// 活動の画面（/activity）の集計。コミット・PR・ボードのイベントの時刻を、指定のタイムゾーンの日付と時台で数える。
// 読み込み（git・gh・SQLite）は activity-sources.ts に分け、ここは副作用を持たない

import { z } from "zod";

// gh pr list --json の出力のうち、使う項目。CI の結果は、チェックの実行（status・conclusion）と
// コミットの状態（state）のどちらでも来る
const Check = z.looseObject({
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  state: z.string().optional(),
});
export const PullRequest = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  url: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  statusCheckRollup: z.array(Check).nullable().default([]),
});
export type PullRequest = z.infer<typeof PullRequest>;
export const PR_FIELDS = Object.keys(PullRequest.shape).join(",");

// 集計に使うボードのイベント。board-db の BoardEvent のうち、数えるのに要る項目だけ
export type ActivityEvent = { at: string; actor: string | null; kind: string; subject: string; data: unknown };

export type Metric = "commits" | "prMerged" | "tasksDone";

export type ActivityInput = {
  commitTimes: string[];
  pullRequests: PullRequest[];
  events: ActivityEvent[];
  // 決定記録の「- 日付:」（YYYY-MM-DD）。時刻は無いので日付だけで数える
  decisionDates: string[];
  now: Date;
  timeZone: string;
  // 直近の何日を見るか。0 は記録の始まりから
  days: number;
};

export type Totals = {
  commits: number;
  prMerged: number;
  tasksDone: number;
  lessons: number;
  decisions: number;
  userActions: number;
  aiActions: number;
};

export type Activity = {
  range: { days: number; from: string; to: string; timeZone: string };
  totals: Totals;
  // 同じ長さの、ひとつ前の期間。全期間のときは比べる相手が無いので null
  previous: Totals | null;
  daily: ({ date: string } & Record<Metric, number>)[];
  // 曜日（月曜が 0）× 時台（0〜23）の件数
  heatmap: Record<Metric, number[][]>;
  // 期間に完了したタスクの、着手（doing）から完了（done）までの時間。着手を通らずに完了したものは数えない
  leadTime: { count: number; medianMs: number | null };
  // 期間に作ったか、マージした PR。新しい順
  pullRequests: PullRequestRow[];
};

export type CheckResult = "success" | "failure" | "pending" | null;
export type PullRequestRow = Omit<PullRequest, "statusCheckRollup"> & { checks: CheckResult; mergeMs: number | null };

type LocalTime = { date: string; hour: number };

function localTimeOf(timeZone: string): (iso: string) => LocalTime {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  return (iso) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  };
}

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayIndex = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

// 完了は「状態が done になったこと」で数える。作った時点で done のもの（git の履歴から取り込んだタスク）も含める
const CreatedDone = z.object({ task: z.object({ status: z.literal("done") }) });
const ChangedToDone = z.object({ changes: z.object({ status: z.object({ to: z.literal("done") }) }) });

function isTaskDone(event: ActivityEvent): boolean {
  if (event.kind === "task.created") return CreatedDone.safeParse(event.data).success;
  if (event.kind === "task.changed") return ChangedToDone.safeParse(event.data).success;
  return false;
}

const FAILED = ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"];
const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];

export function checkResult(checks: PullRequest["statusCheckRollup"]): CheckResult {
  if (!checks?.length) return null;
  const results = checks.map((c) => c.conclusion ?? c.state ?? "");
  if (results.some((r) => FAILED.includes(r))) return "failure";
  return results.every((r) => PASSED.includes(r)) ? "success" : "pending";
}

const StatusTo = z.object({ changes: z.object({ status: z.object({ to: z.string() }) }) });

// 着手してから完了するまで。完了のあとにやり直したタスクは、次の着手から数え直す
export function leadTimes(events: ActivityEvent[]): { doneAt: string; ms: number }[] {
  const started = new Map<string, string>();
  const result: { doneAt: string; ms: number }[] = [];
  for (const e of events) {
    if (e.kind !== "task.changed") continue;
    const to = StatusTo.safeParse(e.data);
    if (!to.success) continue;
    const status = to.data.changes.status.to;
    const start = started.get(e.subject);
    if (status === "doing" && !start) started.set(e.subject, e.at);
    if (status === "done" && start) result.push({ doneAt: e.at, ms: Date.parse(e.at) - Date.parse(start) });
    if (status === "done" || status === "cancelled") started.delete(e.subject);
  }
  return result;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeActivity(input: ActivityInput): Activity {
  const local = localTimeOf(input.timeZone);
  const times: Record<Metric, LocalTime[]> = {
    commits: input.commitTimes.map(local),
    prMerged: input.pullRequests.flatMap((pr) => (pr.mergedAt ? [local(pr.mergedAt)] : [])),
    tasksDone: input.events.filter(isTaskDone).map((e) => local(e.at)),
  };
  const datesOf = (list: LocalTime[]) => list.map((t) => t.date);
  const dated: Record<keyof Totals, string[]> = {
    commits: datesOf(times.commits),
    prMerged: datesOf(times.prMerged),
    tasksDone: datesOf(times.tasksDone),
    lessons: input.events.filter((e) => e.kind === "lesson.created").map((e) => local(e.at).date),
    decisions: input.decisionDates,
    userActions: input.events.filter((e) => e.actor === "user").map((e) => local(e.at).date),
    aiActions: input.events.filter((e) => e.actor === "ai").map((e) => local(e.at).date),
  };

  const to = local(input.now.toISOString()).date;
  const earliest = [
    ...dated.commits,
    ...dated.prMerged,
    ...dated.tasksDone,
    ...dated.lessons,
    ...dated.decisions,
  ].reduce((min, d) => (d < min ? d : min), to);
  const from = input.days > 0 ? addDays(to, -(input.days - 1)) : earliest;

  const within = (start: string, end: string) => (date: string) => date >= start && date <= end;
  const totalsIn = (inRange: (date: string) => boolean): Totals => {
    const count = (key: keyof Totals) => dated[key].filter(inRange).length;
    return {
      commits: count("commits"),
      prMerged: count("prMerged"),
      tasksDone: count("tasksDone"),
      lessons: count("lessons"),
      decisions: count("decisions"),
      userActions: count("userActions"),
      aiActions: count("aiActions"),
    };
  };
  const inRange = within(from, to);

  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const daily = dates.map((date) => {
    const count = (metric: Metric) => times[metric].filter((t) => t.date === date).length;
    return { date, commits: count("commits"), prMerged: count("prMerged"), tasksDone: count("tasksDone") };
  });

  const grid = (metric: Metric) => {
    const cells = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const t of times[metric]) if (inRange(t.date)) cells[weekdayIndex(t.date)]![t.hour]!++;
    return cells;
  };

  const leads = leadTimes(input.events)
    .filter((l) => inRange(local(l.doneAt).date))
    .map((l) => l.ms);

  const pullRequests = input.pullRequests
    .filter((pr) => inRange(local(pr.createdAt).date) || (pr.mergedAt !== null && inRange(local(pr.mergedAt).date)))
    .toSorted((a, b) => b.number - a.number)
    .map(({ statusCheckRollup, ...pr }) => ({
      ...pr,
      checks: checkResult(statusCheckRollup),
      mergeMs: pr.mergedAt ? Date.parse(pr.mergedAt) - Date.parse(pr.createdAt) : null,
    }));

  return {
    range: { days: input.days, from, to, timeZone: input.timeZone },
    totals: totalsIn(inRange),
    previous: input.days > 0 ? totalsIn(within(addDays(from, -input.days), addDays(from, -1))) : null,
    daily,
    heatmap: { commits: grid("commits"), prMerged: grid("prMerged"), tasksDone: grid("tasksDone") },
    leadTime: { count: leads.length, medianMs: median(leads) },
    pullRequests,
  };
}

// ---- マイルストーンの進み（期間に関係なく、いまの状態） ----

type TaskState = { milestone: string | null; status: string };
type MilestoneRef = { id: string; title: string; status: string };
export type MilestoneRow = {
  id: string | null;
  title: string;
  status: string | null;
  total: number;
  done: number;
  cancelled: number;
  open: number;
};

export function milestoneProgress(
  milestones: MilestoneRef[],
  tasks: TaskState[],
): { rows: MilestoneRow[]; total: MilestoneRow } {
  const row = (id: string | null, title: string, status: string | null, mine: TaskState[]): MilestoneRow => {
    const done = mine.filter((t) => t.status === "done").length;
    const cancelled = mine.filter((t) => t.status === "cancelled").length;
    return { id, title, status, total: mine.length, done, cancelled, open: mine.length - done - cancelled };
  };
  const rows = milestones.map((m) =>
    row(
      m.id,
      m.title,
      m.status,
      tasks.filter((t) => t.milestone === m.id),
    ),
  );
  const known = new Set(milestones.map((m) => m.id));
  const unassigned = tasks.filter((t) => !t.milestone || !known.has(t.milestone));
  if (unassigned.length) rows.push(row(null, "マイルストーンなし", null, unassigned));
  return { rows, total: row(null, "合計", null, tasks) };
}
