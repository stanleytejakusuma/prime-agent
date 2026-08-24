import type { KeyId } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type Descriptor = { shortcut: KeyId; description?: string; extensionPath: string };
type DaemonExtensionShortcutsThis = {
	defaultEditor: { onExtensionShortcut?: (data: string) => boolean };
	daemonExtensionShortcuts: Map<KeyId, Descriptor>;
	daemonExtensionShortcutGeneration: number;
	agentConnection: {
		runExtensionShortcut: (key: string, extensionPath: string) => Promise<void>;
		getExtensionShortcuts: () => Promise<Array<{ key: string; description?: string; extensionPath: string }>>;
		subscribe?: (listener: (event: { type: string; status?: string }) => Promise<void>) => () => void;
	};
	keybindings: { getEffectiveConfig: () => Record<string, KeyId | KeyId[] | undefined> };
	showError: (message: string) => void;
	showStatus?: (text: string, kind?: string) => void;
	refreshHeartbeatCatalog?: () => Promise<void>;
	unsubscribe?: () => void;
	clearDaemonExtensionShortcuts: () => void;
	refreshDaemonExtensionShortcuts: () => Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	setupDaemonExtensionShortcuts(this: DaemonExtensionShortcutsThis): void;
	clearDaemonExtensionShortcuts(this: DaemonExtensionShortcutsThis): void;
	refreshDaemonExtensionShortcuts(this: DaemonExtensionShortcutsThis): Promise<void>;
	getHotkeysGuide(this: DaemonExtensionShortcutsThis): string;
	subscribeToAgent(this: DaemonExtensionShortcutsThis): void;
};

function makeContext(overrides: Partial<DaemonExtensionShortcutsThis> = {}): DaemonExtensionShortcutsThis {
	const context = {
		defaultEditor: {},
		daemonExtensionShortcuts: new Map(),
		daemonExtensionShortcutGeneration: 0,
		agentConnection: {
			runExtensionShortcut: vi.fn(async () => {}),
			getExtensionShortcuts: vi.fn(async () => []),
		},
		keybindings: { getEffectiveConfig: () => ({}) },
		showError: vi.fn(),
		clearDaemonExtensionShortcuts: () => {},
		refreshDaemonExtensionShortcuts: async () => {},
		...overrides,
	} as DaemonExtensionShortcutsThis;
	context.clearDaemonExtensionShortcuts = () => interactiveModePrototype.clearDaemonExtensionShortcuts.call(context);
	context.refreshDaemonExtensionShortcuts = () =>
		interactiveModePrototype.refreshDaemonExtensionShortcuts.call(context);
	return context;
}

describe("InteractiveMode daemon extension shortcuts", () => {
	test("a matching descriptor returns literal true synchronously and sends its key plus extension identity", () => {
		let resolveRun: (() => void) | undefined;
		const context = makeContext({
			daemonExtensionShortcuts: new Map([
				["ctrl+e" as KeyId, { shortcut: "ctrl+e" as KeyId, extensionPath: "/tmp/effort.ts" }],
			]),
			agentConnection: {
				runExtensionShortcut: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							resolveRun = resolve;
						}),
				),
				getExtensionShortcuts: vi.fn(async () => []),
			},
		});
		interactiveModePrototype.setupDaemonExtensionShortcuts.call(context);

		const result = context.defaultEditor.onExtensionShortcut?.("\x05");

		expect(result).toBe(true);
		expect(result).not.toBeInstanceOf(Promise);
		expect(context.agentConnection.runExtensionShortcut).toHaveBeenCalledWith("ctrl+e", "/tmp/effort.ts");
		resolveRun?.();
	});

	test("an unmatched or empty registry returns false synchronously", () => {
		const context = makeContext();
		interactiveModePrototype.setupDaemonExtensionShortcuts.call(context);

		expect(context.defaultEditor.onExtensionShortcut?.("\x05")).toBe(false);
		expect(context.agentConnection.runExtensionShortcut).not.toHaveBeenCalled();
	});

	test("a rejected fire-and-forget request surfaces through showError", async () => {
		const context = makeContext({
			daemonExtensionShortcuts: new Map([
				["ctrl+e" as KeyId, { shortcut: "ctrl+e" as KeyId, extensionPath: "/tmp/effort.ts" }],
			]),
			agentConnection: {
				runExtensionShortcut: vi.fn(async () => {
					throw new Error("daemon lookup failed");
				}),
				getExtensionShortcuts: vi.fn(async () => []),
			},
		});
		interactiveModePrototype.setupDaemonExtensionShortcuts.call(context);

		expect(context.defaultEditor.onExtensionShortcut?.("\x05")).toBe(true);
		await vi.waitFor(() => {
			expect(context.showError).toHaveBeenCalledWith("Shortcut handler error: daemon lookup failed");
		});
	});

	test("refresh applies client-local reserved built-in conflict resolution before input and shortcut guide use", async () => {
		const context = makeContext({
			agentConnection: {
				runExtensionShortcut: vi.fn(async () => {}),
				getExtensionShortcuts: vi.fn(async () => [
					{ key: "ctrl+c", description: "Must not consume clear", extensionPath: "/tmp/bad.ts" },
					{ key: "ctrl+e", description: "Safe", extensionPath: "/tmp/good.ts" },
				]),
			},
			keybindings: {
				getEffectiveConfig: () => ({ "app.clear": "ctrl+c" as KeyId, "app.shortcuts": "?" as KeyId }),
			},
		});

		await interactiveModePrototype.refreshDaemonExtensionShortcuts.call(context);
		interactiveModePrototype.setupDaemonExtensionShortcuts.call(context);

		expect(context.daemonExtensionShortcuts.has("ctrl+c" as KeyId)).toBe(false);
		expect(context.daemonExtensionShortcuts.get("ctrl+e" as KeyId)?.extensionPath).toBe("/tmp/good.ts");
		expect(context.defaultEditor.onExtensionShortcut?.("\x03")).toBe(false);
		expect(context.defaultEditor.onExtensionShortcut?.("\x05")).toBe(true);
	});

	test("refresh clears stale entries when the daemon reports none", async () => {
		const context = makeContext({
			daemonExtensionShortcuts: new Map([
				["ctrl+e" as KeyId, { shortcut: "ctrl+e" as KeyId, extensionPath: "/tmp/stale.ts" }],
			]),
		});

		await interactiveModePrototype.refreshDaemonExtensionShortcuts.call(context);

		expect(context.daemonExtensionShortcuts.size).toBe(0);
	});

	test("clear fails closed and prevents an older outstanding refresh from restoring stale entries", async () => {
		let resolveFetch:
			| ((value: Array<{ key: string; description?: string; extensionPath: string }>) => void)
			| undefined;
		const context = makeContext({
			daemonExtensionShortcuts: new Map([
				["ctrl+e" as KeyId, { shortcut: "ctrl+e" as KeyId, extensionPath: "/tmp/stale.ts" }],
			]),
			agentConnection: {
				runExtensionShortcut: vi.fn(async () => {}),
				getExtensionShortcuts: vi.fn(
					() =>
						new Promise<Array<{ key: string; description?: string; extensionPath: string }>>((resolve) => {
							resolveFetch = resolve;
						}),
				),
			},
		});

		const pendingRefresh = interactiveModePrototype.refreshDaemonExtensionShortcuts.call(context);
		interactiveModePrototype.clearDaemonExtensionShortcuts.call(context); // invalidation/reconnecting/closed
		resolveFetch?.([{ key: "ctrl+e", extensionPath: "/tmp/old-response.ts" }]);
		await pendingRefresh;

		expect(context.daemonExtensionShortcuts.size).toBe(0);
	});

	test("a refresh failure clears the active registry", async () => {
		const context = makeContext({
			daemonExtensionShortcuts: new Map([
				["ctrl+e" as KeyId, { shortcut: "ctrl+e" as KeyId, extensionPath: "/tmp/stale.ts" }],
			]),
			agentConnection: {
				runExtensionShortcut: vi.fn(async () => {}),
				getExtensionShortcuts: vi.fn(async () => {
					throw new Error("transport failed");
				}),
			},
		});

		await expect(interactiveModePrototype.refreshDaemonExtensionShortcuts.call(context)).rejects.toThrow(
			"transport failed",
		);
		expect(context.daemonExtensionShortcuts.size).toBe(0);
	});

	test("shortcut guide reads the already-resolved daemon registry, never raw conflicting descriptors", () => {
		const context = makeContext({
			daemonExtensionShortcuts: new Map([
				["ctrl+e" as KeyId, { shortcut: "ctrl+e" as KeyId, description: "Safe", extensionPath: "/tmp/safe.ts" }],
			]),
		}) as DaemonExtensionShortcutsThis & {
			bindLocalSessionExtensions: boolean;
			getEditorKeyDisplay: () => string;
			getAppKeyDisplay: () => string;
		};
		context.bindLocalSessionExtensions = false;
		context.getEditorKeyDisplay = () => "key";
		context.getAppKeyDisplay = () => "key";

		const guide = interactiveModePrototype.getHotkeysGuide.call(context);

		expect(guide).toContain("Safe");
		expect(guide).not.toContain("Must not consume clear");
	});

	test("reconnecting invalidation clears immediately, then connected refreshes a new registry", async () => {
		let listener: ((event: { type: string; status?: string }) => Promise<void>) | undefined;
		const context = makeContext({
			daemonExtensionShortcuts: new Map([
				["ctrl+e" as KeyId, { shortcut: "ctrl+e" as KeyId, extensionPath: "/tmp/stale.ts" }],
			]),
			agentConnection: {
				runExtensionShortcut: vi.fn(async () => {}),
				getExtensionShortcuts: vi.fn(async () => [{ key: "ctrl+shift+e", extensionPath: "/tmp/fresh.ts" }]),
				subscribe: (next) => {
					listener = next;
					return () => {};
				},
			},
			showStatus: vi.fn(),
			refreshHeartbeatCatalog: vi.fn(async () => {}),
		}) as DaemonExtensionShortcutsThis & {
			showStatus: (text: string, kind?: string) => void;
			refreshHeartbeatCatalog: () => Promise<void>;
			unsubscribe?: () => void;
		};
		interactiveModePrototype.subscribeToAgent.call(context);

		await listener?.({ type: "connection_status", status: "reconnecting" });
		expect(context.daemonExtensionShortcuts.size).toBe(0);
		await listener?.({ type: "connection_status", status: "connected" });
		expect(context.showError).not.toHaveBeenCalled();
		expect(context.daemonExtensionShortcuts.get("ctrl+shift+e" as KeyId)?.extensionPath).toBe("/tmp/fresh.ts");
	});

	test("an old daemon's empty descriptor list leaves no bound shortcuts", async () => {
		const context = makeContext();
		await expect(interactiveModePrototype.refreshDaemonExtensionShortcuts.call(context)).resolves.toBeUndefined();
		interactiveModePrototype.setupDaemonExtensionShortcuts.call(context);
		expect(context.defaultEditor.onExtensionShortcut?.("\x05")).toBe(false);
	});
});
