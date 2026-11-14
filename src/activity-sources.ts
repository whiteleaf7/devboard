// 活動の画面の集計に使うデータを読む: main のコミット（git）、PR（gh）、ボードのイベント、決定記録の日付。
// 集計そのものは activity.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { milestoneProgress, summarizeActivity, PR_FIELDS, PullRequest, type Activity } from "./activity.ts";
import { allEvents, board } from "./board-db.ts";
import { readDecisions, readProject, readTasks, repoRoot } from "./store.ts";

const run = promisify(execFile);

// gh はネットワークを使うので、画面の再読み込みのたびには呼ばない
const PR_CACHE_MS = 60_000;
const GH_TIMEOUT_MS = 15_000;

type PullRequests = { pullRequests: PullRequest[]; error: string | null };
const prCache = new Map<string, { at: number; result: PullRequests }>();

// 取り込んだもの（main）を数える。作業中のブランチのコミットは含めない。日時は書いた時刻（author date）
async function readCommitTimes(): Promise<string[]> {
  for (const ref of ["main", "HEAD"]) {
    try {
      const { stdout } = await run("git", ["log", ref, "--format=%aI"], { cwd: repoRoot() });
      return stdout.split("\n").filter(Boolean);
    } catch {
      // main が無いリポジトリは HEAD を、git でなければコミットなしとして扱う
    }
  }
  return [];
}

function ghError(e: unknown): string {
  if (e instanceof Error && "code" in e && e.code === "ENOENT") return "gh が見つからない";
  const stderr = e instanceof Error && "stderr" in e ? String(e.stderr).trim().split("\n")[0] : "";
  return stderr || (e instanceof Error ? e.message : String(e));
}

async function readPullRequests(): Promise<PullRequests> {
  const root = repoRoot();
  const cached = prCache.get(root);
  if (cached && Date.now() - cached.at < PR_CACHE_MS) return cached.result;
  let result: PullRequests;
  try {
    const { stdout } = await run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", PR_FIELDS], {
      cwd: root,
      timeout: GH_TIMEOUT_MS,
    });
    result = { pullRequests: z.array(PullRequest).parse(JSON.parse(stdout)), error: null };
  } catch (e) {
    result = { pullRequests: [], error: `PR を取得できない: ${ghError(e)}` };
  }
  prCache.set(root, { at: Date.now(), result });
  return result;
}

export type ActivityResponse = Activity & {
  milestones: ReturnType<typeof milestoneProgress>;
  sources: { pullRequests: string | null };
};

export async function loadActivity(days: number, now = new Date()): Promise<ActivityResponse> {
  const [commitTimes, prs] = await Promise.all([readCommitTimes(), readPullRequests()]);
  const activity = summarizeActivity({
    commitTimes,
    pullRequests: prs.pullRequests,
    events: allEvents(board()),
    decisionDates: readDecisions()
      .map((d) => d.date)
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
    now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    days,
  });
  return {
    ...activity,
    milestones: milestoneProgress(readProject().milestones, readTasks().tasks),
    sources: { pullRequests: prs.error },
  };
}
