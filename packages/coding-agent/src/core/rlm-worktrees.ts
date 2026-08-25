/**
 * Lifecycle manager for opt-in git-worktree isolation of RLM children.
 *
 * One durable state record per worktree, cross-process proper-lockfile locks
 * (global -> session ordering), a three-source reconcile, WIP-pin-then-remove
 * cleanup, and per-parent/global caps enforced atomically at reservation time.
 *
 * Isolation boundary (documented honestly): worktree isolation isolates the
 * checkout and index state only. It is NOT a security sandbox and NOT full
 * repository isolation: children share the object database, refs, git config,
 * hooks, and remotes, and can interfere through them or through arbitrary
 * filesystem access.
 *
 * Retained refs: branches under refs/heads/rlm-wt/<session>/ and preservation
 * refs under refs/rlm-preserved/<session>/ are retained after every reap, are
 * never auto-pushed, and are never auto-deleted. This feature never initiates
 * a push and never modifies remotes. Listing uses
 * `git for-each-ref 'refs/rlm-preserved/**' 'refs/heads/rlm-wt/**'`.
 *
 * CLEANUP_FAILED remediation (manual, never automated): pin or WIP-commit the
 * worktree manually, run `git worktree remove <path>` (never --force), then
 * delete the `<childId>.rlm.json` record. The reconcile pass retries
 * CLEANUP_FAILED records once per pass and never deletes them automatically.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { execCommand } from "./exec.js";

const log = getLogger("coding-agent.rlm-worktrees");

export const RLM_WORKTREE_ISOLATION = "worktree" as const;
export type RlmWorktreeIsolation = typeof RLM_WORKTREE_ISOLATION;

export const RLM_WORKTREE_RECORD_SUFFIX = ".rlm.json";
export const RLM_WORKTREE_BRANCH_PREFIX = "refs/heads/rlm-wt/";
export const RLM_WORKTREE_PRESERVATION_PREFIX = "refs/rlm-preserved/";
export const RLM_WORKTREE_CHILD_ID_PATTERN = /^sub-[0-9a-f]{8}$/;

export const RLM_WORKTREE_GIT_TIMEOUT_ENV = "RLM_WORKTREE_GIT_TIMEOUT_MS";
export const RLM_WORKTREE_LSOF_TIMEOUT_ENV = "RLM_WORKTREE_LSOF_TIMEOUT_MS";
export const RLM_WORKTREE_CAP_PER_PARENT_ENV = "RLM_WORKTREE_CAP_PER_PARENT";
export const RLM_WORKTREE_CAP_GLOBAL_ENV = "RLM_WORKTREE_CAP_GLOBAL";
export const DEFAULT_RLM_WORKTREE_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_RLM_WORKTREE_LSOF_TIMEOUT_MS = 5_000;
export const DEFAULT_RLM_WORKTREE_CAP_PER_PARENT = 10;
export const DEFAULT_RLM_WORKTREE_CAP_GLOBAL = 40;

export type RlmWorktreeRecordStatus = "CREATING" | "ACTIVE" | "TERMINATED" | "CLEANUP_FAILED";
export const RLM_WORKTREE_LIVE_STATUSES: readonly RlmWorktreeRecordStatus[] = [
	"CREATING",
	"ACTIVE",
	"TERMINATED",
	"CLEANUP_FAILED",
];

export interface RlmWorktreeRecord {
	version: 1;
	status: RlmWorktreeRecordStatus;
	parentSessionId: string;
	childId: string;
	childSessionDir: string;
	repoRoot: string;
	gitCommonDir: string;
	cwdRelPath: string;
	branch: string;
	preservationRef?: string;
	worktreePath: string;
	createdAt: string;
	updatedAt: string;
	lastError?: string;
}

export interface RlmWorktreeAdmission {
	worktreePath: string;
	branch: string;
	cwdOverride: string;
	childSessionDir: string;
	repoRoot: string;
	gitCommonDir: string;
	notes: string[];
}

export interface RlmWorktreeHandleMetadata {
	isolation: RlmWorktreeIsolation;
	worktreePath: string;
	worktreeBranch: string;
	worktreeStatus: RlmWorktreeRecordStatus;
	preservationRef?: string;
}

export type RlmWorktreeReapOutcome =
	| "reaped"
	| "adopted"
	| "kept"
	| "cleaned_record"
	| "removed_registration"
	| "quarantined"
	| "left"
	| "cleanup_failed";

export interface RlmWorktreeReapEntry {
	childId: string;
	branch: string;
	preservationRef?: string;
	wipPinned: boolean;
	outcome: RlmWorktreeReapOutcome;
	error?: string;
}

interface RlmWorktreeLifecycleMarker {
	state: "running" | "terminated";
	pid: number;
	startedAt: number;
}

/** Replace every character outside the git-ref-safe set and reject reserved forms. */
export function encodeRefComponent(value: string): string {
	const encoded = value.replace(/[^A-Za-z0-9._-]/g, "-");
	if (!encoded || encoded === "." || encoded === ".." || encoded.endsWith(".lock")) {
		throw new Error(`Invalid rlm worktree ref component: ${JSON.stringify(value)}`);
	}
	return encoded;
}

/** Stable identity of the shared object/ref database plus checkout root. */
export function deriveRlmWorktreeRepoKey(repoRoot: string, gitCommonDir: string): string {
	return createHash("sha256").update(`${repoRoot}\0${gitCommonDir}`).digest("hex").slice(0, 16);
}

export function deriveRlmWorktreeRefs(
	parentSessionId: string,
	childId: string,
): {
	branch: string;
	preservationRef: string;
} {
	const encoded = encodeRefComponent(parentSessionId);
	return {
		branch: `${RLM_WORKTREE_BRANCH_PREFIX}${encoded}/${childId}`,
		preservationRef: `${RLM_WORKTREE_PRESERVATION_PREFIX}${encoded}/${childId}`,
	};
}

function positiveIntEnv(name: string, fallback: number): number {
	const raw = (process.env[name] ?? "").trim();
	if (!raw) {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		log.warn(`${name} must be a positive integer; using default ${fallback}`);
		return fallback;
	}
	return parsed;
}

function gitTimeoutMs(): number {
	return positiveIntEnv(RLM_WORKTREE_GIT_TIMEOUT_ENV, DEFAULT_RLM_WORKTREE_GIT_TIMEOUT_MS);
}

function lsofTimeoutMs(): number {
	return positiveIntEnv(RLM_WORKTREE_LSOF_TIMEOUT_ENV, DEFAULT_RLM_WORKTREE_LSOF_TIMEOUT_MS);
}

function capPerParent(): number {
	return positiveIntEnv(RLM_WORKTREE_CAP_PER_PARENT_ENV, DEFAULT_RLM_WORKTREE_CAP_PER_PARENT);
}

function capGlobal(): number {
	return positiveIntEnv(RLM_WORKTREE_CAP_GLOBAL_ENV, DEFAULT_RLM_WORKTREE_CAP_GLOBAL);
}

const GIT_NONINTERACTIVE_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" };

interface GitResult {
	stdout: string;
	stderr: string;
}

async function runGit(cwd: string, args: string[], timeoutMs?: number): Promise<GitResult> {
	const result = await execCommand("git", args, cwd, {
		timeout: timeoutMs ?? gitTimeoutMs(),
		env: GIT_NONINTERACTIVE_ENV,
	});
	if (result.killed) {
		throw new Error(`git ${args.join(" ")} timed out (cwd=${cwd})`);
	}
	if (result.code !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (cwd=${cwd}): ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
		);
	}
	return { stdout: result.stdout, stderr: result.stderr };
}

/** Git only ever sees derived paths plus identities re-verified against the live repo (never raw JSON). */
async function verifyRepoIdentity(repoRoot: string, gitCommonDir: string): Promise<boolean> {
	try {
		const result = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
		const observed = result.stdout.trim();
		// Linked worktrees print an absolute path; join() concatenates absolute
		// segments instead of resetting, so branch explicitly.
		const resolved = observed
			? realpathSync(observed.startsWith(sep) ? observed : join(repoRoot, observed))
			: undefined;
		return resolved === gitCommonDir;
	} catch {
		return false;
	}
}

async function withProperLock<T>(lockPath: string, action: () => T | Promise<T>): Promise<T> {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(lockPath, {
		realpath: false,
		stale: 60_000,
		update: 30_000,
		retries: { retries: 10, factor: 1, minTimeout: 200, maxTimeout: 1_000 },
	});
	try {
		return await action();
	} finally {
		await release().catch(() => undefined);
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

const RLM_WORKTREE_STATUS_VALUES = new Set<string>(RLM_WORKTREE_LIVE_STATUSES);

function isRecordStatus(value: unknown): value is RlmWorktreeRecordStatus {
	return typeof value === "string" && RLM_WORKTREE_STATUS_VALUES.has(value);
}

/** Strict shape check: tampered or truncated records never become executable inputs. */
function parseRecord(raw: string): RlmWorktreeRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	if (!isRecordStatus(record.status)) return undefined;
	if (
		!isNonEmptyString(record.parentSessionId) ||
		!isNonEmptyString(record.childId) ||
		!isNonEmptyString(record.repoRoot) ||
		!isNonEmptyString(record.gitCommonDir) ||
		!isNonEmptyString(record.worktreePath) ||
		!isNonEmptyString(record.branch) ||
		!isNonEmptyString(record.createdAt) ||
		!isNonEmptyString(record.updatedAt) ||
		typeof record.cwdRelPath !== "string" ||
		typeof record.childSessionDir !== "string"
	) {
		return undefined;
	}
	if (!RLM_WORKTREE_CHILD_ID_PATTERN.test(record.childId)) return undefined;
	return {
		version: 1,
		status: record.status,
		parentSessionId: record.parentSessionId,
		childId: record.childId,
		childSessionDir: record.childSessionDir,
		repoRoot: record.repoRoot,
		gitCommonDir: record.gitCommonDir,
		cwdRelPath: record.cwdRelPath,
		branch: record.branch,
		...(isNonEmptyString(record.preservationRef) ? { preservationRef: record.preservationRef } : {}),
		worktreePath: record.worktreePath,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(isNonEmptyString(record.lastError) ? { lastError: record.lastError } : {}),
	};
}

/** Atomic write: tmp + fsync + rename + directory fsync. */
function writeRecordAtomic(recordPath: string, record: RlmWorktreeRecord): void {
	mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
	const tmpPath = `${recordPath}.tmp`;
	const fd = openSync(tmpPath, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmpPath, recordPath);
	try {
		const dirFd = openSync(dirname(recordPath), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// Directory fsync is unsupported on some platforms; the rename itself is atomic.
	}
}

/** NUL-delimited porcelain parse: every path token after its two-char status prefix. */
export function parseGitPorcelainZPaths(output: string): string[] {
	const paths: string[] = [];
	for (const token of output.split("\0")) {
		if (!token) continue;
		// XY<space><path>; rename entries in -z mode carry the old path as the next token.
		if (token.length > 3 && token[2] === " ") {
			paths.push(token.slice(3));
		} else {
			paths.push(token);
		}
	}
	return paths;
}

/** Escape a path for literal one-per-line embedding in the injected dirty-parent note. */
export function escapeWorktreeNotePath(path: string): string {
	return JSON.stringify(path);
}

function buildDirtyParentNote(paths: string[]): string {
	const body = paths.map(escapeWorktreeNotePath).join("\n");
	return (
		"[RLM WORKTREE NOTE] The parent working tree has uncommitted changes at spawn time. " +
		"This worktree's baseline (HEAD) does not include them:\n" +
		body
	);
}

export const RLM_WORKTREE_ENV_NOTE =
	"[RLM ENV NOTE] This session runs in a fresh git worktree checkout. Untracked or ignored artifacts " +
	"(for example venv, node_modules, .env) may not be present; tracked files are present. Install or build " +
	"what you need using the repo's documented bootstrap; do not assume shared environment state.";

function buildAbsentRelativeDirNote(cwdRelPath: string): string {
	return (
		`[RLM WORKTREE NOTE] The parent session's relative directory "${cwdRelPath}" does not exist in the ` +
		"fresh checkout; this session starts at the worktree root."
	);
}

function readLifecycleMarker(childSessionDir: string): RlmWorktreeLifecycleMarker | undefined {
	try {
		const raw = readFileSync(join(childSessionDir, "lifecycle.json"), "utf8");
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (value.state !== "running" && value.state !== "terminated") return undefined;
		if (typeof value.pid !== "number" || typeof value.startedAt !== "number") return undefined;
		return { state: value.state, pid: value.pid, startedAt: value.startedAt };
	} catch {
		return undefined;
	}
}

function writeLifecycleMarker(childSessionDir: string, state: "running" | "terminated"): void {
	mkdirSync(childSessionDir, { recursive: true, mode: 0o700 });
	const previous = readLifecycleMarker(childSessionDir);
	const marker: RlmWorktreeLifecycleMarker = {
		state,
		// The marker is owned by the host lifecycle manager; the pid records the
		// process that owns the child lifecycle. Liveness reads only state.
		pid: process.pid,
		startedAt: previous?.startedAt ?? Date.now(),
	};
	const tmpPath = join(childSessionDir, "lifecycle.json.tmp");
	const fd = openSync(tmpPath, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(marker)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmpPath, join(childSessionDir, "lifecycle.json"));
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function parseWorktreeList(output: string): { path: string; branch?: string }[] {
	const entries: { path: string; branch?: string }[] = [];
	for (const block of output.split("\n\n")) {
		let path: string | undefined;
		let branch: string | undefined;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length);
			} else if (line.startsWith("branch ")) {
				branch = line.slice("branch ".length);
			}
		}
		if (path) entries.push({ path, ...(branch ? { branch } : {}) });
	}
	return entries;
}

/** Synchronous boundary probe used only for the admission check. */
function isInsideWorkTree(cwd: string): boolean {
	try {
		const output = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() === "true";
	} catch {
		return false;
	}
}

export class RlmWorktreeLifecycleManager {
	readonly root: string;
	private readonly hooksDir: string;

	constructor(options: { root: string }) {
		mkdirSync(options.root, { recursive: true, mode: 0o700 });
		this.root = realpathSync(options.root);
		this.hooksDir = join(this.root, "hooks-empty");
	}

	private sessionLockPath(repoKey: string, parentSessionId: string): string {
		return join(this.root, "locks", `${repoKey}-${encodeRefComponent(parentSessionId)}.guard`);
	}

	private globalLockPath(): string {
		return join(this.root, "locks", "global.guard");
	}

	namespaceDirFor(repoRoot: string, gitCommonDir: string, parentSessionId: string): string {
		return join(this.root, deriveRlmWorktreeRepoKey(repoRoot, gitCommonDir), encodeRefComponent(parentSessionId));
	}

	private recordPath(namespaceDir: string, childId: string): string {
		return join(namespaceDir, `${childId}${RLM_WORKTREE_RECORD_SUFFIX}`);
	}

	private quarantineDir(namespaceDir: string): string {
		return join(namespaceDir, "quarantine");
	}

	/** Validated record; undefined for absent or malformed files. */
	private readRecord(namespaceDir: string, childId: string): RlmWorktreeRecord | undefined {
		try {
			return parseRecord(readFileSync(this.recordPath(namespaceDir, childId), "utf8"));
		} catch {
			return undefined;
		}
	}

	private listRecordChildIds(namespaceDir: string): string[] {
		if (!existsSync(namespaceDir)) return [];
		return safeReaddir(namespaceDir).flatMap((entry) =>
			entry.endsWith(RLM_WORKTREE_RECORD_SUFFIX) ? [entry.slice(0, -RLM_WORKTREE_RECORD_SUFFIX.length)] : [],
		);
	}

	private listRecords(namespaceDir: string): RlmWorktreeRecord[] {
		return this.listRecordChildIds(namespaceDir).flatMap((childId) => {
			const record = this.readRecord(namespaceDir, childId);
			return record ? [record] : [];
		});
	}

	private countReservedRecords(namespaceDir?: string): number {
		if (namespaceDir !== undefined) {
			return this.listRecords(namespaceDir).filter((record) => RLM_WORKTREE_LIVE_STATUSES.includes(record.status))
				.length;
		}
		let count = 0;
		for (const repoKey of safeReaddir(this.root)) {
			const repoKeyDir = join(this.root, repoKey);
			if (!isDirectory(repoKeyDir)) continue;
			for (const parentDir of safeReaddir(repoKeyDir)) {
				count += this.countReservedRecords(join(repoKeyDir, parentDir));
			}
		}
		return count;
	}

	/**
	 * Sync handle/registry metadata for one child without running git.
	 * Returns undefined when no valid record exists.
	 */
	getHandleMetadata(
		repoRoot: string,
		gitCommonDir: string,
		parentSessionId: string,
		childId: string,
	): RlmWorktreeHandleMetadata | undefined {
		const record = this.readRecord(this.namespaceDirFor(repoRoot, gitCommonDir, parentSessionId), childId);
		if (!record) return undefined;
		return {
			isolation: RLM_WORKTREE_ISOLATION,
			worktreePath: record.worktreePath,
			worktreeBranch: record.branch,
			worktreeStatus: record.status,
			...(record.preservationRef ? { preservationRef: record.preservationRef } : {}),
		};
	}

	/**
	 * Admit a worktree-isolated child: resolve repo identity, boundary-check the
	 * target, check the dirty parent, reserve capacity atomically, create and
	 * verify the worktree, then map the child cwd and build the injected notes.
	 */
	/** Resolve the stable repo identity (checkout root + canonical common dir) for a cwd. */
	async resolveRepoIdentity(cwd: string): Promise<{ repoRoot: string; gitCommonDir: string } | undefined> {
		cwd = canonicalizePath(cwd);
		try {
			const insideTree = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
			if (insideTree.stdout.trim() !== "true") {
				return undefined;
			}
			const toplevel = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
			const repoRoot = realpathSync(toplevel);
			const commonDirOutput = (await runGit(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
			// Linked worktrees print an absolute path here; join() concatenates
			// absolute segments instead of resetting, so branch explicitly.
			const gitCommonDir = realpathSync(
				commonDirOutput.startsWith(sep) ? commonDirOutput : join(cwd, commonDirOutput),
			);
			return { repoRoot, gitCommonDir };
		} catch {
			return undefined;
		}
	}

	async admitWorktree(params: {
		parentCwd: string;
		parentSessionId: string;
		childId: string;
		childSessionDir: string;
	}): Promise<RlmWorktreeAdmission> {
		const { parentSessionId, childId, childSessionDir } = params;
		if (!RLM_WORKTREE_CHILD_ID_PATTERN.test(childId)) {
			throw new Error(`rlm.run isolation="worktree" requires a sub-<8hex> child id, got ${childId}`);
		}
		// Canonicalize so relative(repoRoot, parentCwd) and the dirty-status check
		// agree with the realpath'd repo identity (macOS /var vs /private/var).
		const parentCwd = canonicalizePath(params.parentCwd);
		const identity = await this.resolveRepoIdentity(parentCwd);
		if (!identity) {
			throw new Error(
				`rlm.run isolation="worktree" requires the parent session cwd to be inside a git repository: ${parentCwd}`,
			);
		}
		const { repoRoot, gitCommonDir } = identity;

		const namespaceDir = this.namespaceDirFor(repoRoot, gitCommonDir, parentSessionId);
		const worktreePath = join(namespaceDir, childId);
		this.assertBoundarySafe(repoRoot, worktreePath);

		// F6: dirty-parent check (porcelain includes untracked entries by construction).
		const dirtyStatus = await runGit(parentCwd, ["status", "--porcelain", "-z"]);
		const dirtyPaths = parseGitPorcelainZPaths(dirtyStatus.stdout).filter(Boolean);

		const { branch } = deriveRlmWorktreeRefs(parentSessionId, childId);
		await runGit(repoRoot, ["check-ref-format", branch]);

		// Atomic count+reserve under the locks (global -> session ordering).
		const reserve = () =>
			withProperLock(this.sessionLockPath(deriveRlmWorktreeRepoKey(repoRoot, gitCommonDir), parentSessionId), () => {
				const count = this.countReservedRecords(namespaceDir);
				if (count >= capPerParent()) {
					throw new Error(
						`rlm.run isolation="worktree" per-parent cap reached (RLM_WORKTREE_CAP_PER_PARENT=${capPerParent()}, count=${count})`,
					);
				}
				const now = new Date().toISOString();
				const record: RlmWorktreeRecord = {
					version: 1,
					status: "CREATING",
					parentSessionId,
					childId,
					childSessionDir,
					repoRoot,
					gitCommonDir,
					cwdRelPath: relative(repoRoot, parentCwd),
					branch,
					worktreePath,
					createdAt: now,
					updatedAt: now,
				};
				writeRecordAtomic(this.recordPath(namespaceDir, childId), record);
				writeLifecycleMarker(childSessionDir, "running");
			});
		await withProperLock(this.globalLockPath(), async () => {
			const globalCount = this.countReservedRecords();
			if (globalCount >= capGlobal()) {
				throw new Error(
					`rlm.run isolation="worktree" global cap reached (RLM_WORKTREE_CAP_GLOBAL=${capGlobal()}, count=${globalCount})`,
				);
			}
			await reserve();
		});

		const failSpawn = async (error: unknown): Promise<never> => {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this.transitionRecord(namespaceDir, childId, "CLEANUP_FAILED", message);
			} catch (transitionError) {
				log.error(`[rlm-worktrees] Could not record CLEANUP_FAILED for ${childId}: ${String(transitionError)}`);
			}
			throw new Error(
				`rlm.run isolation="worktree" admission failed (${message}); the worktree lifecycle manager will reconcile it`,
			);
		};

		try {
			// `-b` takes a branch NAME, so pass the short name; the durable record and
			// check-ref-format keep the full refs/heads/rlm-wt/... ref path.
			await runGit(repoRoot, ["worktree", "add", worktreePath, "-b", branch.slice("refs/heads/".length)]);
		} catch (error) {
			await failSpawn(error);
		}

		// Registration verification: exactly one worktree entry under the namespace.
		try {
			const listed = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
			const registrations = parseWorktreeList(listed.stdout)
				.map((entry) => ({ ...entry, path: canonicalizePath(entry.path) }))
				.filter((entry) => entry.path === canonicalizePath(worktreePath));
			if (registrations.length !== 1) {
				await failSpawn(
					new Error(`expected exactly one registration for ${worktreePath}, found ${registrations.length}`),
				);
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("admission failed")) throw error;
			await failSpawn(error);
		}
		this.transitionRecord(namespaceDir, childId, "ACTIVE", undefined);

		const cwdRelPath = relative(repoRoot, parentCwd);
		const childCwd = join(worktreePath, cwdRelPath);
		const absentRelativeDir = !existsSync(childCwd);
		const cwdOverride = absentRelativeDir ? worktreePath : childCwd;
		const notes: string[] = [];
		if (dirtyPaths.length > 0) {
			notes.push(buildDirtyParentNote(dirtyPaths));
		}
		notes.push(RLM_WORKTREE_ENV_NOTE);
		if (absentRelativeDir) {
			notes.push(buildAbsentRelativeDirNote(cwdRelPath));
		}
		return {
			worktreePath,
			branch,
			cwdOverride,
			childSessionDir,
			repoRoot,
			gitCommonDir,
			notes,
		};
	}

	/** Runtime boundary check at every admission (a worktree can never be nested in a working tree). */
	private assertBoundarySafe(repoRoot: string, worktreePath: string): void {
		const canonicalRoot = canonicalizePath(this.root);
		const canonicalTarget = canonicalizePath(worktreePath);
		if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
			throw new Error(`Derived worktree path ${worktreePath} escapes the worktree root ${this.root}`);
		}
		if (canonicalRoot === repoRoot || canonicalRoot.startsWith(`${repoRoot}${sep}`)) {
			throw new Error(`The rlm worktree root ${this.root} must never live inside a repository (${repoRoot})`);
		}
		let probe = worktreePath;
		while (!existsSync(probe)) {
			const parent = dirname(probe);
			if (parent === probe) break;
			probe = parent;
		}
		if (isInsideWorkTree(probe)) {
			throw new Error(`The derived worktree path ${worktreePath} nests inside an existing working tree (${probe})`);
		}
	}

	private transitionRecord(
		namespaceDir: string,
		childId: string,
		status: RlmWorktreeRecordStatus,
		lastError: string | undefined,
	): void {
		const record = this.readRecord(namespaceDir, childId);
		if (!record) {
			throw new Error(`No rlm worktree record for ${childId}`);
		}
		const updated: RlmWorktreeRecord = {
			...record,
			status,
			updatedAt: new Date().toISOString(),
			...(lastError !== undefined ? { lastError } : {}),
		};
		writeRecordAtomic(this.recordPath(namespaceDir, childId), updated);
	}

	/**
	 * Finalize one worktree child: confirm termination, pin the preservation ref,
	 * WIP-commit dirty state, remove the worktree, delete the record. Any failure
	 * transitions the record to CLEANUP_FAILED and retains the worktree. Never
	 * removes with --force.
	 */
	async finalizeWorktree(params: {
		parentSessionId: string;
		childId: string;
		repoRoot: string;
		gitCommonDir: string;
		isChildLive: () => boolean;
	}): Promise<RlmWorktreeReapEntry> {
		const { parentSessionId, childId, repoRoot, gitCommonDir, isChildLive } = params;
		const namespaceDir = this.namespaceDirFor(repoRoot, gitCommonDir, parentSessionId);
		const repoKey = deriveRlmWorktreeRepoKey(repoRoot, gitCommonDir);
		const lockPath = this.sessionLockPath(repoKey, parentSessionId);
		return withProperLock(lockPath, () =>
			this.finalizeWorktreeLocked(namespaceDir, childId, repoRoot, gitCommonDir, isChildLive),
		);
	}

	private async finalizeWorktreeLocked(
		namespaceDir: string,
		childId: string,
		repoRoot: string,
		gitCommonDir: string,
		isChildLive: () => boolean,
	): Promise<RlmWorktreeReapEntry> {
		const record = this.readRecord(namespaceDir, childId);
		if (!record) {
			return { childId, branch: "unknown", wipPinned: false, outcome: "cleaned_record" };
		}
		const entry = (outcome: RlmWorktreeReapOutcome, error?: string, wipPinned = false): RlmWorktreeReapEntry => ({
			childId,
			branch: record.branch,
			...(record.preservationRef ? { preservationRef: record.preservationRef } : {}),
			wipPinned,
			outcome,
			...(error ? { error } : {}),
		});
		const fail = (error: unknown, wipPinned = false): RlmWorktreeReapEntry => {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this.transitionRecord(namespaceDir, childId, "CLEANUP_FAILED", message);
			} catch {
				// Record already absent or unreadable; the worktree is retained either way.
			}
			log.error(`[rlm-worktrees] Finalize failed for ${childId}; worktree retained: ${message}`);
			return entry("cleanup_failed", message, wipPinned);
		};

		// 1. Confirmed termination. The caller asserts the child run settled, was
		// deleted, or the parent disposed before invoking finalize; reap passes use
		// isChildLive = false after the recovery barrier. The lsof check is the hard
		// backstop: never remove a worktree with live processes.
		if (isChildLive()) {
			return entry("kept", "child still live; termination not confirmed");
		}
		try {
			const hasLiveProcess = await this.hasLiveProcessInWorktree(record.worktreePath);
			if (hasLiveProcess) {
				return fail(new Error(`processes still hold cwd under ${record.worktreePath}`));
			}
		} catch (error) {
			return fail(error);
		}
		if (existsSync(record.childSessionDir)) {
			writeLifecycleMarker(record.childSessionDir, "terminated");
		}

		// 2. TERMINATED.
		try {
			this.transitionRecord(namespaceDir, childId, "TERMINATED", undefined);
		} catch (error) {
			return fail(error);
		}

		// 3. Preservation ref: pin the ACTUAL final HEAD regardless of branch state.
		try {
			const dirExists = existsSync(record.worktreePath);
			const headOutput = dirExists
				? await runGit(record.worktreePath, ["rev-parse", "HEAD"])
				: await runGit(repoRoot, ["rev-parse", record.branch]);
			const finalSha = headOutput.stdout.trim();
			await runGit(repoRoot, [
				"update-ref",
				`${RLM_WORKTREE_PRESERVATION_PREFIX}${encodeRefComponent(record.parentSessionId)}/${record.childId}`,
				finalSha,
			]);
			writeRecordAtomic(this.recordPath(namespaceDir, childId), {
				...record,
				preservationRef: `${RLM_WORKTREE_PRESERVATION_PREFIX}${encodeRefComponent(record.parentSessionId)}/${record.childId}`,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			return fail(error);
		}

		// 4. WIP capture only if dirty (staging untracked files included).
		let wipPinned = false;
		if (existsSync(record.worktreePath)) {
			const wipResult = await this.pinWorkInProgress(namespaceDir, childId, record, gitCommonDir);
			if (wipResult.status === "failed") {
				return fail(wipResult.error, false);
			}
			wipPinned = wipResult.pinned === true;
		}

		// 5. Remove (clean after the pin, so no --force is ever needed).
		try {
			await runGit(repoRoot, ["worktree", "remove", record.worktreePath]);
		} catch (error) {
			return fail(error, wipPinned);
		}

		// 6. Terminal REAPED: delete the record. Branch and preservation ref are retained.
		try {
			rmSync(this.recordPath(namespaceDir, childId), { force: true });
		} catch (error) {
			return fail(error, wipPinned);
		}
		log.warn(
			`[rlm-worktrees] Reaped ${childId} (branch=${record.branch}, preservationRef=${RLM_WORKTREE_PRESERVATION_PREFIX}${encodeRefComponent(record.parentSessionId)}/${record.childId}, wipPinned=${wipPinned})`,
		);
		return entry("reaped", undefined, wipPinned);
	}

	private async pinWorkInProgress(
		namespaceDir: string,
		childId: string,
		record: RlmWorktreeRecord,
		gitCommonDir: string,
	): Promise<{ status: "clean" | "pinned" | "failed"; pinned?: boolean; error?: unknown }> {
		void namespaceDir;
		const status = await runGit(record.worktreePath, ["status", "--porcelain", "-z"]);
		if (!status.stdout.trim()) {
			return { status: "clean", pinned: false };
		}
		const commitArgs = [
			"-c",
			"user.name=RLM Worktree Cleanup",
			"-c",
			"user.email=rlm@prime-agent.local",
			"-c",
			"commit.gpgsign=false",
			"-c",
			`core.hooksPath=${this.hooksDir}`,
		];
		mkdirSync(this.hooksDir, { recursive: true, mode: 0o700 });
		const message = `rlm-wip ${record.parentSessionId} ${childId} ${new Date().toISOString()}`;
		const attempt = async (): Promise<void> => {
			await runGit(record.worktreePath, [...commitArgs, "add", "-A"]);
			await runGit(record.worktreePath, [...commitArgs, "commit", "-m", message]);
		};
		try {
			await attempt();
		} catch (error) {
			// Red review (final): a linked worktree's index lock lives at
			// <gitCommonDir>/worktrees/<name>/index.lock, NOT <gitCommonDir>/index.lock
			// (that path is the MAIN checkout's lock). Clearing the common-dir lock
			// could destroy a live lock held by an unrelated concurrent operation in
			// the main checkout -- the one place this feature could reach outside its
			// own namespace. Resolve the worktree's OWN git-dir first and only ever
			// clear a stale lock inside that directory.
			const staleIndexLock = await this.resolveWorktreeIndexLockPath(record.worktreePath, gitCommonDir);
			if (staleIndexLock && existsSync(staleIndexLock)) {
				// Termination is confirmed, so a lock inside THIS worktree's own gitdir
				// is stale by definition; a lock outside it is never touched.
				rmSync(staleIndexLock, { force: true });
				try {
					await attempt();
				} catch (retryError) {
					return { status: "failed", error: retryError };
				}
			} else {
				return { status: "failed", error };
			}
		}
		// Final cleanliness recheck; one more attempt on residual dirt, never --force.
		const recheck = await runGit(record.worktreePath, ["status", "--porcelain", "-z"]);
		if (recheck.stdout.trim()) {
			try {
				await attempt();
			} catch (error) {
				return { status: "failed", error };
			}
			const finalCheck = await runGit(record.worktreePath, ["status", "--porcelain", "-z"]);
			if (finalCheck.stdout.trim()) {
				return { status: "failed", error: new Error("worktree still dirty after WIP commit retries") };
			}
		}
		return { status: "pinned", pinned: true };
	}

	/**
	 * Resolve the git-dir that belongs to THIS worktree specifically (never the
	 * shared common dir), so a stale index.lock is only ever cleared inside the
	 * worktree's own state, never a lock another process (including the parent
	 * checkout) may still legitimately hold.
	 */
	private async resolveWorktreeIndexLockPath(worktreePath: string, gitCommonDir: string): Promise<string | undefined> {
		try {
			const result = await runGit(worktreePath, ["rev-parse", "--git-dir"]);
			const raw = result.stdout.trim();
			if (!raw) return undefined;
			const resolved = raw.startsWith(sep) ? raw : join(worktreePath, raw);
			const canonical = canonicalizePath(resolved);
			// Defense in depth: a linked worktree's own git-dir must live under the
			// shared common dir's "worktrees/" subtree, never equal the common dir
			// itself. If it does not, refuse to touch any lock there at all.
			if (canonical === canonicalizePath(gitCommonDir) || !canonical.includes(`${sep}worktrees${sep}`)) {
				return undefined;
			}
			return join(canonical, "index.lock");
		} catch {
			return undefined;
		}
	}

	private async hasLiveProcessInWorktree(worktreePath: string): Promise<boolean> {
		if (!existsSync(worktreePath)) {
			return false;
		}
		// Red review (final): "+d" only inspects the directory and its immediate
		// top-level entries, so a process with cwd or open files deeper in the
		// tree (a background dev server, a test watcher holding files under
		// node_modules) is invisible -- the "never remove a worktree with live
		// processes" invariant was not actually enforced. "+D" recurses.
		const result = await execCommand("lsof", ["+D", worktreePath], "/", {
			timeout: lsofTimeoutMs(),
		});
		if (result.killed) {
			throw new Error(`lsof +D ${worktreePath} timed out`);
		}
		// lsof exits 1 with empty output/stderr when no process uses the tree; a
		// nonzero exit WITH stderr, or a missing binary, is a broken probe, not a
		// clean answer -- fail closed (treat as live) rather than silently
		// degrading the backstop to a no-op.
		if (result.code !== 0 && result.code !== 1) {
			throw new Error(`lsof +D ${worktreePath} failed (exit ${result.code}): ${result.stderr.trim()}`);
		}
		if (result.code === 1 && result.stderr.trim()) {
			throw new Error(`lsof +D ${worktreePath} errored: ${result.stderr.trim()}`);
		}
		return result.stdout.trim().length > 0;
	}

	/**
	 * Three-source reconcile (records, git registrations, filesystem) for one
	 * namespace. Adopts live children and reaps dead ones; quarantines anything
	 * that fails path trust; never runs git against unvalidated JSON paths.
	 */
	async reconcileNamespace(params: {
		parentSessionId: string;
		repoRoot: string;
		gitCommonDir: string;
		isChildLive: (childId: string, childSessionDir: string) => boolean;
	}): Promise<RlmWorktreeReapEntry[]> {
		const { parentSessionId, repoRoot, gitCommonDir, isChildLive } = params;
		const namespaceDir = this.namespaceDirFor(repoRoot, gitCommonDir, parentSessionId);
		const repoKey = deriveRlmWorktreeRepoKey(repoRoot, gitCommonDir);
		return withProperLock(this.sessionLockPath(repoKey, parentSessionId), () =>
			this.reconcileNamespaceLocked(namespaceDir, parentSessionId, repoRoot, gitCommonDir, isChildLive),
		);
	}

	private async reconcileNamespaceLocked(
		namespaceDir: string,
		parentSessionId: string,
		repoRoot: string,
		gitCommonDir: string,
		isChildLive: (childId: string, childSessionDir: string) => boolean,
	): Promise<RlmWorktreeReapEntry[]> {
		const report: RlmWorktreeReapEntry[] = [];
		if (!existsSync(namespaceDir)) {
			return report;
		}
		const canonicalNamespace = canonicalizePath(namespaceDir);

		// S1: ownership records (malformed files are quarantined, never executed against).
		const recordChildIds = this.listRecordChildIds(namespaceDir);
		const records = this.listRecords(namespaceDir);
		for (const childId of recordChildIds.filter((id) => !records.some((record) => record.childId === id))) {
			this.quarantineRecord(namespaceDir, childId);
			log.error(`[rlm-worktrees] Quarantined malformed record for ${childId}; never executed against`);
			report.push({ childId, branch: "unknown", wipPinned: false, outcome: "quarantined" });
		}
		// S2: git registrations under the namespace prefix.
		let registrations: { path: string; branch?: string }[] = [];
		try {
			const listed = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
			registrations = parseWorktreeList(listed.stdout)
				.map((entry) => ({ ...entry, path: canonicalizePath(entry.path) }))
				.filter(
					(entry) => entry.path === canonicalNamespace || entry.path.startsWith(`${canonicalNamespace}${sep}`),
				);
		} catch (error) {
			log.error(`[rlm-worktrees] Reconcile could not list worktrees for ${repoRoot}: ${String(error)}`);
		}
		// S3: filesystem entries directly under the namespace.
		const dirEntries = safeReaddir(namespaceDir).filter(
			(name) =>
				!name.endsWith(RLM_WORKTREE_RECORD_SUFFIX) &&
				!name.endsWith(".tmp") &&
				name !== "quarantine" &&
				RLM_WORKTREE_CHILD_ID_PATTERN.test(name),
		);

		const registrationByChild = new Map<string, { path: string; branch?: string }>();
		for (const registration of registrations) {
			const childId = basename(registration.path);
			if (RLM_WORKTREE_CHILD_ID_PATTERN.test(childId)) {
				registrationByChild.set(childId, registration);
			}
		}
		const dirByChild = new Map<string, string>(dirEntries.map((name) => [name, join(namespaceDir, name)]));

		const childIds = new Set([
			...records.map((record) => record.childId),
			...registrationByChild.keys(),
			...dirByChild.keys(),
		]);

		for (const childId of childIds) {
			const record = records.find((candidate) => candidate.childId === childId);
			const registration = registrationByChild.get(childId);
			const dir = dirByChild.get(childId);
			const derivedPath = join(namespaceDir, childId);

			// Rule 1: path trust. Recorded identity is re-verified against the live
			// repo; recorded paths are trusted only after they equal the derived path.
			if (record) {
				const identityOk = await verifyRepoIdentity(record.repoRoot, record.gitCommonDir);
				const pathOk = canonicalizePath(record.worktreePath) === canonicalizePath(derivedPath);
				if (!identityOk || !pathOk || record.parentSessionId !== parentSessionId) {
					this.quarantineRecord(namespaceDir, childId);
					log.error(
						`[rlm-worktrees] Quarantined record for ${childId} (identityOk=${identityOk}, pathOk=${pathOk}); never executed against`,
					);
					report.push({ childId, branch: record.branch, wipPinned: false, outcome: "quarantined" });
					continue;
				}
			}

			// Rule 2: consistent (S1 + S2 + S3).
			if (record && registration && dir) {
				if (record.status === "TERMINATED" || record.status === "CLEANUP_FAILED") {
					// Rule 9: retry cleanup for records that failed a previous pass.
					const reaped = await this.finalizeWorktreeLocked(namespaceDir, childId, repoRoot, gitCommonDir, () =>
						isChildLive(childId, record.childSessionDir),
					);
					report.push(reaped);
					continue;
				}
				if (isChildLive(childId, record.childSessionDir)) {
					report.push({ childId, branch: record.branch, wipPinned: false, outcome: "adopted" });
				} else {
					const reaped = await this.finalizeWorktreeLocked(namespaceDir, childId, repoRoot, gitCommonDir, () =>
						isChildLive(childId, record.childSessionDir),
					);
					report.push(reaped);
				}
				continue;
			}

			// Rule 3: registration without record (crash window after worktree add).
			if (!record && registration) {
				const branch =
					registration.branch ?? `${RLM_WORKTREE_BRANCH_PREFIX}${encodeRefComponent(parentSessionId)}/${childId}`;
				const reconstructed: RlmWorktreeRecord = {
					version: 1,
					status: "ACTIVE",
					parentSessionId,
					childId,
					childSessionDir: "",
					repoRoot,
					gitCommonDir,
					cwdRelPath: "",
					branch,
					worktreePath: derivedPath,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				if (!isChildLive(childId, "")) {
					// Owner dead: persist the reconstruction so the finalize path can pin
					// and remove through the record, then reap.
					writeRecordAtomic(this.recordPath(namespaceDir, childId), reconstructed);
					const reaped = await this.finalizeWorktreeLocked(namespaceDir, childId, repoRoot, gitCommonDir, () =>
						isChildLive(childId, ""),
					);
					report.push(reaped);
				} else {
					writeRecordAtomic(this.recordPath(namespaceDir, childId), reconstructed);
					report.push({ childId, branch, wipPinned: false, outcome: "adopted" });
				}
				continue;
			}

			// Rule 4: record without registration, dir present: unregistered dir.
			if (record && !registration && dir) {
				this.quarantineRecord(namespaceDir, childId);
				log.error(`[rlm-worktrees] Unregistered worktree dir left in place for ${childId}: ${dir}`);
				report.push({ childId, branch: record.branch, wipPinned: false, outcome: "quarantined" });
				continue;
			}

			// Rule 5: record without registration and without dir: stale record.
			if (record && !registration && !dir) {
				try {
					rmSync(this.recordPath(namespaceDir, childId), { force: true });
					report.push({ childId, branch: record.branch, wipPinned: false, outcome: "cleaned_record" });
				} catch (error) {
					report.push({
						childId,
						branch: record.branch,
						wipPinned: false,
						outcome: "cleanup_failed",
						error: String(error),
					});
				}
				continue;
			}

			// Rule 6: record + registration, dir missing: stale registration.
			if (record && registration && !dir) {
				try {
					await runGit(repoRoot, ["worktree", "remove", record.worktreePath]);
				} catch (error) {
					report.push({
						childId,
						branch: record.branch,
						wipPinned: false,
						outcome: "cleanup_failed",
						error: String(error),
					});
					continue;
				}
				try {
					rmSync(this.recordPath(namespaceDir, childId), { force: true });
					report.push({ childId, branch: record.branch, wipPinned: false, outcome: "removed_registration" });
				} catch (error) {
					report.push({
						childId,
						branch: record.branch,
						wipPinned: false,
						outcome: "cleanup_failed",
						error: String(error),
					});
				}
				continue;
			}

			// Rule 7: dir with our naming pattern, no record, no registration: unknown
			// residue. Leave it, log loudly, never delete blindly.
			if (!record && !registration && dir) {
				log.error(`[rlm-worktrees] Unknown residue left in place for ${childId}: ${dir}`);
				report.push({ childId, branch: "unknown", wipPinned: false, outcome: "left" });
			}
		}
		// Rule 8 needs no action: registrations outside the namespace are never touched.
		return report;
	}

	private quarantineRecord(namespaceDir: string, childId: string): void {
		const quarantine = this.quarantineDir(namespaceDir);
		mkdirSync(quarantine, { recursive: true, mode: 0o700 });
		const source = this.recordPath(namespaceDir, childId);
		if (!existsSync(source)) return;
		try {
			renameSync(source, join(quarantine, `${childId}${RLM_WORKTREE_RECORD_SUFFIX}.bad`));
		} catch {
			rmSync(source, { force: true });
		}
	}

	/**
	 * Host-level orphan sweep: reap namespaces whose parent session is not in the
	 * daemon's live session set. Runs under the global lock.
	 */
	async sweepDeadSessionNamespaces(params: {
		isSessionLive: (parentSessionId: string) => boolean;
	}): Promise<RlmWorktreeReapEntry[]> {
		return withProperLock(this.globalLockPath(), async () => {
			const report: RlmWorktreeReapEntry[] = [];
			for (const repoKey of safeReaddir(this.root)) {
				const repoKeyDir = join(this.root, repoKey);
				if (!isDirectory(repoKeyDir)) continue;
				for (const parentDir of safeReaddir(repoKeyDir)) {
					const namespaceDir = join(repoKeyDir, parentDir);
					if (!isDirectory(namespaceDir)) continue;
					const recordChildIds = this.listRecordChildIds(namespaceDir);
					const records = this.listRecords(namespaceDir);
					for (const childId of recordChildIds.filter((id) => !records.some((record) => record.childId === id))) {
						this.quarantineRecord(namespaceDir, childId);
						log.error(
							`[rlm-worktrees] Host sweep quarantined malformed record for ${childId}; never executed against`,
						);
						report.push({ childId, branch: "unknown", wipPinned: false, outcome: "quarantined" });
					}
					const rawParentSessionIds = new Set(records.map((record) => record.parentSessionId));
					const childDirs = safeReaddir(namespaceDir).filter((name) => RLM_WORKTREE_CHILD_ID_PATTERN.test(name));
					if (records.length === 0) {
						if (childDirs.length > 0) {
							log.error(`[rlm-worktrees] Unknown residue namespace left in place: ${namespaceDir}`);
							report.push({
								childId: childDirs.join(","),
								branch: "unknown",
								wipPinned: false,
								outcome: "left",
							});
						}
						continue;
					}
					const live = [...rawParentSessionIds].some((id) => params.isSessionLive(id));
					if (live) continue;
					// Red review (final): the host sweep previously held only the global
					// lock and finalized directly, with no mutual exclusion against a
					// session-side finalize/reconcile on the same namespace (those hold
					// only the session lock). Two processes could finalize the same child
					// concurrently: double WIP attempts, spurious CLEANUP_FAILED against an
					// already-deleted record, misleading reports. Nest the session lock
					// inside the already-held global lock, per record's own
					// parentSessionId, matching the established global -> session order.
					const repoKeyForLock = deriveRlmWorktreeRepoKey(
						records[0]?.repoRoot ?? "",
						records[0]?.gitCommonDir ?? "",
					);
					for (const parentSessionId of rawParentSessionIds) {
						await withProperLock(this.sessionLockPath(repoKeyForLock, parentSessionId), async () => {
							for (const record of records.filter(
								(candidate) => candidate.parentSessionId === parentSessionId,
							)) {
								const identityOk = await verifyRepoIdentity(record.repoRoot, record.gitCommonDir);
								const pathOk =
									canonicalizePath(record.worktreePath) ===
									canonicalizePath(join(namespaceDir, record.childId));
								// Defense in depth: the enumerated repoKey directory name must match
								// the record's own identity hash, so a tampered record cannot point
								// this sweep's git operations at a foreign repository.
								const repoKeyOk = deriveRlmWorktreeRepoKey(record.repoRoot, record.gitCommonDir) === repoKey;
								if (!identityOk || !pathOk || !repoKeyOk) {
									this.quarantineRecord(namespaceDir, record.childId);
									log.error(
										`[rlm-worktrees] Host sweep quarantined record for ${record.childId}; never executed against`,
									);
									report.push({
										childId: record.childId,
										branch: record.branch,
										wipPinned: false,
										outcome: "quarantined",
									});
									continue;
								}
								const reaped = await this.finalizeWorktreeLocked(
									namespaceDir,
									record.childId,
									record.repoRoot,
									record.gitCommonDir,
									() => false,
								);
								report.push(reaped);
							}
						});
					}
				}
			}
			return report;
		});
	}
}

export async function sweepDeadRlmWorktreeSessions(options: {
	agentDir: string;
	isSessionLive: (parentSessionId: string) => boolean;
}): Promise<RlmWorktreeReapEntry[]> {
	const manager = new RlmWorktreeLifecycleManager({
		root: join(options.agentDir, "rlm-worktrees"),
	});
	return manager.sweepDeadSessionNamespaces({ isSessionLive: options.isSessionLive });
}
