import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeSummary } from "../src/escapes.ts";
import { Task } from "../src/schema.ts";

const task = (id: string, fields: Record<string, unknown> = {}) =>
  Task.parse({ id, title: id, status: "done", created: "", updated: "", ...fields });
const observed = (check: string) => ({ at: "", actor: null, kind: "rule.observed", subject: "T-009", data: { check } });

test("done のうち、中止していない不具合に原因として結ばれたものの率を出す", () => {
  const tasks = [
    task("T-001"),
    task("T-002"),
    task("T-003"),
    task("T-004", { status: "doing" }),
    task("T-005", { labels: ["bug"], causedBy: ["T-001"] }),
    task("T-006", { labels: ["bug"], status: "todo", causedBy: ["T-001", "T-004"] }),
    task("T-007", { labels: ["bug"], status: "cancelled", causedBy: ["T-002"] }),
    task("T-008", { labels: ["bug"], status: "todo" }),
  ];
  const summary = escapeSummary(tasks, [observed("bug-without-missed-check"), observed("unverified-done")]);
  assert.deepEqual(
    { ...summary, links: summary.links.map((l) => [l.bug, l.causes]) },
    {
      done: 4,
      escaped: 1,
      rate: 1 / 4,
      bugs: 3,
      unlinkedBugs: ["T-008"],
      links: [
        ["T-005", ["T-001"]],
        ["T-006", ["T-001", "T-004"]],
      ],
      closedWithoutMissedCheck: 1,
    },
  );
});

test("done が無いときは率を出さない", () => {
  assert.equal(escapeSummary([task("T-001", { status: "todo" })], []).rate, null);
});
