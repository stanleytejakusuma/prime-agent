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
	cwd: "/home/dev/prime-agent-fork",
	sessionName: "Prime Agent Onboarding",
	gitBranch: "local-patches",
	usageTotals: {
		input: 438_000_000,
		output: 5_400_000,
		cacheRead: 1_055_000_000,
		cacheWrite: 77_000_000,
		cost: 0.123456,
	},
	cacheHitRate: 0.0,
	autoCompactEnabled: true,
	extensionStatuses: new Map([
		["goal", "2/5"],
		["heartbeat", "next 12:00"],
	]),
};

describe("FooterComponent status line (pi 0.84.2 parity, option A)", () => {
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

	it("renders the pwd line first (cwd, branch, session name, dim)", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => baseData);
		const lines = footer.render(120).map((line) => stripAnsi(line));
		expect(lines[0]).toContain("prime-agent-fork (local-patches) • Prime Agent Onboarding");
	});

	it("renders the cumulative session stats on line 2 (up/down/cache/cost)", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => baseData);
		const stats = stripAnsi(footer.render(120)[1]);
		expect(stats).toContain("↑438.0M");
		expect(stats).toContain("↓5.4M");
		expect(stats).toContain("R1.1B");
		expect(stats).toContain("W77.0M");
		expect(stats).toContain("CH0.0%");
		expect(stats).toContain("$0.123");
	});

	it("omits zero usage segments (no stats line is emitted)", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => ({
			cwd: "/tmp/project",
			usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		}));
		const lines = footer.render(120).map((line) => stripAnsi(line));
		// Only the pwd line renders; no stats line, no extension line.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("/tmp/project");
	});

	it("renders extension statuses on the last line, sorted by key, sanitized", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => ({
			...baseData,
			extensionStatuses: new Map([
				["zebra", "last"],
				["alpha", "first"],
				["hostile", "line one\nline two"],
			]),
		}));
		const lastLine = stripAnsi(footer.render(120).at(-1)!);
		// sorted by key: alpha, hostile, zebra
		expect(lastLine.indexOf("first")).toBeLessThan(lastLine.indexOf("line one line two"));
		expect(lastLine.indexOf("line one line two")).toBeLessThan(lastLine.indexOf("last"));
		expect(lastLine).not.toContain("\n");
		expect(lastLine).not.toContain("\r");
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

	it("strips control characters from a hostile git branch name", () => {
		const footer = new FooterComponent(createFooterData(new Map(), "feature\nrm -rf /"));
		footer.setStatusLineProvider(() => ({ ...baseData, gitBranch: "feature\nrm -rf /" }));
		const line = stripAnsi(footer.render(120)[0]);
		expect(line).not.toContain("\n");
		expect(line).not.toContain("\r");
	});

	it("never throws and degrades to an empty footer when the provider itself throws", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => {
			throw new Error("simulated provider failure");
		});
		expect(() => footer.render(120)).not.toThrow();
		expect(footer.render(120)).toEqual([]);
	});

	it("falls back to the legacy single-line footer when only old fields are supplied", () => {
		const footer = new FooterComponent(createFooterData());
		footer.setStatusLineProvider(() => ({
			model: "deepseek-v4-flash",
			thinkingLevel: "high",
			contextPercent: 42,
			contextTokens: 42000,
			turnTokens: 1250,
			gitBranch: "local-patches",
		}));
		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toContain("deepseek-v4-flash");
		expect(line).toContain("high");
		expect(line).toContain("42%");
		expect(line).toContain("1.3k");
		expect(line).toContain("⎇ local-patches");
	});

	it("computes the cache hit rate from cumulative totals, not the last message", () => {
		const footer = new FooterComponent(createFooterData());
		// Two messages: first 90% hit on 100k prompt tokens, second 0% on 100k
		// -> cumulative = 90k/200k = 45%.
		footer.setStatusLineProvider(() => ({
			cwd: "/tmp/project",
			usageTotals: { input: 200_000, output: 1000, cacheRead: 90_000, cacheWrite: 10_000, cost: 0.1 },
			cacheHitRate: 45.0,
		}));
		const stats = stripAnsi(footer.render(120)[1]);
		expect(stats).toContain("CH45.0%");
	});
});
