// ボードの決まり（CLAUDE.md の「作業するとき」）に合わない状態を探す。
// store は書く前と後で比べ、新しく増えた問題があれば書かない（決定記録 0011）。get_overview の problems にも使う

import type { Task } from "./schema.ts";

export type RuleProblem = { task: string; check: string; message: string };

const OPEN = ["todo", "doing", "blocked", "review"];
const NEEDS_NOTE: Record<string, string> = {
  done: "done にするときはメモが要る。何を確かめて終えたのかを note に残す",
  cancelled: "cancelled にするときはメモが要る。不要になった理由を note に残す",
  blocked: "blocked にするときはメモが要る。進められない理由と、ユーザーにしてほしいことを note に残す",
};

// start から links をたどって、start 自身に戻ってくるか
function reaches(start: string, first: string[], links: (id: string) => string[]): boolean {
  const seen = new Set<string>();
  const queue = [...first];
  while (queue.length) {
    const id = queue.pop()!;
    if (id === start) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...links(id));
  }
  return false;
}

export function ruleProblems(tasks: Task[], milestones: Set<string>): RuleProblem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const problems: RuleProblem[] = [];
  for (const task of tasks) {
    const add = (check: string, message: string) => problems.push({ task: task.id, check, message });
    if (task.milestone && !milestones.has(task.milestone))
      add("broken-link", `マイルストーン ${task.milestone} が無い`);
    if (task.parent && !byId.has(task.parent)) add("broken-link", `親 ${task.parent} が存在しない`);
    for (const dep of task.dependsOn) if (!byId.has(dep)) add("broken-link", `依存先 ${dep} が存在しない`);
    if (task.dependsOn.includes(task.id) || reaches(task.id, task.dependsOn, (id) => byId.get(id)?.dependsOn ?? []))
      add("broken-link", "依存が循環している");
    if (
      reaches(task.id, task.parent ? [task.parent] : [], (id) =>
        [byId.get(id)?.parent].filter((p): p is string => Boolean(p)),
      )
    ) {
      add("broken-link", "親子関係が循環している");
    }
    const needsNote = NEEDS_NOTE[task.status];
    if (needsNote && task.notes.length === 0) add("unexplained-state", needsNote);
    if (task.status === "review" && task.createdBy === "ai")
      add("forbidden-review", "AI のタスクは review にしない。結果を自分で確かめて done にする");
    if (task.status === "done") {
      const open = tasks
        .filter((child) => child.parent === task.id && OPEN.includes(child.status))
        .map((child) => child.id);
      if (open.length) add("parent-closed-early", `子（${open.join(", ")}）が終わっていないのに done になっている`);
    }
  }
  return problems;
}

const key = (p: RuleProblem) => `${p.task}\0${p.check}\0${p.message}`;

// 変更の前には無かった問題。移行で持ち込んだ古い問題は断らず、新しく壊すことだけを止める
export function introducedProblems(before: RuleProblem[], after: RuleProblem[]): RuleProblem[] {
  const existing = new Set(before.map(key));
  return after.filter((p) => !existing.has(key(p)));
}
