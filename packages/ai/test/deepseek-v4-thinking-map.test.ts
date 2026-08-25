import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

// DeepSeek V4 thinking-level wire mapping (fork todos #44/#45): upstream effort
// vocabulary is low / high / max only; medium and xhigh must never be selectable,
// max must serialize as "max", and off disables thinking entirely.
// See DEEPSEEK_V4_THINKING_LEVEL_MAP in scripts/generate-models.ts.

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("DeepSeek V4 thinking-level wire mapping", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	async function payloadFor(reasoning: "off" | "low" | "high" | "max") {
		const model = getModel("deepseek", "deepseek-v4-pro")!;
		let payload: unknown;
		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning,
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimple>[2],
		).result();
		return (payload ?? mockState.lastParams) as {
			reasoning_effort?: string;
			thinking?: { type: string };
		};
	}

	it("exposes exactly off/low/high/max for DeepSeek V4 Pro", () => {
		const model = getModel("deepseek", "deepseek-v4-pro")!;
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
	});

	it("serializes max as reasoning_effort max with thinking enabled", async () => {
		const payload = await payloadFor("max");
		expect(payload.reasoning_effort).toBe("max");
		expect(payload.thinking).toEqual({ type: "enabled" });
	});

	it("serializes low and high as-is with thinking enabled", async () => {
		expect((await payloadFor("low")).reasoning_effort).toBe("low");
		expect((await payloadFor("low")).thinking).toEqual({ type: "enabled" });
		expect((await payloadFor("high")).reasoning_effort).toBe("high");
		expect((await payloadFor("high")).thinking).toEqual({ type: "enabled" });
	});

	it("disables thinking for off and sends no reasoning_effort", async () => {
		const payload = await payloadFor("off");
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.reasoning_effort).toBeUndefined();
	});
});
