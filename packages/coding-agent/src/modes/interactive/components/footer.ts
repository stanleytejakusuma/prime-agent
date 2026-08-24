import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Data shown in the built-in one-line status footer (Pi-style status line).
 * All fields are optional; a missing field is simply omitted from the line.
 */
export interface FooterStatusLineData {
	/** Display name of the active model (e.g. "deepseek-v4-flash"). */
	model?: string;
	/** Current reasoning effort level (e.g. "high"), shown next to the model. */
	thinkingLevel?: string;
	/** Context usage as a percentage of the model window, or null when unknown. */
	contextPercent?: number | null;
	/** Estimated context tokens, or null when unknown. */
	contextTokens?: number | null;
	/** Tokens attributed to the current turn (0 or undefined hides the segment). */
	turnTokens?: number;
	/** Current git branch, or null when not in a git worktree. */
	gitBranch?: string | null;
	/** Extension status texts registered through ctx.ui.setStatus(). */
	extensionStatuses?: ReadonlyMap<string, string>;
}

/**
 * Footer component for the prime brand TUI.
 *
 * Renders a single Pi-style status line when a status-line provider is set:
 * model, reasoning level, context usage, current-turn tokens, git branch, and
 * extension statuses. Without a provider it renders nothing, preserving the
 * original empty-footer behavior for callers that do not opt in.
 *
 * The provider is invoked lazily on every render (pi-tui calls render() fresh
 * on every scheduled frame, never memoized by prior output), so any existing
 * `footer.invalidate()` call site in interactive-mode already sees fresh
 * state with no extra plumbing. Data is read-only and client-local; nothing
 * here crosses the daemon wire.
 *
 * SECURITY / DISPLAY NOTE: extension status text (ctx.ui.setStatus()) is the
 * one untrusted content channel rendered here. It is sanitized (control
 * characters and newlines stripped) so it cannot break the single-line
 * contract or inject terminal control sequences, but it is NOT redacted --
 * an extension that writes secrets, keys, or sensitive trading state into a
 * status string will display it on screen and it will appear in terminal
 * recordings/screenshots. Extensions must not put sensitive data in
 * ctx.ui.setStatus().
 *
 * render() never throws: any failure while deriving or formatting the line
 * degrades to an empty footer rather than crashing the render loop.
 */
export class FooterComponent implements Component {
	private statusLineProvider: (() => FooterStatusLineData | undefined) | undefined;

	constructor(private footerData: ReadonlyFooterDataProvider) {
		void this.footerData;
	}

	/** Provide a lazy status-line data source, or undefined to render an empty footer. */
	setStatusLineProvider(provider: (() => FooterStatusLineData | undefined) | undefined): void {
		this.statusLineProvider = provider;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// no-op: auto-compaction state is not surfaced in the status line
	}

	/**
	 * No-op: the status line is re-derived from the provider on every render.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch caching is handled by the provider.
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		if (!this.statusLineProvider) {
			return [];
		}
		try {
			const data = this.statusLineProvider();
			if (!data) {
				return [];
			}
			const line = this.buildStatusLine(data);
			if (line.length === 0) {
				return [];
			}
			return [truncateToWidth(line, width, "…")];
		} catch {
			// The footer must never be able to crash the render loop. A bad
			// provider read (or a future edit that introduces a throw) degrades
			// to an empty footer instead of taking down the whole TUI.
			return [];
		}
	}

	private buildStatusLine(data: FooterStatusLineData): string {
		const segments: string[] = [];

		const modelParts: string[] = [];
		if (data.model) {
			modelParts.push(theme.fg("accent", sanitizeInline(data.model)));
		}
		if (data.thinkingLevel && data.thinkingLevel !== "off" && data.thinkingLevel !== "none") {
			modelParts.push(sanitizeInline(data.thinkingLevel));
		}
		if (modelParts.length > 0) {
			segments.push(modelParts.join(" "));
		}

		const context = this.formatContext(data.contextPercent, data.contextTokens);
		if (context) {
			segments.push(context);
		}

		if (data.turnTokens !== undefined && Number.isFinite(data.turnTokens) && data.turnTokens > 0) {
			segments.push(theme.fg("dim", formatTokenCount(data.turnTokens)));
		}

		if (data.gitBranch) {
			segments.push(theme.fg("dim", `⎇ ${sanitizeInline(data.gitBranch)}`));
		}

		if (data.extensionStatuses && data.extensionStatuses.size > 0) {
			const statusText = [...data.extensionStatuses.values()]
				.map((text) => sanitizeInline(text))
				.filter((text) => text.length > 0)
				.join(" | ");
			if (statusText.length > 0) {
				segments.push(theme.fg("muted", statusText));
			}
		}

		return segments.join("  ·  ");
	}

	private formatContext(percent: number | null | undefined, tokens: number | null | undefined): string | undefined {
		const finiteTokens = tokens !== null && tokens !== undefined && Number.isFinite(tokens) ? tokens : undefined;
		const finitePercent = percent !== null && percent !== undefined && Number.isFinite(percent) ? percent : undefined;

		if (finitePercent === undefined) {
			if (!finiteTokens || finiteTokens === 0) {
				return undefined;
			}
			return theme.fg("dim", `${formatTokenCount(finiteTokens)} ctx`);
		}
		const color = finitePercent > 90 ? "error" : finitePercent > 70 ? "warning" : "dim";
		const pct = `${Math.round(finitePercent)}%`;
		return finiteTokens && finiteTokens > 0
			? theme.fg(color, `${pct} (${formatTokenCount(finiteTokens)})`)
			: theme.fg(color, `${pct} ctx`);
	}
}

/**
 * Strip newlines and C0/C1 control characters (including raw ESC) from
 * untrusted single-line display text. Extension status strings and git
 * branch names are the only values here that do not originate from the
 * client's own trusted state, and the footer's contract is exactly one
 * line: a stray "\n" or an embedded ANSI/control sequence must not be able
 * to break that contract or bleed styling/cursor movement into the frame.
 */
function sanitizeInline(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}
	return String(count);
}
