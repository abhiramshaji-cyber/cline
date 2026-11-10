import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
	MODEL_STREAM_IDLE_TIMEOUT_ENV,
	resolveModelStreamTimeout,
	withoutFetchIdleTimeout,
} from "./http";

describe("withoutFetchIdleTimeout", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("leaves the fetch untouched outside Bun", () => {
		const base = vi.fn() as unknown as typeof fetch;
		expect(withoutFetchIdleTimeout(base, false)).toBe(base);
		expect(withoutFetchIdleTimeout(undefined, false)).toBeUndefined();
	});

	it("disables the runtime idle timeout and keeps the caller's init", async () => {
		const base = vi.fn(async () => new Response("ok"));
		const signal = new AbortController().signal;
		const wrapped = withoutFetchIdleTimeout(
			base as unknown as typeof fetch,
			true,
		);

		await wrapped?.("https://example.test/v1", { method: "POST", signal });

		expect(base).toHaveBeenCalledWith("https://example.test/v1", {
			method: "POST",
			signal,
			timeout: false,
		});
	});

	it("falls back to the global fetch current at call time", async () => {
		const wrapped = withoutFetchIdleTimeout(undefined, true);
		const later = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", later);

		await wrapped?.("https://example.test/v1");

		expect(later).toHaveBeenCalledWith("https://example.test/v1", {
			timeout: false,
		});
	});

	it("keeps preconnect available on the wrapped fetch", () => {
		const preconnect = vi.fn();
		const base = Object.assign(
			vi.fn(async () => new Response("ok")),
			{ preconnect },
		);
		const wrapped = withoutFetchIdleTimeout(
			base as unknown as typeof fetch,
			true,
		) as typeof fetch & { preconnect?: (url: string) => void };

		wrapped.preconnect?.("https://example.test");

		expect(preconnect).toHaveBeenCalledWith("https://example.test");
	});
});

describe("resolveModelStreamTimeout", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("defaults to a 20 minute stall limit", () => {
		vi.stubEnv(MODEL_STREAM_IDLE_TIMEOUT_ENV, "");
		expect(resolveModelStreamTimeout()).toEqual({
			firstChunkMs: DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
			chunkMs: DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
		});
		expect(DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(1_200_000);
	});

	it("honors an override and treats 0 as disabled", () => {
		vi.stubEnv(MODEL_STREAM_IDLE_TIMEOUT_ENV, "90000");
		expect(resolveModelStreamTimeout()).toEqual({
			firstChunkMs: 90_000,
			chunkMs: 90_000,
		});
		vi.stubEnv(MODEL_STREAM_IDLE_TIMEOUT_ENV, "0");
		expect(resolveModelStreamTimeout()).toBeUndefined();
	});

	it("ignores an invalid override", () => {
		vi.stubEnv(MODEL_STREAM_IDLE_TIMEOUT_ENV, "soon");
		expect(resolveModelStreamTimeout()?.chunkMs).toBe(
			DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
		);
	});
});
