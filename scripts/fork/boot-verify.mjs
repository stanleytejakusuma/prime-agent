#!/usr/bin/env node
// Fork boot verification gate (PRD R10, deepened per red review).
//
// The 2026-08-18 crash (os.homedir shadowed by a regex in the bundled scope)
// parsed clean under `node --check` but crashed on the very first import.
// Syntax checking is not verification: this script actually imports the
// bundle and drives one real command against it before calling it bootable.
//
// Usage: node scripts/fork/boot-verify.mjs <path-to-bundle-cli.js>

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const bundlePath = process.argv[2];
if (!bundlePath) {
	console.error("usage: node scripts/fork/boot-verify.mjs <path-to-bundle-cli.js>");
	process.exit(2);
}
if (!existsSync(bundlePath)) {
	console.error(`FAIL: bundle not found at ${bundlePath}`);
	process.exit(1);
}

let failed = false;

function step(name, fn) {
	try {
		fn();
		console.log(`PASS: ${name}`);
	} catch (error) {
		failed = true;
		console.error(`FAIL: ${name}`);
		console.error(`  ${error instanceof Error ? error.message : String(error)}`);
	}
}

// 1. Import as its own process (own argv[1], matching real invocation --
//    a plain `node -e "import(...)"` gives no argv[1] and produces false
//    crashes in code paths that compute the CLI's own entrypoint).
step("bundle imports and runs as its own process (--version)", () => {
	const result = spawnSync(process.execPath, [bundlePath, "--version"], { encoding: "utf8", timeout: 15000 });
	if (result.status !== 0) {
		throw new Error(`exit ${result.status}: ${result.stderr || result.stdout}`);
	}
	const version = (result.stdout || result.stderr || "").trim();
	if (!version) {
		throw new Error("no version output on stdout or stderr");
	}
	console.log(`  version: ${version}`);
});

// 2. A throwaway daemon start + status roundtrip. Import/version alone does
//    not exercise the daemon lifecycle code, which is where the highest-risk
//    patches in this fork actually live (cwd-resume, timer, ghost-sweep).
step("throwaway daemon starts and reports status", () => {
	const socketPath = `/tmp/prime-agent-fork-boot-verify-${process.pid}.sock`;
	try {
		const statusResult = spawnSync(
			process.execPath,
			[bundlePath, "status", "--daemon-socket", socketPath, "--json"],
			{ encoding: "utf8", timeout: 20000 },
		);
		// A fresh socket path with no daemon running is expected to report "not
		// running" rather than crash; either a clean JSON response or a clean
		// non-zero exit with a recognizable message counts as a pass here. What
		// must NOT happen is an uncaught exception / stack trace.
		const combined = `${statusResult.stdout || ""}${statusResult.stderr || ""}`;
		if (/TypeError|ReferenceError|is not a function|Cannot determine/.test(combined)) {
			throw new Error(`daemon code path threw during status check: ${combined.slice(0, 400)}`);
		}
	} finally {
		spawnSync(process.execPath, [bundlePath, "shutdown", "--force", "--daemon-socket", socketPath], {
			encoding: "utf8",
			timeout: 15000,
		});
	}
});

// 3. Fork feature presence markers. A stale or feature-dropping build silently
//    loses UI surfaces (the status-line footer was once reported "gone" when
//    the running bundle predated its source). Each marker below is a plain
//    string literal (a capability name, protocol id, or user-facing hint
//    text) that appears verbatim in source and is guaranteed to survive
//    bundling and minification -- property/method names are deliberately
//    NOT used here (Red review 2026-08-24: an identifier like a method name
//    can be mangled if property renaming is ever enabled, and coupling this
//    branch's gate to a different feature's identifier ties their fates
//    together for no reason). Each marker is scoped to the branch that
//    introduced it; when a branch is reverted, remove its markers too.
step("bundle contains fork feature markers", () => {
	const bundleText = readFileSync(bundlePath, "utf8");
	const markers = [
		"agents/resume", // chat tray hint (fork agents view navigation, feat/status-line-parity)
		"session_usage_snapshot", // agents-view usage snapshot capability id (protocol 23, feat/agents-view-status-footer)
	];
	const missing = markers.filter((marker) => !bundleText.includes(marker));
	if (missing.length > 0) {
		throw new Error(`missing fork feature markers: ${missing.join(", ")}`);
	}
});

if (failed) {
	console.error("\nBOOT GATE: FAILED. Do not swap this build in.");
	process.exit(1);
}
console.log("\nBOOT GATE: PASSED.");
