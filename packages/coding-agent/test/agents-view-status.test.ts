import { beforeAll, describe, expect, it } from "vitest";
import { createAgentsViewListCommand } from "../src/modes/agents-view/agents-view-mode.js";
import { buildAgentsViewStatusLines } from "../src/modes/agents-view/agents-view-status.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("light");
});

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "active-1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		activeSessionId: "active-1",
		sessionId: "session-1",
		cwd: "/tmp/project",
		sessionName: "Prime Agent Onboarding",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: 12,
		unfinishedActionCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		model: { provider: "omniroute", id: "ox-alpha" } as SessionSummary["model"],
		thinkingLevel: "max",
		...overrides,
	};
}

const plainSummary = makeSummary();

const snapshotSummary = makeSummary({
	usageSnapshot: {
		input: 12_345,
		output: 678,
		cacheRead: 12_345,
		cacheWrite: 0,
		cost: 1.2345,
		cacheHitRate: 50,
		contextTokens: 77_000,
		contextWindow: 200_000,
		contextPercent: 38.5,
	},
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("buildAgentsViewStatusLines", () => {
	it("renders selected session, roster, and usage lines", () => {
		const lines = buildAgentsViewStatusLines(
			{ summary: snapshotSummary, countsText: "3 running, 1 idle, 5 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[0]).toContain("/tmp/project");
		expect(plain[0]).toContain("Prime Agent Onboarding");
		expect(plain[0]).toContain("ox-alpha:max");
		expect(plain[0]).toContain("77.0k (39%)");
		expect(plain[1]).toBe("3 running, 1 idle, 5 inactive · scope global · depth0");
		expect(plain[2]).toContain("↑12.3k");
		expect(plain[2]).toContain("↓678");
		expect(plain[2]).toContain("R12.3k");
		expect(plain[2]).toContain("CH50.0%");
		expect(plain[2]).toContain("$1.234");
	});

	it("omits the usage line when the daemon sent no snapshot (Phase 1 only)", () => {
		const lines = buildAgentsViewStatusLines(
			{ summary: plainSummary, countsText: "1 running, 0 idle, 0 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[0]).toContain("ox-alpha:max");
		expect(plain[0]).not.toContain("(");
		expect(plain).toHaveLength(2);
	});

	it("renders only the roster line without a selection", () => {
		const lines = buildAgentsViewStatusLines(
			{ summary: undefined, countsText: "0 running, 0 idle, 1 inactive", scopeLabel: "scoped", depth: 2 },
			80,
		);
		const plain = lines.map(stripAnsi);
		expect(plain).toEqual(["0 running, 0 idle, 1 inactive · scope scoped · depth2"]);
	});

	it("flattens control characters in user-provided text", () => {
		const dirty = makeSummary({ cwd: "/tmp/a\u0007b", sessionName: "bad\u001bname" });
		const lines = buildAgentsViewStatusLines(
			{ summary: dirty, countsText: "0 running, 0 idle, 1 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
	});

	it("truncates every line to the requested width", () => {
		const lines = buildAgentsViewStatusLines(
			{ summary: snapshotSummary, countsText: "3 running, 1 idle, 5 inactive", scopeLabel: "global", depth: 0 },
			20,
		);
		for (const line of lines) {
			expect(stripAnsi(line).length).toBeLessThanOrEqual(22);
		}
	});

	it("resolves a git branch for a real repo cwd", () => {
		const repoSummary = makeSummary({ cwd: process.cwd() });
		const lines = buildAgentsViewStatusLines(
			{ summary: repoSummary, countsText: "0 running, 0 idle, 1 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		expect(stripAnsi(lines[0])).toMatch(/\([^)]+\)/);
	});
});

describe("createAgentsViewListCommand", () => {
	it("advertises the session_usage_snapshot capability", () => {
		const command = createAgentsViewListCommand();
		expect(command.type).toBe("list");
		expect(command.capabilities).toContain("session_usage_snapshot");
	});
});
