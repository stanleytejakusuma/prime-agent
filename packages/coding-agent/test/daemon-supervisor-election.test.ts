import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	SUPERVISOR_STATE_FRESH_MS,
	SUPERVISOR_STATE_HEARTBEAT_MS,
	type SupervisorStateRecord,
	writeSupervisorState,
} from "../src/modes/daemon/daemon-supervisor-state.js";

const launchState = vi.hoisted(() => ({
	spawned: [] as Array<{ command: string; args: readonly string[] }>,
	launchSpecs: [] as Array<{ command: string; args: readonly string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		spawn(command: string, args: readonly string[], _options: SpawnOptions): ChildProcess {
			launchState.spawned.push({ command, args });
			return { unref: () => undefined, kill: () => true } as unknown as ChildProcess;
		},
	};
});

vi.mock("../src/cli/subprocess-launch.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createCliSubprocessLaunchSpec(args: readonly string[]) {
			const spec = { command: process.execPath, args: [...args] };
			launchState.launchSpecs.push(spec);
			return spec;
		},
		createCliSubprocessEnv() {
			return {};
		},
	};
});

const registryEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
let previousRegistryDir: string | undefined;

function lockDirFor(socketPath: string): string {
	const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
	return join(dirname(socketPath), `.supervisor-launch-${key}.lock`);
}

interface ElectionHarness {
	options: { worker: object; defaultSessionConfig: { cwd: string } };
	clients: Set<object>;
	supervisorClaims: Map<object, object>;
	shuttingDown: boolean;
	canConnectToSupervisor: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	scheduleSupervisorAvailabilityCheck: ReturnType<typeof vi.fn>;
	launchReplacementSupervisor: (socketPath: string) => Promise<void>;
	checkSupervisorAvailability: (socketPath: string) => Promise<void>;
	supervisorLastLaunchAttemptAt: number;
	supervisorLaunchInProgress: boolean;
}

function createHarness(socketPath: string, canConnect: () => Promise<boolean>): ElectionHarness {
	const harness = Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {}, defaultSessionConfig: { cwd: dirname(socketPath) } },
		clients: new Set<object>(),
		supervisorClaims: new Map<object, object>(),
		shuttingDown: false,
		supervisorLaunchInProgress: false,
		supervisorLastLaunchAttemptAt: 0,
		supervisorLastLossLogAt: 0,
		canConnectToSupervisor: vi.fn(canConnect),
		log: vi.fn(),
		scheduleSupervisorAvailabilityCheck: vi.fn(),
	}) as unknown as ElectionHarness;
	return harness;
}

function freshStateRecord(socketPath: string, overrides: Partial<SupervisorStateRecord> = {}): SupervisorStateRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		pid: process.pid,
		generation: "hung-gen",
		socketPath,
		appVersion: "0.8.0+fork.test",
		startedAt: now,
		lastHeartbeatAt: now,
		...overrides,
	};
}

describe("supervisor replacement election (recovery storm hardening)", () => {
	beforeEach(() => {
		launchState.spawned.length = 0;
		launchState.launchSpecs.length = 0;
		previousRegistryDir = process.env[registryEnv];
		process.env[registryEnv] = mkdtempSync(join(tmpdir(), "prime-supervisor-election-test-"));
	});

	afterEach(() => {
		if (previousRegistryDir === undefined) {
			delete process.env[registryEnv];
		} else {
			process.env[registryEnv] = previousRegistryDir;
		}
		vi.useRealTimers();
	});

	it("elects exactly one replacement spawn across three concurrent workers", async () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "prime-supervisor-election-sock-")), "daemon.sock");
		// The first worker to spawn becomes the "winner": after a spawn exists the
		// socket probe reports healthy so the winner's post-spawn wait exits fast.
		const harnesses = [0, 1, 2].map(() => createHarness(socketPath, async () => launchState.spawned.length > 0));

		await Promise.all(harnesses.map((h) => h.launchReplacementSupervisor(socketPath)));

		expect(launchState.spawned).toHaveLength(1);
		const winner = harnesses.find((h) =>
			h.log.mock.calls.some((call) => String(call[0]).includes("launched replacement supervisor")),
		);
		expect(winner).toBeDefined();
	});

	it("reclaims a stale lock whose owner is dead and spawns", async () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "prime-supervisor-stale-sock-")), "daemon.sock");
		const lockDir = lockDirFor(socketPath);
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, "pid"), "999999\n");
		const harness = createHarness(socketPath, async () => launchState.spawned.length > 0);

		await harness.launchReplacementSupervisor(socketPath);

		expect(launchState.spawned).toHaveLength(1);
		expect(harness.log.mock.calls.some((call) => String(call[0]).includes("launched replacement supervisor"))).toBe(
			true,
		);
	});

	it("defers spawning while a live owner with a fresh heartbeat is hung", async () => {
		vi.useFakeTimers();
		const socketPath = join(mkdtempSync(join(tmpdir(), "prime-supervisor-hung-sock-")), "daemon.sock");
		// A live owner keeps heartbeating (hung: the socket is dead but the
		// process and its event loop are alive). The election lock is free, so
		// this worker wins it, sees the fresh journal, and must defer instead of
		// spawning a replacement into a contested socket lock.
		const record = freshStateRecord(socketPath);
		writeSupervisorState(record);
		const harness = createHarness(socketPath, async () => false);

		const launchPromise = harness.launchReplacementSupervisor(socketPath);
		// Drive fake time one heartbeat step at a time, refreshing the journal so
		// the owner stays "alive and fresh" for the whole hung-owner wait window.
		for (let step = 0; step < 22; step += 1) {
			writeSupervisorState(freshStateRecord(socketPath, { generation: record.generation }));
			await vi.advanceTimersByTimeAsync(SUPERVISOR_STATE_HEARTBEAT_MS);
		}
		await launchPromise;

		expect(launchState.spawned).toHaveLength(0);
		expect(harness.log.mock.calls.some((call) => String(call[0]).includes("supervisor replacement deferred"))).toBe(
			true,
		);
	});

	it("spawns promptly when the journal owner heartbeat is stale", async () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "prime-supervisor-stalehb-sock-")), "daemon.sock");
		const stale = freshStateRecord(socketPath, {
			lastHeartbeatAt: new Date(Date.now() - SUPERVISOR_STATE_FRESH_MS * 10).toISOString(),
		});
		writeSupervisorState(stale);
		const harness = createHarness(socketPath, async () => launchState.spawned.length > 0);

		await harness.launchReplacementSupervisor(socketPath);

		expect(launchState.spawned).toHaveLength(1);
	});

	it("rate-limits repeated launch attempts through the availability check cooldown", async () => {
		const socketPath = join(mkdtempSync(join(tmpdir(), "prime-supervisor-cooldown-sock-")), "daemon.sock");
		const harness = createHarness(socketPath, async () => false);
		// The first availability check attempts a launch (spy records the call).
		const launchSpy = vi.spyOn(harness, "launchReplacementSupervisor").mockResolvedValue(undefined);
		await harness.checkSupervisorAvailability(socketPath);
		expect(launchSpy).toHaveBeenCalledTimes(1);
		// Mirror what the real launch method does: stamp the launch attempt time.
		harness.supervisorLastLaunchAttemptAt = Date.now();

		// A second check within the cooldown window must not attempt another
		// launch; it just reschedules the poll.
		await harness.checkSupervisorAvailability(socketPath);
		expect(launchSpy).toHaveBeenCalledTimes(1);
		expect(harness.scheduleSupervisorAvailabilityCheck).toHaveBeenCalledWith(socketPath, 5000);
	});
});
