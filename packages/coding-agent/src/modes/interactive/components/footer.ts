import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Cumulative per-session token/cost totals, mirroring pi 0.84.2's footer
 * (packages pi-ai Usage shapes summed over the session's assistant/toolResult/
 * compaction entries). Input/output/cache/cost are the fields the tray does
 * not already surface; the tray owns model/thinking/context.
 */
export interface FooterUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * Data shown in the built-in multi-line status footer (Pi 0.84.2 parity,
 * fork option A). All fields are optional; a missing field is simply omitted
 * from the line.
 */
export interface FooterStatusLineData {
	/** Working directory for the pwd line (line 1). */
	cwd?: string;
	/** Session name appended to the pwd line (line 1). */
	sessionName?: string;
	/** Display name of the active model (tray-owned; kept for provider shape). */
	model?: string;
	/** Current reasoning effort level (tray-owned; kept for provider shape). */
	thinkingLevel?: string;
	/** Context usage as a percentage of the model window, or null when unknown. */
	contextPercent?: number | null;
	/** Estimated context tokens, or null when unknown. */
	contextTokens?: number | null;
	/** Tokens attributed to the current turn (0 or undefined hides the segment). */
	turnTokens?: number;
	/** Cumulative session usage totals (line 2: up/down/cache/cost). */
	usageTotals?: FooterUsageTotals;
	/** Latest cache hit rate percent (line 2: CH), or null/undefined to omit. */
	cacheHitRate?: number | null;
	/** Auto-compaction enabled flag; shows "(auto)" next to nothing here since
	 *  context stays in the tray -- kept for pi-parity shape. */
	autoCompactEnabled?: boolean;
	/** Current git branch, or null when not in a git worktree. */
	gitBranch?: string | null;
	/** Extension status texts registered through ctx.ui.setStatus(). */
	extensionStatuses?: ReadonlyMap<string, string>;
}

/**
 * Footer component for the prime brand TUI.
 *
 * Pi 0.84.2 parity (option A): renders a multi-line status footer when a
 * status-line provider is set --
 *   line 1: pwd (branch) • sessionName   (dim)
 *   line 2: cumulative session stats: up/down tokens, cache read/write,
 *           cache hit rate, session cost   (dim, right-aligned model NOT
 *           shown here: the tray owns model/thinking/context)
 *   line 3: extension statuses (sorted by key, sanitized)
 * Without a provider it renders nothing, preserving the original empty-footer
 * behavior for callers that do not opt in.
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
 * render() never throws: any failure while deriving or formatting the lines
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
		// no-op: auto-compaction state is not surfaced in the footer (the tray
		// owns context, and pi's "(auto)" indicator rode next to context %).
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
			return this.buildStatusLines(data, width);
		} catch {
			// The footer must never be able to crash the render loop. A bad
			// provider read (or a future edit that introduces a throw) degrades
			// to an empty footer instead of taking down the whole TUI.
			return [];
		}
	}

	private buildStatusLines(data: FooterStatusLineData, width: number): string[] {
		// Legacy contract: when the pi-parity fields (cwd/usageTotals) are not
		// supplied, render the original single-line footer (model, thinking,
		// context, turn tokens, git branch, extension statuses) so existing
		// callers keep their behavior. The multi-line parity layout only kicks
		// in when the new data is actually provided.
		if (data.cwd === undefined && data.usageTotals === undefined) {
			const legacy = this.buildLegacyStatusLine(data);
			return legacy.length > 0 ? [truncateToWidth(legacy, width, "…")] : [];
		}

		const lines: string[] = [];

		// Line 1: pwd (branch) • sessionName, dim (pi parity).
		const pwd = this.buildPwdLine(data);
		if (pwd.length > 0) {
			lines.push(truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")));
		}

		// Line 2: cumulative session stats (pi parity, option A -- the tray
		// owns model/thinking/context, so this line carries only the stats the
		// tray never had: up/down/cache/cost).
		const stats = this.buildStatsLine(data);
		if (stats.length > 0) {
			lines.push(truncateToWidth(stats, width, theme.fg("dim", "...")));
		}

		// Line 3: extension statuses sorted by key (pi parity), sanitized.
		if (data.extensionStatuses && data.extensionStatuses.size > 0) {
			const statuses = [...data.extensionStatuses.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeInline(text))
				.filter((text) => text.length > 0);
			if (statuses.length > 0) {
				lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
			}
		}

		return lines;
	}

	/** Original single-line footer for legacy providers (no cwd/usageTotals). */
	private buildLegacyStatusLine(data: FooterStatusLineData): string {
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
		const context = this.formatLegacyContext(data.contextPercent, data.contextTokens);
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

	private formatLegacyContext(
		percent: number | null | undefined,
		tokens: number | null | undefined,
	): string | undefined {
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

	private buildPwdLine(data: FooterStatusLineData): string {
		let pwd = data.cwd ? sanitizeInline(formatCwdForFooter(data.cwd)) : "";
		const branch = data.gitBranch;
		if (branch) {
			pwd = pwd ? `${pwd} (${sanitizeInline(branch)})` : `(${sanitizeInline(branch)})`;
		}
		if (data.sessionName) {
			pwd = pwd ? `${pwd} • ${sanitizeInline(data.sessionName)}` : sanitizeInline(data.sessionName);
		}
		return pwd;
	}

	private buildStatsLine(data: FooterStatusLineData): string {
		const totals = data.usageTotals;
		if (!totals) {
			return "";
		}
		const parts: string[] = [];
		if (Number.isFinite(totals.input) && totals.input > 0) {
			parts.push(theme.fg("accent", `↑${formatTokenCount(totals.input)}`));
		}
		if (Number.isFinite(totals.output) && totals.output > 0) {
			parts.push(theme.fg("accent", `↓${formatTokenCount(totals.output)}`));
		}
		if (Number.isFinite(totals.cacheRead) && totals.cacheRead > 0) {
			parts.push(theme.fg("muted", `R${formatTokenCount(totals.cacheRead)}`));
		}
		if (Number.isFinite(totals.cacheWrite) && totals.cacheWrite > 0) {
			parts.push(theme.fg("muted", `W${formatTokenCount(totals.cacheWrite)}`));
		}
		const hitRate = data.cacheHitRate;
		if (
			hitRate !== null &&
			hitRate !== undefined &&
			Number.isFinite(hitRate) &&
			(totals.cacheRead > 0 || totals.cacheWrite > 0)
		) {
			parts.push(theme.fg("muted", `CH${hitRate.toFixed(1)}%`));
		}
		if (Number.isFinite(totals.cost) && totals.cost > 0) {
			parts.push(theme.fg("warning", `$${totals.cost.toFixed(3)}`));
		}
		return parts.join("  ");
	}
}

/**
 * Format a cwd for the pwd line: replace the home directory prefix with "~"
 * (pi's formatCwdForFooter equivalent).
 *
 * POSIX-only by explicit contract: when either the cwd or the home path uses
 * a Windows drive/backslash layout we return the cwd unchanged, because the
 * "/"-based normalization below would otherwise mangle it. The fork targets
 * macOS/Linux terminals, so this is a documented limit, not a silent bug.
 */
function formatCwdForFooter(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) {
		return cwd;
	}
	if (cwd.includes("\\") || home.includes("\\") || /^[A-Za-z]:/.test(cwd) || /^[A-Za-z]:/.test(home)) {
		return cwd;
	}
	const resolvedCwd = resolvePath(cwd);
	const resolvedHome = resolvePath(home);
	if (!resolvedCwd.startsWith(`${resolvedHome}/`) && resolvedCwd !== resolvedHome) {
		return cwd;
	}
	if (resolvedCwd === resolvedHome) {
		return "~";
	}
	return `~/${resolvedCwd.slice(resolvedHome.length + 1)}`;
}

function resolvePath(p: string): string {
	// POSIX-style normalization adequate for the pwd line; avoids pulling in
	// node:path resolution at render time.
	const parts: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			parts.pop();
		} else {
			parts.push(seg);
		}
	}
	return `/${parts.join("/")}`;
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
	if (count >= 1_000_000_000) {
		return `${(count / 1_000_000_000).toFixed(1)}B`;
	}
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}
	return String(count);
}
