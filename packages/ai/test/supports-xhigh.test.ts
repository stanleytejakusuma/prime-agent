import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("max");
		expect(levels).not.toContain("xhigh");
	});

	it("includes both xhigh and max for Anthropic Opus 4.7 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
	});

	it("includes both xhigh and max for Anthropic Opus 4.8 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
	});

	it("includes max but not xhigh for Anthropic Sonnet 4.6 (adaptive thinking)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("max");
		expect(levels).not.toContain("xhigh");
	});

	it("includes both xhigh and max for Anthropic Sonnet 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-5");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
		expect(model!.contextWindow).toBe(1000000);
		expect(model!.maxTokens).toBe(128000);
		expect(model!.cost).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
	});

	it("does not include max for older budget-based Claude models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
	});

	it("does not include xhigh for non-Opus Anthropic models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it.each(["gpt-5.4", "gpt-5.5"] as const)("includes xhigh for %s models", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"includes xhigh and max for %s through the OpenAI API and Codex subscription",
		(modelId) => {
			const apiModel = getModel("openai", modelId);
			const codexModel = getModel("openai-codex", modelId);

			expect(apiModel).toBeDefined();
			expect(codexModel).toBeDefined();
			expect(getSupportedThinkingLevels(apiModel!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
			expect(getSupportedThinkingLevels(codexModel!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
			expect(apiModel!.contextWindow).toBe(1050000);
			expect(apiModel!.maxTokens).toBe(128000);
			expect(codexModel!.contextWindow).toBe(272000);
			expect(codexModel!.maxTokens).toBe(128000);
		},
	);

	it("supports disabling reasoning for the base GPT-5.6 API alias", () => {
		const model = getModel("openai", "gpt-5.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("off");
	});

	// Upstream DeepSeek V4 effort vocabulary is low / high / max only (OmniRoute
	// Model Management handoff, fork todos #44/#45): medium and xhigh map to high
	// upstream and must not be exposed as selectable tiers; max is the real top tier.
	it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
		"exposes exactly off/low/high/max for DeepSeek V4 %s on the DeepSeek provider",
		(modelId) => {
			const model = getModel("deepseek", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
		},
	);

	it("exposes exactly off/low/high/max for DeepSeek V4 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
	});

	it("exposes exactly off/low/high/max for DeepSeek V4 Flash on OpenRouter", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
	});

	it('maps DeepSeek V4 max to upstream "max" and pins medium/xhigh to null (hidden)', () => {
		const model = getModel("deepseek", "deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(model!.thinkingLevelMap).toMatchObject({
			off: "none",
			low: "low",
			high: "high",
			max: "max",
		});
		expect(model!.thinkingLevelMap?.medium).toBeNull();
		expect(model!.thinkingLevelMap?.xhigh).toBeNull();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).not.toContain("medium");
		expect(levels).not.toContain("xhigh");
	});

	it("includes max but not xhigh for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("max");
		expect(levels).not.toContain("xhigh");
	});
});
