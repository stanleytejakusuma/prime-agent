import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent, type FooterStatusLineData } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFooterData(
	statuses: Map<string, string> = new Map(),
	branch = "main",
	providerCount = 3,
): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};
}

const baseData: FooterStatusLineData = {
	model: "deepseek-v4-flash",
	thinkingLevel: "high",
	contextPercent: 42,
	contextTokens: 42000,
	turnTokens: 1250,
	gitBranch: "local-patches",
};

describe("FooterComponent status line", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders nothing without a status-line provider", () => {
		const footer = new FooterComponent(createFooterData());
		expect(footer.render(120)).toEqual([]);
	});

	it("renders nothing when the provider returns undefined", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => undefined);
		expect(footer.render(120)).toEqual([]);
	});

	it("renders model, thinking level, context, tokens, and git branch", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => baseData);
		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toContain("deepseek-v4-flash");
		expect(line).toContain("high");
		expect(line).toContain("42%");
		expect(line).toContain("1.3k");
		expect(line).toContain("⎇ local-patches");
	});

	it("includes extension statuses registered via setStatus", () => {
		const statuses = new Map([
			["heartbeat", "next 12:00"],
			["goal", "2/5"],
		]);
		const footer = new FooterComponent(createFooterData(statuses));
		footer.setStatusLineProvider(() => ({ ...baseData, extensionStatuses: statuses }));
		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toContain("next 12:00");
		expect(line).toContain("2/5");
	});

	it("omits unknown context and zero-turn tokens", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => ({
			model: "gpt-5.6-terra",
			contextPercent: null,
			contextTokens: null,
			turnTokens: 0,
		}));
		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toBe("gpt-5.6-terra");
	});

	it("omits reasoning level for non-reasoning models (off level)", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => ({ ...baseData, thinkingLevel: "off" }));
		const line = stripAnsi(footer.render(120)[0]);
		expect(line).not.toContain("off");
	});

	it("keeps every rendered line within the terminal width", () => {
		const statuses = new Map([["heartbeat", "a very long extension status ".repeat(20)]]);
		const footer = new FooterComponent(createFooterData(statuses));
		footer.setStatusLineProvider(() => ({ ...baseData, extensionStatuses: statuses }));
		for (const width of [40, 60, 93, 160]) {
			for (const line of footer.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("colors context usage by threshold", () => {
		const footer = new FooterComponent(createFooterData());
		const renderLine = (_percent: number) => footer.render(120)[0].replace(/\u001b\[[0-9;]*m/g, "");
		footer.setStatusLineProvider(() => ({ ...baseData, contextPercent: 45 }));
		expect(renderLine(45)).toContain("45%");
		footer.setStatusLineProvider(() => ({ ...baseData, contextPercent: 75 }));
		expect(renderLine(75)).toContain("75%");
		footer.setStatusLineProvider(() => ({ ...baseData, contextPercent: 95 }));
		expect(renderLine(95)).toContain("95%");
	});
});
