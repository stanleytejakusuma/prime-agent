import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import * as supervisorStateModule from "../src/modes/daemon/daemon-supervisor-state.js";
import { SUPERVISOR_STATE_HEARTBEAT_MS } from "../src/modes/daemon/daemon-supervisor-state.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
});

describe("supervisor state heartbeat interval: write-failure resilience", () => {
	it("does not let a touchSupervisorHeartbeat throw escape the interval callback (B1)", async () => {
		// Red review 2026-08-24 (supervisor recovery re-review), B1: diagnostics
		// must be strictly weaker than the thing they diagnose. Before the fix,
		// startSupervisorStateJournal's setInterval callback called
		// touchSupervisorHeartbeat bare; an exception there is an uncaught
		// exception inside a timer callback, which is process-fatal in Node --
		// turning a transient journal write failure into exactly the supervisor
		// death this journal exists to help recover from, once per second.
		vi.useFakeTimers();
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeat-guard-"));
		tempDirs.push(directory);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes: 90 }));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as { log: ReturnType<typeof vi.fn>; shuttingDown: boolean };
		supervisor.log = vi.fn();

		const touchSpy = vi.spyOn(supervisorStateModule, "touchSupervisorHeartbeat").mockImplementation(() => {
			throw new Error("simulated ENOSPC: no space left on device");
		});

		try {
			const startSupervisorStateJournal = Reflect.get(DaemonSupervisor.prototype, "startSupervisorStateJournal") as (
				this: unknown,
			) => void;
			// Calling this directly, then advancing fake timers across many heartbeat
			// ticks, is the discriminator: if the callback's throw were unguarded,
			// vitest's fake-timer driver would surface it as an unhandled error and
			// this test would fail/crash instead of completing.
			startSupervisorStateJournal.call(supervisor);

			for (let tick = 0; tick < 10; tick += 1) {
				await vi.advanceTimersByTimeAsync(SUPERVISOR_STATE_HEARTBEAT_MS);
			}

			expect(touchSpy).toHaveBeenCalled();
			// Rate-limited: 10 ticks at 1s each (10s total) must not each produce a
			// separate failure log line -- exactly one within the cooldown window.
			const failureLogs = supervisor.log.mock.calls.filter((call) =>
				String(call[0]).includes("supervisor state heartbeat write failed"),
			);
			expect(failureLogs).toHaveLength(1);
		} finally {
			touchSpy.mockRestore();
		}
	});
});
