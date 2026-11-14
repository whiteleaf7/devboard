// 開発ボードのデータを読み書きする。ダッシュボード（server.ts）と MCP サーバ（mcp.ts）の両方がこれを使う。
// タスク・教訓・マイルストーンは git の外の SQLite（board-db.ts、決定記録 0011）、決定記録はリポジトリの docs/decisions/ に置く。

import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { z } from "zod";
import { appendEvent, board, eventsOf, write, type BoardEvent } from "./board-db.ts";
import { withLock } from "./lock.ts";
import { closingProblems, introducedProblems, ruleProblems } from "./rules.ts";
import {
  DECISION_STATUSES,
  Lesson,
  LessonInput,
  MilestoneInput,
  Project,
  Task,
  type Author,
  type Decision,
  type GitInfo,
  type NewTask,
  type Snapshot,
  type TaskUpdateInput,
} from "./schema.ts";
import { mainWorktreeOf } from "./worktree.ts";

export * from "./schema.ts";
export { describeTasks, nextTasks, type TaskView } from "./describe.ts";

// 作業用の worktree から呼ばれても、main の worktree の決定記録を使う（決定記録 0010）
const ownRoot = mainWorktreeOf(resolve(import.meta.dirname, "../../.."));

export function repoRoot(): string {
  // fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
  return process.env.NAGAYA_ROOT ?? ownRoot;
}

export const paths = {
  decisions: () => join(repoRoot(), "docs", "decisions"),
};

function now(): string {
  return new Date().toISOString();
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// AI の書き込みは、ボードの決まりに新しく反するなら断る。ユーザーが画面から書くものは断らず、problems に出して AI が気づけるようにする
function assertRules(before: Task[], after: Task[], by: Author): void {
  if (by === "user") return;
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
    const by = input.createdBy ?? "ai";
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
      createdBy: by,
      created: at,
      updated: at,
    });
    assertRules(tasks, [...tasks, task], by);
    saveTask(task, number);
    appendEvent(db, { at, actor: by, kind: "task.created", subject: id, data: { task } });
    return task;
  });
}

export type TaskPatch = z.infer<typeof TaskUpdateInput> & { by?: Author };

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
    const { note, by = "ai", ...fields } = patch;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const at = now();
    const added = note?.trim() ? { at, text: note.trim(), by } : null;
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
      by,
    );
    const number = Number(db.prepare("SELECT number FROM tasks WHERE id = ?").get(id)?.number);
    saveTask(task, number);
    const changes = changesOf(current, task);
    if (Object.keys(changes).length)
      appendEvent(db, { at, actor: by, kind: "task.changed", subject: id, data: { changes } });
    if (added) appendEvent(db, { at, actor: by, kind: "task.noted", subject: id, data: { note: added } });
    return task;
  });
}

export function updateProject(change: (project: Project) => Project, by: Author = "ai"): Project {
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
      actor: by,
      kind: "project.changed",
      subject: "project",
      data: { from: before, to: after },
    });
    return after;
  });
}

export function setMilestone({ id, title, goal, status }: z.infer<typeof MilestoneInput>, by: Author = "ai"): Project {
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
  }, by);
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

// ---- 決定記録（リポジトリの docs/decisions/） ----

// 書きかけのファイルを読まれないよう、一時ファイルに書いてから rename する
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// 番号を決めてから書くまでを、ほかのプロセスと 1 つずつ行う
function lockedDecisions<T>(fn: () => T): T {
  const dir = join(repoRoot(), ".dev");
  mkdirSync(dir, { recursive: true });
  return withLock(join(dir, "decisions.lock"), fn);
}

// docs/decisions/NNNN-slug.md の先頭にある「# NNNN. タイトル」「- 状態: 」「- 日付: 」を読む
function parseDecision(file: string, text: string): Decision {
  const number = Number(/^(\d{4})-/.exec(file)?.[1] ?? NaN);
  const title = /^#\s*\d{4}\.\s*(.+)$/m.exec(text)?.[1]?.trim() ?? file;
  const status = /^-\s*状態:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "不明";
  const date = /^-\s*日付:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  return { number, file: `docs/decisions/${file}`, title, status, date, body: text };
}

export function readDecisions(): Decision[] {
  const dir = paths.decisions();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .sort()
    .map((f) => parseDecision(f, readFileSync(join(dir, f), "utf8")));
}

export type NewDecision = {
  title: string;
  slug: string;
  status?: (typeof DECISION_STATUSES)[number];
  context: string;
  decision: string;
  consequences: string;
};

export function createDecision(input: NewDecision): Decision {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) {
    throw new Error("slug は英小文字・数字・ハイフンだけにする（例: app-architecture）");
  }
  const body = [
    `- 状態: ${input.status ?? "提案"}`,
    `- 日付: ${today()}`,
    "",
    "## 背景",
    "",
    input.context.trim(),
    "",
    "## 決定",
    "",
    input.decision.trim(),
    "",
    "## 影響",
    "",
    input.consequences.trim(),
    "",
  ].join("\n");
  return lockedDecisions(() => {
    const dir = paths.decisions();
    mkdirSync(dir, { recursive: true });
    const numbers = readDecisions().map((d) => d.number);
    const nnnn = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(4, "0");
    const file = `${nnnn}-${input.slug}.md`;
    const text = `# ${nnnn}. ${input.title}\n\n${body}`;
    writeAtomic(join(dir, file), text);
    return parseDecision(file, text);
  });
}

export function setDecisionStatus(number: number, status: (typeof DECISION_STATUSES)[number]): Decision {
  return lockedDecisions(() => {
    const d = readDecisions().find((x) => x.number === number);
    if (!d) throw new Error(`決定記録 ${number} は存在しない`);
    if (!/^-\s*状態:.*$/m.test(d.body)) throw new Error(`${d.file} に「- 状態:」の行がない`);
    const text = d.body.replace(/^-\s*状態:.*$/m, `- 状態: ${status}`);
    const name = d.file.replace(/^docs\/decisions\//, "");
    writeAtomic(join(paths.decisions(), name), text);
    return parseDecision(name, text);
  });
}

// ---- git と、まとめての読み取り ----

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// `Task:` の行でこのタスクを指したコミットが変えたファイル。取り込む前の worktree のブランチも見るため --all
function committedFiles(id: string): string[] {
  const log = git(["log", "--all", "-i", "-E", `--grep=^Task:.*${id}([^0-9]|$)`, "--name-only", "--format="]);
  return (log ?? "").split("\n").filter(Boolean);
}

// `git status --porcelain` の 1 行のパス。git() が出力を trim するので、先頭の行は状態の列の空白が欠けている。名前の変更は変更後を取る
function changedPath(line: string): string {
  const path = line.replace(/^\s*\S{1,2}\s+/, "");
  return path.split(" -> ").at(-1) ?? path;
}

export function readGit(limit = 8): GitInfo {
  const branch = git(["branch", "--show-current"]) || null;
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  const log = git(["log", `-${limit}`, "--format=%h%x09%cs%x09%s"]);
  const commits = (log ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", date = "", subject = ""] = line.split("\t");
      return { hash, date, subject };
    });
  const changed = (status ?? "").split("\n").filter(Boolean);
  return {
    branch,
    dirty: changed.length,
    uncommittedDecisions: changed.map(changedPath).filter((file) => file.startsWith("docs/decisions/")),
    commits,
  };
}

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
    tasks,
    decisions: readDecisions(),
    git: readGit(),
    errors: [...errors, ...taskErrors],
    generatedAt: now(),
  };
}
