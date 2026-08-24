import { execFile } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionSummary, SessionUsageSnapshot } from "../daemon/daemon-session-list.js";
import { theme } from "../interactive/theme/theme.js";

/**
 * Agents-view status footer (pi-style parity). The default landing view shows
 * the same family of information the chat footer does, sourced from what the
 * daemon already sends on the roster wire:
 *
 *  - line 1: selected session cwd (branch), session name, model:thinking, and
 *    live context utilization when the daemon included a usage snapshot;
 *  - line 2: roster summary (running/idle/inactive), scope, and depth;
 *  - line 3: cumulative token/cache/cost totals (Phase 2).
 *
 * FIXED HEIGHT (Red review, 2026-08-24): always three lines, even when data
 * is absent for a line -- a blank/dim placeholder line takes its slot. A
 * variable 1-4 line footer made the dock height (and therefore the roster's
 * visible-row window and scroll anchor) jitter with selection, which is a
 * worse defect than a slightly less dense footer. Callers that need the dock
 * height must not need to special-case "how many lines will render".
 *
 * NON-BLOCKING (Red review, 2026-08-24): git branch resolution used to run
 * spawnSync() directly inside this render-path function, which could block
 * the whole TUI for up to its 2s timeout on every uncached cwd and again on
 * every 15s cache expiry. Branch lookups are now async-only
 * (resolveGitBranchAsync, mirroring core/footer-data-provider.ts's existing
 * chat-footer pattern) and populate a small module-level cache that the
 * caller polls into; the render path only ever reads the cache synchronously
 * and never spawns a process itself. A missing/expired cache entry renders
 * as "no branch" for that frame rather than blocking to fetch one -- the
 * next poll (the view already polls every 1s) fills it in.
 *
 * The builder is otherwise a pure function so it is unit-testable and can
 * never take down the render loop: all formatting is guarded, control
 * characters are flattened, and every line is width-truncated.
 */

export interface AgentsViewStatusLineData {
	/** Selected session row (agent or subagent), if one is selected. */
	summary?: SessionSummary;
	/** Roster summary text, e.g. "3 running, 1 idle, 5 inactive". */
	countsText: string;
	/** Scope label: scoped session title, or "global" for the root view. */
	scopeLabel?: string;
	depth: number;
}

const GIT_BRANCH_TTL_MS = 15_000;
const GIT_BRANCH_NEGATIVE_TTL_MS = 15_000;
const GIT_BRANCH_MAX_CACHE_ENTRIES = 64;
const GIT_BRANCH_RESOLVE_TIMEOUT_MS = 2000;

interface BranchCacheEntry {
	branch: string | null;
	at: number;
}

const branchCache = new Map<string, BranchCacheEntry>();
const branchResolutionsInFlight = new Set<string>();

/**
 * Synchronous, non-blocking cache read. Returns undefined when there is no
 * fresh entry yet (never spawned a lookup, or the entry expired) -- the
 * caller renders without a branch for this frame; refreshGitBranchCache
 * (called from the view's existing poll loop, not from render) fills it in
 * for the next frame.
 */
export function peekCachedGitBranch(cwd: string): string | null | undefined {
	const cached = branchCache.get(cwd);
	if (!cached) {
		return undefined;
	}
	const ttl = cached.branch === null ? GIT_BRANCH_NEGATIVE_TTL_MS : GIT_BRANCH_TTL_MS;
	if (Date.now() - cached.at >= ttl) {
		return undefined;
	}
	return cached.branch;
}

/**
 * Asynchronously (re)populate the branch cache for a cwd if it is missing,
 * expired, or not already in flight. Call from a poll loop, never from a
 * render path. Bounds the cache to the most recently touched entries so a
 * long session touching many cwds cannot grow it unbounded.
 */
export async function refreshGitBranchCache(cwd: string): Promise<void> {
	if (!cwd || branchResolutionsInFlight.has(cwd)) {
		return;
	}
	const cached = branchCache.get(cwd);
	const ttl = cached && cached.branch === null ? GIT_BRANCH_NEGATIVE_TTL_MS : GIT_BRANCH_TTL_MS;
	if (cached && Date.now() - cached.at < ttl) {
		return;
	}
	branchResolutionsInFlight.add(cwd);
	try {
		const branch = await resolveGitBranchAsync(cwd);
		branchCache.set(cwd, { branch, at: Date.now() });
		evictOldestBranchCacheEntriesIfNeeded();
	} finally {
		branchResolutionsInFlight.delete(cwd);
	}
}

function evictOldestBranchCacheEntriesIfNeeded(): void {
	if (branchCache.size <= GIT_BRANCH_MAX_CACHE_ENTRIES) {
		return;
	}
	const entries = [...branchCache.entries()].sort((a, b) => a[1].at - b[1].at);
	const overflow = entries.length - GIT_BRANCH_MAX_CACHE_ENTRIES;
	for (let i = 0; i < overflow; i++) {
		branchCache.delete(entries[i][0]);
	}
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD, not a repo, or a git failure. Never throws. */
function resolveGitBranchAsync(cwd: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		try {
			const child = execFile(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				{ cwd, encoding: "utf8", timeout: GIT_BRANCH_RESOLVE_TIMEOUT_MS },
				(error, stdout) => {
					if (error) {
						resolvePromise(null);
						return;
					}
					const branch = stdout.trim();
					resolvePromise(branch || null);
				},
			);
			child.on("error", () => resolvePromise(null));
		} catch {
			resolvePromise(null);
		}
	});
}

function sanitizeInline(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function formatTokenCount(count: number): string {
	if (!Number.isFinite(count)) {
		return "0";
	}
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

/** Coerce a possibly-NaN/non-finite usage field to a safe non-negative number. */
function safeUsageNumber(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Cumulative stats line, mirroring the chat footer (pi parity). Empty string when there is nothing to show. */
function buildUsageLine(usage: SessionUsageSnapshot): string {
	const parts: string[] = [];
	const input = safeUsageNumber(usage.input);
	const output = safeUsageNumber(usage.output);
	const cacheRead = safeUsageNumber(usage.cacheRead);
	const cacheWrite = safeUsageNumber(usage.cacheWrite);
	const cost = safeUsageNumber(usage.cost);
	if (input > 0) {
		parts.push(theme.fg("accent", `\u2191${formatTokenCount(input)}`));
	}
	if (output > 0) {
		parts.push(theme.fg("accent", `\u2193${formatTokenCount(output)}`));
	}
	if (cacheRead > 0) {
		parts.push(theme.fg("muted", `R${formatTokenCount(cacheRead)}`));
	}
	if (cacheWrite > 0) {
		parts.push(theme.fg("muted", `W${formatTokenCount(cacheWrite)}`));
	}
	if (usage.cacheHitRate !== null && Number.isFinite(usage.cacheHitRate) && (cacheRead > 0 || cacheWrite > 0)) {
		parts.push(theme.fg("muted", `CH${usage.cacheHitRate.toFixed(1)}%`));
	}
	if (cost > 0) {
		parts.push(theme.fg("warning", `$${cost.toFixed(3)}`));
	}
	return parts.join(" ");
}

/**
 * Build the three-line agents-view status footer. Always returns exactly
 * three lines (a blank dim placeholder fills a slot with nothing to show),
 * so dock height never varies with selection or data availability. Pure and
 * synchronous: reads the module-level branch cache (see peekCachedGitBranch)
 * instead of resolving a branch itself.
 */
export function buildAgentsViewStatusLines(data: AgentsViewStatusLineData, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const summary = data.summary;
	const blank = "";

	// Line 1: selected session identity.
	let line1 = blank;
	if (summary) {
		const parts: string[] = [];
		const cwd = sanitizeInline(summary.cwd || "");
		if (cwd) {
			const branch = summary.cwd ? peekCachedGitBranch(summary.cwd) : undefined;
			parts.push(branch ? `${cwd} (${sanitizeInline(branch)})` : cwd);
		}
		if (summary.sessionName) {
			parts.push(sanitizeInline(summary.sessionName));
		}
		if (summary.model) {
			const level = summary.thinkingLevel && summary.thinkingLevel !== "off" ? `:${summary.thinkingLevel}` : "";
			parts.push(`${sanitizeInline(summary.model.id)}${level}`);
		}
		const usage = summary.usageSnapshot;
		if (usage && typeof usage.contextTokens === "number" && usage.contextWindow > 0) {
			const pct =
				typeof usage.contextPercent === "number" && Number.isFinite(usage.contextPercent)
					? ` (${Math.round(usage.contextPercent)}%)`
					: "";
			parts.push(`${formatTokenCount(usage.contextTokens)}${pct}`);
		}
		if (parts.length > 0) {
			line1 = truncateToWidth(theme.fg("dim", parts.join(" \u2022 ")), safeWidth, theme.fg("dim", "\u2026"));
		}
	}

	// Line 2: roster summary, always present.
	const rosterParts: string[] = [data.countsText];
	const scopeLabel = data.scopeLabel ? sanitizeInline(data.scopeLabel) : undefined;
	if (scopeLabel) {
		rosterParts.push(`scope ${scopeLabel}`);
	}
	rosterParts.push(`depth${data.depth}`);
	const line2 = truncateToWidth(theme.fg("dim", rosterParts.join(" \u00b7 ")), safeWidth, theme.fg("dim", "\u2026"));

	// Line 3: cumulative usage stats, blank placeholder when absent.
	let line3 = blank;
	if (summary?.usageSnapshot) {
		const usageLine = buildUsageLine(summary.usageSnapshot);
		if (usageLine.length > 0) {
			line3 = truncateToWidth(usageLine, safeWidth, theme.fg("dim", "\u2026"));
		}
	}

	return [line1, line2, line3];
}
