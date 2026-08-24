import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAgentSessionMessage } from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { normalizeRequestedRlmIsolation } from "../src/core/rlm-runtime.js";
import {
	deriveRlmWorktreeRefs,
	deriveRlmWorktreeRepoKey,
	encodeRefComponent,
	escapeWorktreeNotePath,
	parseGitPorcelainZPaths,
	RLM_WORKTREE_CAP_GLOBAL_ENV,
	RLM_WORKTREE_CAP_PER_PARENT_ENV,
	RLM_WORKTREE_ENV_NOTE,
	RlmWorktreeLifecycleManager,
	sweepDeadRlmWorktreeSessions,
} from "../src/core/rlm-worktrees.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

// Record every git command while delegating to the real implementation so the
// grep gates (no --force, no prune, argument-array form) can assert exactly.
const { recordedGitCalls } = vi.hoisted(() => {
	const recordedGitCalls: { command: string; args: string[]; cwd: string }[] = [];
	return { recordedGitCalls };
});
vi.mock("../src/core/exec.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/exec.js")>();
	return {
		...actual,
		execCommand: vi.fn(
			(
				command: string,
				args: string[],
				cwd: string,
				options?: { timeout?: number; env?: Record<string, string | undefined> },
			) => {
				if (command === "git") {
					recordedGitCalls.push({ command, args, cwd });
				}
				return actual.execCommand(command, args, cwd, options);
			},
		),
	};
});

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const lastMessage = context.messages[context.messages.length - 1] as AgentMessage | undefined;
	if (!lastMessage) return "";
	if (isAgentSessionMessage(lastMessage)) {
		return lastMessage.content.replace(/^\[task from parent\]\n\n/, "");
	}
	if (lastMessage.role !== "user") return "";
	if (typeof lastMessage.content === "string") {
		return lastMessage.content.replace(/^\[task from parent\]\n\n/, "");
	}
	const text = lastMessage.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return text.replace(/^\[task from parent\]\n\n/, "");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistantMessage(text);
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t.co");
	git(dir, "config", "user.name", "t");
	writeFileSync(join(dir, "file.txt"), "hello\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return git(dir, "rev-parse", "HEAD");
}

describe("normalizeRequestedRlmIsolation", () => {
	it("accepts undefined, null, and the literal worktree", () => {
		expect(normalizeRequestedRlmIsolation(undefined)).toBeUndefined();
		expect(normalizeRequestedRlmIsolation(null)).toBeUndefined();
		expect(normalizeRequestedRlmIsolation("worktree")).toBe("worktree");
	});

	it("throws a clear error for anything else", () => {
		expect(() => normalizeRequestedRlmIsolation(7)).toThrow('rlm.run isolation must be "worktree" when provided');
		expect(() => normalizeRequestedRlmIsolation("")).toThrow('rlm.run isolation must be "worktree" when provided');
		expect(() => normalizeRequestedRlmIsolation("sandbox")).toThrow(
			'rlm.run isolation must be "worktree" when provided',
		);
		expect(() => normalizeRequestedRlmIsolation({})).toThrow('rlm.run isolation must be "worktree" when provided');
	});
});

describe("rlm worktree ref helpers", () => {
	it("encodes ref components and rejects reserved forms", () => {
		expect(encodeRefComponent("prime-agent-2026-08-24T00-00-00")).toBe("prime-agent-2026-08-24T00-00-00");
		expect(encodeRefComponent("a/b c:d")).toBe("a-b-c-d");
		expect(() => encodeRefComponent("")).toThrow();
		expect(() => encodeRefComponent(".")).toThrow();
		expect(() => encodeRefComponent("..")).toThrow();
		expect(() => encodeRefComponent("name.lock")).toThrow();
	});

	it("derives namespaced branch and preservation refs", () => {
		const refs = deriveRlmWorktreeRefs("prime-agent-123", "sub-1234abcd");
		expect(refs.branch).toBe("refs/heads/rlm-wt/prime-agent-123/sub-1234abcd");
		expect(refs.preservationRef).toBe("refs/rlm-preserved/prime-agent-123/sub-1234abcd");
	});

	it("derives a stable repo key from root + common dir", () => {
		const key = deriveRlmWorktreeRepoKey("/repos/x", "/repos/x/.git");
		expect(key).toMatch(/^[0-9a-f]{16}$/);
		expect(key).toBe(deriveRlmWorktreeRepoKey("/repos/x", "/repos/x/.git"));
		expect(key).not.toBe(deriveRlmWorktreeRepoKey("/repos/y", "/repos/y/.git"));
	});

	it("parses NUL-delimited porcelain paths including renames", () => {
		expect(parseGitPorcelainZPaths(" M file.txt\0?? untracked.txt\0")).toEqual(["file.txt", "untracked.txt"]);
		expect(parseGitPorcelainZPaths("RM b.txt\0a.txt\0?? new\0")).toEqual(["b.txt", "a.txt", "new"]);
		expect(parseGitPorcelainZPaths("")).toEqual([]);
	});

	it("escapes paths for literal one-per-line embedding", () => {
		expect(escapeWorktreeNotePath("plain/path.txt")).toBe('"plain/path.txt"');
		expect(escapeWorktreeNotePath('weird\nname"quote')).toBe('"weird\\nname\\"quote"');
	});
});

describe("RlmWorktreeLifecycleManager", () => {
	let tempDir: string;
	let repoDir: string;
	let worktreeRoot: string;
	let manager: RlmWorktreeLifecycleManager;
	let parentSessionId: string;
	const childId = "sub-1234abcd";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "rlm-wt-"));
		repoDir = join(tempDir, "repo");
		initRepo(repoDir);
		// Parent runs from a repo SUBDIRECTORY (test-plan requirement 7).
		mkdirSync(join(repoDir, "packages", "sub"), { recursive: true });
		writeFileSync(join(repoDir, "packages", "sub", "tracked.txt"), "tracked\n");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "subdir");
		worktreeRoot = join(tempDir, "rlm-worktrees");
		manager = new RlmWorktreeLifecycleManager({ root: worktreeRoot });
		parentSessionId = `prime-agent-${Date.now()}`;
		delete process.env[RLM_WORKTREE_CAP_PER_PARENT_ENV];
		delete process.env[RLM_WORKTREE_CAP_GLOBAL_ENV];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		delete process.env[RLM_WORKTREE_CAP_PER_PARENT_ENV];
		delete process.env[RLM_WORKTREE_CAP_GLOBAL_ENV];
	});

	afterAll(() => {
		// Grep gate: the feature never runs a forced removal or a repo-wide prune.
		for (const call of recordedGitCalls) {
			expect(call.args.join(" ")).not.toContain("--force");
			expect(call.args.join(" ")).not.toContain("prune");
		}
	});

	function childSessionDirFor(): string {
		const dir = mkdtempSync(join(tempDir, `sessions-${childId}-`));
		return dir;
	}

	async function admit(): Promise<Awaited<ReturnType<RlmWorktreeLifecycleManager["admitWorktree"]>>> {
		return manager.admitWorktree({
			parentCwd: join(repoDir, "packages", "sub"),
			parentSessionId,
			childId,
			childSessionDir: childSessionDirFor(),
		});
	}

	it("admits a worktree with derived paths, branch, mapped cwd, and env note", async () => {
		const admission = await admit();
		const namespaceDir = manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId);
		expect(admission.worktreePath).toBe(join(namespaceDir, childId));
		expect(admission.branch).toBe(`refs/heads/rlm-wt/${parentSessionId}/${childId}`);
		expect(admission.cwdOverride).toBe(join(admission.worktreePath, "packages", "sub"));
		expect(existsSync(admission.cwdOverride)).toBe(true);
		// Child cwd is distinct from the parent cwd and lives in the worktree.
		expect(admission.cwdOverride).not.toBe(join(repoDir, "packages", "sub"));
		// Branch was created and is check-ref-format valid.
		expect(git(repoDir, "branch", "--list", "rlm-wt/*/sub-1234abcd")).toContain("rlm-wt/");
		// Env note is always present with the exact wording.
		expect(admission.notes.join("\n")).toMatch(/untracked or ignored artifacts/i);
		expect(RLM_WORKTREE_ENV_NOTE).toMatch(/untracked or ignored artifacts/i);
		// Durable record exists with ACTIVE status and verified identity fields.
		const record = JSON.parse(readFileSync(join(namespaceDir, `${childId}.rlm.json`), "utf8"));
		expect(record.status).toBe("ACTIVE");
		expect(record.version).toBe(1);
		expect(record.repoRoot).toBe(admission.repoRoot);
		expect(record.gitCommonDir).toBe(admission.gitCommonDir);
		expect(record.cwdRelPath).toBe("packages/sub");
		// Exactly one registration under the namespace.
		const listed = git(repoDir, "worktree", "list", "--porcelain");
		expect(listed.split(admission.worktreePath).length - 1).toBe(1);
	});

	it("maps the child cwd to the worktree root when the parent runs at the repo root", async () => {
		const admission = await manager.admitWorktree({
			parentCwd: repoDir,
			parentSessionId,
			childId,
			childSessionDir: childSessionDirFor(),
		});
		expect(admission.cwdOverride).toBe(admission.worktreePath);
		expect(admission.notes.join("\n")).not.toContain("does not exist in the fresh checkout");
	});

	it("lists dirty parent paths (modified, staged, untracked) in a prepended note", async () => {
		writeFileSync(join(repoDir, "packages", "sub", "tracked.txt"), "modified\n");
		git(repoDir, "add", join(repoDir, "packages", "sub", "tracked.txt"));
		writeFileSync(join(repoDir, "untracked.txt"), "u\n");
		const admission = await admit();
		const notes = admission.notes.join("\n");
		expect(notes).toContain("[RLM WORKTREE NOTE]");
		expect(notes).toContain('"packages/sub/tracked.txt"');
		expect(notes).toContain('"untracked.txt"');
		expect(notes).toContain("This worktree's baseline (HEAD) does not include them");
	});

	it("fails clearly when the parent cwd is not inside a git repository", async () => {
		const outside = mkdtempSync(join(tempDir, "no-git-"));
		await expect(
			manager.admitWorktree({
				parentCwd: outside,
				parentSessionId,
				childId,
				childSessionDir: childSessionDirFor(),
			}),
		).rejects.toThrow("requires the parent session cwd to be inside a git repository");
	});

	it("enforces the per-parent cap atomically and fails the next spawn at cap", async () => {
		process.env[RLM_WORKTREE_CAP_PER_PARENT_ENV] = "2";
		const admissionOne = await manager.admitWorktree({
			parentCwd: repoDir,
			parentSessionId,
			childId,
			childSessionDir: childSessionDirFor(),
		});
		expect(admissionOne).toBeDefined();
		const admissionTwo = await manager.admitWorktree({
			parentCwd: repoDir,
			parentSessionId,
			childId: "sub-2234abcd",
			childSessionDir: childSessionDirFor(),
		});
		expect(admissionTwo).toBeDefined();
		await expect(
			manager.admitWorktree({
				parentCwd: repoDir,
				parentSessionId,
				childId: "sub-3234abcd",
				childSessionDir: childSessionDirFor(),
			}),
		).rejects.toThrow("per-parent cap reached");
		// The failed admission reserved nothing.
		const namespaceDir = manager.namespaceDirFor(admissionOne.repoRoot, admissionOne.gitCommonDir, parentSessionId);
		expect(readdirSync(namespaceDir).filter((name) => name.endsWith(".rlm.json"))).toHaveLength(2);
	});

	it("enforces the global cap under the global lock", async () => {
		process.env[RLM_WORKTREE_CAP_GLOBAL_ENV] = "1";
		await manager.admitWorktree({
			parentCwd: repoDir,
			parentSessionId,
			childId,
			childSessionDir: childSessionDirFor(),
		});
		await expect(
			manager.admitWorktree({
				parentCwd: repoDir,
				parentSessionId: "another-session",
				childId: "sub-2234abcd",
				childSessionDir: childSessionDirFor(),
			}),
		).rejects.toThrow("global cap reached");
	});

	it("finalize pins the preservation ref, WIP-commits untracked content, and removes cleanly", async () => {
		const admission = await admit();
		// Child work products: a commit on its branch plus untracked residue.
		writeFileSync(join(admission.worktreePath, "child-work.txt"), "committed\n");
		git(admission.worktreePath, "add", "-A");
		git(admission.worktreePath, "commit", "-q", "-m", "child work");
		const finalSha = git(admission.worktreePath, "rev-parse", "HEAD");
		writeFileSync(join(admission.worktreePath, "wip.txt"), "untracked wip\n");

		const entry = await manager.finalizeWorktree({
			parentSessionId,
			childId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(entry.outcome).toBe("reaped");
		expect(entry.wipPinned).toBe(true);
		// Preservation ref pins the child's final HEAD (pre-WIP); the WIP commit is
		// retained on the branch so every byte stays reachable.
		expect(git(admission.repoRoot, "rev-parse", `refs/rlm-preserved/${parentSessionId}/${childId}`)).toBe(finalSha);
		const finalBranchTip = git(admission.repoRoot, "rev-parse", admission.branch);
		expect(finalBranchTip).not.toBe(finalSha);
		// Worktree removed and record deleted.
		expect(existsSync(admission.worktreePath)).toBe(false);
		expect(
			existsSync(
				join(
					manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId),
					`${childId}.rlm.json`,
				),
			),
		).toBe(false);
		// WIP commit is authored by the deterministic identity and includes untracked files.
		expect(git(admission.repoRoot, "log", "-1", "--format=%an", admission.branch)).toBe("RLM Worktree Cleanup");
		const wipFiles = git(admission.repoRoot, "show", "--name-only", "--format=", admission.branch).trim();
		expect(wipFiles).toContain("wip.txt");
	});

	it("pins the preservation ref even when the child detached HEAD", async () => {
		const admission = await admit();
		const originalSha = git(admission.worktreePath, "rev-parse", "HEAD");
		git(admission.worktreePath, "checkout", "-q", "--detach", "HEAD");
		const entry = await manager.finalizeWorktree({
			parentSessionId,
			childId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(entry.outcome).toBe("reaped");
		expect(git(admission.repoRoot, "rev-parse", `refs/rlm-preserved/${parentSessionId}/${childId}`)).toBe(
			originalSha,
		);
	});

	it("aborts cleanup and retains the worktree when a process still holds its cwd", async () => {
		const admission = await admit();
		const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
			cwd: admission.worktreePath,
			stdio: "ignore",
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		const entry = await manager.finalizeWorktree({
			parentSessionId,
			childId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(entry.outcome).toBe("cleanup_failed");
		expect(entry.error).toContain("processes still hold cwd");
		expect(existsSync(admission.worktreePath)).toBe(true);
		proc.kill("SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const retry = await manager.finalizeWorktree({
			parentSessionId,
			childId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(retry.outcome).toBe("reaped");
		expect(existsSync(admission.worktreePath)).toBe(false);
	});

	it("reconcile adopts live children and reaps dead ones", async () => {
		const admission = await admit();
		const params = {
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
		};
		const reportLive = await manager.reconcileNamespace({
			...params,
			isChildLive: () => true,
		});
		expect(reportLive.some((entry) => entry.childId === childId && entry.outcome === "adopted")).toBe(true);
		expect(existsSync(admission.worktreePath)).toBe(true);

		const reportDead = await manager.reconcileNamespace({
			...params,
			isChildLive: () => false,
		});
		const reaped = reportDead.find((entry) => entry.childId === childId);
		expect(reaped?.outcome).toBe("reaped");
		expect(existsSync(admission.worktreePath)).toBe(false);
		expect(git(admission.repoRoot, "rev-parse", `refs/rlm-preserved/${parentSessionId}/${childId}`)).toBeTruthy();
	});

	it("reconcile rule 5: stale record without registration or dir is deleted", async () => {
		const admission = await admit();
		const namespaceDir = manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId);
		git(admission.repoRoot, "worktree", "remove", "--force", admission.worktreePath);
		rmSync(admission.worktreePath, { recursive: true, force: true });
		const report = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(report.some((entry) => entry.childId === childId && entry.outcome === "cleaned_record")).toBe(true);
		expect(existsSync(join(namespaceDir, `${childId}.rlm.json`))).toBe(false);
	});

	it("reconcile rule 6: record + registration with missing dir removes the stale registration", async () => {
		const admission = await admit();
		const namespaceDir = manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId);
		rmSync(admission.worktreePath, { recursive: true, force: true });
		const report = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(report.some((entry) => entry.childId === childId && entry.outcome === "removed_registration")).toBe(true);
		expect(existsSync(join(namespaceDir, `${childId}.rlm.json`))).toBe(false);
		expect(git(admission.repoRoot, "worktree", "list", "--porcelain")).not.toContain(admission.worktreePath);
	});

	it("reconcile rule 3: registration without record is reconstructed and reaped when dead", async () => {
		const admission = await admit();
		const namespaceDir = manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId);
		rmSync(join(namespaceDir, `${childId}.rlm.json`));
		const report = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		const reaped = report.find((entry) => entry.childId === childId);
		expect(reaped?.outcome).toBe("reaped");
		expect(existsSync(admission.worktreePath)).toBe(false);
		expect(git(admission.repoRoot, "rev-parse", `refs/rlm-preserved/${parentSessionId}/${childId}`)).toBeTruthy();
	});

	it("reconcile rule 3: registration without record is adopted when the owner is live", async () => {
		const admission = await admit();
		const namespaceDir = manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId);
		rmSync(join(namespaceDir, `${childId}.rlm.json`));
		const report = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => true,
		});
		expect(report.some((entry) => entry.childId === childId && entry.outcome === "adopted")).toBe(true);
		expect(existsSync(admission.worktreePath)).toBe(true);
		expect(existsSync(join(namespaceDir, `${childId}.rlm.json`))).toBe(true);
	});

	it("reconcile rule 4: record with unregistered dir quarantines the record and leaves the dir", async () => {
		const admission = await admit();
		const namespaceDir = manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId);
		// Simulate a lost registration: delete only the worktree admin metadata,
		// leaving the directory in place (the crash window rule 4 models).
		const gitdirTarget = readFileSync(join(admission.worktreePath, ".git"), "utf8").trim();
		rmSync(gitdirTarget.replace(/^gitdir: /, ""), { recursive: true, force: true });
		const report = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(report.some((entry) => entry.childId === childId && entry.outcome === "quarantined")).toBe(true);
		expect(existsSync(admission.worktreePath)).toBe(true);
		expect(existsSync(join(namespaceDir, "quarantine", `${childId}.rlm.json.bad`))).toBe(true);
	});

	it("reconcile rule 7: unknown residue dir is left in place", async () => {
		const identity = await manager.resolveRepoIdentity(repoDir);
		expect(identity).toBeDefined();
		const namespaceDir = manager.namespaceDirFor(identity!.repoRoot, identity!.gitCommonDir, parentSessionId);
		mkdirSync(join(namespaceDir, "sub-9999abcd"), { recursive: true });
		const report = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: identity!.repoRoot,
			gitCommonDir: identity!.gitCommonDir,
			isChildLive: () => false,
		});
		expect(report.some((entry) => entry.childId === "sub-9999abcd" && entry.outcome === "left")).toBe(true);
		expect(existsSync(join(namespaceDir, "sub-9999abcd"))).toBe(true);
	});

	it("quarantines malformed and path-tampered records and never executes against them", async () => {
		const admission = await admit();
		const namespaceDir = manager.namespaceDirFor(admission.repoRoot, admission.gitCommonDir, parentSessionId);
		const recordPath = join(namespaceDir, `${childId}.rlm.json`);
		// Path-tampered record: worktreePath no longer equals the derived path.
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		record.worktreePath = "/tmp/attacker-controlled";
		writeFileSync(recordPath, JSON.stringify(record));
		const tamperReport = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(tamperReport.some((entry) => entry.childId === childId && entry.outcome === "quarantined")).toBe(true);
		expect(existsSync(join(namespaceDir, "quarantine", `${childId}.rlm.json.bad`))).toBe(true);
		expect(existsSync(admission.worktreePath)).toBe(true);

		// Malformed record for a second child.
		writeFileSync(join(namespaceDir, "sub-7777abcd.rlm.json"), "{not json");
		const malformedReport = await manager.reconcileNamespace({
			parentSessionId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(malformedReport.some((entry) => entry.childId === "sub-7777abcd" && entry.outcome === "quarantined")).toBe(
			true,
		);
	});

	it("host sweep reaps dead-session namespaces and keeps live ones", async () => {
		const deadAdmission = await manager.admitWorktree({
			parentCwd: repoDir,
			parentSessionId: "dead-session",
			childId: "sub-5555abcd",
			childSessionDir: childSessionDirFor(),
		});
		const liveAdmission = await manager.admitWorktree({
			parentCwd: repoDir,
			parentSessionId: "live-session",
			childId: "sub-6666abcd",
			childSessionDir: childSessionDirFor(),
		});
		const report = await sweepDeadRlmWorktreeSessions({
			agentDir: tempDir,
			isSessionLive: (sessionId) => sessionId === "live-session",
		});
		expect(report.some((entry) => entry.childId === "sub-5555abcd" && entry.outcome === "reaped")).toBe(true);
		expect(existsSync(deadAdmission.worktreePath)).toBe(false);
		expect(existsSync(liveAdmission.worktreePath)).toBe(true);
		expect(report.some((entry) => entry.childId === "sub-6666abcd")).toBe(false);
	});

	it("exposes handle metadata with status transitions and preservation refs", async () => {
		const admission = await admit();
		const metadata = manager.getHandleMetadata(admission.repoRoot, admission.gitCommonDir, parentSessionId, childId);
		expect(metadata).toEqual({
			isolation: "worktree",
			worktreePath: admission.worktreePath,
			worktreeBranch: admission.branch,
			worktreeStatus: "ACTIVE",
		});
		writeFileSync(join(admission.worktreePath, "wip.txt"), "dirty\n");
		await manager.finalizeWorktree({
			parentSessionId,
			childId,
			repoRoot: admission.repoRoot,
			gitCommonDir: admission.gitCommonDir,
			isChildLive: () => false,
		});
		expect(
			manager.getHandleMetadata(admission.repoRoot, admission.gitCommonDir, parentSessionId, childId),
		).toBeUndefined();
	});
});

interface InspectableWorktreeSession {
	_activeRlmChildRuns: Map<string, { id: string; status: string; settled: boolean; session?: AgentSession }>;
	_rlmChildSessions: Map<string, AgentSession>;
	_rlmWorktreeAdmissions: Map<string, { worktreePath: string; branch: string }>;
	disposeAsync(): Promise<void>;
}

describe("AgentSession worktree isolation", () => {
	let tempDir: string;
	let repoDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "rlm-wt-session-"));
		repoDir = join(tempDir, "repo");
		initRepo(repoDir);
		delete process.env[RLM_WORKTREE_CAP_PER_PARENT_ENV];
		delete process.env[RLM_WORKTREE_CAP_GLOBAL_ENV];
	});

	afterEach(async () => {
		if (session) {
			await session.disposeAsync().catch(() => undefined);
			session = undefined;
		}
		rmSync(tempDir, { recursive: true, force: true });
		delete process.env[RLM_WORKTREE_CAP_PER_PARENT_ENV];
		delete process.env[RLM_WORKTREE_CAP_GLOBAL_ENV];
	});

	function createSession(options: { cwd?: string } = {}): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(options.cwd ?? repoDir, join(tempDir, "sessions"));
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "",
				tools: [],
				thinkingLevel: "off",
			},
			streamFn: (_context, context) => streamAnswer(`child answer: ${userText(context)}`),
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: options.cwd ?? repoDir,
			agentDir: tempDir,
			rlmWorktreeRoot: join(tempDir, "rlm-worktrees"),
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({}),
		});
		return session;
	}

	it("spawns a worktree child with cwd inside the worktree and exposes handle metadata", async () => {
		const parent = createSession();
		const handle = await parent.runRlmChild("work in the repo", { isolation: "worktree" });
		expect(handle.isolation).toBe("worktree");
		expect(handle.worktree_path).toContain("rlm-worktrees");
		expect(handle.worktree_branch).toMatch(/^refs\/heads\/rlm-wt\/.*\/sub-[0-9a-f]{8}$/);
		expect(handle.worktree_status).toBe("ACTIVE");
		expect(existsSync(handle.worktree_path ?? "")).toBe(true);
		const childId = handle.rlm_child_id;
		expect(childId).toMatch(/^sub-[0-9a-f]{8}$/);
		// Child cwd = worktree root (parent ran at the repo root).
		await vi.waitFor(async () => {
			const run = [...(parent as unknown as InspectableWorktreeSession)._activeRlmChildRuns.values()].find(
				(candidate) => candidate.id === childId,
			);
			expect(run?.session).toBeDefined();
		});
		const run = [...(parent as unknown as InspectableWorktreeSession)._activeRlmChildRuns.values()].find(
			(candidate) => candidate.id === childId,
		);
		const childCwd = (run?.session as unknown as { _cwd: string })?._cwd;
		expect(childCwd).toBe(handle.worktree_path);
		// Registry entries expose the same metadata.
		const listed = await parent.listRlmSubagents();
		const entry = listed.subagents.find((candidate) => candidate.rlm_child_id === childId);
		expect(entry?.isolation).toBe("worktree");
		expect(entry?.worktree_status).toBe("ACTIVE");
	});

	it("fails with a clear error for a non-git parent cwd and admits nothing", async () => {
		const outside = mkdtempSync(join(tempDir, "no-git-"));
		const parent = createSession({ cwd: outside });
		await expect(parent.runRlmChild("task", { isolation: "worktree" })).rejects.toThrow(
			"requires the parent session cwd to be inside a git repository",
		);
		expect([...(parent as unknown as InspectableWorktreeSession)._activeRlmChildRuns]).toHaveLength(0);
	});

	it("rejects unsupported isolation values while other new kwargs still throw", async () => {
		const parent = createSession();
		await expect(parent.runRlmChild("task", { isolation: "sandbox" })).rejects.toThrow(
			'rlm.run isolation must be "worktree" when provided',
		);
		await expect(parent.runRlmChild("task", { someFutureKwarg: true })).rejects.toThrow(
			"Unsupported rlm.run kwargs: someFutureKwarg",
		);
	});

	it("prepends worktree notes before the caller prompt", async () => {
		// Dirty the parent so the dirty-parent note is injected too.
		writeFileSync(join(repoDir, "untracked.txt"), "u\n");
		const parent = createSession();
		const childId = (await parent.runRlmChild("caller prompt text", { isolation: "worktree" })).rlm_child_id;
		const run = [...(parent as unknown as InspectableWorktreeSession)._activeRlmChildRuns.values()].find(
			(candidate) => candidate.id === childId,
		);
		await vi.waitFor(() => expect(run?.session).toBeDefined());
		const child = run?.session;
		const spawnMessageOf = (): string | undefined => {
			const spawnEntry = child?.messages.find((message) => {
				const content = (message as { content?: unknown }).content;
				return typeof content === "string" && content.includes("caller prompt text");
			});
			return (spawnEntry as { content?: unknown } | undefined)?.content as string | undefined;
		};
		await vi.waitFor(() => expect(spawnMessageOf()).toBeDefined());
		const spawnMessage = spawnMessageOf();
		expect(spawnMessage).toBeDefined();
		const notesIndex = spawnMessage!.indexOf("[RLM WORKTREE NOTE]");
		const envIndex = spawnMessage!.indexOf("[RLM ENV NOTE]");
		const callerIndex = spawnMessage!.indexOf("caller prompt text");
		expect(notesIndex).toBeGreaterThanOrEqual(0);
		expect(envIndex).toBeGreaterThanOrEqual(0);
		expect(notesIndex).toBeLessThan(callerIndex);
		expect(envIndex).toBeLessThan(callerIndex);
		expect(spawnMessage).toContain('"untracked.txt"');
	});

	it("admits concurrent direct worktree spawns without over-counting the cap", async () => {
		const parent = createSession();
		const [first, second, third] = await Promise.all([
			parent.runRlmChild("one", { isolation: "worktree" }),
			parent.runRlmChild("two", { isolation: "worktree" }),
			parent.runRlmChild("three", { isolation: "worktree" }),
		]);
		const paths = new Set([first.worktree_path, second.worktree_path, third.worktree_path]);
		expect(paths.size).toBe(3);
		for (const path of paths) {
			expect(existsSync(path ?? "")).toBe(true);
		}
		// Independent edits: each worktree sees only its own file.
		const contents = new Map<string, string>();
		for (const [index, handle] of [first, second, third].entries()) {
			const marker = join(handle.worktree_path ?? "", `marker-${index}.txt`);
			writeFileSync(marker, `content-${index}\n`);
			contents.set(`marker-${index}.txt`, `content-${index}\n`);
		}
		for (const [index, handle] of [first, second, third].entries()) {
			const other = [first, second, third].filter((_, otherIndex) => otherIndex !== index);
			for (const sibling of other) {
				expect(existsSync(join(sibling.worktree_path ?? "", `marker-${index}.txt`))).toBe(false);
			}
			expect(readFileSync(join(handle.worktree_path ?? "", `marker-${index}.txt`), "utf8")).toBe(
				`content-${index}\n`,
			);
		}
		// Deleting each child finalizes its worktree: WIP pin + preservation ref + removal.
		for (const handle of [first, second, third]) {
			await parent.deleteRlmSubagent(handle.rlm_child_id);
		}
		for (const handle of [first, second, third]) {
			const stillExists = existsSync(handle.worktree_path ?? "");
			if (stillExists) {
				const inspectable = parent as unknown as {
					_activeRlmChildRuns: Map<string, { status: string; settled: boolean }>;
					_rlmChildSessions: Map<string, unknown>;
					_rlmWorktreeAdmissions: Map<string, unknown>;
				};
				console.log(
					"LEFTOVER",
					handle.rlm_child_id,
					handle.worktree_path,
					"runs:",
					[...inspectable._activeRlmChildRuns.entries()].map(([id, run]) => [id, run.status, run.settled]),
					"retained:",
					[...inspectable._rlmChildSessions.keys()],
					"admissions:",
					[...inspectable._rlmWorktreeAdmissions.keys()],
				);
			}
			expect(stillExists).toBe(false);
			const preserved = git(repoDir, "rev-parse", `refs/rlm-preserved/*/${handle.rlm_child_id}`);
			expect(preserved).toBeTruthy();
		}
	});

	it("finalizes a retained worktree child on parent disposal", async () => {
		const parent = createSession();
		const handle = await parent.runRlmChild("finish then retain", { isolation: "worktree" });
		const run = [...(parent as unknown as InspectableWorktreeSession)._activeRlmChildRuns.values()].find(
			(candidate) => candidate.id === handle.rlm_child_id,
		);
		await vi.waitFor(() => expect(run?.settled).toBe(true));
		// Retained: the worktree survives completion while the child is addressable.
		expect(existsSync(handle.worktree_path ?? "")).toBe(true);
		expect((parent as unknown as InspectableWorktreeSession)._rlmChildSessions.has(handle.rlm_child_id)).toBe(true);
		await parent.disposeAsync();
		expect(existsSync(handle.worktree_path ?? "")).toBe(false);
		expect(git(repoDir, "rev-parse", `refs/rlm-preserved/*/${handle.rlm_child_id}`)).toBeTruthy();
	});

	it("enforces the per-parent cap through the session admission path", async () => {
		process.env[RLM_WORKTREE_CAP_PER_PARENT_ENV] = "2";
		const parent = createSession();
		await parent.runRlmChild("one", { isolation: "worktree" });
		await parent.runRlmChild("two", { isolation: "worktree" });
		await expect(parent.runRlmChild("three", { isolation: "worktree" })).rejects.toThrow("per-parent cap reached");
	});
});
