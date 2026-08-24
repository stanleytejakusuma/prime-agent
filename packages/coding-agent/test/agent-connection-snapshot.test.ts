import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import {
	createAgentConnectionResourceSnapshot,
	createAgentConnectionState,
} from "../src/modes/agent-connection/snapshot.js";

describe("agent connection snapshots", () => {
	it("adds remote-friendly artifact references to resource snapshots", () => {
		const session = {
			sessionId: "session-1",
			sessionManager: {
				getCwd: () => "/workspace/project",
			},
			resourceLoader: {
				getAgentsFiles: () => ({
					agentsFiles: [{ path: "/workspace/project/AGENTS.md" }],
				}),
				getSkills: () => ({
					skills: [
						{
							name: "commit",
							description: "Commit changes",
							filePath: "/workspace/project/.prime/skills/commit/SKILL.md",
						},
					],
					diagnostics: [],
				}),
				getPrompts: () => ({
					prompts: [],
					diagnostics: [],
				}),
				getThemes: () => ({
					themes: [],
					diagnostics: [],
				}),
				getExtensions: () => ({
					extensions: [{ path: "/opt/prime/extensions/review/index.ts" }],
					errors: [],
				}),
			},
		} as unknown as AgentSession;

		const snapshot = createAgentConnectionResourceSnapshot(session);

		expect(snapshot.contextFiles[0]).toMatchObject({
			path: "/workspace/project/AGENTS.md",
			artifact: {
				id: expect.stringMatching(/^artifact_[a-f0-9]{16}$/),
				sessionId: "session-1",
				type: "context_file",
				logicalPath: "AGENTS.md",
				relativePath: "AGENTS.md",
			},
		});
		expect(snapshot.skills[0]?.artifact).toMatchObject({
			type: "skill",
			logicalPath: ".prime/skills/commit/SKILL.md",
			relativePath: ".prime/skills/commit/SKILL.md",
		});
		expect(snapshot.extensions[0]).toMatchObject({
			path: "/opt/prime/extensions/review/index.ts",
			artifact: {
				type: "extension",
				logicalPath: "index.ts",
			},
		});
		expect(snapshot.extensions[0]?.artifact).not.toHaveProperty("relativePath");
	});
});

describe("activityStartedAt turn-start anchor (fork fix: timer-startedat)", () => {
	function makeMinimalSession(overrides: {
		isStreaming: boolean;
		messages: Array<{ role: string; timestamp?: number }>;
	}) {
		return {
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			sessionName: "test-session",
			sessionManager: {
				getCwd: () => "/workspace/project",
				getSessionDir: () => "/workspace/project/.prime/agent/sessions",
				getLeafId: () => "leaf-1",
				getEntries: () => [],
				getLatestAgentStatus: () => undefined,
			},
			model: undefined,
			thinkingLevel: "medium",
			serviceTier: "auto",
			getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
			isStreaming: overrides.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			steeringMode: "immediate",
			followUpMode: "queue",
			autoCompactionEnabled: true,
			messages: overrides.messages,
			getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			goalState: undefined,
			scopedModels: [],
			getActiveToolNames: () => [],
			getContextUsage: () => undefined,
		} as unknown as AgentSession;
	}

	it("anchors elapsed time to the last user message while streaming", () => {
		const session = makeMinimalSession({
			isStreaming: true,
			messages: [
				{ role: "user", timestamp: 1000 },
				{ role: "assistant", timestamp: 1500 },
				{ role: "user", timestamp: 2000 },
			],
		});
		const runtime = { session } as unknown as AgentSessionRuntime;

		const state = createAgentConnectionState(runtime, "active-1");

		// Anchors to the LATEST user message (2000), not the first, and not the
		// assistant message that happens to have a later timestamp than the
		// first user message.
		expect(state.activityStartedAt).toBe(2000);
	});

	it("is undefined when the session is idle, even if messages exist", () => {
		const session = makeMinimalSession({
			isStreaming: false,
			messages: [{ role: "user", timestamp: 1000 }],
		});
		const runtime = { session } as unknown as AgentSessionRuntime;

		const state = createAgentConnectionState(runtime, "active-1");

		expect(state.activityStartedAt).toBeUndefined();
	});

	it("is undefined when streaming but no user message has a valid timestamp", () => {
		const session = makeMinimalSession({
			isStreaming: true,
			messages: [{ role: "assistant", timestamp: 1000 }],
		});
		const runtime = { session } as unknown as AgentSessionRuntime;

		const state = createAgentConnectionState(runtime, "active-1");

		expect(state.activityStartedAt).toBeUndefined();
	});

	it("survives a simulated reattach: the anchor is derived from persisted message data, not client-local state", () => {
		// This is the actual bug being fixed: a client's local workingStartedAt
		// clock only starts counting from whenever the client itself last
		// (re)attached, so on reattach the elapsed timer reset to 0 even though
		// the agent had been working for minutes. activityStartedAt instead comes
		// from data the daemon already has (the message timestamps), so it is
		// identical no matter how many times or how late a client reconnects.
		const messages = [
			{ role: "user", timestamp: 5000 },
			{ role: "assistant", timestamp: 5200 },
		];
		const session = makeMinimalSession({ isStreaming: true, messages });
		const runtime = { session } as unknown as AgentSessionRuntime;

		// Simulate two different clients (or the same client reattaching later)
		// both requesting the connection state at different wall-clock moments;
		// both must see the same anchor, derived purely from message data.
		const firstAttach = createAgentConnectionState(runtime, "active-1");
		const secondAttachMuchLater = createAgentConnectionState(runtime, "active-1");

		expect(firstAttach.activityStartedAt).toBe(5000);
		expect(secondAttachMuchLater.activityStartedAt).toBe(5000);
	});
});
