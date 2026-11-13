// タスクの一覧に、進め方の判断に使う情報（着手できるか、順番、止まっている理由、範囲の重なり）を足す。保存には触らない

import { FINISHED, PRIORITIES, type Priority, type Task, type TaskStatus } from "./schema.ts";

export type TaskView = Task & {
  // まだ終わっていない依存先
  waitingOn: { id: string; status: TaskStatus | "missing" }[];
  // 子タスクの ID
  children: string[];
  // 今すぐ着手できる（未着手・子を持たない・依存先がすべて終わっている）
  ready: boolean;
  // 依存をたどった先が確認待ち・ブロック・存在しないなどで、AI だけでは進められない理由
  stuck: string | null;
  // 子を持つ親で、子がすべて終わっている（親を閉じてよい）
  closable: boolean;
  // 未着手のタスクを、依存と優先度を考えて並べたときの順番（1 始まり）。進められないものは null
  order: number | null;
  // 触る範囲が重なる、ほかの進行中のタスク。空のものだけを並行して着手する
  overlaps: string[];
};

const ACTIVE: readonly TaskStatus[] = ["todo", "doing"];

// ユーザーの確認や対応がないと先に進まない状態
const NEEDS_USER: readonly TaskStatus[] = ["review", "blocked"];

const normalizePath = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "");
const contains = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);

// 範囲を書いていないタスクは、どこを触るか分からないので、すべてと重なるものとして扱う
function pathsOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  return a.map(normalizePath).some((x) => b.map(normalizePath).some((y) => contains(x, y) || contains(y, x)));
}

export function describeTasks(tasks: Task[]): TaskView[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenOf = new Map<string, string[]>();
  for (const t of tasks) if (t.parent) childrenOf.set(t.parent, [...(childrenOf.get(t.parent) ?? []), t.id]);
  const finished = (id: string) => FINISHED.includes(byId.get(id)?.status ?? "todo");

  // 依存をたどって、AI だけでは解消できない理由を探す
  const stuckMemo = new Map<string, string | null>();
  const stuckOf = (id: string, seen = new Set<string>()): string | null => {
    if (stuckMemo.has(id)) return stuckMemo.get(id)!;
    if (seen.has(id)) return null;
    seen.add(id);
    const t = byId.get(id);
    let reason: string | null = null;
    for (const d of t?.dependsOn ?? []) {
      const dep = byId.get(d);
      if (!dep) reason = `依存先 ${d} が存在しない`;
      else if (NEEDS_USER.includes(dep.status))
        reason = `依存先 ${d} が${dep.status === "review" ? "確認待ち" : "ブロック"}`;
      else if (!FINISHED.includes(dep.status)) {
        const inner = stuckOf(d, seen);
        if (inner) reason = `${d} 経由: ${inner}`;
      }
      if (reason) break;
    }
    stuckMemo.set(id, reason);
    return reason;
  };

  // 未着手で子を持たないものを、依存の順を守りつつ優先度の高い順に並べる
  const rank = (p: Priority) => PRIORITIES.indexOf(p);
  const plannable = tasks.filter((t) => t.status === "todo" && !childrenOf.has(t.id) && !stuckOf(t.id));
  const remaining = new Set(plannable.map((t) => t.id));
  const order = new Map<string, number>();
  while (remaining.size) {
    const available = plannable
      .filter((t) => remaining.has(t.id))
      .filter((t) => t.dependsOn.every((d) => finished(d) || order.has(d) || byId.get(d)?.status === "doing"))
      .sort((x, y) => rank(x.priority) - rank(y.priority) || x.id.localeCompare(y.id));
    const pick = available[0];
    if (!pick) break; // 子を持つ親に依存しているなど、並べられないものは残す
    order.set(pick.id, order.size + 1);
    remaining.delete(pick.id);
  }

  // 子を持つ親は作業そのものではないので、範囲の比べ先に含めない
  const doing = tasks.filter((t) => t.status === "doing" && !childrenOf.has(t.id));
  return tasks.map((t) => {
    const waitingOn = t.dependsOn
      .filter((d) => !finished(d))
      .map((d) => ({ id: d, status: byId.get(d)?.status ?? ("missing" as const) }));
    const children = childrenOf.get(t.id) ?? [];
    const stuck = t.status === "todo" ? stuckOf(t.id) : null;
    return {
      ...t,
      waitingOn,
      children,
      ready: t.status === "todo" && children.length === 0 && waitingOn.length === 0,
      stuck,
      closable: children.length > 0 && !FINISHED.includes(t.status) && children.every(finished),
      order: order.get(t.id) ?? null,
      overlaps: ACTIVE.includes(t.status)
        ? doing.filter((d) => d.id !== t.id && pathsOverlap(t.paths, d.paths)).map((d) => d.id)
        : [],
    };
  });
}

// 今すぐ着手できるタスクを、着手する順に返す
export function nextTasks(tasks: Task[]): TaskView[] {
  return describeTasks(tasks)
    .filter((t) => t.ready)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
}
