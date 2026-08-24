import { describe, expect, test } from "vitest";
import {
	applyAgentsViewManualMove,
	buildAgentsViewRows,
	migrateAgentsViewManualOrder,
	orderSectionRows,
	pruneAgentsViewManualOrder,
	type UnifiedSessionRecord,
} from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function idleSummary(id: string, lastActivityAt: string): SessionSummary {
	return makeSummary({
		id,
		activeSessionId: id,
		sessionId: id,
		sessionName: id,
		modified: lastActivityAt,
		lastActivityAt,
		activity: "idle",
	});
}

describe("orderSectionRows", () => {
	test("no manual order falls back to the existing heuristic order unchanged", () => {
		const rows = buildAgentsViewRows([
			idleSummary("b", "2026-01-03T00:00:00Z"),
			idleSummary("a", "2026-01-02T00:00:00Z"),
			idleSummary("c", "2026-01-01T00:00:00Z"),
		]);
		const ordered = orderSectionRows(rows, undefined);
		expect(ordered.map((row) => row.summary.sessionId)).toEqual(rows.map((row) => row.summary.sessionId));
	});

	test("placed rows keep pinned relative order even when it disagrees with the heuristic", () => {
		const rows = buildAgentsViewRows([
			idleSummary("newest", "2026-01-05T00:00:00Z"),
			idleSummary("oldest", "2026-01-01T00:00:00Z"),
		]);
		// Heuristic (most-recent-first) would put newest before oldest; pin the
		// opposite order and confirm the pin wins.
		const ordered = orderSectionRows(rows, ["active:oldest", "active:newest"]);
		expect(ordered.map((row) => row.summary.sessionId)).toEqual(["oldest", "newest"]);
	});

	test("unplaced rows interleave around placed rows at their heuristic position, not after all placed rows", () => {
		// Heuristic order (most-recent-first): d, c, b, a.
		const rows = buildAgentsViewRows([
			idleSummary("a", "2026-01-01T00:00:00Z"),
			idleSummary("b", "2026-01-02T00:00:00Z"),
			idleSummary("c", "2026-01-03T00:00:00Z"),
			idleSummary("d", "2026-01-04T00:00:00Z"),
		]);
		// Pin d and b in their heuristic relative order (most-recent-first); c and
		// a stay unplaced and must interleave at their heuristic slot, not dump
		// after both pinned rows.
		const ordered = orderSectionRows(rows, ["active:d", "active:b"]);
		expect(ordered.map((row) => row.summary.sessionId)).toEqual(["d", "c", "b", "a"]);
	});

	test("determinism: pinned output is unchanged when equivalent input rows arrive in a different order", () => {
		const rows = buildAgentsViewRows([
			idleSummary("a", "2026-01-01T00:00:00Z"),
			idleSummary("b", "2026-01-02T00:00:00Z"),
			idleSummary("c", "2026-01-03T00:00:00Z"),
			idleSummary("d", "2026-01-04T00:00:00Z"),
			idleSummary("e", "2026-01-05T00:00:00Z"),
		]);
		const pinned = ["session:c", "session:a"];
		const first = orderSectionRows(rows, pinned).map((row) => row.summary.sessionId);
		const permutations = [[...rows].reverse(), [rows[2]!, rows[4]!, rows[0]!, rows[3]!, rows[1]!]];
		for (const permutation of permutations) {
			expect(orderSectionRows(permutation, pinned).map((row) => row.summary.sessionId)).toEqual(first);
		}
	});

	test("pinned entries for currently-absent sessions are dropped without leaving a gap", () => {
		const rows = buildAgentsViewRows([
			idleSummary("a", "2026-01-01T00:00:00Z"),
			idleSummary("b", "2026-01-02T00:00:00Z"),
		]);
		const ordered = orderSectionRows(rows, ["active:missing", "active:a", "active:b"]);
		expect(ordered.map((row) => row.summary.sessionId)).toEqual(["a", "b"]);
	});

	test("singleton and empty row lists are no-ops, never crash", () => {
		const single = buildAgentsViewRows([idleSummary("solo", "2026-01-01T00:00:00Z")]);
		expect(orderSectionRows(single, ["active:solo"]).map((row) => row.summary.sessionId)).toEqual(["solo"]);
		expect(orderSectionRows([], ["active:solo"])).toEqual([]);
		expect(orderSectionRows([], undefined)).toEqual([]);
	});
});

describe("applyAgentsViewManualMove", () => {
	test("seeds manualOrder from the current display order on first use and swaps the moved pair", () => {
		const displayOrder = ["session:a", "session:b", "session:c"];
		const next = applyAgentsViewManualMove(undefined, displayOrder, "session:b", "session:a");
		expect(next).toEqual(["session:b", "session:a", "session:c"]);
	});

	test("swaps two already-pinned identities in place, keeping every other pin's position", () => {
		const pinned = ["session:a", "session:b", "session:c", "session:d"];
		const displayOrder = pinned;
		const next = applyAgentsViewManualMove(pinned, displayOrder, "session:c", "session:b");
		expect(next).toEqual(["session:a", "session:c", "session:b", "session:d"]);
	});

	test("moving an unplaced row past a placed neighbor pins both without disturbing other pins", () => {
		// b is pinned; a, c are unplaced. Moving c "earlier" past b must pin both
		// b and c, adjacent, without needing every row pre-pinned.
		const pinned = ["session:b"];
		const displayOrder = ["session:a", "session:b", "session:c"];
		const next = applyAgentsViewManualMove(pinned, displayOrder, "session:c", "session:b");
		expect(next).toEqual(["session:c", "session:b"]);
	});
});

describe("migrateAgentsViewManualOrder", () => {
	function record(identity: string, aliases: string[]): UnifiedSessionRecord {
		return {
			identity,
			identityAliases: aliases,
			section: "idle",
			searchableText: "",
		};
	}

	test("dedupes and preserves order while rewriting stale aliases to the current identity", () => {
		const byKey = new Map<string, UnifiedSessionRecord>();
		const migrated = record("file:/tmp/a.jsonl", ["file:/tmp/a.jsonl", "active:a"]);
		byKey.set("active:a", migrated);
		byKey.set("file:/tmp/a.jsonl", migrated);

		const result = migrateAgentsViewManualOrder(
			{ idle: ["active:a", "session:untouched", "file:/tmp/a.jsonl"] },
			byKey,
		);
		// active:a and file:/tmp/a.jsonl both resolve to the same current
		// identity; only the first occurrence survives, order preserved.
		expect(result.idle).toEqual(["file:/tmp/a.jsonl", "session:untouched"]);
	});

	test("leaves an identity with no alias match untouched (record not streamed in yet)", () => {
		const result = migrateAgentsViewManualOrder({ running: ["session:not-yet-seen"] }, new Map());
		expect(result.running).toEqual(["session:not-yet-seen"]);
	});

	test("does not force-initialize sections absent from the input (Partial<Record> shape)", () => {
		const result = migrateAgentsViewManualOrder({ idle: ["session:a"] }, new Map());
		expect(result).toEqual({ idle: ["session:a"] });
		expect(Object.hasOwn(result, "running")).toBe(false);
		expect(Object.hasOwn(result, "inactive")).toBe(false);
	});
});

describe("pruneAgentsViewManualOrder", () => {
	test("drops only identities that no longer exist anywhere; a section-internal absence is not pruned by this function", () => {
		// pruneAgentsViewManualOrder only knows "does this identity exist at all"
		// (knownIdentities is global, not per-section); section-membership churn
		// (Idle -> Running -> Idle) never removes the entry because the identity
		// keeps existing across the move -- restoring the slot is proven by the
		// orderSectionRows tests above (a pin for a row currently absent from
		// `rows` is simply dropped from that call's output, not deleted from the
		// stored array).
		const result = pruneAgentsViewManualOrder(
			{ idle: ["session:alive", "session:deleted"], running: ["session:alive"] },
			new Set(["session:alive"]),
		);
		expect(result).toEqual({ idle: ["session:alive"], running: ["session:alive"] });
	});

	test("drops an entire section key once its array is empty after pruning", () => {
		const result = pruneAgentsViewManualOrder({ idle: ["session:deleted"] }, new Set());
		expect(Object.hasOwn(result, "idle")).toBe(false);
	});
});

describe("orderAgentsViewRoots: section round-trip retention", () => {
	test("a pin for a session that leaves its section and later returns restores its pinned slot", () => {
		// Idle session pinned first among idle rows.
		let sessions = [idleSummary("pinned", "2026-01-01T00:00:00Z"), idleSummary("other", "2026-01-05T00:00:00Z")];
		let rows = buildAgentsViewRows(sessions);
		const manualOrder = { idle: ["active:pinned", "active:other"] };
		let ordered = orderSectionRows(
			rows.filter((row) => row.section === "idle"),
			manualOrder.idle,
		);
		expect(ordered.map((row) => row.summary.sessionId)).toEqual(["pinned", "other"]);

		// The pinned session goes running (leaves the idle section); the pin
		// entry is untouched by pruning (see pruneAgentsViewManualOrder tests)
		// because the identity still exists globally.
		sessions = [{ ...sessions[0]!, activity: "working", hasActiveHeartbeat: true }, sessions[1]!];
		rows = buildAgentsViewRows(sessions);
		const idleRowsWhileRunning = rows.filter((row) => row.section === "idle");
		ordered = orderSectionRows(idleRowsWhileRunning, manualOrder.idle);
		// Pinned identity absent from the idle rows this call; only "other" shows.
		expect(ordered.map((row) => row.summary.sessionId)).toEqual(["other"]);

		// The session returns to idle; its old pin restores the slot without
		// any extra bookkeeping, because manualOrder was never touched.
		sessions = [{ ...sessions[0]!, activity: "idle", hasActiveHeartbeat: false }, sessions[1]!];
		rows = buildAgentsViewRows(sessions);
		ordered = orderSectionRows(
			rows.filter((row) => row.section === "idle"),
			manualOrder.idle,
		);
		expect(ordered.map((row) => row.summary.sessionId)).toEqual(["pinned", "other"]);
	});
});

describe("buildAgentsViewRows manual order integration", () => {
	test("orders top-level roots by identity before emitting an expanded subagent tree", () => {
		const parent = idleSummary("parent", "2026-01-01T00:00:00Z");
		const child = makeSummary({
			id: "child",
			activeSessionId: "child",
			sessionId: "child",
			sessionName: "child",
			runtimeKind: "subagent",
			parentSessionId: parent.sessionId,
			parentActiveSessionId: parent.activeSessionId,
			activity: "idle",
		});
		const other = idleSummary("other", "2026-01-02T00:00:00Z");

		const rows = buildAgentsViewRows([parent, child, other], new Set(["active:parent"]), new Set(), undefined, {
			idle: ["active:parent", "active:other"],
		});

		expect(
			rows
				.filter((row) => row.kind === "agent" && row.depth === 0)
				.map((row) => [row.identity, row.summary.sessionId]),
		).toEqual([
			["active:parent", "parent"],
			["active:other", "other"],
		]);
		expect(rows.filter((row) => row.kind === "subagent").map((row) => row.summary.sessionId)).toEqual(["child"]);
	});

	test("leaves a scoped subtree in heuristic order instead of applying global pins", () => {
		const parent = idleSummary("parent", "2026-01-01T00:00:00Z");
		const childA = makeSummary({
			id: "child-a",
			activeSessionId: "child-a",
			sessionId: "child-a",
			sessionName: "child-a",
			runtimeKind: "subagent",
			parentSessionId: parent.sessionId,
			parentActiveSessionId: parent.activeSessionId,
			activity: "idle",
			modified: "2026-01-01T00:00:00Z",
			lastActivityAt: "2026-01-01T00:00:00Z",
		});
		const childB = makeSummary({
			id: "child-b",
			activeSessionId: "child-b",
			sessionId: "child-b",
			sessionName: "child-b",
			runtimeKind: "subagent",
			parentSessionId: parent.sessionId,
			parentActiveSessionId: parent.activeSessionId,
			activity: "idle",
			modified: "2026-01-02T00:00:00Z",
			lastActivityAt: "2026-01-02T00:00:00Z",
		});

		const rows = buildAgentsViewRows(
			[parent, childA, childB],
			new Set(),
			new Set(),
			{ sessionId: parent.sessionId, activeSessionId: parent.activeSessionId },
			{ idle: ["active:child-a", "active:child-b"] },
		);

		expect(rows.filter((row) => row.depth === 0).map((row) => row.summary.sessionId)).toEqual(["child-b", "child-a"]);
	});
});
