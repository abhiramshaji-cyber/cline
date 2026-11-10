import type {
	AgentModelEvent,
	GatewayProviderContext,
	GatewayStreamRequest,
	ModelReasoningOption,
} from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleProvider } from "./ai-sdk";
import { MODEL_STREAM_IDLE_TIMEOUT_ENV } from "./http";

/**
 * Wire-level tests for Gemini: they drive the real `@ai-sdk/google` adapter
 * and the real `ai` package against a fake fetch, so the request body the
 * Gemini API would receive is what gets asserted. Reasoning levels are owned
 * by the AI SDK's portable `reasoning` option, which the adapter turns into
 * `thinkingLevel` (Gemini 3 and later) or `thinkingBudget` (Gemini 2.5).
 */

const BUDGET_25_FLASH: ModelReasoningOption[] = [
	{ type: "toggle" },
	{ type: "budget_tokens", min: 0, max: 24_576 },
];
const LEVELS: ModelReasoningOption[] = [
	{ type: "effort", values: ["low", "medium", "high"] },
];

const textSse = `data: ${JSON.stringify({
	candidates: [
		{
			content: { role: "model", parts: [{ text: "hello" }] },
			finishReason: "STOP",
		},
	],
	usageMetadata: {
		promptTokenCount: 1,
		candidatesTokenCount: 1,
		totalTokenCount: 2,
	},
})}\n\n`;

async function collect(
	iterable: AsyncIterable<AgentModelEvent>,
): Promise<AgentModelEvent[]> {
	const events: AgentModelEvent[] = [];
	for await (const event of iterable) {
		events.push(event);
	}
	return events;
}

function providerContext(
	modelId: string,
	config: Record<string, unknown>,
	reasoningOptions?: ModelReasoningOption[],
): GatewayProviderContext {
	const model = {
		id: modelId,
		providerId: "gemini",
		name: modelId,
		capabilities: ["reasoning"],
		...(reasoningOptions ? { reasoningOptions } : {}),
	};
	return {
		provider: {
			id: "gemini",
			name: "Google Gemini",
			defaultModelId: modelId,
			models: [model],
		},
		model,
		config,
	} as unknown as GatewayProviderContext;
}

function streamRequest(
	modelId: string,
	reasoning: GatewayStreamRequest["reasoning"],
): GatewayStreamRequest {
	return {
		providerId: "gemini",
		modelId,
		messages: [
			{
				id: "msg_user",
				role: "user",
				content: [{ type: "text", text: "do the thing" }],
				createdAt: new Date(),
			},
		],
		reasoning,
	} as unknown as GatewayStreamRequest;
}

async function run(input: {
	modelId: string;
	reasoning?: GatewayStreamRequest["reasoning"];
	reasoningOptions?: ModelReasoningOption[];
	fetch?: typeof fetch;
}) {
	const fetchMock = vi.fn(
		input.fetch ??
			(async () =>
				new Response(textSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})),
	);
	const config = {
		providerId: "gemini",
		apiKey: "test-key",
		fetch: fetchMock as unknown as typeof fetch,
	};
	const provider = await createGoogleProvider(config);
	const events = await collect(
		await provider.stream(
			streamRequest(input.modelId, input.reasoning),
			providerContext(input.modelId, config, input.reasoningOptions),
		),
	);
	const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
	const body =
		typeof init?.body === "string"
			? (JSON.parse(init.body) as {
					generationConfig?: { thinkingConfig?: Record<string, unknown> };
				})
			: undefined;
	return {
		events,
		fetchMock,
		thinkingConfig: body?.generationConfig?.thinkingConfig,
	};
}

describe("Gemini reasoning on the wire", () => {
	it("sends a thinking level, never a budget, to an unlisted Gemini 4 model", async () => {
		const { events, thinkingConfig } = await run({
			modelId: "gemini-4-carbon-eap",
			reasoning: { enabled: true, effort: "high" },
		});

		expect(thinkingConfig).toEqual({ thinkingLevel: "high" });
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
	});

	it("drops an exact token budget for a model that takes thinking levels", async () => {
		const { thinkingConfig } = await run({
			modelId: "gemini-4-argon",
			reasoning: { enabled: true, budgetTokens: 4096 },
			reasoningOptions: [
				...LEVELS,
				{ type: "budget_tokens", min: 0, max: 32_768 },
			],
		});

		expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
	});

	it("sends a thinking level to Gemini 3", async () => {
		const { thinkingConfig } = await run({
			modelId: "gemini-3-pro-preview",
			reasoning: { enabled: true, effort: "low" },
			reasoningOptions: LEVELS,
		});

		expect(thinkingConfig).toEqual({ thinkingLevel: "low" });
	});

	it("lets the AI SDK derive a thinking budget for Gemini 2.5 effort", async () => {
		const { thinkingConfig } = await run({
			modelId: "gemini-2.5-flash",
			reasoning: { enabled: true, effort: "high" },
			reasoningOptions: BUDGET_25_FLASH,
		});

		expect(thinkingConfig).not.toHaveProperty("thinkingLevel");
		expect(thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
		expect(thinkingConfig?.thinkingBudget).toBeLessThanOrEqual(24_576);
	});

	it("keeps an exact token budget for Gemini 2.5", async () => {
		const { thinkingConfig } = await run({
			modelId: "gemini-2.5-flash",
			reasoning: { enabled: true, budgetTokens: 4096 },
			reasoningOptions: BUDGET_25_FLASH,
		});

		expect(thinkingConfig).toEqual({
			thinkingBudget: 4096,
			includeThoughts: true,
		});
	});

	it("turns thinking off for Gemini 2.5 Flash", async () => {
		const { thinkingConfig } = await run({
			modelId: "gemini-2.5-flash",
			reasoning: { enabled: false },
			reasoningOptions: BUDGET_25_FLASH,
		});

		expect(thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it("sends no thinking config without reasoning intent", async () => {
		const { thinkingConfig } = await run({ modelId: "gemini-2.5-flash" });

		expect(thinkingConfig).toBeUndefined();
	});
});

describe("Gemini stream stall timeout", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("ends a silent stream with a retryable timeout error", async () => {
		vi.stubEnv(MODEL_STREAM_IDLE_TIMEOUT_ENV, "40");
		// Headers arrive, then the body never produces a chunk.
		const silentFetch = (async (_input: unknown, init?: RequestInit) =>
			new Response(
				new ReadableStream({
					start(controller) {
						init?.signal?.addEventListener("abort", () =>
							controller.error(init.signal?.reason),
						);
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;

		const { events } = await run({
			modelId: "gemini-4-carbon-eap",
			fetch: silentFetch,
		});

		const finish = events.at(-1);
		expect(finish).toMatchObject({
			type: "finish",
			reason: "error",
			errorRetryable: true,
		});
		expect((finish as { error?: string }).error).toMatch(/timeout/i);
	});
});
