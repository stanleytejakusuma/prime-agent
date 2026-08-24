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

	it("applies visibly distinct coloring to context usage across thresholds", () => {
		// Isolate the context segment from the model segment (also colored) by
		// omitting model/thinkingLevel/tokens/branch, so the only ANSI escape in
		// the line is the one under test.
		const footer = new FooterComponent(createFooterData());
		const rawLineFor = (contextPercent: number) => {
			footer.setStatusLineProvider(() => ({ contextPercent, contextTokens: 1000 }));
			return footer.render(120)[0];
		};
		const normal = rawLineFor(45);
		const warning = rawLineFor(75);
		const error = rawLineFor(95);
		const ansiEscape = /\x1b\[[0-9;]*m/;
		for (const line of [normal, warning, error]) {
			expect(line).toMatch(ansiEscape);
		}
		const colorOf = (line: string) => line.match(ansiEscape)?.[0];
		expect(colorOf(normal)).not.toBe(colorOf(warning));
		expect(colorOf(warning)).not.toBe(colorOf(error));
		expect(colorOf(normal)).not.toBe(colorOf(error));
		expect(stripAnsi(normal)).toContain("45%");
		expect(stripAnsi(warning)).toContain("75%");
		expect(stripAnsi(error)).toContain("95%");
	});

	it("treats non-finite context percent and tokens as unknown instead of rendering NaN", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => ({
			model: "gpt-5.6-terra",
			contextPercent: Number.NaN,
			contextTokens: Number.NaN,
			turnTokens: Number.NaN,
		}));
		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toBe("gpt-5.6-terra");
		expect(line).not.toContain("NaN");
	});

	it("strips newlines and control characters from extension status text", () => {
		const statuses = new Map([["bad", "line one\nline two\r\x1b[31mred\x07"]]);
		const footer = new FooterComponent(createFooterData(statuses));
		footer.setStatusLineProvider(() => ({ ...baseData, extensionStatuses: statuses }));
		const rendered = footer.render(120);
		expect(rendered.length).toBe(1);
		expect(rendered[0]).not.toContain("\n");
		expect(rendered[0]).not.toContain("\r");
		const line = stripAnsi(rendered[0]);
		expect(line).toContain("line one line two");
	});

	it("strips control characters from a hostile git branch name", () => {
		const footer = new FooterComponent(createFooterData(new Map(), "feature\nrm -rf /"));
		footer.setStatusLineProvider(() => ({ ...baseData, gitBranch: "feature\nrm -rf /" }));
		const rendered = footer.render(120);
		expect(rendered.length).toBe(1);
		expect(rendered[0]).not.toContain("\n");
	});

	it("never throws and degrades to an empty footer when the provider itself throws", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => {
			throw new Error("simulated provider failure");
		});
		expect(() => footer.render(120)).not.toThrow();
		expect(footer.render(120)).toEqual([]);
	});
});
