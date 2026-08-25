import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor, idleEvictionSweepIntervalMs } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";
import * as childProcessModule from "../src/utils/child-process.js";

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		ownerClientId?: string;
		stopRequestedAt?: string;
		createCommand: { type: "create"; config?: { sessionDir?: string } };
	};
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
	updateRestartPrepareClient?: object;
}

/**
 * A genuine ResidentWorker-shaped fixture (not the shallow WorkerFixture
 * above), for the one test that exercises the real, un-mocked stopWorker.
 */
interface RealResidentWorkerFixture {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, unknown>;
	transcriptCaches: Map<string, unknown>;
	snapshotGenerations: Map<string, Map<string, unknown>>;
	snapshotLoads: Map<string, Promise<unknown>>;
	intentionalStop: boolean;
	stopRevision: number;
	stopFinalization?: Promise<void>;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	clients: Set<{ id: string; attachedActiveSessionIds: Set<string> }>;
	idleEvictionFence?: Promise<void>;
	catalog: { resolve: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
	createOrReuseWorker: ReturnType<typeof vi.fn>;
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	scheduleIdleEvictionSweep(): void;
	runIdleEvictionSweep(now?: number): Promise<void>;
	shutdown(exitCode: number, stopWorkers: boolean): Promise<never>;
	handleCommand(client: object, command: object): Promise<unknown>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string, now: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date(now - 120 * 60_000).toISOString(),
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function makeWorker(id: string, summaries: SessionSummary[]): WorkerFixture {
	const client = {
		request: vi.fn(async () => success(undefined, "list", { sessions: summaries })),
		requestWorker: vi.fn(),
		close: vi.fn(),
	};
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: `${id}-descriptor-root`,
			rootSessionId: `${id}-root-session`,
			pid: 1,
			createCommand: { type: "create" },
		},
		client,
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
		intentionalStop: false,
	};
}

function makeSupervisor(idleEvictionMinutes: number | "off" = 90): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-eviction-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.stopWorker = vi.fn(async (worker: WorkerFixture) => {
		supervisor.workers.delete(worker.descriptor.workerId);
	});
	supervisor.log = vi.fn();
	return supervisor;
}

describe("daemon supervisor whole-tree eviction", () => {
	it("derives a bounded sweep interval from the live threshold", () => {
		expect(idleEvictionSweepIntervalMs("off")).toBe(5 * 60_000);
		expect(idleEvictionSweepIntervalMs(90)).toBe(5 * 60_000);
		expect(idleEvictionSweepIntervalMs(6)).toBe(2 * 60_000);
		expect(idleEvictionSweepIntervalMs(1)).toBe(60_000);
	});

	it("stops a fully idle worker and leaves pinned workers resident", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now), makeSummary("idle-child", now)]);
		const active = makeWorker("active", [makeSummary("active-root", now, { isSessionActive: true })]);
		const heartbeat = makeWorker("heartbeat", [makeSummary("heartbeat-root", now, { hasRegisteredHeartbeat: true })]);
		const cron = makeWorker("cron", [makeSummary("cron-root", now, { hasRegisteredCronJob: true })]);
		const attached = makeWorker("attached", [makeSummary("attached-root", now)]);
		for (const worker of [idle, active, heartbeat, cron, attached]) {
			supervisor.workers.set(worker.descriptor.workerId, worker);
		}
		supervisor.clients.add({ id: "viewer", attachedActiveSessionIds: new Set(["attached-root"]) });

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(idle, true);
		expect(supervisor.log).toHaveBeenCalledWith(
			expect.stringMatching(/Evicted idle worker idle .*idleMinutes=120 sessions=2/),
		);
		expect([...supervisor.workers.keys()].sort()).toEqual(["active", "attached", "cron", "heartbeat"]);
	});

	it("delegates capped child passivation only to live non-evictable workers", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const active = makeWorker("active", [
			makeSummary("active-root", now, { isSessionActive: true }),
			makeSummary("idle-child", now, { runtimeKind: "subagent", parentActiveSessionId: "active-root" }),
		]);
		const whollyIdle = makeWorker("wholly-idle", [makeSummary("idle-root", now)]);
		active.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_passivate_idle_children",
			success: true,
			data: { count: 1 },
		});
		supervisor.workers.set("active", active);
		supervisor.workers.set("wholly-idle", whollyIdle);

		await supervisor.runIdleEvictionSweep(now);

		expect(active.client?.requestWorker).toHaveBeenCalledWith(
			{
				type: "worker_passivate_idle_children",
				idleEvictionMinutes: 90,
				now,
				// Mirrors CHILD_PASSIVATION_PER_WORKER_CAP: this test only verifies
				// the supervisor forwards its configured per-sweep cap on the wire,
				// not that this specific number is correct policy.
				limit: 20,
			},
			30_000,
		);
		expect(whollyIdle.client?.requestWorker).not.toHaveBeenCalled();
		expect(supervisor.stopWorker).toHaveBeenCalledWith(whollyIdle, true);
	});

	it("caps per-sweep child passivation well above the old value of 2, so a worker with dozens of idle subagents behind a still-active root does not accumulate a permanent backlog", async () => {
		// Regression for the real scenario this was diagnosed against: a single
		// worker hosting one still-active root session plus a large RLM fan-out
		// of subagents that finished hours ago. Whole-worker eviction never
		// applies (canEvictWorker requires every session on the worker to be
		// idle), so this worker relies entirely on the per-child passivation
		// path. At the old cap of 2 per sweep, sweeps run roughly every few
		// minutes but new subagent activity on the same worker can add idle
		// candidates faster than 2-per-sweep drains them, so the backlog never
		// shrinks. This asserts the wired limit is materially larger than 2.
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const summaries = [makeSummary("root", now, { isSessionActive: true })];
		for (let i = 0; i < 48; i++) {
			summaries.push(
				makeSummary(`idle-child-${i}`, now, { runtimeKind: "subagent", parentActiveSessionId: "root" }),
			);
		}
		const worker = makeWorker("busy-fanout", summaries);
		worker.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_passivate_idle_children",
			success: true,
			data: { count: 20 },
		});
		supervisor.workers.set("busy-fanout", worker);

		await supervisor.runIdleEvictionSweep(now);

		const call = worker.client?.requestWorker.mock.calls[0]?.[0] as { limit: number } | undefined;
		expect(call?.limit).toBeGreaterThan(2);
		expect(call?.limit).toBeGreaterThanOrEqual(20);
	});

	it("does not fence unrelated mutations while child passivation is in flight", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const active = makeWorker("active", [makeSummary("active-root", now, { isSessionActive: true })]);
		let releasePassivation!: () => void;
		active.client!.requestWorker.mockImplementation(
			() =>
				new Promise((resolve) => {
					releasePassivation = () =>
						resolve({
							type: "response",
							command: "worker_passivate_idle_children",
							success: true,
							data: { count: 0 },
						});
				}),
		);
		supervisor.workers.set("active", active);

		const sweep = supervisor.runIdleEvictionSweep(now);
		await vi.waitFor(() => expect(active.client?.requestWorker).toHaveBeenCalledOnce());

		expect(supervisor.idleEvictionFence).toBeUndefined();
		releasePassivation();
		await sweep;
	});

	it("uses canonical busy state so a stale parent with a running child is not evicted", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const parent = makeWorker("parent", [makeSummary("parent-root", now, { hasRunningRlmChildren: true })]);
		supervisor.workers.set("parent", parent);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.has("parent")).toBe(true);
	});

	it("evicts a paused-heartbeat session but pins an active-heartbeat session", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const paused = makeWorker("paused", [makeSummary("paused-root", now)]);
		const active = makeWorker("active-heartbeat", [
			makeSummary("active-heartbeat-root", now, { hasRegisteredHeartbeat: true }),
		]);
		supervisor.workers.set("paused", paused);
		supervisor.workers.set("active-heartbeat", active);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(paused, true);
		expect(supervisor.workers.has("active-heartbeat")).toBe(true);
	});

	it("honors off after reloading settings at sweep time", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor("off");
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		supervisor.workers.set("idle", idle);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(idle.client?.request).not.toHaveBeenCalled();
	});

	it("awaits an in-flight eviction sweep before shutdown tears down workers", async () => {
		vi.useFakeTimers();
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		vi.setSystemTime(now);
		let resolveList: (response: ReturnType<typeof success>) => void = () => undefined;
		const listResponse = new Promise<ReturnType<typeof success>>((resolve) => {
			resolveList = resolve;
		});
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		idle.client!.request = vi.fn(() => listResponse);
		supervisor.workers.set("idle", idle);
		supervisor.catalog.stop = vi.fn(async () => undefined);
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);

		try {
			supervisor.scheduleIdleEvictionSweep();
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(idle.client?.request).toHaveBeenCalledOnce();

			const shutdown = supervisor.shutdown(42, false).then(
				() => undefined,
				(error: unknown) => error,
			);
			await Promise.resolve();
			expect(exit).not.toHaveBeenCalled();
			expect(supervisor.stopWorker).not.toHaveBeenCalled();

			resolveList(success(undefined, "list", { sessions: [makeSummary("idle-root", now)] }));
			await expect(shutdown).resolves.toEqual(new Error("exit 42"));
			expect(supervisor.stopWorker).not.toHaveBeenCalled();
			expect(exit).toHaveBeenCalledWith(42);
		} finally {
			exit.mockRestore();
			vi.useRealTimers();
		}
	});

	it("reopens an inactive saved session through the existing create path used before attach", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const rootSummary = makeSummary("new-active-id", now, {
			sessionId: "saved-session",
			sessionFile: "/tmp/saved.jsonl",
		});
		const reopened = makeWorker("reopened", [rootSummary]);
		reopened.descriptor.rootActiveSessionId = "new-active-id";
		supervisor.createOrReuseWorker = vi.fn(async () => reopened);
		const client = { id: "viewer", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "create-1",
			type: "create",
			sessionPath: "/tmp/saved.jsonl",
			continueRecent: false,
		});

		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith(
			"viewer",
			expect.objectContaining({ sessionPath: "/tmp/saved.jsonl" }),
		);
		expect(response).toMatchObject({
			success: true,
			command: "create",
			data: { activeSessionId: "new-active-id", sessionId: "saved-session" },
		});
	});

	it("resolves a saved target in the source worker's create-time session directory", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source-session" });
		const source = makeWorker("source", [sourceSummary]);
		Object.assign(source.descriptor, { sessionDir: "/tmp/custom-sessions" });
		source.summaries = new Map([["source-active", sourceSummary]]);
		const targetSummary = makeSummary("target-active", now, {
			sessionId: "target-session",
			sessionFile: "/tmp/target.jsonl",
		});
		const target = makeWorker("target", [targetSummary]);
		target.descriptor.rootActiveSessionId = "target-active";
		target.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_deliver_message",
			success: true,
			data: { deliveryStatus: "delivered" },
		});
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => "/tmp/target.jsonl");
		supervisor.createOrReuseWorker = vi.fn(async () => target);
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "message-1",
			type: "send_message",
			targetActiveSessionId: "target-session",
			fromActiveSessionId: "source-active",
			message: "wake up",
		});

		expect(supervisor.catalog.resolve).toHaveBeenCalledWith("target-session", "/tmp/project", "/tmp/custom-sessions");
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith(
			"sender",
			expect.objectContaining({ type: "create", sessionPath: "/tmp/target.jsonl", continueRecent: false }),
		);
		expect(target.client?.requestWorker).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "worker_deliver_message",
				targetActiveSessionId: "target-active",
				message: "wake up",
			}),
			24 * 60 * 60 * 1000,
		);
		expect(response).toMatchObject({ success: true, id: "message-1", command: "send_message" });
	});

	it("delivers a same-worker name selector through its canonical active session id", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source-session" });
		const targetSummary = makeSummary("target-active", now, {
			sessionId: "target-session",
			sessionName: "Saved target",
		});
		const worker = makeWorker("shared", [sourceSummary, targetSummary]);
		worker.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_deliver_message",
			success: true,
			data: { deliveryStatus: "delivered" },
		});
		supervisor.workers.set("shared", worker);
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "message-same-worker",
			type: "send_message",
			targetActiveSessionId: "Saved target",
			fromActiveSessionId: "source-active",
			message: "continue",
		});

		expect(worker.client?.requestWorker).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "worker_deliver_message",
				targetActiveSessionId: "target-active",
				message: "continue",
			}),
			24 * 60 * 60 * 1000,
		);
		expect(worker.client?.request).not.toHaveBeenCalled();
		expect(response).toMatchObject({
			success: true,
			id: "message-same-worker",
			command: "send_message",
			data: { deliveryStatus: "delivered" },
		});
	});

	it("fails an unknown agent-message selector without forwarding it back to the worker", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const source = makeWorker("source", [makeSummary("source-active", now)]);
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => {
			throw new Error("Unknown saved session: missing-target");
		});
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(client, {
				id: "message-missing",
				type: "send_message",
				targetActiveSessionId: "missing-target",
				fromActiveSessionId: "source-active",
				message: "continue",
			}),
		).rejects.toThrow("Unknown active session: missing-target");
		expect(source.client?.requestWorker).not.toHaveBeenCalled();
		expect(source.client?.request).toHaveBeenCalledOnce();
		expect(source.client?.request).toHaveBeenCalledWith({ type: "list" }, 5000);
	});

	it("propagates an ambiguous saved-session selector during a2a wake", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const source = makeWorker("source", [makeSummary("source-active", now)]);
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => {
			throw new Error('Ambiguous session selector "target"');
		});
		supervisor.createOrReuseWorker = vi.fn();
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(client, {
				id: "message-ambiguous",
				type: "send_message",
				targetActiveSessionId: "target",
				fromActiveSessionId: "source-active",
				message: "wake up",
			}),
		).rejects.toThrow('Ambiguous session selector "target"');
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
	});
});

describe("daemon supervisor idle eviction: real stop -> timeout -> finalizer chain", () => {
	it("logs an eviction sweep timeout, then the background finalizer SIGKILLs and force-cleans up the same worker", async () => {
		// Closes the gap between two previously separate proofs: the eviction test
		// mocks stopWorker (only proves the sweep calls it), while the finalizer
		// tests invoke scheduleWorkerStopFinalization directly (only proves the
		// finalizer itself). This drives the real, un-mocked production path:
		// runIdleEvictionSweep -> real stopWorker -> 2s graceful timeout ->
		// scheduleWorkerStopFinalization -> 5s SIGKILL grace -> forced stopWorker
		// cleanup, with a genuine ResidentWorker (not the shallow WorkerFixture).
		vi.useFakeTimers();
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		vi.setSystemTime(now);
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-eviction-finalizer-"));
		tempDirs.push(directory);
		const descriptorDir = join(directory, "workers");
		mkdirSync(directory, { recursive: true });
		mkdirSync(descriptorDir, { recursive: true });
		writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes: 90 }));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir,
		}) as unknown as SupervisorInternals & {
			workers: Map<string, RealResidentWorkerFixture>;
			stopWorker(
				worker: object,
				removeDescriptor: boolean,
				force?: boolean,
				archiveSession?: boolean,
			): Promise<void>;
		};
		supervisor.log = vi.fn();

		const processStartId = getProcessStartId(process.pid);
		if (processStartId === undefined) {
			throw new Error("Could not identify test process");
		}
		const summary = makeSummary("idle-root", now);
		const worker: RealResidentWorkerFixture = {
			descriptor: {
				version: 2,
				workerId: "idle",
				pid: process.pid,
				processStartId,
				rootActiveSessionId: "idle-root",
				rootSessionId: "idle-root-session",
				socketPath: join(directory, "worker-idle.sock"),
				recoveryJournalPath: join(descriptorDir, "idle.recovery.jsonl"),
				supervisorSocketPath: join(directory, "daemon.sock"),
				authenticationToken: "test-token",
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				lifecycle: "ready",
				createCommand: { type: "create" },
				consecutiveFailures: 0,
			},
			descriptorPath: join(descriptorDir, "idle.json"),
			client: {
				request: vi.fn(async () => success(undefined, "list", { sessions: [summary] })),
				requestWorker: vi.fn(),
				close: vi.fn(),
			},
			summaries: new Map([["idle-root", summary]]),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		supervisor.workers.set("idle", worker);

		// The worker process never actually exits: liveness stays true through the
		// graceful window and the finalizer's own wait, only flipping false once
		// SIGKILL is observed. Using the real test process pid keeps
		// processIdExists() truthful; only the liveness/signal decision is mocked.
		let alive = true;
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation((_pid, signal) => {
			if (signal === "SIGKILL") alive = false;
		});

		try {
			const sweep = supervisor.runIdleEvictionSweep(now).catch((error: unknown) => error);

			// The real stopWorker sends SIGTERM, then polls for up to 2s (non-force
			// graceful deadline) before giving up and scheduling the finalizer.
			await vi.advanceTimersByTimeAsync(2100);
			const sweepResult = await sweep;

			// The scheduled sweep's own catch logs and swallows the timeout instead of
			// throwing "Evicted idle worker" (that log only fires on a successful
			// awaited stop) -- runIdleEvictionSweep itself rejects with the timeout,
			// the caller (scheduleIdleEvictionSweep) is what logs and swallows it.
			expect(sweepResult).toBeInstanceOf(Error);
			expect((sweepResult as Error).message).toContain("did not stop");

			// The worker must still be registered (tombstoned, not deleted) with the
			// finalizer armed in the background -- premature cleanup would strand
			// state or double-run the stop.
			expect(supervisor.workers.has("idle")).toBe(true);
			expect(worker.descriptor.stopRequestedAt).toBeDefined();
			expect(worker.stopFinalization).toBeDefined();
			const finalization = worker.stopFinalization;

			// Advance well past the finalizer's 5s SIGKILL grace period, its 500ms
			// liveness-cache throttle, and the bounded graceful/force deadlines of
			// the retry stopWorker call it makes afterward.
			await vi.advanceTimersByTimeAsync(15_000);
			await finalization;

			expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGKILL");
			// Forced cleanup actually ran and deregistered the worker.
			expect(supervisor.workers.has("idle")).toBe(false);
			expect(worker.stopFinalization).toBeUndefined();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});
