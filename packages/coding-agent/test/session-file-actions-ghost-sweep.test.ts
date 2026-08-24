import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEmptyDraftSessionFile, sweepGhostSessionFiles } from "../src/core/session-file-actions.js";
import {
	acquireSessionLease,
	canonicalSessionPath,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-ghost-sweep-test-"));
	tempDirs.push(directory);
	return directory;
}

function enabledEnvironment(owner: string): NodeJS.ProcessEnv {
	return {
		[SESSION_LEASES_ENABLED_ENV]: "1",
		[SESSION_LEASE_OWNER_ID_ENV]: owner,
	};
}

function writeGhostDraft(sessionPath: string): void {
	const lines = [
		{ type: "session", id: "session-1", timestamp: new Date(0).toISOString(), cwd: "/tmp" },
		{ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" },
		{ type: "thinking_level_change", level: "medium" },
		{ type: "service_tier_change", tier: "auto" },
		{ type: "session_state", state: { status: "active" } },
	];
	writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function writeRealSession(sessionPath: string): void {
	const lines = [
		{ type: "session", id: "session-2", timestamp: new Date(0).toISOString(), cwd: "/tmp" },
		{ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" },
		{
			type: "message",
			id: "m1",
			timestamp: 1,
			message: { role: "user", content: "hello", timestamp: 1 },
		},
	];
	writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("isEmptyDraftSessionFile (fork fix: ghost-sweep)", () => {
	it("is true for a file with only bootstrap and session_state entries", async () => {
		const tempDir = createTempDir();
		const sessionPath = join(tempDir, "ghost.jsonl");
		writeGhostDraft(sessionPath);

		expect(await isEmptyDraftSessionFile(sessionPath)).toBe(true);
	});

	it("is false for a file that contains a real message", async () => {
		const tempDir = createTempDir();
		const sessionPath = join(tempDir, "real.jsonl");
		writeRealSession(sessionPath);

		expect(await isEmptyDraftSessionFile(sessionPath)).toBe(false);
	});

	it("is false for an empty file (no entries at all)", async () => {
		const tempDir = createTempDir();
		const sessionPath = join(tempDir, "empty.jsonl");
		writeFileSync(sessionPath, "");

		expect(await isEmptyDraftSessionFile(sessionPath)).toBe(false);
	});

	it("is false when a line cannot be parsed, rather than risking a false-positive delete", async () => {
		const tempDir = createTempDir();
		const sessionPath = join(tempDir, "malformed.jsonl");
		writeFileSync(sessionPath, '{"type":"session","id":"x"}\nnot json{{{\n');

		expect(await isEmptyDraftSessionFile(sessionPath)).toBe(false);
	});

	it("is false for a nonexistent file", async () => {
		expect(await isEmptyDraftSessionFile("/nonexistent/path/does-not-exist.jsonl")).toBe(false);
	});
});

describe("sweepGhostSessionFiles (fork fix: ghost-sweep)", () => {
	it("deletes a ghost draft file with no live lease", async () => {
		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionPath = join(sessionDir, "ghost.jsonl");
		writeGhostDraft(sessionPath);

		const swept = await sweepGhostSessionFiles(sessionDir, agentDir);

		expect(swept).toBe(1);
		expect(existsSync(sessionPath)).toBe(false);
	});

	it("never deletes a real session file, even without a lease", async () => {
		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionPath = join(sessionDir, "real.jsonl");
		writeRealSession(sessionPath);

		const swept = await sweepGhostSessionFiles(sessionDir, agentDir);

		expect(swept).toBe(0);
		expect(existsSync(sessionPath)).toBe(true);
	});

	it("never deletes a ghost-shaped file that has a live lease (the passive-RLM-child case)", async () => {
		// This is the exact regression the upstream bisection found: a ghost
		// draft and a legitimate passive RLM child share the identical on-disk
		// shape (bootstrap entries + session_state, no messages). The only
		// thing that distinguishes them is whether a live process still holds
		// the lease. This test proves that distinction is honored.
		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionPath = join(sessionDir, "passive-child.jsonl");
		writeGhostDraft(sessionPath);

		const canonicalPath = canonicalSessionPath(sessionPath);
		const lease = acquireSessionLease(canonicalPath, agentDir, enabledEnvironment("passive-rlm-child"));

		try {
			const swept = await sweepGhostSessionFiles(sessionDir, agentDir);

			expect(swept).toBe(0);
			expect(existsSync(sessionPath)).toBe(true);
		} finally {
			lease?.release();
		}
	});

	it("returns 0 without throwing when the session directory does not exist", async () => {
		const tempDir = createTempDir();

		expect(await sweepGhostSessionFiles(join(tempDir, "missing"), join(tempDir, "agent"))).toBe(0);
	});

	it("sweeps only the ghost files among a mix of ghost, real, and leased-ghost sessions", async () => {
		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });

		const ghostPath = join(sessionDir, "ghost.jsonl");
		writeGhostDraft(ghostPath);

		const realPath = join(sessionDir, "real.jsonl");
		writeRealSession(realPath);

		const leasedGhostPath = join(sessionDir, "leased-ghost.jsonl");
		writeGhostDraft(leasedGhostPath);
		const canonicalLeased = canonicalSessionPath(leasedGhostPath);
		const lease = acquireSessionLease(canonicalLeased, agentDir, enabledEnvironment("resident"));

		try {
			const swept = await sweepGhostSessionFiles(sessionDir, agentDir);

			expect(swept).toBe(1);
			expect(existsSync(ghostPath)).toBe(false);
			expect(existsSync(realPath)).toBe(true);
			expect(existsSync(leasedGhostPath)).toBe(true);
		} finally {
			lease?.release();
		}
	});
});
