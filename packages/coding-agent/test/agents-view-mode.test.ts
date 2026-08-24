import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import {
	AgentsViewMode,
	type AgentsViewPersistentState,
	combineAgentsViewStartupNotices,
	createInitialAgentsViewPersistentState,
	runAgentsViewMode,
} from "../src/modes/agents-view/agents-view-mode.js";
import {
	type AgentsViewRow,
	getAgentsViewSummaryIdentity,
	resolveAgentsViewLeftResult,
} from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

const modeMocks = vi.hoisted(() => ({
	interactiveRun: vi.fn<() => Promise<never>>(),
	teardownSessionUi: vi.fn(async () => undefined),
	dispose: vi.fn(async () => undefined),
	connectionPrompt: vi.fn(async () => undefined),
	clientRequest: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.js")>();
	return { ...actual, appendRotatingLog: vi.fn() };
});

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: class {
		connect = vi.fn(async () => undefined);
		close = vi.fn();
		request = modeMocks.clientRequest;
	},
	getDaemonSocketCloseReason: vi.fn(),
}));

vi.mock("../src/modes/agent-connection/daemon-agent-connection.js", () => ({
	DaemonAgentConnection: Object.assign(function DaemonAgentConnection() {}, {
		attach: vi.fn(async () => ({ prompt: modeMocks.connectionPrompt, dispose: modeMocks.dispose })),
	}),
}));

vi.mock("../src/modes/interactive/interactive-mode.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/interactive/interactive-mode.js")>();
	return {
		...actual,
		InteractiveMode: class {
			run = modeMocks.interactiveRun;
			teardownSessionUi = modeMocks.teardownSessionUi;
		},
	};
});

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "scope-active",
		activeSessionId: "scope-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "scope-session",
		sessionFile: "/tmp/scope.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

const settingsManager = {
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
	getEditorPaddingX: () => 0,
	getAutocompleteMaxVisible: () => 5,
};

describe("AgentsViewMode", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));
	beforeEach(() => vi.clearAllMocks());

	it("keeps the selection chosen by row rebuilding when the query changes", () => {
		const self = {
			editor: { getText: () => "matching query" },
			persistentState: { query: "" },
			selectedIndex: 4,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		invoke("queryChanged", self);

		expect(self.persistentState.query).toBe("matching query");
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(self.selectedIndex).toBe(4);
	});

	it("re-resolves subagent state before choosing stop or delete intent", async () => {
		const child = summary({
			id: "passive-child-session",
			activeSessionId: undefined,
			sessionId: "passive-child-session",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const request = vi.fn(async (command: { type: string }) => ({
			success: true as const,
			data: command.type === "cancel_rlm_child" ? { cancelled: false } : { deleted: true },
		}));
		const client = { request, supportsServerCapability: vi.fn(() => true) };
		const self = {
			rows: [
				{
					kind: "subagent",
					section: "running",
					summary: child,
					selectable: true,
					identity: "child-row",
					parentIdentity: "root-row",
				},
				{
					kind: "agent",
					section: "idle",
					summary: summary({ id: "root-active", activeSessionId: "root-active", sessionId: "root-session" }),
					selectable: true,
					identity: "root-row",
				},
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			pendingKillSubagent: undefined,
			deleteConfirmExpiresAt: 0,
			deleteConfirmTimer: undefined,
			ui: { requestRender: vi.fn() },
			requireClient: () => client,
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			handleKillSubagentSelected(row: unknown) {
				return invoke("handleKillSubagentSelected", self, row);
			},
			findSubagentRootRow(row: unknown) {
				return invoke("findSubagentRootRow", self, row);
			},
			isDeleteConfirmationVisible() {
				return invoke("isDeleteConfirmationVisible", self);
			},
			showDeleteConfirmation() {
				return invoke("showDeleteConfirmation", self);
			},
			clearDeleteConfirmation(options: unknown) {
				return invoke("clearDeleteConfirmation", self, options);
			},
			killSubagent(pending: unknown, row: unknown) {
				return invoke("killSubagent", self, pending, row);
			},
		};

		await invoke("handleDeleteSelected", self);
		expect(request).not.toHaveBeenCalled();

		// The child finishes during confirmation. The second keypress must use the
		// current row state rather than the original running state.
		self.rows[0]!.section = "inactive";
		await invoke("handleDeleteSelected", self);
		expect(request).toHaveBeenCalledWith({
			type: "delete_rlm_subagent",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancel_rlm_child" }));
		expect(self.setStatusMessage).toHaveBeenCalledWith("Subagent deleted", { render: false });
	});

	it("uses cancel when an inactive subagent starts running during confirmation", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: true } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => true }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "passive-child" },
			{ section: "running" },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "delete_rlm_subagent" }));
	});

	it("falls back to cancel-only when subagent deletion is unsupported", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: false } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => false }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "passive-child" },
			{ section: "inactive" },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(self.setStatusMessage).toHaveBeenCalledWith("The daemon cannot delete subagents; it was left unchanged", {
			render: false,
			tone: "warning",
		});
	});

	it("checks telemetry policy before replying from an opted-out agents view", async () => {
		const client = { close: vi.fn() };
		const connectDedicatedClient = vi.fn(async () => client);
		const self = {
			options: {
				config: { telemetryDisabled: true },
				recoverDaemon: vi.fn(async () => undefined),
				reconnectTimeoutMs: 1234,
			},
			connectDedicatedClient,
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "followUp");

		expect(connectDedicatedClient).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(client, "active-1", {
			closeClientOnDispose: true,
			supportsExtensionUi: false,
			recoverDaemon: self.options.recoverDaemon,
			reconnectTimeoutMs: 1234,
			telemetryDisabled: true,
		});
		expect(modeMocks.connectionPrompt).toHaveBeenCalledWith("private prompt", {
			streamingBehavior: "followUp",
		});
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
	});

	it("keeps direct agents-view replies when telemetry is enabled", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: undefined }));
		const self = {
			options: { config: {} },
			requireClient: () => ({ request }),
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "steer");

		expect(request).toHaveBeenCalledWith({
			type: "prompt",
			activeSessionId: "active-1",
			message: "private prompt",
			streamingBehavior: "steer",
		});
		expect(DaemonAgentConnection.attach).not.toHaveBeenCalled();
	});

	it("uses the opened session as the crash-path back target", async () => {
		const opened = summary({ sessionName: "opened" });
		const previous = summary({ id: "previous", activeSessionId: "previous", sessionId: "previous" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockResolvedValueOnce({ type: "open", summary: opened })
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.backSession).toMatchObject({ sessionId: opened.sessionId });
				return Promise.resolve({ type: "exit" });
			});
		modeMocks.interactiveRun.mockRejectedValueOnce(new Error("post-attach crash"));

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp", telemetryDisabled: true } as never,
			initialSession: previous,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		expect(modeMocks.teardownSessionUi).toHaveBeenCalledWith({ preserveAltScreen: true });
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(
			expect.anything(),
			opened.activeSessionId,
			expect.objectContaining({ telemetryDisabled: true }),
		);
		runView.mockRestore();
	});

	it("invalidates the persisted scope root after popping a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [
					{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } },
					{ scope: { sessionId: child.sessionId, activeSessionId: child.activeSessionId } },
				];
				state.scopeRootSummary = child;
				return Promise.resolve({
					type: "scope_back",
					selection: child,
					expandedAncestorSessionIds: [],
					hasChildren: false,
				});
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(1);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});

		await runAgentsViewMode({
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

	it("invalidates the persisted scope root after pushing a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } }];
				state.scopeRootSummary = parent;
				return Promise.resolve({ type: "open", summary: child });
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(2);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});
		modeMocks.interactiveRun.mockResolvedValueOnce({
			type: "scoped_agents_view",
			source: {
				activeSessionId: child.activeSessionId,
				sessionFile: child.sessionFile,
				sessionId: child.sessionId,
				sessionName: child.sessionName,
				cwd: child.cwd,
			},
		} as never);

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

	it("does not discard scope while the saved-session refresh is in flight", async () => {
		let finishRefresh: ((value: { success: true; data: { sessions: unknown[] } }) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: { sessions: unknown[] } }>((resolve) => {
					finishRefresh = resolve;
				}),
		);
		const scopeSummary = summary();
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: scopeSummary.sessionId, activeSessionId: scopeSummary.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			options: { config: { cwd: "/tmp" } },
			persistentState,
			savedCatalogGeneration: 0,
			savedCatalogReady: true,
			savedCatalogRefreshPending: false,
			lastSuccessfulSavedSessions: [],
			savedSessions: [],
			requireClient: () => ({ request }),
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp" }),
			reconcileCatalogs: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
		};

		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
		expect(self.savedCatalogReady).toBe(false);

		Object.assign(self, {
			lastListedSummaries: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			liveCatalogReady: true,
			liveCatalogRefreshPending: false,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			manualOrder: {},
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		});
		self.reconcileCatalogs = () => invoke("reconcileCatalogs", self);
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeFrames).toHaveLength(1);

		const saved: AgentConnectionSavedSessionInfo = {
			path: "/tmp/scope.jsonl",
			id: "scope-session",
			cwd: "/tmp",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-01T00:00:00Z"),
			messageCount: 1,
			firstMessage: "scope",
			allMessagesText: "scope",
		};
		finishRefresh?.({
			success: true,
			data: {
				sessions: [
					{
						...saved,
						created: saved.created.toISOString(),
						modified: saved.modified.toISOString(),
					},
				],
			},
		});
		await expect(refresh).resolves.toBe(true);
		expect(persistentState.scopeFrames).toHaveLength(1);
	});

	it("retains unresolved manual pins until both full catalogs are complete", () => {
		const buildSelf = (liveCatalogComplete: boolean, savedCatalogComplete: boolean) => {
			const manualOrder = { idle: ["active:not-yet-streamed"] };
			const persistentState: AgentsViewPersistentState = { manualOrder };
			const self: Record<string, unknown> = {
				persistentState,
				lastListedSummaries: [],
				savedSessions: [],
				heartbeats: [],
				inactiveAgentIdentities: new Set(),
				pendingDeleteAgent: undefined,
				// Ready can be set after a terminal fetch failure. It must not make
				// an incomplete roster eligible for destructive pruning.
				liveCatalogReady: true,
				savedCatalogReady: true,
				liveCatalogComplete,
				savedCatalogComplete,
				expandedSubagentParents: new Set(),
				programShownParents: new Set(),
				manualOrder,
				editor: { getText: () => "" },
				getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
				applyPendingAncestorExpansion: vi.fn(),
				restoreSelection: vi.fn(),
				ui: { requestRender: vi.fn() },
				setStatusMessage: vi.fn(),
				withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			};
			return { self, persistentState };
		};

		for (const [liveCatalogComplete, savedCatalogComplete] of [
			[false, true],
			[true, false],
		] as const) {
			const { self, persistentState } = buildSelf(liveCatalogComplete, savedCatalogComplete);
			invoke("reconcileCatalogs", self);
			expect(self.manualOrder).toEqual({ idle: ["active:not-yet-streamed"] });
			expect(persistentState.manualOrder).toBe(self.manualOrder);
		}

		const { self } = buildSelf(true, true);
		invoke("reconcileCatalogs", self);
		expect(self.manualOrder).toEqual({});
	});

	it("wires manualOrder through the real reconcileCatalogs production path into emitted rows", () => {
		// Closes the review gap left by unit tests that call buildAgentsViewRows()
		// directly: this invokes the real reconcileCatalogs (no stub), the same
		// method refreshSessions/refreshSavedSessions call in production, and
		// asserts the manual pin actually reorders this.rows.
		const older = summary({
			id: "older",
			activeSessionId: "older",
			sessionId: "older-session",
			sessionFile: "/tmp/older.jsonl",
			lastActivityAt: "2026-01-01T00:00:00Z",
		});
		const newer = summary({
			id: "newer",
			activeSessionId: "newer",
			sessionId: "newer-session",
			sessionFile: "/tmp/newer.jsonl",
			lastActivityAt: "2026-01-02T00:00:00Z",
		});
		const manualOrder = { idle: [getAgentsViewSummaryIdentity(older), getAgentsViewSummaryIdentity(newer)] };
		const persistentState: AgentsViewPersistentState = { manualOrder };
		const self: Record<string, unknown> = {
			persistentState,
			lastListedSummaries: [newer, older],
			savedSessions: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			liveCatalogReady: true,
			savedCatalogReady: true,
			liveCatalogComplete: true,
			savedCatalogComplete: true,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			manualOrder,
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		};

		invoke("reconcileCatalogs", self);

		// Without the manual pin, heuristic ordering would surface `newer` first
		// (more recent activity). The pin must win through the real production path.
		const rows = Reflect.get(self, "rows") as AgentsViewRow[];
		expect(rows.map((row) => row.summary.sessionId)).toEqual(["older-session", "newer-session"]);
	});

	it("stamps the decoded-daemon-frame time on a successful roster apply (trust capsule source)", () => {
		const self: Record<string, unknown> = {
			persistentState: {},
			lastListedSummaries: [],
			lastDecodedDaemonFrameAt: undefined,
			savedSessions: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			manualOrder: {},
			editor: { getText: () => "" },
			getFilteredRecords: () => [],
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			reconcileCatalogs: vi.fn(),
		};
		const before = Date.now();
		invoke("applySessionList", self, [], true);
		const stamped = Reflect.get(self, "lastDecodedDaemonFrameAt") as number;
		expect(stamped).toBeGreaterThanOrEqual(before);
		expect(stamped).toBeLessThanOrEqual(Date.now());

		// An unsuccessful apply must not stamp (a failed refresh is not fresh).
		Reflect.set(self, "lastDecodedDaemonFrameAt", undefined);
		invoke("applySessionList", self, [], false);
		expect(Reflect.get(self, "lastDecodedDaemonFrameAt")).toBeUndefined();
	});

	it("carries the resolved scope root across view remounts", () => {
		const root = summary({ sessionName: "Scoped root" });
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			persistentState,
			lastListedSummaries: [root],
			savedSessions: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			liveCatalogReady: true,
			savedCatalogReady: true,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			manualOrder: {},
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		};
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeRootSummary).toMatchObject({ sessionId: root.sessionId });

		const remount = new AgentsViewMode(
			{
				config: { cwd: "/tmp" } as never,
				uiServices: {
					settingsManager: settingsManager as never,
					modelRegistry: {} as never,
					getInitialCwd: () => "/tmp",
					getInitialSessionName: () => undefined,
					getThemes: () => [],
				},
			},
			persistentState,
		) as AgentsViewMode & Record<string, unknown>;
		const remountedRoot = Reflect.get(remount, "scopeRootSummary") as SessionSummary;
		expect(remountedRoot).toMatchObject({ sessionName: "Scoped root" });
		expect(resolveAgentsViewLeftResult(remountedRoot)).toMatchObject({
			type: "scope_back",
			selection: { sessionId: root.sessionId },
		});
	});

	it("restores expanded subagent lists across view remounts", () => {
		const persistentState: AgentsViewPersistentState = {};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		try {
			(Reflect.get(view, "expandedSubagentParents") as Set<string>).add("file:/tmp/root.jsonl");
			(Reflect.get(view, "programShownParents") as Set<string>).add("file:/tmp/root.jsonl");

			const remount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect((Reflect.get(remount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(
				true,
			);
			expect((Reflect.get(remount, "programShownParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(true);

			// A collapsed-back list persists that way too.
			(Reflect.get(remount, "expandedSubagentParents") as Set<string>).delete("file:/tmp/root.jsonl");
			const collapsedRemount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect(
				(Reflect.get(collapsedRemount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl"),
			).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps subagent expansion across the active-to-persisted identity flip", () => {
		const rowsOf = (self: Record<string, unknown>) => Reflect.get(self, "rows") as AgentsViewRow[];
		const buildView = (expand: boolean) => {
			const parent = summary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionFile: undefined,
				runtimeKind: "top-level",
			});
			const child = summary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionFile: undefined,
				runtimeKind: "subagent",
				parentSessionId: "root-session",
				parentActiveSessionId: "root-active",
			});
			const expandedSubagentParents = new Set<string>();
			const self: Record<string, unknown> = {
				persistentState: {},
				lastListedSummaries: [parent, child],
				savedSessions: [],
				heartbeats: [],
				inactiveAgentIdentities: new Set(),
				pendingDeleteAgent: undefined,
				liveCatalogReady: true,
				savedCatalogReady: true,
				expandedSubagentParents,
				programShownParents: new Set(),
				manualOrder: {},
				editor: { getText: () => "" },
				getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
				applyPendingAncestorExpansion: vi.fn(),
				restoreSelection: vi.fn(),
				ui: { requestRender: vi.fn() },
				setStatusMessage: vi.fn(),
				withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			};
			invoke("reconcileCatalogs", self);
			if (expand) {
				const parentRow = rowsOf(self).find(
					(row) => row.kind === "agent" && row.summary.sessionId === "root-session",
				);
				expect(parentRow?.identity).toBe("session:root-session");
				expandedSubagentParents.add(parentRow!.identity);
				invoke("reconcileCatalogs", self);
				expect(rowsOf(self).some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(true);
			}
			// The runtime flushes the session file; the record identity flips to file:.
			self.lastListedSummaries = [{ ...parent, sessionFile: "/tmp/root.jsonl" }, child];
			invoke("reconcileCatalogs", self);
			return { self, expandedSubagentParents };
		};

		const expandedView = buildView(true);
		const expandedRows = rowsOf(expandedView.self);
		expect(
			expandedRows.find((row) => row.kind === "agent" && row.summary.sessionId === "root-session")?.identity,
		).toBe("file:/tmp/root.jsonl");
		expect(expandedRows.some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(true);
		expect(expandedRows.some((row) => row.kind === "subagent" && row.summary.sessionId === "child-session")).toBe(
			true,
		);
		expect([...expandedView.expandedSubagentParents]).toEqual(["file:/tmp/root.jsonl"]);

		const collapsedView = buildView(false);
		const collapsedRows = rowsOf(collapsedView.self);
		expect(collapsedRows.some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(false);
		expect(collapsedRows.some((row) => row.kind === "subagent")).toBe(false);
		expect(collapsedView.expandedSubagentParents.size).toBe(0);
	});

	it("toggles subagent list expansion from the summary row", () => {
		const expandedSubagentParents = new Set(["root-row"]);
		const programShownParents = new Set(["root-row"]);
		const persistentState: AgentsViewPersistentState = {
			expandedSubagentParents,
			programShownParents,
		};
		const self: Record<string, unknown> = {
			persistentState,
			expandedSubagentParents,
			programShownParents,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const summaryRow = { kind: "subagent-summary", parentIdentity: "root-row", expanded: true };

		invoke("toggleSubagentList", self, summaryRow);
		expect(expandedSubagentParents.size).toBe(0);
		// Collapsing the list hides its revealed program too.
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(1);

		invoke("toggleSubagentList", self, { ...summaryRow, expanded: false });
		expect(expandedSubagentParents).toEqual(new Set(["root-row"]));
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(2);
	});
});

describe("AgentsViewMode manual reorder", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));

	function agentRow(overrides: Partial<AgentsViewRow> & { identity: string }): AgentsViewRow {
		return {
			kind: "agent",
			section: "idle",
			summary: summary({
				id: overrides.identity,
				activeSessionId: overrides.identity,
				sessionId: overrides.identity,
			}),
			title: overrides.identity,
			subtitle: "",
			statusLabel: "",
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			...overrides,
		};
	}

	function subagentRow(identity: string, parentIdentity: string, section: AgentsViewRow["section"]): AgentsViewRow {
		return {
			kind: "subagent",
			section,
			summary: summary({ id: identity, activeSessionId: identity, sessionId: identity, runtimeKind: "subagent" }),
			title: identity,
			subtitle: "",
			statusLabel: "",
			depth: 1,
			selectable: true,
			runningSubagentCount: 0,
			identity,
			parentIdentity,
		};
	}

	function moveHarness(rows: AgentsViewRow[], selectedIndex: number, manualOrder: Record<string, string[]> = {}) {
		const self: Record<string, unknown> = {
			rows,
			selectedIndex,
			manualOrder,
			persistentState: {},
			rebuildRows: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		return self;
	}

	it("does not reorder or reset within a scoped frame", () => {
		const rows = [agentRow({ identity: "a" }), agentRow({ identity: "b" })];
		const self: Record<string, unknown> = {
			...moveHarness(rows, 1, { idle: ["a", "b"] }),
			scopeKey: { sessionId: "scope-root", activeSessionId: "scope-root" },
		};

		invoke("moveSelectedAgent", self, "earlier");
		invoke("resetSelectedAgentSectionOrder", self);

		expect(self.manualOrder).toEqual({ idle: ["a", "b"] });
		expect(self.rebuildRows).not.toHaveBeenCalled();
	});

	it("moves the selected agent earlier and swaps identities in manualOrder, seeded from current display order", () => {
		const rows = [agentRow({ identity: "a" }), agentRow({ identity: "b" }), agentRow({ identity: "c" })];
		const self = moveHarness(rows, 1); // select "b"

		invoke("moveSelectedAgent", self, "earlier");

		expect(self.manualOrder).toEqual({ idle: ["b", "a", "c"] });
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect((self.persistentState as { manualOrder?: unknown }).manualOrder).toBe(self.manualOrder);
	});

	it("moves the selected agent later and swaps identities in manualOrder", () => {
		const rows = [agentRow({ identity: "a" }), agentRow({ identity: "b" }), agentRow({ identity: "c" })];
		const self = moveHarness(rows, 1); // select "b"

		invoke("moveSelectedAgent", self, "later");

		expect(self.manualOrder).toEqual({ idle: ["a", "c", "b"] });
	});

	it("is a no-op at the top of the section (shift/alt+up on the first row)", () => {
		const rows = [agentRow({ identity: "a" }), agentRow({ identity: "b" })];
		const self = moveHarness(rows, 0); // select "a", already first

		invoke("moveSelectedAgent", self, "earlier");

		expect(self.manualOrder).toEqual({});
		expect(self.rebuildRows).not.toHaveBeenCalled();
	});

	it("is a no-op at the bottom of the section (alt+down on the last row)", () => {
		const rows = [agentRow({ identity: "a" }), agentRow({ identity: "b" })];
		const self = moveHarness(rows, 1); // select "b", already last

		invoke("moveSelectedAgent", self, "later");

		expect(self.manualOrder).toEqual({});
		expect(self.rebuildRows).not.toHaveBeenCalled();
	});

	it("skips nested subagent rows and lands the swap on the next top-level agent row", () => {
		// a (agent) / a's subagent (nested) / b (agent): moving b earlier must
		// swap with a, not with a's nested subagent row.
		const rows = [agentRow({ identity: "a" }), subagentRow("a-child", "a", "idle"), agentRow({ identity: "b" })];
		const self = moveHarness(rows, 2); // select "b"

		invoke("moveSelectedAgent", self, "earlier");

		expect(self.manualOrder).toEqual({ idle: ["b", "a"] });
	});

	it("only reorders within the selected row's own section", () => {
		const rows = [
			agentRow({ identity: "running-a", section: "running" }),
			agentRow({ identity: "idle-a", section: "idle" }),
			agentRow({ identity: "idle-b", section: "idle" }),
		];
		const self = moveHarness(rows, 2); // select idle-b

		invoke("moveSelectedAgent", self, "earlier");

		expect(self.manualOrder).toEqual({ idle: ["idle-b", "idle-a"] });
	});

	it("does not move a subagent row or a nested-summary row (top-level agent rows only)", () => {
		const rows = [agentRow({ identity: "a" }), subagentRow("a-child", "a", "idle")];
		const self = moveHarness(rows, 1); // select the subagent row

		invoke("moveSelectedAgent", self, "earlier");

		expect(self.manualOrder).toEqual({});
		expect(self.rebuildRows).not.toHaveBeenCalled();
	});

	it("TOCTOU: no-ops when the selected row disappeared from `rows` before the keypress applied", () => {
		// Simulates a refreshSessions() landing between the keypress being queued
		// and moveSelectedAgent running: selectedIndex points past the end of a
		// now-shorter rows array.
		const rows = [agentRow({ identity: "a" })];
		const self = moveHarness(rows, 5);

		invoke("moveSelectedAgent", self, "earlier");

		expect(self.manualOrder).toEqual({});
		expect(self.rebuildRows).not.toHaveBeenCalled();
	});

	it("resets manual order for only the selected row's section", () => {
		const rows = [agentRow({ identity: "a", section: "idle" }), agentRow({ identity: "b", section: "running" })];
		const self = moveHarness(rows, 0, { idle: ["active:z"], running: ["active:y"] });

		invoke("resetSelectedAgentSectionOrder", self);

		expect(self.manualOrder).toEqual({ running: ["active:y"] });
		expect(self.rebuildRows).toHaveBeenCalledOnce();
	});

	it("reset is a no-op when the selected section has no manual order", () => {
		const rows = [agentRow({ identity: "a", section: "idle" })];
		const self = moveHarness(rows, 0, { running: ["active:y"] });

		invoke("resetSelectedAgentSectionOrder", self);

		expect(self.manualOrder).toEqual({ running: ["active:y"] });
		expect(self.rebuildRows).not.toHaveBeenCalled();
	});

	it("dispatches the real default terminal sequences for move earlier, move later, and reset", () => {
		const moveSelectedAgent = vi.fn();
		const resetSelectedAgentSectionOrder = vi.fn();
		const self: Record<string, unknown> = {
			clearStickyStatusMessage: vi.fn(),
			renameTarget: undefined,
			replyTarget: undefined,
			scopeKey: undefined,
			editor: { getText: () => "" },
			keybindings: new KeybindingsManager(),
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			moveSelectedAgent,
			resetSelectedAgentSectionOrder,
		};

		invoke("handleInput", self, "\x1b[1;3A"); // xterm alt+up
		invoke("handleInput", self, "\x1b[1;3B"); // xterm alt+down
		invoke("handleInput", self, "\x1br"); // legacy terminal alt+r

		expect(moveSelectedAgent).toHaveBeenNthCalledWith(1, "earlier");
		expect(moveSelectedAgent).toHaveBeenNthCalledWith(2, "later");
		expect(resetSelectedAgentSectionOrder).toHaveBeenCalledOnce();
	});

	it("does not dispatch reorder actions from a scoped frame", () => {
		const moveSelectedAgent = vi.fn();
		const resetSelectedAgentSectionOrder = vi.fn();
		const self: Record<string, unknown> = {
			clearStickyStatusMessage: vi.fn(),
			renameTarget: undefined,
			replyTarget: undefined,
			scopeKey: { sessionId: "scope-root", activeSessionId: "scope-root" },
			editor: { getText: () => "", handleInput: vi.fn() },
			keybindings: new KeybindingsManager(),
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			moveSelectedAgent,
			resetSelectedAgentSectionOrder,
			handleListNavigation: vi.fn(() => true),
		};

		invoke("handleInput", self, "\x1b[1;3A");
		invoke("handleInput", self, "\x1br");

		expect(moveSelectedAgent).not.toHaveBeenCalled();
		expect(resetSelectedAgentSectionOrder).not.toHaveBeenCalled();
	});

	it("handleInput does not dispatch reorder while the search box has text (filter active)", () => {
		const moveSelectedAgent = vi.fn();
		const self: Record<string, unknown> = {
			clearStickyStatusMessage: vi.fn(),
			renameTarget: undefined,
			replyTarget: undefined,
			editor: { getText: () => "filtering", handleInput: vi.fn() },
			keybindings: {
				matches: (_d: string, action: string) => action === "app.agents.moveEarlier",
			},
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			moveSelectedAgent,
			handleListNavigation: vi.fn(() => false),
			queryChanged: vi.fn(),
		};

		invoke("handleInput", self, "\x1b[1;3A");
		expect(moveSelectedAgent).not.toHaveBeenCalled();
	});

	it("handleInput does not dispatch reorder while a reply composer is armed", () => {
		const moveSelectedAgent = vi.fn();
		const self: Record<string, unknown> = {
			clearStickyStatusMessage: vi.fn(),
			renameTarget: undefined,
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			editor: { getText: () => "", handleInput: vi.fn() },
			keybindings: {
				matches: (_d: string, action: string) => action === "app.agents.moveEarlier",
			},
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			moveSelectedAgent,
			handleListNavigation: vi.fn(() => false),
			queryChanged: vi.fn(),
		};

		invoke("handleInput", self, "\x1b[1;3A");
		expect(moveSelectedAgent).not.toHaveBeenCalled();
	});

	it("renderHints shows the reorder hint only for a top-level agent row with an empty search box", () => {
		const buildSelf = (row: AgentsViewRow | undefined, queryText: string) => ({
			isCtrlCExitHintVisible: () => false,
			statusMessage: undefined,
			renameTarget: undefined,
			replyTarget: undefined,
			rows: row ? [row] : [],
			selectedIndex: 0,
			editor: { getText: () => queryText },
			selectedRowCanShowProgram: () => false,
		});

		const agentHints = invoke("renderHints", buildSelf(agentRow({ identity: "a" }), ""), 200) as string;
		expect(agentHints).toContain("reorder");

		const filteredHints = invoke("renderHints", buildSelf(agentRow({ identity: "a" }), "query"), 200) as string;
		expect(filteredHints).not.toContain("reorder");

		const subagentHints = invoke("renderHints", buildSelf(subagentRow("a-child", "a", "idle"), ""), 200) as string;
		expect(subagentHints).not.toContain("reorder");

		const scopedHints = invoke(
			"renderHints",
			{ ...buildSelf(agentRow({ identity: "a" }), ""), scopeKey: { sessionId: "scope-root" } },
			200,
		) as string;
		expect(scopedHints).not.toContain("reorder");
	});
});

function createUiServices(): InteractiveModeUiServices {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentsViewMode persistent catalog state", () => {
	it("keeps an initial handoff scope when the first live poll fails after both catalogs settle", async () => {
		const root = summary();
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		const persistentState = createInitialAgentsViewPersistentState({
			initialScopeKey: scope,
			initialSession: root,
		});
		persistentState.lastSuccessfulSavedSessions = [];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(Reflect.get(view, "liveCatalogReady")).toBe(true);
			// A failed payload is settled enough for scope fallback, but it never
			// supplied the complete roster required for destructive pin pruning.
			expect(Reflect.get(view, "liveCatalogComplete")).toBe(false);
			expect(Reflect.get(view, "savedCatalogReady")).toBe(true);
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: root }]);
			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([root]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("never marks the live catalog complete when the daemon returns a malformed session list", async () => {
		// Distinct from the reject-path test above: client.request resolves
		// successfully here, so the throw comes from response validation itself,
		// which must run before liveCatalogComplete is set true, not after.
		const persistentState = createInitialAgentsViewPersistentState({});
		persistentState.lastSuccessfulSavedSessions = [];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => ({ success: true, data: { sessions: "not-an-array" } })),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(Reflect.get(view, "liveCatalogReady")).toBe(true);
			expect(Reflect.get(view, "liveCatalogComplete")).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("resets liveCatalogComplete if applySessionList itself throws after validation succeeds", async () => {
		// Complements the malformed-payload test above: this proves the catch-path
		// reset (R1), not just validation-before-flag-set. A valid payload passes
		// expectSessionList, so liveCatalogComplete is set true, then
		// applySessionList itself throws -- the catch must still reset the flag.
		const persistentState = createInitialAgentsViewPersistentState({});
		persistentState.lastSuccessfulSavedSessions = [];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => ({ success: true, data: { sessions: [] } })),
		});
		Reflect.set(view, "applySessionList", () => {
			throw new Error("simulated post-validation failure");
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(Reflect.get(view, "liveCatalogReady")).toBe(true);
			expect(Reflect.get(view, "liveCatalogComplete")).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope after a fresh instance's first live poll fails", async () => {
		const root = summary({
			id: "root-active",
			activeSessionId: "root-active",
			isSessionActive: true,
			runtimeKind: "top-level",
			sessionId: "root-session",
			cwd: process.cwd(),
		});
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(persistentState.scopeFrames).toEqual([
				{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } },
			]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope through reconnect timeout and settles it on the next successful list", async () => {
		vi.useFakeTimers();
		const root = summary();
		const frame = { scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } };
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [frame],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode(
			{ config: {}, uiServices: createUiServices(), reconnectTimeoutMs: 0 },
			persistentState,
		);
		const client = { isConnected: false, reconnect: vi.fn() };
		Reflect.set(view, "client", client);
		Reflect.set(view, "liveCatalogReady", true);
		Reflect.set(view, "savedCatalogReady", true);

		try {
			await expect(invoke("reconnectClient", view, client, new Error("disconnected"))).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([frame]);
			expect(Reflect.get(view, "lastListedSummaries")).toEqual([root]);

			Reflect.set(view, "client", {
				isConnected: true,
				request: vi.fn(async () => ({ success: true, data: { sessions: [] } })),
			});
			await expect(invoke("refreshSessions", view)).resolves.toBe(true);
			expect(persistentState.scopeFrames).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a newly pushed scope and the existing live cache when its first poll fails", async () => {
		const root = summary();
		const other = summary({ id: "other-active", activeSessionId: "other-active", sessionId: "other-session" });
		const returnedRoot = { ...root, sessionName: "Updated root" };
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			const persistentState = Reflect.get(this, "persistentState") as AgentsViewPersistentState;
			if (runs === 1) {
				persistentState.lastSuccessfulLiveSummaries = [other];
				persistentState.lastSuccessfulSavedSessions = [];
				return { type: "open", summary: root, hasChildren: false };
			}

			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([other, returnedRoot]);
			Reflect.set(this, "client", {
				isConnected: true,
				request: vi.fn(async () => {
					throw new Error("transient list failure");
				}),
			});
			await expect(invoke("refreshSessions", this, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: returnedRoot }]);
			return { type: "exit" };
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "scoped_agents_view",
			source: {
				activeSessionId: root.activeSessionId!,
				sessionId: root.sessionId,
				sessionName: returnedRoot.sessionName,
				cwd: root.cwd,
			},
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});
});

describe("agents view startup notices", () => {
	it("combines the open fallback and cwd fallback without dropping either notice", () => {
		expect(combineAgentsViewStartupNotices("Child unavailable", "Original directory is missing")).toBe(
			"Child unavailable · Original directory is missing",
		);
		expect(combineAgentsViewStartupNotices("Child unavailable", undefined)).toBe("Child unavailable");
		expect(combineAgentsViewStartupNotices(undefined, "Original directory is missing")).toBe(
			"Original directory is missing",
		);
	});

	it("persists the combined open and cwd fallback notices after returning to agents view", async () => {
		const root = summary({
			activeSessionId: undefined,
			cwd: "/definitely/not/a/real/dir/for/this/test",
			lifecycle: "archived",
			sessionFile: "/tmp/root.jsonl",
		});
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			if (runs === 1) {
				return {
					type: "open",
					summary: root,
					hasChildren: false,
					statusMessage: "Child unavailable",
				};
			}
			expect(Reflect.get(this, "persistentState")).toMatchObject({
				statusMessage: `Child unavailable · Original directory is missing (${root.cwd}); opened in ${process.cwd()} instead.`,
			});
			return { type: "exit" };
		});
		modeMocks.clientRequest.mockResolvedValue({
			type: "response",
			command: "create",
			success: true,
			data: { ...root, cwd: process.cwd(), activeSessionId: "resumed-active", lifecycle: "live" },
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "agents_view",
			source: {
				activeSessionId: "resumed-active",
				sessionId: root.sessionId,
				cwd: process.cwd(),
			},
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});

	it("promotes a confirmed saved-session delete to the stop flow when the session is actually live", async () => {
		// A saved/inactive row (no activeSessionId) whose session file the daemon
		// now reports as a live session -- e.g. an empty draft stuck on
		// activity:"working". The confirmed delete must promote to the live
		// stop-then-delete flow instead of refusing with
		// "Session became active; stop it before deleting".
		const saved = summary({
			id: "draft-saved",
			activeSessionId: undefined,
			sessionId: "draft-session",
			sessionFile: "/tmp/draft.jsonl",
			messageCount: 0,
		});
		const live = summary({
			id: "draft-active",
			activeSessionId: "draft-active",
			sessionId: "draft-session",
			sessionFile: "/tmp/draft.jsonl",
			activity: "working",
			messageCount: 0,
		});
		const request = vi.fn(async (_command: { type: string }) => ({
			success: true as const,
			data: { sessions: [live] },
		}));
		const client = { request, supportsServerCapability: vi.fn(() => true) };
		const calls: string[] = [];
		const self = {
			rows: [
				{
					kind: "agent",
					section: "inactive",
					summary: saved,
					selectable: true,
					identity: "draft-row",
				},
			],
			selectedIndex: 0,
			lastListedSummaries: [],
			pendingDeleteAgent: undefined,
			pendingKillSubagent: undefined,
			deleteConfirmExpiresAt: 0,
			deleteConfirmTimer: undefined,
			selectedActiveSessionId: undefined,
			inactiveAgentIdentities: new Set<string>(),
			ui: { requestRender: vi.fn() },
			requireClient: () => client,
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			refreshSavedSessions: vi.fn(async () => true),
			getSavedSessionCatalogContext: () => ({ sessionDir: "/tmp", cwd: "/tmp" }),
			isDeleteConfirmationVisible() {
				return invoke("isDeleteConfirmationVisible", self);
			},
			showDeleteConfirmation() {
				calls.push("showDeleteConfirmation");
				return invoke("showDeleteConfirmation", self);
			},
			clearDeleteConfirmation(options: unknown) {
				return invoke("clearDeleteConfirmation", self, options);
			},
			stopAgentForDeletion(row: unknown) {
				calls.push("stopAgentForDeletion");
				return invoke("stopAgentForDeletion", self, row);
			},
			deactivatePendingAgent() {
				calls.push("deactivatePendingAgent");
				return invoke("deactivatePendingAgent", self);
			},
		};

		// Press 1: saved row -> confirmation.
		await invoke("handleDeleteSelected", self);
		expect(self.pendingDeleteAgent).toMatchObject({ sessionFile: "/tmp/draft.jsonl", stopped: false });
		expect(calls).toContain("showDeleteConfirmation");

		// Press 2 (confirm): daemon now reports the file as live -> promote.
		await invoke("handleDeleteSelected", self);
		expect(calls).toContain("stopAgentForDeletion");
		expect(calls).not.toContain("deactivatePendingAgent");
		// The pending delete now carries the live identity (file-based, same as the
		// saved row), activeSessionId, and the stopped flag stopAgentForDeletion
		// actually produced -- pinning what the promotion stored, not what a later
		// hand-stitched press-3 state assumes.
		expect(self.pendingDeleteAgent).toMatchObject({
			sessionFile: "/tmp/draft.jsonl",
			activeSessionId: "draft-active",
		});
		expect((self as Record<string, unknown>).pendingDeleteAgent).toMatchObject({
			identity: getAgentsViewSummaryIdentity(live),
			stopped: true,
		});
		// The stale refusal message must never appear.
		expect(self.setStatusMessage).not.toHaveBeenCalledWith("Session became active; stop it before deleting", {
			tone: "warning",
		});

		// Press 3 with the row now rebuilt from the live catalog (the daemon's own
		// list is authoritative; reconcileCatalogs swaps the saved row for the live
		// summary, which carries activeSessionId): the live-session path completes
		// the delete instead of re-entering the saved-row branch.
		self.rows = [
			{
				kind: "agent",
				section: "running",
				summary: live,
				selectable: true,
				identity: "draft-row",
			},
		];
		(self as Record<string, unknown>).pendingDeleteAgent = {
			identity: getAgentsViewSummaryIdentity(live),
			activeSessionId: "draft-active",
			sessionFile: live.sessionFile,
			summary: live,
			stopped: false,
		};
		self.deleteConfirmExpiresAt = Date.now() + 60_000;
		await invoke("handleDeleteSelected", self);
		expect(calls).toContain("deactivatePendingAgent");
		expect(self.pendingDeleteAgent).toBeUndefined();
	});
});
