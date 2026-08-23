import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

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

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	clients: Set<{ id: string; attachedActiveSessionIds: Set<string> }>;
	openingWorkers: Map<string, Promise<unknown>>;
	processIdentity: ReturnType<typeof vi.fn>;
	catalog: {
		resolve: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	launchWorker: ReturnType<typeof vi.fn>;
	reuseWorkerForCreate: ReturnType<typeof vi.fn>;
	createOrReuseWorker(clientId: string, command: object): Promise<unknown>;
	handleCommand(client: object, command: object): Promise<unknown>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date().toISOString(),
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
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: `${id}-descriptor-root`,
			rootSessionId: `${id}-root-session`,
			pid: 1,
			createCommand: { type: "create" },
		},
		client: {
			request: vi.fn(async () => success(undefined, "list", { sessions: summaries })),
			requestWorker: vi.fn(),
			close: vi.fn(),
		},
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
		intentionalStop: false,
	};
}

function makeSupervisor(): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-kill-delete-fallback-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes: 90 }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.stopWorker = vi.fn(async (worker: WorkerFixture) => {
		supervisor.workers.delete(worker.descriptor.workerId);
	});
	supervisor.log = vi.fn();
	supervisor.openingWorkers = new Map();
	supervisor.processIdentity = vi.fn(() => "current" as const);
	supervisor.launchWorker = vi.fn(async (command: { sessionPath?: string }) => {
		const sessionFile = command?.sessionPath;
		const summary = makeSummary("launched-root", {
			activeSessionId: "launched-root",
			sessionId: "launched-root-session",
			sessionFile: sessionFile ?? "/tmp/project/launched.jsonl",
			activity: "idle",
		});
		const fake = makeWorker("launched", [summary]);
		supervisor.workers.set(fake.descriptor.workerId, fake);
		return fake;
	}) as unknown as never;
	supervisor.reuseWorkerForCreate = vi.fn(async (worker: WorkerFixture) => worker) as unknown as never;
	return supervisor;
}

describe("daemon supervisor saved-session delete vs worker summary residency", () => {
	it("deletes a saved session when its file only appears in a catalog-shadow summary (no activeSessionId)", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/echo-1.jsonl";
		const shadow = makeSummary("catalog-shadow", {
			activeSessionId: undefined,
			sessionId: "echo-1",
			sessionFile,
			lifecycle: "live",
			activity: "idle",
		});
		const worker = makeWorker("worker-1", [shadow]);
		supervisor.workers.set(worker.descriptor.workerId, worker);
		supervisor.catalog.delete = vi.fn(async () => ({ status: "deleted" }));

		const response = (await supervisor.handleCommand(
			{ id: "client-1", attachedActiveSessionIds: new Set() } as unknown as object,
			{ id: "cmd-1", type: "delete_saved_session", sessionPath: sessionFile },
		)) as { success: boolean; error?: string; data?: unknown };

		expect(response.success).toBe(true);
		expect(supervisor.catalog.delete).toHaveBeenCalledWith(sessionFile);
	});

	it("refuses delete when a resident summary exists in a DIFFERENT worker than the shadow", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/live-1.jsonl";
		const shadow = makeSummary("shadow", {
			activeSessionId: undefined,
			sessionId: "live-1",
			sessionFile,
		});
		const resident = makeSummary("resident-root", {
			activeSessionId: "resident-root",
			sessionId: "live-1",
			sessionFile,
			activity: "idle",
			isSessionActive: false,
		});
		const shadowWorker = makeWorker("worker-shadow", [shadow]);
		const residentWorker = makeWorker("worker-resident", [resident]);
		supervisor.workers.set(shadowWorker.descriptor.workerId, shadowWorker);
		supervisor.workers.set(residentWorker.descriptor.workerId, residentWorker);
		supervisor.catalog.delete = vi.fn(async () => ({ status: "deleted" }));

		await expect(
			supervisor.handleCommand({ id: "client-2", attachedActiveSessionIds: new Set() } as unknown as object, {
				id: "cmd-2",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			}),
		).rejects.toThrow("Cannot delete the currently active session");
		expect(supervisor.catalog.delete).not.toHaveBeenCalled();
	});

	it("refuses delete when shadow and resident summaries share one worker map", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/live-2.jsonl";
		const shadow = makeSummary("shadow-2", {
			activeSessionId: undefined,
			sessionId: "live-2",
			sessionFile,
		});
		const resident = makeSummary("resident-root-2", {
			activeSessionId: "resident-root-2",
			sessionId: "live-2",
			sessionFile,
		});
		const worker = makeWorker("worker-3", [shadow, resident]);
		supervisor.workers.set(worker.descriptor.workerId, worker);
		supervisor.catalog.delete = vi.fn(async () => ({ status: "deleted" }));

		await expect(
			supervisor.handleCommand({ id: "client-3", attachedActiveSessionIds: new Set() } as unknown as object, {
				id: "cmd-3",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			}),
		).rejects.toThrow("Cannot delete the currently active session");
		expect(supervisor.catalog.delete).not.toHaveBeenCalled();
	});

	it("serializes delete against a create for the same canonical path (delete wins the lock, create waits)", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/opening-1.jsonl";
		// Pause the delete inside catalog.delete so it provably holds the
		// session-path lock while a create arrives for the same file.
		let releaseDelete!: () => void;
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		supervisor.catalog.delete = vi.fn(async () => {
			await deleteGate;
			return { status: "deleted" };
		});
		const deletePromise = supervisor.handleCommand(
			{ id: "client-5", attachedActiveSessionIds: new Set() } as unknown as object,
			{ id: "cmd-5", type: "delete_saved_session", sessionPath: sessionFile },
		);
		// Give the delete a tick to acquire the lock and reach catalog.delete.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(supervisor.catalog.delete).toHaveBeenCalledTimes(1);
		// A concurrent create for the same path must not publish residency
		// while the delete holds the lock. Launch is stubbed; if the lock were
		// absent, this would resolve and mark residency before the delete
		// completes.
		let createResolved = false;
		const createPromise = supervisor
			.createOrReuseWorker("client-5", {
				type: "create",
				sessionPath: sessionFile,
			} as never)
			.then(() => {
				createResolved = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(createResolved).toBe(false);
		// Release the delete; both then complete, delete first.
		releaseDelete();
		await deletePromise;
		await createPromise;
	});

	it("deletes when the only matching worker is a stale registration whose process is confirmed dead", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/ghost-1.jsonl";
		// A ghost worker: no client, stop requested, process gone. Its summary
		// still carries an activeSessionId, but it is not a live owner.
		const ghost = makeSummary("ghost-root", {
			activeSessionId: "ghost-root",
			sessionId: "ghost-1",
			sessionFile,
		});
		const worker = makeWorker("worker-ghost", [ghost]);
		worker.client = undefined;
		worker.descriptor.stopRequestedAt = "2026-08-01T00:00:00.000Z";
		supervisor.workers.set(worker.descriptor.workerId, worker);
		supervisor.catalog.delete = vi.fn(async () => ({ status: "deleted" }));
		// stub processIdentity to report the recorded process as gone
		supervisor.processIdentity = vi.fn(() => "gone" as const);

		const response = (await supervisor.handleCommand(
			{ id: "client-6", attachedActiveSessionIds: new Set() } as unknown as object,
			{ id: "cmd-6", type: "delete_saved_session", sessionPath: sessionFile },
		)) as { success: boolean; error?: string };

		expect(response.success).toBe(true);
		expect(supervisor.catalog.delete).toHaveBeenCalledWith(sessionFile);
	});

	it("refuses delete for a resident idle detached session (activeSessionId set, isSessionActive false, attachedClients 0)", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/live-3.jsonl";
		const resident = makeSummary("resident-root-3", {
			activeSessionId: "resident-root-3",
			sessionId: "live-3",
			sessionFile,
			activity: "idle",
			isSessionActive: false,
			attachedClients: 0,
		});
		const worker = makeWorker("worker-4", [resident]);
		supervisor.workers.set(worker.descriptor.workerId, worker);
		supervisor.catalog.delete = vi.fn(async () => ({ status: "deleted" }));

		await expect(
			supervisor.handleCommand({ id: "client-4", attachedActiveSessionIds: new Set() } as unknown as object, {
				id: "cmd-4",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			}),
		).rejects.toThrow("Cannot delete the currently active session");
		expect(supervisor.catalog.delete).not.toHaveBeenCalled();
	});
	it("refuses delete when a create holds the lock and publishes residency (create-first/delete-second, concurrent)", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/create-first.jsonl";
		supervisor.catalog.delete = vi.fn(async () => ({ status: "deleted" }));
		// Gate the create's launch so the create holds the session-path lock
		// and has NOT yet published residency when the delete arrives.
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		supervisor.launchWorker = vi.fn(async () => {
			await launchGate;
			const summary = makeSummary("resident-cf", {
				activeSessionId: "resident-cf",
				sessionId: "cf-1",
				sessionFile,
				activity: "idle",
			});
			const fake = makeWorker("launched-cf", [summary]);
			supervisor.workers.set(fake.descriptor.workerId, fake);
			return fake;
		}) as unknown as never;
		const createPromise = supervisor.createOrReuseWorker("client-cf", {
			type: "create",
			sessionPath: sessionFile,
		} as never);
		// Let the create reach the gated launch (holding the lock).
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Delete arrives concurrently; it must queue on the lock.
		const deletePromise = supervisor.handleCommand(
			{ id: "client-cf2", attachedActiveSessionIds: new Set() } as unknown as object,
			{ id: "cmd-cf", type: "delete_saved_session", sessionPath: sessionFile },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(supervisor.catalog.delete).not.toHaveBeenCalled();
		// Release the create: it publishes the resident summary, completes,
		// releases the lock; the queued delete then observes residency and
		// refuses.
		releaseLaunch();
		await createPromise;
		await expect(deletePromise).rejects.toThrow("Cannot delete the currently active session");
		expect(supervisor.catalog.delete).not.toHaveBeenCalled();
	});

	it("launches exactly one worker when two creates queue behind a held delete", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/two-creates.jsonl";
		// Hold the delete in flight (gate inside catalog.delete) so both
		// creates queue behind the same lock.
		let releaseDelete!: () => void;
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		supervisor.catalog.delete = vi.fn(async () => {
			await deleteGate;
			return { status: "deleted" };
		});
		const deletePromise = supervisor.handleCommand(
			{ id: "client-tc", attachedActiveSessionIds: new Set() } as unknown as object,
			{ id: "cmd-tc", type: "delete_saved_session", sessionPath: sessionFile },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(supervisor.catalog.delete).toHaveBeenCalledTimes(1);
		// Two creates for the same path while delete holds the lock.
		const launchWorkerMock = supervisor.launchWorker;
		const c1 = supervisor.createOrReuseWorker("client-tc1", { type: "create", sessionPath: sessionFile } as never);
		const c2 = supervisor.createOrReuseWorker("client-tc2", { type: "create", sessionPath: sessionFile } as never);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(launchWorkerMock).not.toHaveBeenCalled();
		releaseDelete();
		await Promise.all([deletePromise, c1, c2]);
		expect(launchWorkerMock).toHaveBeenCalledTimes(1);
	});
	it("refuses delete by name-form selector when the resolved file is resident", async () => {
		const supervisor = makeSupervisor();
		const sessionFile = "/tmp/project/sessions/name-resident.jsonl";
		const resident = makeSummary("resident-name", {
			activeSessionId: "resident-name",
			sessionId: "name-resident",
			sessionFile,
			activity: "idle",
		});
		const worker = makeWorker("worker-name", [resident]);
		supervisor.workers.set(worker.descriptor.workerId, worker);
		supervisor.catalog.delete = vi.fn(async () => ({ status: "deleted" }));
		supervisor.catalog.resolve = vi.fn(async () => sessionFile);

		await expect(
			supervisor.handleCommand({ id: "client-n", attachedActiveSessionIds: new Set() } as unknown as object, {
				id: "cmd-n",
				type: "delete_saved_session",
				sessionPath: "name-resident",
			}),
		).rejects.toThrow("Cannot delete the currently active session");
		expect(supervisor.catalog.delete).not.toHaveBeenCalled();
	});
});
