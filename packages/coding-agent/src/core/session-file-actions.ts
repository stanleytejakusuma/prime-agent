import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { readLinesAsBuffers } from "../utils/file-lines.js";
import { hasLiveSessionLease } from "./session-lease.js";
import { getSessionArtifactPathForFile } from "./session-manager.js";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
export async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	// A degenerate name (".jsonl") would resolve to the artifacts root itself.
	if (!basename(sessionPath).replace(/\.jsonl$/, "")) return;
	await rm(getSessionArtifactPathForFile(sessionPath), { recursive: true, force: true });
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}

// Entry types that are always present when a session is created and carry no
// user-visible content on their own. A file whose only entries fall in this
// set holds nothing worth keeping (fork fix: ghost-sweep).
const GHOST_DRAFT_ENTRY_TYPES = new Set([
	"session",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"session_state",
]);

/**
 * True when a session file is an empty draft: it has no message entries and
 * every entry present is a bootstrap/state entry (fork fix: ghost-sweep).
 * These are ghost sessions -- created on disk for crash recovery bookkeeping
 * but never sent a message -- which the agents view shows as an undeletable
 * "(no messages)" row because the daemon still resolves an orphaned lease as
 * active.
 *
 * A passive RLM child that finished its work shares this exact on-disk
 * shape. The caller is responsible for checking lease liveness separately
 * (see hasLiveSessionLease) before treating a match here as safe to delete.
 */
export async function isEmptyDraftSessionFile(sessionPath: string): Promise<boolean> {
	try {
		let sawAnyEntry = false;
		for await (const lineBuffer of readLinesAsBuffers(sessionPath)) {
			const line = lineBuffer.toString("utf8").trim();
			if (!line) continue;
			let entry: { type?: unknown };
			try {
				entry = JSON.parse(line) as { type?: unknown };
			} catch {
				// An unparseable line means this file is not a clean, empty draft;
				// leave it alone rather than risk deleting something with real
				// (if malformed) content.
				return false;
			}
			sawAnyEntry = true;
			if (typeof entry.type !== "string" || !GHOST_DRAFT_ENTRY_TYPES.has(entry.type)) {
				return false;
			}
		}
		return sawAnyEntry;
	} catch {
		return false;
	}
}

/**
 * Delete every ghost session file in sessionDir: empty drafts with no live
 * lease (fork fix: ghost-sweep). Never touches a file with a live lease, so
 * a legitimate in-progress or passive RLM child session -- which can share
 * the exact same on-disk shape -- is never at risk.
 *
 * Ports only the verified-safe half of the logic bisected from an earlier
 * upstream PR (#1079); see sweepStaleSessionLeases in session-lease.ts for
 * the corresponding note on the deliberately-excluded regression.
 */
export async function sweepGhostSessionFiles(sessionDir: string, agentDir: string): Promise<number> {
	if (!existsSync(sessionDir)) {
		return 0;
	}
	let entries: string[];
	try {
		entries = readdirSync(sessionDir);
	} catch {
		return 0;
	}
	let swept = 0;
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) {
			continue;
		}
		const sessionPath = join(sessionDir, entry);
		if (hasLiveSessionLease(agentDir, sessionPath)) {
			continue;
		}
		if (await isEmptyDraftSessionFile(sessionPath)) {
			const result = await deleteSessionFile(sessionPath);
			if (result.ok) {
				swept++;
			}
		}
	}
	return swept;
}
