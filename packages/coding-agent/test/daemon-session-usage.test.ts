import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	buildSessionList,
	type SessionUsageSnapshot,
	summaryForActiveSession,
} from "../src/modes/daemon/daemon-session-list.js";

function makeMessage(role: "assistant" | "toolResult", usage: unknown): AgentMessage {
	return { role, content: [], usage } as unknown as AgentMessage;
}

function makeState(
	options: {
		activeSessionId: string;
		messages?: AgentMessage[];
		contextUsage?: { tokens: number; contextWindow: number; percent: number };
	} & Partial<Parameters<typeof summaryForActiveSession>[0]>,
): ActiveSessionState {
	const clients = new Set<DaemonSocketClient>();
	return {
		activeSessionId: options.activeSessionId,
		clients,
		lastEventSequence: 0,
		summaryState: undefined,
		runtime: {
			metadata: { kind: "top-level", createdAt: 1 },
			diagnostics: [],
			session: {
				model: undefined,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				sessionFile: `/tmp/${options.activeSessionId}.jsonl`,
				sessionId: `session-${options.activeSessionId}`,
				rlmDepth: 0,
				sessionName: `session ${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
					getHeader: () => ({ timestamp: "2026-05-01T00:00:00.000Z" }),
					getSessionDir: () => "/tmp/sessions",
					hasUserContent: () => false,
				},
				messages: options.messages ?? [],
				getRlmChildRunStatus: () => undefined,
				hasRunningRlmChildren: () => false,
				hasAcceptedPromptInFlight: false,
				unfinishedActionCount: 0,
				isSessionActive: false,
				getCurrentRecap: () => undefined,
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				state: { streamingMessage: undefined, pendingToolCalls: new Set() },
				getContextUsage: options.contextUsage ? () => options.contextUsage! : () => undefined,
			},
		},
	} as unknown as ActiveSessionState;
}

function makeSessionInfo(overrides: Pick<SessionInfo, "path" | "id"> & Partial<SessionInfo>): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: "/tmp/project",
		name: overrides.name,
		state: overrides.state,
		parentSessionPath: overrides.parentSessionPath,
		rlmDepth: overrides.rlmDepth ?? 0,
		created: new Date("2026-05-01T00:00:00.000Z"),
		modified: new Date("2026-05-02T00:00:00.000Z"),
		messageCount: overrides.messageCount ?? 2,
		firstMessage: "hello",
		allMessagesText: "hello world",
		agentStatus: overrides.agentStatus,
	};
}

describe("session usage snapshot (agents-view status footer, phase 2)", () => {
	const usageA = {
		input: 1000,
		output: 400,
		cacheRead: 1000,
		cacheWrite: 0,
		cost: { total: 1.2 },
	};
	const usageB = {
		input: 0,
		output: 100,
		cacheRead: 0,
		cacheWrite: 500,
		cost: { total: 0.3 },
	};

	it("omits usageSnapshot when the client did not ask for it", () => {
		const state = makeState({
			activeSessionId: "a",
			messages: [makeMessage("assistant", usageA)],
			contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
		});
		const summary = summaryForActiveSession(state);
		expect(summary.usageSnapshot).toBeUndefined();
		const listed = buildSessionList([state], [], []);
		expect(listed[0].usageSnapshot).toBeUndefined();
	});

	it("computes aggregate totals, cache hit rate, and context when asked", () => {
		const state = makeState({
			activeSessionId: "a",
			messages: [
				makeMessage("assistant", usageA),
				makeMessage("assistant", usageB),
				makeMessage("toolResult", { no: "usage" }),
			],
			contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.17 },
		});
		const summary = summaryForActiveSession(state, undefined, false, false, false, true);
		const snapshot = summary.usageSnapshot as SessionUsageSnapshot;
		expect(snapshot).toBeDefined();
		expect(snapshot.input).toBe(1000);
		expect(snapshot.output).toBe(500);
		expect(snapshot.cacheRead).toBe(1000);
		expect(snapshot.cacheWrite).toBe(500);
		expect(snapshot.cost).toBeCloseTo(1.5);
		// promptTokens = input + cacheRead + cacheWrite = 2500; hit = 1000/2500 = 40%.
		expect(snapshot.cacheHitRate).toBeCloseTo(40);
		expect(snapshot.contextTokens).toBe(12_345);
		expect(snapshot.contextWindow).toBe(200_000);
		expect(snapshot.contextPercent).toBeCloseTo(6.17);
	});

	it("propagates the flag through buildSessionList for active rows only", () => {
		const active = makeState({
			activeSessionId: "a",
			messages: [makeMessage("assistant", usageA)],
			contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
		});
		const inactive = makeSessionInfo({ path: "/tmp/inactive.jsonl", id: "inactive" });
		const entries = buildSessionList([active], [inactive], [], true);
		expect(entries.find((entry) => entry.id === "a")?.usageSnapshot).toBeDefined();
		expect(entries.find((entry) => entry.id === "inactive")?.usageSnapshot).toBeUndefined();
	});

	it("returns no snapshot when there is neither usage nor context", () => {
		const state = makeState({ activeSessionId: "a", messages: [] });
		const summary = summaryForActiveSession(state, undefined, false, false, false, true);
		expect(summary.usageSnapshot).toBeUndefined();
	});

	it("ignores messages whose usage is all zeros", () => {
		const state = makeState({
			activeSessionId: "a",
			messages: [makeMessage("assistant", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })],
		});
		const summary = summaryForActiveSession(state, undefined, false, false, false, true);
		expect(summary.usageSnapshot).toBeUndefined();
	});
});

describe("schedule fixture sanity", () => {
	it("keeps buildSessionList callable with the default flag", () => {
		const jobs: AgentCronJob[] = [];
		expect(buildSessionList([], [], jobs)).toEqual([]);
	});
});
