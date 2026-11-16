// ボードへの操作の並びを、MCP のツールと同じ名前と入力の形で、順に当てる。AI の書き込みとして扱う。
// ハーネスの評価のシナリオと、MCP が使えないときの代わり（`devboard apply`）が使う。
// 文字列の "$N" は、N 番目（0 始まり）の操作が作ったものの ID に置き換える（例: 親を作ってから子を作る）

import { z } from "zod";
import {
  createDecision,
  createLesson,
  createTask,
  setDecisionStatus,
  setMilestone,
  updateProject,
  updateTask,
} from "./store.ts";
import { DECISION_STATUSES, LessonInput, MilestoneInput, TaskCreateInput, TaskUpdateInput } from "./schema.ts";

const DecisionCreateInput = z.strictObject({
  title: z.string().min(1),
  slug: z.string().min(1),
  status: z.enum(DECISION_STATUSES).optional(),
  context: z.string(),
  decision: z.string(),
  consequences: z.string(),
});

const DecisionStatusInput = z.strictObject({
  number: z.number().int().positive(),
  status: z.enum(DECISION_STATUSES),
});

// プロジェクトの表示名と概要。ダッシュボードの見出しと get_overview に出る。新しいプロジェクトの初期化に使う
const ProjectInput = z
  .strictObject({ name: z.string().min(1).optional(), summary: z.string().optional() })
  .refine((v) => v.name !== undefined || v.summary !== undefined, "name か summary のどちらかが要る");

// 知らない項目は黙って落とさずに断る
export const BoardOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("create_task"), args: TaskCreateInput.strict() }),
  z.strictObject({ op: z.literal("update_task"), args: TaskUpdateInput.extend({ id: z.string() }).strict() }),
  z.strictObject({ op: z.literal("add_lesson"), args: LessonInput.strict() }),
  z.strictObject({ op: z.literal("set_milestone"), args: MilestoneInput.strict() }),
  z.strictObject({ op: z.literal("set_project"), args: ProjectInput }),
  z.strictObject({ op: z.literal("create_decision"), args: DecisionCreateInput }),
  z.strictObject({ op: z.literal("set_decision_status"), args: DecisionStatusInput }),
]);
export type BoardOp = z.infer<typeof BoardOp>;

function substitute(value: unknown, ids: string[]): unknown {
  if (typeof value === "string") return value.replace(/^\$(\d+)$/, (whole, n: string) => ids[Number(n)] ?? whole);
  if (Array.isArray(value)) return value.map((v) => substitute(v, ids));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ids)]));
  return value;
}

function applyOne(op: BoardOp): string {
  switch (op.op) {
    case "create_task":
      return createTask(op.args).id;
    case "update_task": {
      const { id, ...patch } = op.args;
      return updateTask(id, patch).id;
    }
    case "add_lesson":
      return createLesson(op.args).id;
    case "set_milestone":
      setMilestone(op.args);
      return op.args.id;
    case "set_project":
      updateProject((project) => ({
        ...project,
        name: op.args.name ?? project.name,
        summary: op.args.summary ?? project.summary,
      }));
      return "project";
    case "create_decision":
      return `D-${String(createDecision(op.args).number).padStart(4, "0")}`;
    case "set_decision_status":
      return `D-${String(setDecisionStatus(op.args.number, op.args.status).number).padStart(4, "0")}`;
  }
}

// 当てた操作が作った・変えたものの ID を返す。途中で断られたら、何番目の操作がなぜ断られたかを投げる（それより前の操作は当たったまま）
export function applyOps(raw: unknown[]): string[] {
  const ids: string[] = [];
  raw.forEach((item, i) => {
    const parsed = BoardOp.safeParse(substitute(item, ids));
    if (!parsed.success) throw new Error(`操作 ${i}: ${z.prettifyError(parsed.error)}`);
    try {
      ids.push(applyOne(parsed.data));
    } catch (e) {
      throw new Error(`操作 ${i}（${parsed.data.op}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return ids;
}
