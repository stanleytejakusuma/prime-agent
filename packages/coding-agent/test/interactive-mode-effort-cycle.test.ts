import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type CycleEffortContext = {
	connectionState?: { thinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] };
	agentConnection: { cycleThinkingLevel: () => Promise<ThinkingLevel | undefined> };
	footer: { invalidate: () => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	updateEditorBorderColor: () => void;
	getAvailableThinkingLevels: () => ThinkingLevel[];
};

type InteractiveModePrototype = {
	getAvailableThinkingLevels(this: CycleEffortContext): ThinkingLevel[];
	cycleEffortLevel(this: CycleEffortContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type HandleSubagentSummaryChatAction = (
	this: {
		keybindings: { matches(data: string, action: string): boolean };
		editor: { handleInput(data: string): void };
		focusEditor(): void;
		toggleToolOutputExpansion(): void;
		toggleAgentMessageExpansion(): void;
		toggleEditDiffExpansion(): void;
		toggleThinkingBlockVisibility(): void;
		cycleEffortLevel(): void;
	},
	data: string,
) => void;

const handleSubagentSummaryChatAction = (
	InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
).handleSubagentSummaryChatAction;

function makeContext(overrides: Partial<CycleEffortContext> = {}): CycleEffortContext {
	const context: CycleEffortContext = {
		connectionState: {
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
		},
		agentConnection: { cycleThinkingLevel: vi.fn(async () => "high" as ThinkingLevel) },
		footer: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		patchConnectionState: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		getAvailableThinkingLevels: () => interactiveModePrototype.getAvailableThinkingLevels.call(context),
		...overrides,
	};
	return context;
}

describe("app.effort.cycle keybinding", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	describe("keybinding catalog", () => {
		it("registers app.effort.cycle with a description and no conflicting default key", () => {
			const entry = KEYBINDINGS["app.effort.cycle"];

			expect(entry).toBeDefined();
			expect(entry.description).toBe("Cycle reasoning effort level");
			expect(entry.defaultKeys).toEqual([]);
		});
	});

	describe("cycleEffortLevel", () => {
		it("cycles through the connection and reports the new level", async () => {
			const cycleThinkingLevel = vi.fn(async () => "high" as ThinkingLevel);
			const context = makeContext({ agentConnection: { cycleThinkingLevel } });

			interactiveModePrototype.cycleEffortLevel.call(context);
			await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Thinking level: high"));

			expect(cycleThinkingLevel).toHaveBeenCalledOnce();
			expect(context.patchConnectionState).toHaveBeenCalledWith({ thinkingLevel: "high" });
			expect(context.footer.invalidate).toHaveBeenCalledWith();
			expect(context.updateEditorBorderColor).toHaveBeenCalledWith();
			expect(context.showError).not.toHaveBeenCalled();
		});

		it("reports when the model does not support thinking without touching the connection", () => {
			const cycleThinkingLevel = vi.fn(async () => "high" as ThinkingLevel);
			const context = makeContext({
				connectionState: { thinkingLevel: "off", availableThinkingLevels: ["off"] },
				agentConnection: { cycleThinkingLevel },
			});

			interactiveModePrototype.cycleEffortLevel.call(context);

			expect(cycleThinkingLevel).not.toHaveBeenCalled();
			expect(context.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
		});

		it("surfaces an error when cycling fails", async () => {
			const cycleThinkingLevel = vi.fn(async () => {
				throw new Error("nope");
			});
			const context = makeContext({ agentConnection: { cycleThinkingLevel } });

			interactiveModePrototype.cycleEffortLevel.call(context);
			await vi.waitFor(() => expect(context.showError).toHaveBeenCalledWith("nope"));

			expect(context.patchConnectionState).not.toHaveBeenCalled();
			expect(context.showStatus).not.toHaveBeenCalled();
		});
	});

	describe("raw input dispatch", () => {
		it("triggers cycleEffortLevel when the raw input matches app.effort.cycle", () => {
			const fakeThis = {
				keybindings: { matches: vi.fn((_data: string, action: string) => action === "app.effort.cycle") },
				editor: { handleInput: vi.fn() },
				focusEditor: vi.fn(),
				toggleToolOutputExpansion: vi.fn(),
				toggleAgentMessageExpansion: vi.fn(),
				toggleEditDiffExpansion: vi.fn(),
				toggleThinkingBlockVisibility: vi.fn(),
				cycleEffortLevel: vi.fn(),
			};

			handleSubagentSummaryChatAction.call(fakeThis, "\x1a");

			expect(fakeThis.cycleEffortLevel).toHaveBeenCalledOnce();
			expect(fakeThis.toggleThinkingBlockVisibility).not.toHaveBeenCalled();
			expect(fakeThis.focusEditor).not.toHaveBeenCalled();
			expect(fakeThis.editor.handleInput).not.toHaveBeenCalled();
		});

		it("does not trigger cycleEffortLevel for unrelated raw input", () => {
			const fakeThis = {
				keybindings: { matches: vi.fn(() => false) },
				editor: { handleInput: vi.fn() },
				focusEditor: vi.fn(),
				toggleToolOutputExpansion: vi.fn(),
				toggleAgentMessageExpansion: vi.fn(),
				toggleEditDiffExpansion: vi.fn(),
				toggleThinkingBlockVisibility: vi.fn(),
				cycleEffortLevel: vi.fn(),
			};

			handleSubagentSummaryChatAction.call(fakeThis, "x");

			expect(fakeThis.cycleEffortLevel).not.toHaveBeenCalled();
			expect(fakeThis.focusEditor).toHaveBeenCalledOnce();
			expect(fakeThis.editor.handleInput).toHaveBeenCalledWith("x");
		});
	});
});
