#!/usr/bin/env node
// Fork binary swap procedure (PRD D3/R4). WRITE-ONCE, HUMAN-EXECUTED SCRIPT.
//
// Swaps the live `prime-agent` binary from the Homebrew-installed original
// to this fork's own built bundle, with a one-command rollback path.
//
// This script does NOT run automatically as part of any build, check, or
// commit. It must be invoked explicitly and deliberately, ideally by
// Stanley directly or with his explicit real-time go-ahead, never by an
// agent session autonomously -- it stops and restarts the daemon that owns
// every live Prime Agent session on this machine, which is a fundamentally
// different risk class than any patch branch built so far.
//
// Usage:
//   node scripts/fork/swap.mjs status   Report current install state, do nothing.
//   node scripts/fork/swap.mjs swap     Execute the swap (D3/R4 procedure).
//   node scripts/fork/swap.mjs rollback Restore the original binary.
//
// R4 procedure (from the PRD, red review): stop daemon -> atomic symlink
// flip -> start daemon -> assert client AND daemon report +fork. Rollback
// mirrors this (kill fork daemon first, then flip back, then restart).
//
// R1: the rollback copy is a plain tarball OUTSIDE the Homebrew prefix
// (`brew cleanup` cannot delete it, unlike a package kept inside the
// Cellar). `brew pin prime-agent` (or uninstall the Homebrew formula
// entirely) is a prerequisite for a durable swap -- otherwise a future
// `brew upgrade` silently reinstalls over the fork. This script does NOT
// run `brew pin`/`brew uninstall` itself; it checks and reports the current
// pin state and tells the operator what to do, since that is a one-time,
// deliberate decision, not something to automate silently.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const HOMEBREW_BIN = "/opt/homebrew/bin/prime-agent";
const HOMEBREW_PACKAGE_DIR = "/opt/homebrew/lib/node_modules/prime-agent";
const FORK_BUNDLE = join(dirname(new URL(import.meta.url).pathname), "..", "..", "packages", "coding-agent", "dist", "bundle", "cli.js");
// Rollback copy lives OUTSIDE any Homebrew-managed path (R1: brew cleanup
// cannot touch it) and outside the fork repo itself (a `git clean` or repo
// deletion must not be able to destroy the only rollback copy).
const ROLLBACK_DIR = join(homedir(), ".prime-agent-orig-backup");
const ROLLBACK_MARKER = join(ROLLBACK_DIR, "swapped-from.json");

function run(cmd, args, options = {}) {
	return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

function readVersion(bundlePath, extraEnv = {}) {
	const result = run(process.execPath, [bundlePath, "--version"], { env: { ...process.env, ...extraEnv } });
	const text = (result.stdout || result.stderr || "").trim();
	return { status: result.status, version: text };
}

function currentSymlinkTarget() {
	try {
		return readlinkSync(HOMEBREW_BIN);
	} catch {
		return undefined;
	}
}

function isForkBundlePresent() {
	return existsSync(FORK_BUNDLE);
}

function reportStatus() {
	console.log("=== Fork swap status ===");
	console.log("Homebrew bin: " + HOMEBREW_BIN);
	console.log("  symlink target: " + (currentSymlinkTarget() ?? "(not a symlink or missing)"));
	const liveVersion = readVersion(HOMEBREW_BIN);
	console.log("  live --version: " + liveVersion.version);
	console.log("Fork bundle: " + FORK_BUNDLE);
	console.log("  present: " + isForkBundlePresent());
	if (isForkBundlePresent()) {
		const forkVersion = readVersion(FORK_BUNDLE);
		console.log("  --version: " + forkVersion.version);
	}
	console.log("Rollback backup: " + ROLLBACK_DIR);
	console.log("  present: " + existsSync(ROLLBACK_DIR));
	const brewPin = run("brew", ["list", "--pinned"]);
	const pinned = (brewPin.stdout || "").split("\n").includes("prime-agent");
	console.log("Homebrew pin (brew list --pinned): " + (pinned ? "PINNED" : "NOT PINNED -- brew upgrade could silently overwrite the swap"));
}

function assertDaemonStopped() {
	// A real implementation should verify no daemon process remains bound to
	// the default socket before proceeding. Left as an explicit manual
	// checkpoint here rather than an automated kill, per Stanley's
	// instruction (2026-08-19) never to issue daemon shutdown commands from
	// an agent session without his direct, real-time involvement.
	console.log("MANUAL CHECKPOINT: confirm the live daemon is stopped (e.g. via the client UI or a command Stanley runs directly) before continuing.");
}

function doSwap() {
	if (!isForkBundlePresent()) {
		throw new Error("fork bundle not found at " + FORK_BUNDLE + " -- run npm run build in the fork first");
	}
	const forkVersionCheck = readVersion(FORK_BUNDLE);
	if (!forkVersionCheck.version.includes("+fork.")) {
		throw new Error(
			"fork bundle --version does not contain the +fork. stamp (" + forkVersionCheck.version + "); " +
			"refusing to swap an unstamped build (R1 requires the +fork suffix to distinguish it from upstream)",
		);
	}

	if (!existsSync(ROLLBACK_DIR)) {
		console.log("No rollback backup found; creating one from the current install before swapping.");
		mkdirSync(ROLLBACK_DIR, { recursive: true });
		cpSync(HOMEBREW_PACKAGE_DIR, join(ROLLBACK_DIR, "prime-agent-orig"), { recursive: true });
		const originalTarget = currentSymlinkTarget();
		if (!originalTarget) {
			throw new Error(HOMEBREW_BIN + " is not currently a symlink; cannot safely record its target for rollback");
		}
		writeFileSync(
			ROLLBACK_MARKER,
			JSON.stringify({ originalSymlinkTarget: originalTarget, backedUpAt: new Date().toISOString() }, null, 2),
		);
	}

	assertDaemonStopped();

	// Atomic symlink flip: write a new symlink at a temp path, then rename
	// over the original -- rename is atomic on the same filesystem, so there
	// is no window where HOMEBREW_BIN points nowhere.
	const tempLink = HOMEBREW_BIN + ".swap-tmp";
	if (existsSync(tempLink)) {
		unlinkSync(tempLink);
	}
	symlinkSync(FORK_BUNDLE, tempLink);
	run("mv", ["-f", tempLink, HOMEBREW_BIN]);

	console.log("Symlink flipped: " + HOMEBREW_BIN + " -> " + FORK_BUNDLE);
	console.log("MANUAL CHECKPOINT: start the daemon (e.g. by running a prime-agent command) and verify below.");

	const clientVersion = readVersion(HOMEBREW_BIN);
	console.log("Client --version after swap: " + clientVersion.version);
	if (!clientVersion.version.includes("+fork.")) {
		throw new Error("post-swap client --version does not report +fork -- swap did not take effect as expected");
	}

	console.log("Swap complete. Daemon-side +fork assertion must be checked separately once the daemon is running (this script does not start the daemon or query a running daemon's version, per the no-autonomous-daemon-operations rule).");
}

function doRollback() {
	if (!existsSync(ROLLBACK_MARKER)) {
		throw new Error("no rollback marker found at " + ROLLBACK_MARKER + " -- nothing to roll back to, or the backup was made outside this script");
	}
	const marker = JSON.parse(readFileSync(ROLLBACK_MARKER, "utf8"));

	console.log("MANUAL CHECKPOINT: confirm the fork daemon is stopped before continuing (rollback mirrors the swap: kill fork daemon first).");

	const tempLink = HOMEBREW_BIN + ".rollback-tmp";
	if (existsSync(tempLink)) {
		unlinkSync(tempLink);
	}
	symlinkSync(marker.originalSymlinkTarget, tempLink);
	run("mv", ["-f", tempLink, HOMEBREW_BIN]);

	console.log("Symlink restored: " + HOMEBREW_BIN + " -> " + marker.originalSymlinkTarget);
	console.log("MANUAL CHECKPOINT: start the daemon and verify --version no longer reports +fork.");
}

const command = process.argv[2];
if (command === "status") {
	reportStatus();
} else if (command === "swap") {
	doSwap();
} else if (command === "rollback") {
	doRollback();
} else {
	console.error("usage: node scripts/fork/swap.mjs <status|swap|rollback>");
	process.exit(2);
}
