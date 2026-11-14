import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkResult,
  leadTimes,
  milestoneProgress,
  summarizeActivity,
  type ActivityEvent,
  type ActivityInput,
} from "../src/activity.ts";

const base: ActivityInput = {
  commitTimes: [],
  pullRequests: [],
  events: [],
  decisionDates: [],
  now: new Date("2026-11-14T12:00:00+09:00"),
  timeZone: "Asia/Tokyo",
  days: 7,
};

const pr = (number: number, mergedAt: string | null, createdAt = "2026-11-10T00:00:00Z") => ({
  number,
  title: `pr ${number}`,
  state: mergedAt ? ("MERGED" as const) : ("OPEN" as const),
  url: `https://example.com/${number}`,
  createdAt,
  mergedAt,
  additions: 3,
  deletions: 1,
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
});

const status = (subject: string, at: string, to: string): ActivityEvent => ({
  at,
  actor: "ai",
  kind: "task.changed",
  subject,
  data: { changes: { status: { from: "x", to } } },
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
      {
        at,
        subject: "T-001",
        actor: "ai",
        kind: "task.changed",
        data: { changes: { status: { from: "doing", to: "done" } } },
      },
      {
        at,
        subject: "T-001",
        actor: "ai",
        kind: "task.changed",
        data: { changes: { status: { from: "todo", to: "doing" } } },
      },
      { at, subject: "T-001", actor: null, kind: "task.created", data: { task: { status: "done" } } },
      { at, subject: "T-001", actor: "user", kind: "task.created", data: { task: { status: "todo" } } },
      { at, subject: "T-001", actor: "user", kind: "task.noted", data: { note: { text: "x" } } },
      { at, subject: "T-001", actor: "ai", kind: "lesson.created", data: {} },
      { at, subject: "T-002", actor: "ai", kind: "task.noted", data: { note: { text: "y" } } },
    ],
  });
  assert.equal(a.totals.tasksDone, 2);
  assert.equal(a.totals.lessons, 1);
  assert.equal(a.totals.userActions, 2);
  assert.equal(a.totals.aiActions, 4);
});

test("記録が無くても、期間の日付は空の行で埋める", () => {
  const a = summarizeActivity({ ...base, days: 30 });
  assert.equal(a.daily.length, 30);
  assert.ok(a.daily.every((d) => d.commits === 0 && d.prMerged === 0 && d.tasksDone === 0));
  assert.equal(a.heatmap.tasksDone.flat().length, 7 * 24);
});

test("CI の結果は、失敗が 1 つでもあれば失敗、すべて通れば成功、それ以外は実行中", () => {
  assert.equal(checkResult([]), null);
  assert.equal(checkResult(null), null);
  assert.equal(checkResult([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }, { conclusion: "SKIPPED" }]), "success");
  assert.equal(checkResult([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), "failure");
  assert.equal(checkResult([{ status: "IN_PROGRESS", conclusion: "" }]), "pending");
  assert.equal(checkResult([{ state: "PENDING" }]), "pending");
  assert.equal(checkResult([{ conclusion: "SUCCESS" }, { state: "PENDING" }]), "pending");
});

test("着手から完了までは、最初の doing から done までを測り、やり直したら次の doing から数える", () => {
  const leads = leadTimes([
    status("T-1", "2026-11-13T00:00:00Z", "doing"),
    status("T-1", "2026-11-13T01:00:00Z", "blocked"),
    status("T-1", "2026-11-13T02:00:00Z", "doing"),
    status("T-1", "2026-11-13T03:00:00Z", "done"),
    status("T-1", "2026-11-13T04:00:00Z", "doing"),
    status("T-1", "2026-11-13T04:30:00Z", "done"),
    status("T-2", "2026-11-13T00:00:00Z", "done"),
  ]);
  assert.deepEqual(
    leads.map((l) => l.ms / 60_000),
    [180, 30],
  );
});

test("期間に完了したタスクが無ければ、中央値は null", () => {
  assert.deepEqual(summarizeActivity(base).leadTime, { count: 0, medianMs: null });
});

test("期間の中央値と、期間に作ったかマージした PR を新しい順に返す", () => {
  const a = summarizeActivity({
    ...base,
    events: [
      status("T-1", "2026-11-13T00:00:00Z", "doing"),
      status("T-1", "2026-11-13T01:00:00Z", "done"),
      status("T-2", "2026-11-13T00:00:00Z", "doing"),
      status("T-2", "2026-11-13T03:00:00Z", "done"),
      status("T-3", "2026-10-01T00:00:00Z", "doing"),
      status("T-3", "2026-10-01T09:00:00Z", "done"),
    ],
    pullRequests: [
      pr(1, "2026-10-01T01:00:00Z", "2026-10-01T00:00:00Z"),
      pr(2, "2026-11-12T00:30:00Z", "2026-11-01T00:00:00Z"),
      pr(3, null, "2026-11-13T00:00:00Z"),
    ],
  });
  assert.deepEqual(a.leadTime, { count: 2, medianMs: 2 * 3_600_000 });
  assert.deepEqual(
    a.pullRequests.map((p) => [p.number, p.checks, p.mergeMs]),
    [
      [3, "success", null],
      [2, "success", 11 * 86_400_000 + 1_800_000],
    ],
  );
});

test("マイルストーンごとに完了・中止・残りを数え、どれにも属さないタスクは別の行にする", () => {
  const { rows, total } = milestoneProgress(
    [
      { id: "M0", title: "a", status: "active" },
      { id: "M1", title: "b", status: "planned" },
    ],
    [
      { milestone: "M0", status: "done" },
      { milestone: "M0", status: "cancelled" },
      { milestone: "M0", status: "doing" },
      { milestone: null, status: "todo" },
      { milestone: "M9", status: "done" },
    ],
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.total, r.done, r.cancelled, r.open]),
    [
      ["M0", 3, 1, 1, 1],
      ["M1", 0, 0, 0, 0],
      [null, 2, 1, 0, 1],
    ],
  );
  assert.deepEqual([total.total, total.done, total.cancelled, total.open], [5, 2, 1, 2]);
});
