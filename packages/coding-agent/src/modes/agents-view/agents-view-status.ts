import { spawnSync } from "node:child_process";
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
 *  - line 3: cumulative token/cache/cost totals (Phase 2), present only when
 *    the selected session carries a usageSnapshot.
 *
 * The builder is a pure function so it is unit-testable and can never take
 * down the render loop: all formatting is guarded, control characters are
 * flattened, and every line is width-truncated.
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
const branchCache = new Map<string, { branch: string | null; at: number }>();

/** Resolve the git branch for a cwd, cached briefly; never throws. */
function resolveGitBranch(cwd: string): string | null {
	const cached = branchCache.get(cwd);
	if (cached && Date.now() - cached.at < GIT_BRANCH_TTL_MS) {
		return cached.branch;
	}
	let branch: string | null = null;
	try {
		const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		});
		branch = result.status === 0 ? result.stdout.trim() : null;
	} catch {
		branch = null;
	}
	branchCache.set(cwd, { branch, at: Date.now() });
	return branch;
}

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

/** Cumulative stats line, mirroring the chat footer (pi parity). */
function buildUsageLine(usage: SessionUsageSnapshot): string {
	const parts: string[] = [];
	if (usage.input > 0) {
		parts.push(theme.fg("accent", `↑${formatTokenCount(usage.input)}`));
	}
	if (usage.output > 0) {
		parts.push(theme.fg("accent", `↓${formatTokenCount(usage.output)}`));
	}
	if (usage.cacheRead > 0) {
		parts.push(theme.fg("muted", `R${formatTokenCount(usage.cacheRead)}`));
	}
	if (usage.cacheWrite > 0) {
		parts.push(theme.fg("muted", `W${formatTokenCount(usage.cacheWrite)}`));
	}
	if (
		usage.cacheHitRate !== null &&
		Number.isFinite(usage.cacheHitRate) &&
		(usage.cacheRead > 0 || usage.cacheWrite > 0)
	) {
		parts.push(theme.fg("muted", `CH${usage.cacheHitRate.toFixed(1)}%`));
	}
	if (usage.cost > 0) {
		parts.push(theme.fg("warning", `$${usage.cost.toFixed(3)}`));
	}
	return parts.join(" ");
}

export function buildAgentsViewStatusLines(data: AgentsViewStatusLineData, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	const summary = data.summary;

	if (summary) {
		const parts: string[] = [];
		const cwd = sanitizeInline(summary.cwd || "");
		if (cwd) {
			const branch = summary.cwd ? resolveGitBranch(summary.cwd) : null;
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
			lines.push(truncateToWidth(theme.fg("dim", parts.join(" • ")), safeWidth, theme.fg("dim", "…")));
		}
	}

	const rosterParts: string[] = [data.countsText];
	if (data.scopeLabel) {
		rosterParts.push(`scope ${data.scopeLabel}`);
	}
	rosterParts.push(`depth${data.depth}`);
	lines.push(truncateToWidth(theme.fg("dim", rosterParts.join(" · ")), safeWidth, theme.fg("dim", "…")));

	if (summary?.usageSnapshot) {
		const usageLine = buildUsageLine(summary.usageSnapshot);
		if (usageLine.length > 0) {
			lines.push(truncateToWidth(usageLine, safeWidth, theme.fg("dim", "…")));
		}
	}

	return lines;
}
