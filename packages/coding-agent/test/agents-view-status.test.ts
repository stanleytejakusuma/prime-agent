import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentsViewListCommand } from "../src/modes/agents-view/agents-view-mode.js";
import {
	buildAgentsViewStatusLines,
	peekCachedGitBranch,
	refreshGitBranchCache,
} from "../src/modes/agents-view/agents-view-status.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// Mocked so the "does not re-resolve a fresh cache entry" test can assert on
// real invocation counts instead of an unattached spy. Resolves with a
// synthetic "not a git repo" error on every call, matching resolveGitBranchAsync's
// null-on-failure contract without touching a real subprocess.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(
			(
				_command: string,
				_args: string[],
				_options: unknown,
				callback: (error: Error | null, stdout: string) => void,
			) => {
				queueMicrotask(() => callback(new Error("not a git repository"), ""));
				return new EventEmitter();
			},
		),
	};
});

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
	it("always returns exactly three lines (fixed dock height)", () => {
		// Red review 2026-08-24: a variable 1-4 line footer made the dock height
		// (and therefore the roster's visible-row window/scroll anchor) jitter
		// with selection. The footer must always be exactly three lines,
		// regardless of whether there is a selection or usage data.
		const withEverything = buildAgentsViewStatusLines(
			{ summary: snapshotSummary, countsText: "3 running, 1 idle, 5 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		expect(withEverything).toHaveLength(3);

		const noSelection = buildAgentsViewStatusLines(
			{ summary: undefined, countsText: "0 running, 0 idle, 1 inactive", scopeLabel: "scoped", depth: 2 },
			80,
		);
		expect(noSelection).toHaveLength(3);

		const noUsageSnapshot = buildAgentsViewStatusLines(
			{ summary: plainSummary, countsText: "1 running, 0 idle, 0 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		expect(noUsageSnapshot).toHaveLength(3);
	});

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
		expect(plain[1]).toBe("D? · 3 running, 1 idle, 5 inactive · scope global · depth0");
		expect(plain[2]).toContain("↑12.3k");
		expect(plain[2]).toContain("↓678");
		expect(plain[2]).toContain("R12.3k");
		expect(plain[2]).toContain("CH50.0%");
		expect(plain[2]).toContain("$1.234");
	});

	it("blanks the usage line (not omits it) when the daemon sent no snapshot (Phase 1 only)", () => {
		const lines = buildAgentsViewStatusLines(
			{ summary: plainSummary, countsText: "1 running, 0 idle, 0 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[0]).toContain("ox-alpha:max");
		expect(plain[0]).not.toContain("(");
		expect(plain).toHaveLength(3);
		expect(plain[2].trim()).toBe("");
	});

	it("blanks the selection line (not omits it) without a selection", () => {
		const lines = buildAgentsViewStatusLines(
			{ summary: undefined, countsText: "0 running, 0 idle, 1 inactive", scopeLabel: "scoped", depth: 2 },
			80,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[0].trim()).toBe("");
		expect(plain[1]).toBe("D? · 0 running, 0 idle, 1 inactive · scope scoped · depth2");
		expect(plain[2].trim()).toBe("");
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

	it("flattens control characters in scopeLabel", () => {
		// Red review 2026-08-24: scopeLabel is derived from a session title
		// (user-influenced data) and was interpolated into line 2 without
		// sanitization, unlike cwd/sessionName/branch.
		const lines = buildAgentsViewStatusLines(
			{ summary: undefined, countsText: "0 running, 0 idle, 1 inactive", scopeLabel: "evil\u001bscope", depth: 0 },
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[1]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
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

	it("coerces non-finite usage fields to zero instead of poisoning totals", () => {
		// Red review 2026-08-24: usage fields were accumulated without a finite
		// check (only cacheHitRate was guarded), so a NaN input/output/etc.
		// could silently poison the displayed totals.
		const nanSummary = makeSummary({
			usageSnapshot: {
				input: Number.NaN,
				output: 100,
				cacheRead: Number.POSITIVE_INFINITY,
				cacheWrite: -5,
				cost: Number.NaN,
				cacheHitRate: null,
				contextTokens: null,
				contextWindow: 0,
				contextPercent: null,
			},
		});
		const lines = buildAgentsViewStatusLines(
			{ summary: nanSummary, countsText: "1 running, 0 idle, 0 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[2]).not.toContain("NaN");
		expect(plain[2]).not.toContain("Infinity");
		expect(plain[2]).toContain("↓100");
	});

	it("reads the branch from the cache instead of resolving it itself (pure builder)", () => {
		// Red review 2026-08-24: the previous implementation called spawnSync()
		// directly inside this function, which could block the TUI render loop
		// for up to its own timeout. The builder must be a pure, synchronous
		// cache read; branch resolution happens out-of-band via
		// refreshGitBranchCache, called from the view's poll loop, never here.
		const withCwd = makeSummary({ cwd: "/tmp/cache-miss-project" });
		const linesBeforeCache = buildAgentsViewStatusLines(
			{ summary: withCwd, countsText: "1 running, 0 idle, 0 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		// No cache entry yet: renders the cwd without a branch, does not block.
		expect(stripAnsi(linesBeforeCache[0])).not.toMatch(/\([^)]+\)/);
		expect(peekCachedGitBranch("/tmp/cache-miss-project")).toBeUndefined();
	});
});

describe("control-plane trust capsule (line 2)", () => {
	it("renders a fresh capsule as D with a check and the frame age in seconds", () => {
		const lines = buildAgentsViewStatusLines(
			{
				summary: undefined,
				countsText: "1 running, 0 idle, 0 inactive",
				scopeLabel: "global",
				depth: 0,
				daemonFrameAgeMs: 500,
			},
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[1]).toMatch(/^D\u2713 0s \u00b7 1 running, 0 idle, 0 inactive/);
	});

	it("renders an unknown capsule when no daemon frame has ever been decoded", () => {
		const lines = buildAgentsViewStatusLines(
			{ summary: undefined, countsText: "0 running, 0 idle, 1 inactive", scopeLabel: "global", depth: 0 },
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[1]).toMatch(/^D\? \u00b7 0 running, 0 idle, 1 inactive/);
	});

	it("renders a stale capsule once the frame age exceeds the threshold", () => {
		const lines = buildAgentsViewStatusLines(
			{
				summary: undefined,
				countsText: "1 running, 0 idle, 0 inactive",
				scopeLabel: "global",
				depth: 0,
				daemonFrameAgeMs: 6000,
			},
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[1]).toMatch(/^D! STALE 6s \u00b7 1 running, 0 idle, 0 inactive/);
	});

	it("keeps the roster summary intact when the capsule is present", () => {
		const lines = buildAgentsViewStatusLines(
			{
				summary: undefined,
				countsText: "3 running, 1 idle, 5 inactive",
				scopeLabel: "scoped",
				depth: 2,
				daemonFrameAgeMs: 100,
			},
			120,
		);
		const plain = lines.map(stripAnsi);
		expect(plain[1]).toContain("3 running, 1 idle, 5 inactive \u00b7 scope scoped \u00b7 depth2");
	});

	it("stale and unknown states never render as healthy", () => {
		const unknown = buildAgentsViewStatusLines(
			{ summary: undefined, countsText: "0 running, 0 idle, 0 inactive", scopeLabel: "global", depth: 0 },
			120,
		).map(stripAnsi);
		expect(unknown[1]).not.toMatch(/^D\u2713/);

		const stale = buildAgentsViewStatusLines(
			{
				summary: undefined,
				countsText: "0 running, 0 idle, 0 inactive",
				scopeLabel: "global",
				depth: 0,
				daemonFrameAgeMs: 30_000,
			},
			120,
		).map(stripAnsi);
		expect(stale[1]).not.toMatch(/^D\u2713/);
	});
});

describe("git branch cache", () => {
	it("is populated asynchronously by refreshGitBranchCache, not by the builder", async () => {
		const cwd = process.cwd();
		expect(peekCachedGitBranch(cwd)).toBeUndefined();
		await refreshGitBranchCache(cwd);
		// process.cwd() during the test run is inside this repo; whether it
		// resolves to a real branch name or null (detached HEAD in CI) is
		// environment-dependent and must not be asserted -- only that the
		// cache was populated (no longer undefined) without throwing.
		expect(peekCachedGitBranch(cwd)).not.toBeUndefined();
	});

	it("does not re-resolve a fresh cache entry", async () => {
		// Red review 2026-08-24 (footer remediation re-review): the prior version
		// of this test declared an unattached vi.fn() spy and asserted a
		// nonexistent cwd resolves identically to null both times -- it could not
		// fail even if the TTL short-circuit in refreshGitBranchCache were
		// deleted entirely. This mocks node:child_process directly and counts
		// real invocations, so it fails if the short-circuit regresses.
		const cwd = "/tmp/fake-repo-for-cache-test-real-mock";
		const execFileMock = vi.mocked(execFile);
		execFileMock.mockClear();
		await refreshGitBranchCache(cwd);
		expect(execFileMock).toHaveBeenCalledTimes(1);
		const first = peekCachedGitBranch(cwd);

		// A second call within the TTL must be a genuine no-op: no additional
		// process spawn, and the cached value is unchanged.
		await refreshGitBranchCache(cwd);
		expect(execFileMock).toHaveBeenCalledTimes(1);
		const second = peekCachedGitBranch(cwd);
		expect(second).toBe(first);
	});
});

describe("createAgentsViewListCommand", () => {
	it("advertises the session_usage_snapshot capability", () => {
		const command = createAgentsViewListCommand();
		expect(command.type).toBe("list");
		expect(command.capabilities).toContain("session_usage_snapshot");
	});
});
