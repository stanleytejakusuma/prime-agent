import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Durable supervisor lifecycle journal, written next to the supervisor socket
 * (the same directory that holds the daemon socket lock). Workers read it when
 * the socket becomes unreachable so they can distinguish a genuinely dead
 * supervisor (pid gone, heartbeat stale) from a hung one (pid alive with a
 * fresh heartbeat but no listening socket), and so incident triage always has
 * the last-known identity and heartbeat age instead of an unexplained hole.
 *
 * The journal is best-effort: a SIGKILL leaves a stale lastHeartbeatAt, which
 * is itself the diagnostic signal. Atomic writes (tmp + rename) mean readers
 * never observe a torn record.
 */

export const SUPERVISOR_STATE_VERSION = 1 as const;

/** How often the supervisor refreshes lastHeartbeatAt. */
export const SUPERVISOR_STATE_HEARTBEAT_MS = 1000;
/** A heartbeat this fresh proves the owner's event loop is alive. */
export const SUPERVISOR_STATE_FRESH_MS = 4000;

export interface SupervisorStateRecord {
	version: typeof SUPERVISOR_STATE_VERSION;
	pid: number;
	processStartId?: string;
	generation: string;
	socketPath: string;
	appVersion: string;
	startedAt: string;
	lastHeartbeatAt: string;
	exitedAt?: string;
	exitReason?: string;
}

export function supervisorStatePath(socketPath: string): string {
	const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
	return join(dirname(socketPath), `.supervisor-state-${key}.json`);
}

export function readSupervisorState(socketPath: string): SupervisorStateRecord | undefined {
	const path = supervisorStatePath(socketPath);
	try {
		if (!existsSync(path)) {
			return undefined;
		}
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SupervisorStateRecord;
		return parsed.version === SUPERVISOR_STATE_VERSION ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function writeSupervisorState(record: SupervisorStateRecord): void {
	const path = supervisorStatePath(record.socketPath);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	try {
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** Refresh the heartbeat in place when the journal still belongs to `record`. */
export function touchSupervisorHeartbeat(record: SupervisorStateRecord): void {
	const current = readSupervisorState(record.socketPath);
	if (!current || current.pid !== record.pid || current.generation !== record.generation) {
		return;
	}
	writeSupervisorState({ ...current, lastHeartbeatAt: new Date().toISOString() });
}

/** Mark a graceful exit so triage can distinguish it from a disappearance. */
export function markSupervisorExited(socketPath: string, record: SupervisorStateRecord, reason: string): void {
	const current = readSupervisorState(socketPath);
	if (!current || current.pid !== record.pid || current.generation !== record.generation || current.exitedAt) {
		return;
	}
	writeSupervisorState({ ...current, exitedAt: new Date().toISOString(), exitReason: reason });
}
