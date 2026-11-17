// done にした後に不具合が出た率。不具合（labels に bug）のタスクの causedBy から、それを持ち込んだタスクを数える。
// 検証の層が、実際に見逃したものの数で測れるようにする。読み込みはせず、渡されたタスクとイベントだけから数える

import { z } from "zod";
import type { ActivityEvent } from "./activity.ts";
import { BUG_LABEL, MISSED_CHECK } from "./rules.ts";
import type { Task } from "./schema.ts";

export type EscapeSummary = {
  // いま done のタスク
  done: number;
  // そのうち、中止していない不具合に原因として結ばれたもの
  escaped: number;
  rate: number | null;
  // 中止していない不具合のタスク
  bugs: number;
  // 原因が結ばれていない不具合。結ぶと率に入る
  unlinkedBugs: string[];
  // 不具合と、それを持ち込んだタスク
  links: { bug: string; title: string; causes: string[] }[];
  // done にするときに「見逃した検査」の行が無かった不具合（observe で記録した回数）
  closedWithoutMissedCheck: number;
};

const ObservedMissedCheck = z.object({ check: z.literal(MISSED_CHECK) });

export function escapeSummary(tasks: Task[], events: ActivityEvent[]): EscapeSummary {
  const done = tasks.filter((t) => t.status === "done");
  const bugs = tasks.filter((t) => t.labels.includes(BUG_LABEL) && t.status !== "cancelled");
  const doneIds = new Set(done.map((t) => t.id));
  const escaped = new Set(bugs.flatMap((b) => b.causedBy).filter((id) => doneIds.has(id)));
  return {
    done: done.length,
    escaped: escaped.size,
    rate: done.length ? escaped.size / done.length : null,
    bugs: bugs.length,
    unlinkedBugs: bugs.filter((b) => !b.causedBy.length).map((b) => b.id),
    links: bugs.filter((b) => b.causedBy.length).map((b) => ({ bug: b.id, title: b.title, causes: b.causedBy })),
    closedWithoutMissedCheck: events.filter(
      (e) => e.kind === "rule.observed" && ObservedMissedCheck.safeParse(e.data).success,
    ).length,
  };
}
