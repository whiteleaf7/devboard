// ボードのデータの形。store（保存）と rules（決まり）の両方が使う。zod のスキーマを唯一の定義にする

import { z } from "zod";

export const TASK_STATUSES = ["todo", "doing", "review", "blocked", "done", "cancelled"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export const MILESTONE_STATUSES = ["planned", "active", "done"] as const;
export const DECISION_STATUSES = ["提案", "採用", "却下", "置き換え"] as const;

export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

// 依存先がこの状態なら「終わった」とみなす
export const FINISHED: readonly TaskStatus[] = ["done", "cancelled"];

// 誰が書いたか。いまの書き込みはすべて ai。user は、ダッシュボードから書けたころ（決定記録 0038 まで）の記録に残る
export const Author = z.enum(["user", "ai"]);
export type Author = z.infer<typeof Author>;

// ボードは複数の版のコード（worktree ごとの MCP）が読み書きする。知らない項目を落とすと、新しい版が書いたものを古い版が消してしまうので、
// 読んでから書き戻すものは looseObject にして残す（T-039）
const Note = z.looseObject({ at: z.string(), text: z.string(), by: Author.optional() });

export const Task = z.looseObject({
  id: z.string().regex(/^T-\d{3,}$/),
  title: z.string().min(1),
  status: TaskStatus,
  milestone: z.string().nullable().default(null),
  parent: z.string().nullable().default(null),
  dependsOn: z.array(z.string()).default([]),
  priority: Priority.default("normal"),
  labels: z.array(z.string()).default([]),
  // 触る予定のパスの接頭辞。並行して着手してよいかの判断に使う（決定記録 0010）
  paths: z.array(z.string()).default([]),
  description: z.string().default(""),
  branch: z.string().nullable().default(null),
  notes: z.array(Note).default([]),
  createdBy: Author.default("ai"),
  created: z.string(),
  updated: z.string(),
});
export type Task = z.infer<typeof Task>;

export const Milestone = z.looseObject({
  id: z.string(),
  title: z.string(),
  goal: z.string().default(""),
  status: z.enum(MILESTONE_STATUSES),
});
export type Milestone = z.infer<typeof Milestone>;

export const Project = z.looseObject({
  name: z.string(),
  summary: z.string().default(""),
  milestones: z.array(Milestone).default([]),
});
export type Project = z.infer<typeof Project>;

// マイルストーンの追加・更新の入力。ID が一致すれば更新する
export const MilestoneInput = z.object({
  id: z.string().describe("例: M1"),
  title: z.string().optional(),
  goal: z.string().optional().describe("完了の条件"),
  status: z.enum(MILESTONE_STATUSES).optional(),
});

export type Decision = {
  number: number;
  file: string;
  title: string;
  status: string;
  date: string;
  body: string;
};

export type GitInfo = {
  branch: string | null;
  dirty: number;
  // 作業者が書いて報告し、司令塔がまだ取り込んでいない決定記録（0015）。見落とすと main の worktree に取り残される
  uncommittedDecisions: string[];
  commits: { hash: string; subject: string; date: string }[];
};

// タスクの追加・更新の入力。MCP のツールと画面の API で共有する
export const TaskCreateInput = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional().describe("目的・完了条件。Markdown 可"),
  status: TaskStatus.optional().describe("既定は todo"),
  milestone: z.string().nullable().optional().describe("ボードのマイルストーン ID"),
  labels: z.array(z.string()).optional(),
  paths: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("触る予定のパスの接頭辞（例: tools/devboard/）。置き換え。空なら、ほかのタスクと並行させない"),
  branch: z.string().nullable().optional(),
  parent: z.string().nullable().optional().describe("分解元の親タスク ID"),
  dependsOn: z.array(z.string()).optional().describe("先に終わっている必要があるタスク ID（置き換え）"),
  priority: Priority.optional().describe("既定は normal"),
});
export type NewTask = z.infer<typeof TaskCreateInput>;

export const TaskUpdateInput = TaskCreateInput.partial().extend({
  labels: z.array(z.string()).optional().describe("置き換え（追記ではない）"),
  parent: z.string().nullable().optional().describe("分解元の親タスク ID。null で外す"),
  note: z
    .string()
    .optional()
    .describe(
      "メモの履歴に追記する。経過・判断・次にやること。paths に docs 以外があるタスクを done にするときは「動かした: `コマンド` → 結果」の行を入れる（テストと型チェックだけでは閉じられない）",
    ),
});

// 教訓: うまくいかなかったことと、その対処。似た作業の前に recall で引き出して、同じ失敗を繰り返さないために残す
export const Lesson = z.object({
  id: z.string().regex(/^L-\d{3,}$/),
  title: z.string().min(1),
  problem: z.string().min(1),
  cause: z.string().default(""),
  fix: z.string().min(1),
  task: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  created: z.string(),
});
export type Lesson = z.infer<typeof Lesson>;

export const LessonInput = z.object({
  title: z.string().trim().min(1).describe("何についての教訓か（1 行）"),
  problem: z.string().trim().min(1).describe("何が起きたか、どう気づいたか"),
  cause: z.string().optional().describe("原因"),
  fix: z.string().trim().min(1).describe("どう対処したか。次に同じ場面でどうするか"),
  task: z.string().nullable().optional().describe("関係するタスク ID"),
  tags: z.array(z.string()).optional(),
});
