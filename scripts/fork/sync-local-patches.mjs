#!/usr/bin/env node
// Rebuild local-patches deterministically from a base ref plus an ordered
// series of fix/feat branches (PRD R2).
//
// local-patches is disposable and rebuildable, not a branch anyone commits
// to directly. This script is the only sanctioned way to update it: it
// always deletes and recreates local-patches from scratch off the base ref,
// then merges each branch listed in scripts/fork/local-patches-series.txt in
// order. This dissolves the D6/D7 tension between "main tracks upstream via
// rebase" and "each fix lives on its own branch" -- local-patches never
// accumulates drift of its own, it is always a pure, reproducible function
// of (base ref, series file, branch tips).
//
// Usage:
//   node scripts/fork/sync-local-patches.mjs [--base <ref>] [--push] [--dry-run]
//
//   --base <ref>   Ref to rebuild local-patches from (default: main).
//   --push         Push the rebuilt local-patches branch to origin after a
//                   successful rebuild (skipped on --dry-run).
//   --dry-run      Build in a temporary branch name, verify, then delete it
//                   without touching the real local-patches branch or
//                   pushing anything. Safe to run any time as a health check.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seriesPath = join(repoRoot, "scripts", "fork", "local-patches-series.txt");

function parseArgs(argv) {
	const args = { base: "main", push: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--base") {
			args.base = argv[++i];
		} else if (argv[i] === "--push") {
			args.push = true;
		} else if (argv[i] === "--dry-run") {
			args.dryRun = true;
		}
	}
	return args;
}

function git(args, options = {}) {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", ...options });
	if (result.status !== 0 && !options.allowFailure) {
		const detail = (result.stderr || result.stdout || "").trim();
		throw new Error("git " + args.join(" ") + " failed: " + detail);
	}
	return result;
}

function readSeries() {
	if (!existsSync(seriesPath)) {
		throw new Error("series file not found at " + seriesPath);
	}
	const raw = readFileSync(seriesPath, "utf8");
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function branchExists(name) {
	const result = git(["rev-parse", "--verify", "--quiet", name], { allowFailure: true });
	return result.status === 0;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const series = readSeries();

	console.log("Base ref: " + args.base);
	console.log("Series (" + series.length + " branches): " + series.join(", "));

	for (const branch of series) {
		if (!branchExists(branch)) {
			throw new Error("series branch does not exist locally: " + branch + " (fetch it first)");
		}
	}

	const targetBranch = args.dryRun ? "local-patches-sync-dry-run-" + process.pid : "local-patches";

	const status = git(["status", "--porcelain"]).stdout;
	if (status.trim().length > 0) {
		throw new Error("working tree is not clean; commit or stash changes before syncing");
	}

	const originalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

	try {
		// Rebuild target branch from scratch off the base ref every time --
		// never an incremental merge onto whatever the branch currently is.
		if (branchExists(targetBranch)) {
			git(["branch", "-D", targetBranch]);
		}
		git(["checkout", "-b", targetBranch, args.base]);

		for (const branch of series) {
			console.log("Merging " + branch + " ...");
			const mergeResult = git(["merge", "--no-edit", branch], { allowFailure: true });
			if (mergeResult.status !== 0) {
				const detail = (mergeResult.stderr || mergeResult.stdout || "").trim();
				git(["merge", "--abort"], { allowFailure: true });
				throw new Error(
					"merge conflict on " + branch + ", aborted: " + detail + "\n" +
					"Resolve manually: git checkout " + args.base + "; then merge each series branch by hand up to and including " + branch + ", fix the conflict, and update this script's merge or the series order if needed.",
				);
			}
		}

		console.log("Rebuilt " + targetBranch + " from " + args.base + " + " + series.length + " branches.");

		if (args.push && !args.dryRun) {
			git(["push", "--force-with-lease", "origin", targetBranch]);
			console.log("Pushed " + targetBranch + " to origin.");
		} else if (args.dryRun) {
			console.log("Dry run: " + targetBranch + " built successfully, not pushed, will be deleted.");
		} else {
			console.log("Not pushed (pass --push to push to origin).");
		}
	} finally {
		git(["checkout", originalBranch], { allowFailure: true });
		if (args.dryRun && branchExists(targetBranch)) {
			git(["branch", "-D", targetBranch], { allowFailure: true });
		}
	}
}

main();
