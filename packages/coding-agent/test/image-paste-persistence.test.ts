import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	attachmentDirFor,
	attachmentExtension,
	attachmentPathFor,
	persistPastedImageAttachment,
	readPastedImageAttachment,
} from "../src/modes/interactive/interactive-mode.js";

// getAgentDir() (used internally by attachmentDirFor) reads from the
// CONFIG_DIR_NAME under the user's home directory. Point HOME at a temp dir
// for the duration of these tests so persisted attachments never touch a
// real ~/.prime/agent installation.
describe("pasted image attachment persistence (fork fix: image-paste)", () => {
	let tempHome: string;
	let originalHome: string | undefined;

	let originalAgentDirEnv: string | undefined;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "prime-agent-image-paste-test-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHome;
		// getAgentDir() checks the CODING_AGENT_DIR override env var before HOME.
		// When these tests run inside a Prime Agent kernel (as they did during
		// fork development), that var is already set to the real ~/.prime/agent
		// from the host process's own environment, which silently defeats the
		// HOME redirection above. Clear it so the tests are honest regardless of
		// what process runs them.
		originalAgentDirEnv = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		} else {
			delete process.env.HOME;
		}
		if (originalAgentDirEnv !== undefined) {
			process.env.PRIME_AGENT_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	test("attachmentExtension maps common mime types to their real extensions", () => {
		expect(attachmentExtension("image/png")).toBe(".png");
		expect(attachmentExtension("image/jpeg")).toBe(".jpg");
		expect(attachmentExtension("image/svg+xml")).toBe(".svg");
		expect(attachmentExtension("image/webp")).toBe(".webp");
		expect(attachmentExtension(undefined)).toBe(".png");
		expect(attachmentExtension("not-a-mime-type")).toBe(".png");
	});

	test("attachmentPathFor scopes the file under the session id and agent dir", () => {
		const p1 = attachmentPathFor("session-a", 3, "image/png");
		const p2 = attachmentPathFor("session-b", 3, "image/png");

		expect(p1).not.toBe(p2);
		expect(p1).toContain("session-a");
		expect(p1).toContain("image-3.png");
		expect(attachmentDirFor("session-a")).toBe(join(p1, ".."));
	});

	test("persists pasted bytes to disk and they round-trip byte-identical", () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		const image = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };

		const savedPath = persistPastedImageAttachment("session-x", 5, image);

		expect(savedPath).toBeDefined();
		expect(existsSync(savedPath!)).toBe(true);
		expect(Buffer.from(readFileSync(savedPath!)).equals(bytes)).toBe(true);
	});

	test("recovers a persisted image after the in-memory registry is gone (the actual resume bug)", () => {
		// This is the core regression: pastedImages is an in-memory Map that is
		// empty in a fresh process. A resumed session's message still contains
		// the [image #N] marker text, but with no bytes behind it unless they
		// were persisted to disk on the original paste.
		const bytes = Buffer.from("fake png bytes for round trip test");
		const image = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };

		const savedPath = persistPastedImageAttachment("session-resume", 9, image);
		expect(savedPath).toBeDefined();

		// Simulate a fresh process: nothing but the file on disk survives.
		const recovered = readPastedImageAttachment("session-resume", 9, "image/png");

		expect(recovered).toBeDefined();
		expect(recovered?.data).toBe(image.data);
		expect(recovered?.mimeType).toBe("image/png");
		expect(recovered?.path).toBe(savedPath);
	});

	test("returns undefined when no attachment was ever persisted for that marker", () => {
		expect(readPastedImageAttachment("session-never-pasted", 42, "image/png")).toBeUndefined();
	});

	test("persistence failure is non-fatal and returns undefined rather than throwing", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		// An unwritable HOME simulates a disk/permission failure without needing
		// root or actual filesystem corruption.
		process.env.HOME = "/dev/null/impossible-path";

		expect(() => persistPastedImageAttachment("session-y", 1, image)).not.toThrow();
		expect(persistPastedImageAttachment("session-y", 1, image)).toBeUndefined();
	});
});
