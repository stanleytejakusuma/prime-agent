import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	markSupervisorExited,
	readSupervisorState,
	type SupervisorStateRecord,
	touchSupervisorHeartbeat,
	writeSupervisorState,
} from "../src/modes/daemon/daemon-supervisor-state.js";

const dirs: string[] = [];

function makeRecord(socketPath: string, overrides: Partial<SupervisorStateRecord> = {}): SupervisorStateRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		pid: 4242,
		processStartId: "start-1",
		generation: "gen-1",
		socketPath,
		appVersion: "0.8.0+fork.test",
		startedAt: now,
		lastHeartbeatAt: now,
		...overrides,
	};
}

describe("supervisor state journal", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips a record and heartbeats in place", () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "pa-supervisor-state-")), "daemon.sock");
		dirs.push(join(socketPath, ".."));
		const record = makeRecord(socketPath);
		writeSupervisorState(record);
		expect(readSupervisorState(socketPath)).toMatchObject({ pid: 4242, generation: "gen-1" });

		touchSupervisorHeartbeat(makeRecord(socketPath, { lastHeartbeatAt: new Date(0).toISOString() }));
		const updated = readSupervisorState(socketPath);
		expect(updated?.pid).toBe(4242);
		expect(updated?.generation).toBe("gen-1");
	});

	it("does not touch a journal owned by a different generation", () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "pa-supervisor-state-")), "daemon.sock");
		dirs.push(join(socketPath, ".."));
		writeSupervisorState(makeRecord(socketPath));
		touchSupervisorHeartbeat(makeRecord(socketPath, { generation: "other-gen" }));
		expect(readSupervisorState(socketPath)?.generation).toBe("gen-1");
	});

	it("records a graceful exit once and ignores repeat marks", () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "pa-supervisor-state-")), "daemon.sock");
		dirs.push(join(socketPath, ".."));
		const record = makeRecord(socketPath);
		writeSupervisorState(record);
		markSupervisorExited(socketPath, record, "cleanup");
		const exited = readSupervisorState(socketPath);
		expect(exited?.exitReason).toBe("cleanup");
		expect(exited?.exitedAt).toBeDefined();

		markSupervisorExited(socketPath, record, "cleanup-again");
		expect(readSupervisorState(socketPath)?.exitReason).toBe("cleanup");
	});

	it("returns undefined for a missing or malformed journal", () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "pa-supervisor-state-")), "daemon.sock");
		dirs.push(join(socketPath, ".."));
		expect(readSupervisorState(socketPath)).toBeUndefined();
		writeSupervisorState(makeRecord(socketPath, { version: 99 as never }));
		expect(readSupervisorState(socketPath)).toBeUndefined();
	});
});
