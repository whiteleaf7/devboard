import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeActivity, type ActivityInput } from "../src/activity.ts";

const base: ActivityInput = {
  commitTimes: [],
  pullRequests: [],
  events: [],
  decisionDates: [],
  now: new Date("2026-11-14T12:00:00+09:00"),
  timeZone: "Asia/Tokyo",
  days: 7,
};

const pr = (number: number, mergedAt: string | null) => ({
  number,
  title: `pr ${number}`,
  state: mergedAt ? ("MERGED" as const) : ("OPEN" as const),
  url: `https://example.com/${number}`,
  createdAt: "2026-11-10T00:00:00Z",
  mergedAt,
});

test("日付と時台は、指定したタイムゾーンで数える", () => {
  // UTC では 11/13 の 15 時台だが、JST では 11/14（土）の 0 時台
  const a = summarizeActivity({ ...base, commitTimes: ["2026-11-13T15:30:00Z"] });
  assert.equal(a.daily.at(-1)?.date, "2026-11-14");
  assert.equal(a.daily.at(-1)?.commits, 1);
  assert.equal(a.heatmap.commits[5]?.[0], 1);
});

test("直近 N 日は今日を含む N 日で、ひとつ前の N 日と比べる", () => {
  const a = summarizeActivity({
    ...base,
    commitTimes: ["2026-11-08T10:00:00+09:00", "2026-11-07T23:00:00+09:00", "2026-10-31T10:00:00+09:00"],
  });
  assert.deepEqual(a.range, { days: 7, from: "2026-11-08", to: "2026-11-14", timeZone: "Asia/Tokyo" });
  assert.equal(a.daily.length, 7);
  assert.equal(a.totals.commits, 1);
  assert.equal(a.previous?.commits, 1);
});

test("全期間は最も古い記録の日から数え、比べる相手を持たない", () => {
  const a = summarizeActivity({
    ...base,
    days: 0,
    commitTimes: ["2026-11-12T09:00:00+09:00"],
    decisionDates: ["2026-11-11"],
  });
  assert.equal(a.range.from, "2026-11-11");
  assert.equal(a.daily.length, 4);
  assert.equal(a.totals.decisions, 1);
  assert.equal(a.previous, null);
});

test("PR はマージした時刻で数え、マージしていないものは数えない", () => {
  const a = summarizeActivity({ ...base, pullRequests: [pr(1, "2026-11-13T01:00:00Z"), pr(2, null)] });
  assert.equal(a.totals.prMerged, 1);
  assert.equal(a.daily.find((d) => d.date === "2026-11-13")?.prMerged, 1);
});

test("完了したタスクは、done になった変更と、done で作られたタスクを数える", () => {
  const at = "2026-11-13T03:00:00Z";
  const a = summarizeActivity({
    ...base,
    events: [
      { at, actor: "ai", kind: "task.changed", data: { changes: { status: { from: "doing", to: "done" } } } },
      { at, actor: "ai", kind: "task.changed", data: { changes: { status: { from: "todo", to: "doing" } } } },
      { at, actor: null, kind: "task.created", data: { task: { status: "done" } } },
      { at, actor: "user", kind: "task.created", data: { task: { status: "todo" } } },
      { at, actor: "user", kind: "task.noted", data: { note: { text: "x" } } },
      { at, actor: "ai", kind: "lesson.created", data: {} },
    ],
  });
  assert.equal(a.totals.tasksDone, 2);
  assert.equal(a.totals.lessons, 1);
  assert.equal(a.totals.userActions, 2);
  assert.equal(a.totals.aiActions, 3);
});

test("記録が無くても、期間の日付は空の行で埋める", () => {
  const a = summarizeActivity({ ...base, days: 30 });
  assert.equal(a.daily.length, 30);
  assert.ok(a.daily.every((d) => d.commits === 0 && d.prMerged === 0 && d.tasksDone === 0));
  assert.equal(a.heatmap.tasksDone.flat().length, 7 * 24);
});
