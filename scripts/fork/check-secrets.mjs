#!/usr/bin/env node
// Pre-commit secrets scan (fork hardening, R11: pre-push gitleaks scan on every push).
//
// Wraps `gitleaks protect --staged` with a clear, actionable error when the
// gitleaks binary is missing, instead of the raw ENOENT a bare npm script
// would produce. gitleaks is a system tool (installed via `brew install
// gitleaks`), not an npm dependency -- there is no npm-packaged gitleaks
// binary to pull in as a devDependency, so this script is the seam that
// makes the requirement visible and fixable rather than a silent skip or a
// confusing failure.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baselinePath = join(repoRoot, ".gitleaks-baseline.json");

function commandExists(command) {
	const result = spawnSync("command", ["-v", command], { shell: true });
	return result.status === 0;
}

if (!commandExists("gitleaks")) {
	const lines = [
		"check:secrets: gitleaks is not installed.",
		"",
		"gitleaks is a system tool, not an npm dependency (there is no npm-packaged",
		"gitleaks binary). Install it once with:",
		"",
		"  brew install gitleaks",
		"",
		"This gate exists to catch a real credential (API key, token) accidentally",
		"staged for commit before it reaches git history. It is not optional in this",
		"fork's hardening posture (see PRD R11).",
	];
	console.error(lines.join(String.fromCharCode(10)));
	process.exit(1);
}

if (!existsSync(baselinePath)) {
	console.error("check:secrets: baseline file not found at " + baselinePath);
	process.exit(1);
}

const result = spawnSync(
	"gitleaks",
	["protect", "--staged", "--baseline-path", baselinePath, "--no-banner"],
	{ cwd: repoRoot, stdio: "inherit" },
);

process.exit(result.status ?? 1);
