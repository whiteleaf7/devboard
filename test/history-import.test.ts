import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsFromSnapshots } from "../src/history-import.ts";
import { Lesson, Task } from "../src/schema.ts";

const task = (fields: Record<string, unknown>) => Task.parse({ id: "T-001", title: "a", status: "todo", created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", ...fields });
const note = (at: string, text: string, by = "ai") => ({ at, text, by });
const project = { name: "p", summary: "", milestones: [] };

test("コミットごとの写しの違いを、作成・変更・メモのイベントにして、時刻の順に並べる", () => {
  const events = eventsFromSnapshots([
    { at: "2026-01-01T09:00:00Z", project, lessons: [], tasks: [task({ notes: [note("2026-01-01T00:30:00Z", "着手前のメモ")] })] },
    {
      at: "2026-01-02T09:00:00Z",
      project: { ...project, summary: "変えた" },
      lessons: [Lesson.parse({ id: "L-001", title: "l", problem: "p", fix: "f", created: "2026-01-02T01:00:00Z" })],
      tasks: [
        task({ status: "done", updated: "2026-01-02T02:00:00Z", notes: [note("2026-01-01T00:30:00Z", "着手前のメモ"), note("2026-01-02T02:00:00Z", "終えた", "user")] }),
        task({ id: "T-002", createdBy: "user", created: "2026-01-02T00:00:00Z", updated: "2026-01-02T00:00:00Z" }),
      ],
    },
    { at: "2026-01-03T09:00:00Z", project: { ...project, summary: "変えた" }, lessons: [], tasks: [] },
  ]);
  assert.deepEqual(
    events.map((e) => [e.at, e.kind, e.subject, e.actor]),
    [
      ["2026-01-01T00:00:00Z", "task.created", "T-001", "ai"],
      ["2026-01-01T00:30:00Z", "task.noted", "T-001", "ai"],
      ["2026-01-01T09:00:00Z", "project.changed", "project", null],
      ["2026-01-02T00:00:00Z", "task.created", "T-002", "user"],
      ["2026-01-02T01:00:00Z", "lesson.created", "L-001", "ai"],
      ["2026-01-02T02:00:00Z", "task.changed", "T-001", "user"],
      ["2026-01-02T02:00:00Z", "task.noted", "T-001", "user"],
      ["2026-01-02T09:00:00Z", "project.changed", "project", null],
    ],
    "同じ時刻に足されたメモの書き手を、変更した人とみなす。写しから消えたものと、変わらないものはイベントにしない",
  );
  assert.deepEqual(events[0]?.data, { task: task({ notes: [] }) }, "作成のイベントにはメモを含めない");
  assert.deepEqual(events[5]?.data, { changes: { status: { from: "todo", to: "done" } } });
});
