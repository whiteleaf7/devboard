// 開発ボードのデータを読み書きする。ダッシュボード（server.ts）と MCP サーバ（mcp.ts）の両方がこれを使う。
// タスク・教訓・マイルストーンは git の外の SQLite（board-db.ts）、決定記録はリポジトリの決定記録のディレクトリ（decisions.ts）に置く。

import { basename } from "node:path";
import type { z } from "zod";
import { appendEvent, board, eventsOf, write, type BoardEvent } from "./board-db.ts";
import { readDecisions } from "./decisions.ts";
import { describeTasks, type TaskView } from "./describe.ts";
import { committedFiles, readGit } from "./git.ts";
import { repoRoot } from "./repo-root.ts";
import { closingProblems, introducedProblems, ruleProblems } from "./rules.ts";
import {
  Lesson,
  LessonInput,
  MilestoneInput,
  Project,
  Task,
  type Decision,
  type GitInfo,
  type NewTask,
  type TaskUpdateInput,
} from "./schema.ts";

export * from "./schema.ts";
export { createDecision, decisionsDir, readDecisions, setDecisionStatus, type NewDecision } from "./decisions.ts";
export { describeTasks, nextTasks, type TaskView } from "./describe.ts";
export { readGit } from "./git.ts";
export { repoRoot } from "./repo-root.ts";

function now(): string {
  return new Date().toISOString();
}

const padded = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, "0")}`;

// 行の JSON を読む。壊れた行があっても他は読めるよう、例外ではなく結果で返す
function parseRow<T>(
  schema: z.ZodType<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(String(data));
  } catch {
    return { success: false, error: "JSON として読めない" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, error: parsed.error.issues[0]?.message ?? "形式が合わない" };
}

// ---- プロジェクトとマイルストーン ----

export function readProject(): Project {
  const row = board().prepare("SELECT data FROM project WHERE id = 1").get();
  return row
    ? Project.parse(JSON.parse(String(row.data)))
    : { name: basename(repoRoot()), summary: "", milestones: [] };
}

// ---- タスク ----

// 壊れた行があっても他は読めるよう、エラーは配列で返す（新しい版のコードが書いたものを古い版が読むときなど）
export function readTasks(): { tasks: Task[]; errors: string[] } {
  const tasks: Task[] = [];
  const errors: string[] = [];
  for (const row of board().prepare("SELECT id, data FROM tasks ORDER BY number").all()) {
    const parsed = parseRow(Task, row.data);
    if (parsed.success) tasks.push(parsed.data);
    else errors.push(`${String(row.id)}: ${parsed.error}`);
  }
  return { tasks, errors };
}

export function getTask(id: string): Task {
  const row = board().prepare("SELECT data FROM tasks WHERE id = ?").get(id);
  if (!row) throw new Error(`タスク ${id} は存在しない`);
  return Task.parse(JSON.parse(String(row.data)));
}

// タスクの変更の履歴（作成、項目の変更、メモ）を古い順に返す
export function taskHistory(id: string): BoardEvent[] {
  getTask(id);
  return eventsOf(board(), id);
}

function assertMilestone(milestone: string | null | undefined): void {
  if (!milestone) return;
  const ids = readProject().milestones.map((m) => m.id);
  if (!ids.includes(milestone)) throw new Error(`マイルストーン ${milestone} はボードにない（${ids.join(", ")}）`);
}

// 親と依存先が存在し、自分自身や循環を指していないことを確かめる。決まりの検査より先に、分かりやすい言葉で断る
function assertLinks(
  tasks: Task[],
  id: string,
  parent: string | null | undefined,
  dependsOn: string[] | undefined,
): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const exists = (x: string) => {
    if (!byId.has(x)) throw new Error(`タスク ${x} は存在しない`);
  };
  if (parent) {
    exists(parent);
    for (let p: string | null = parent; p; p = byId.get(p)?.parent ?? null) {
      if (p === id) throw new Error(`${id} の親を ${parent} にすると親子関係が循環する`);
    }
  }
  if (dependsOn) {
    const seen = new Set<string>();
    const walk = (x: string): void => {
      if (x === id) throw new Error(`${id} の依存が循環する`);
      if (seen.has(x)) return;
      seen.add(x);
      for (const d of byId.get(x)?.dependsOn ?? []) walk(d);
    };
    for (const d of dependsOn) {
      exists(d);
      walk(d);
    }
  }
}

// 書き込みは、ボードの決まりに新しく反するなら断る。もとからある問題（過去にユーザーが画面から書いたものなど）は problems に出すだけにする
function assertRules(before: Task[], after: Task[]): void {
  const milestones = new Set(readProject().milestones.map((m) => m.id));
  const introduced = [
    ...introducedProblems(ruleProblems(before, milestones), ruleProblems(after, milestones)),
    ...closingProblems(before, after, committedFiles),
  ];
  if (introduced.length) throw new Error(introduced.map((p) => `${p.task}: ${p.message}`).join("\n"));
}

function saveTask(task: Task, number: number): void {
  board()
    .prepare(
      "INSERT INTO tasks (id, number, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
    )
    .run(task.id, number, JSON.stringify(task));
}

export function createTask(input: NewTask): Task {
  assertMilestone(input.milestone);
  const db = board();
  return write(db, () => {
    const { tasks } = readTasks();
    const number = Number(db.prepare("SELECT coalesce(max(number), 0) + 1 AS next FROM tasks").get()?.next);
    const id = padded("T", number);
    assertLinks(tasks, id, input.parent, input.dependsOn);
    const at = now();
    const task = Task.parse({
      id,
      title: input.title,
      status: input.status ?? "todo",
      milestone: input.milestone ?? null,
      parent: input.parent ?? null,
      dependsOn: input.dependsOn ?? [],
      priority: input.priority ?? "normal",
      labels: input.labels ?? [],
      paths: input.paths ?? [],
      description: input.description ?? "",
      branch: input.branch ?? null,
      notes: [],
      createdBy: "ai",
      created: at,
      updated: at,
    });
    assertRules(tasks, [...tasks, task]);
    saveTask(task, number);
    appendEvent(db, { at, actor: "ai", kind: "task.created", subject: id, data: { task } });
    return task;
  });
}

export type TaskPatch = z.infer<typeof TaskUpdateInput>;

// 項目ごとの変更の前後。メモは別のイベントにするので含めない
function changesOf(before: Task, after: Task): Record<string, { from: unknown; to: unknown }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => k !== "notes" && k !== "updated"));
  return Object.fromEntries(
    [...keys]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => [k, { from: before[k] ?? null, to: after[k] ?? null }]),
  );
}

export function updateTask(id: string, patch: TaskPatch): Task {
  if (patch.milestone !== undefined) assertMilestone(patch.milestone);
  const db = board();
  return write(db, () => {
    const current = getTask(id);
    const { tasks } = readTasks();
    assertLinks(tasks, id, patch.parent, patch.dependsOn);
    const { note, ...fields } = patch;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const at = now();
    const added = note?.trim() ? { at, text: note.trim(), by: "ai" as const } : null;
    const task = Task.parse({
      ...current,
      ...defined,
      notes: added ? [...current.notes, added] : current.notes,
      id: current.id,
      updated: at,
    });
    assertRules(
      tasks,
      tasks.map((t) => (t.id === id ? task : t)),
    );
    const number = Number(db.prepare("SELECT number FROM tasks WHERE id = ?").get(id)?.number);
    saveTask(task, number);
    const changes = changesOf(current, task);
    if (Object.keys(changes).length)
      appendEvent(db, { at, actor: "ai", kind: "task.changed", subject: id, data: { changes } });
    if (added) appendEvent(db, { at, actor: "ai", kind: "task.noted", subject: id, data: { note: added } });
    return task;
  });
}

export function updateProject(change: (project: Project) => Project): Project {
  const db = board();
  return write(db, () => {
    const before = readProject();
    const after = Project.parse(change(structuredClone(before)));
    const { tasks } = readTasks();
    const used = tasks.flatMap((t) =>
      t.milestone && !after.milestones.some((m) => m.id === t.milestone) ? [`${t.id}（${t.milestone}）`] : [],
    );
    if (used.length) throw new Error(`タスクが使っているマイルストーンは消せない: ${used.join(", ")}`);
    db.prepare("INSERT INTO project (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data").run(
      JSON.stringify(after),
    );
    appendEvent(db, {
      at: now(),
      actor: "ai",
      kind: "project.changed",
      subject: "project",
      data: { from: before, to: after },
    });
    return after;
  });
}

export function setMilestone({ id, title, goal, status }: z.infer<typeof MilestoneInput>): Project {
  return updateProject((project) => {
    const i = project.milestones.findIndex((m) => m.id === id);
    if (i < 0) {
      if (!title) throw new Error("新しいマイルストーンには title が必要");
      project.milestones.push({ id, title, goal: goal ?? "", status: status ?? "planned" });
    } else {
      const m = project.milestones[i]!;
      project.milestones[i] = { ...m, title: title ?? m.title, goal: goal ?? m.goal, status: status ?? m.status };
    }
    return project;
  });
}

// ---- 教訓 ----

export function readLessons(): { lessons: Lesson[]; errors: string[] } {
  const lessons: Lesson[] = [];
  const errors: string[] = [];
  for (const row of board().prepare("SELECT id, data FROM lessons ORDER BY number").all()) {
    const parsed = parseRow(Lesson, row.data);
    if (parsed.success) lessons.push(parsed.data);
    else errors.push(`${String(row.id)}: ${parsed.error}`);
  }
  return { lessons, errors };
}

export function createLesson(input: z.infer<typeof LessonInput>): Lesson {
  if (input.task) getTask(input.task);
  const db = board();
  return write(db, () => {
    const number = Number(db.prepare("SELECT coalesce(max(number), 0) + 1 AS next FROM lessons").get()?.next);
    const lesson = Lesson.parse({
      id: padded("L", number),
      title: input.title,
      problem: input.problem,
      cause: input.cause ?? "",
      fix: input.fix,
      task: input.task ?? null,
      tags: input.tags ?? [],
      created: now(),
    });
    db.prepare("INSERT INTO lessons (id, number, data) VALUES (?, ?, ?)").run(
      lesson.id,
      number,
      JSON.stringify(lesson),
    );
    appendEvent(db, { at: lesson.created, actor: "ai", kind: "lesson.created", subject: lesson.id, data: { lesson } });
    return lesson;
  });
}

// ---- まとめての読み取り ----

// 画面が並び順や待ちを自分で計算し直さないよう、タスクは判断の情報を足した形で渡す
export type Snapshot = {
  project: Project;
  tasks: TaskView[];
  decisions: Decision[];
  git: GitInfo;
  errors: string[];
  generatedAt: string;
};

export function snapshot(): Snapshot {
  const errors: string[] = [];
  let project: Project = { name: basename(repoRoot()), summary: "", milestones: [] };
  try {
    project = readProject();
  } catch (e) {
    errors.push(`project: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { tasks, errors: taskErrors } = readTasks();
  return {
    project,
    tasks: describeTasks(tasks),
    decisions: readDecisions(),
    git: readGit(),
    errors: [...errors, ...taskErrors],
    generatedAt: now(),
  };
}
