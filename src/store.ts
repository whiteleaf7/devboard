// 開発ボードのデータ（dev/ と docs/decisions/）を読み書きする。
// ダッシュボード（server.ts）と MCP サーバ（mcp.ts）の両方がこれを使う。

import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { withLock } from "./lock.ts";
import { mainWorktreeOf } from "./worktree.ts";

export const TASK_STATUSES = ["todo", "doing", "review", "blocked", "done", "cancelled"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export const MILESTONE_STATUSES = ["planned", "active", "done"] as const;
export const DECISION_STATUSES = ["提案", "採用", "却下", "置き換え"] as const;

export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

// 依存先がこの状態なら「終わった」とみなす
const FINISHED: readonly TaskStatus[] = ["done", "cancelled"];

// 誰が書いたか。ユーザーが画面から入れたものは user、MCP や AI の編集は ai
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
  commits: { hash: string; subject: string; date: string }[];
};

export type Snapshot = {
  project: Project;
  tasks: Task[];
  decisions: Decision[];
  git: GitInfo;
  errors: string[];
  generatedAt: string;
};

// 作業用の worktree から呼ばれても、main の worktree のボードを使う（決定記録 0010）
const ownRoot = mainWorktreeOf(resolve(import.meta.dirname, "../../.."));

export function repoRoot(): string {
  // fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
  return process.env.NAGAYA_ROOT ?? ownRoot;
}

export const paths = {
  dev: () => join(repoRoot(), "dev"),
  project: () => join(repoRoot(), "dev", "project.json"),
  tasks: () => join(repoRoot(), "dev", "tasks"),
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

// 書きかけのファイルを読まれないよう、一時ファイルに書いてから rename する
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function writeJson(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

// 読んでから書くまで（採番を含む）を、ほかのプロセスと 1 つずつ行う。同時に書くと、同じ番号で上書きされて消える
function locked<T>(fn: () => T): T {
  const dir = join(repoRoot(), ".dev");
  mkdirSync(dir, { recursive: true });
  return withLock(join(dir, "board.lock"), fn);
}

export function readProject(): Project {
  return Project.parse(JSON.parse(readFileSync(paths.project(), "utf8")));
}

export function updateProject(change: (project: Project) => Project): Project {
  return locked(() => {
    const project = Project.parse(change(readProject()));
    writeJson(paths.project(), project);
    return project;
  });
}

function taskFile(id: string): string {
  return join(paths.tasks(), `${id}.json`);
}

// 壊れたファイルがあっても他は読めるよう、エラーは配列で返す
export function readTasks(): { tasks: Task[]; errors: string[] } {
  const dir = paths.tasks();
  if (!existsSync(dir)) return { tasks: [], errors: [] };
  const tasks: Task[] = [];
  const errors: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      tasks.push(Task.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
    } catch (e) {
      errors.push(`dev/tasks/${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { tasks, errors };
}

export function getTask(id: string): Task {
  const file = taskFile(id);
  if (!existsSync(file)) throw new Error(`タスク ${id} は存在しない`);
  return Task.parse(JSON.parse(readFileSync(file, "utf8")));
}

function nextTaskId(): string {
  const dir = paths.tasks();
  const nums = existsSync(dir)
    ? readdirSync(dir)
        .map((f) => /^T-(\d+)\.json$/.exec(f)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
    : [];
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `T-${String(next).padStart(3, "0")}`;
}

function assertMilestone(milestone: string | null | undefined): void {
  if (!milestone) return;
  const ids = readProject().milestones.map((m) => m.id);
  if (!ids.includes(milestone)) {
    throw new Error(`マイルストーン ${milestone} は dev/project.json にない（${ids.join(", ")}）`);
  }
}

// タスクの追加・更新の入力。MCP のツールと画面の API で共有する
export const TaskCreateInput = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional().describe("目的・完了条件。Markdown 可"),
  status: TaskStatus.optional().describe("既定は todo"),
  milestone: z.string().nullable().optional().describe("dev/project.json のマイルストーン ID"),
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
export type NewTask = z.infer<typeof TaskCreateInput> & { createdBy?: Author };

export const TaskUpdateInput = TaskCreateInput.partial().extend({
  labels: z.array(z.string()).optional().describe("置き換え（追記ではない）"),
  parent: z.string().nullable().optional().describe("分解元の親タスク ID。null で外す"),
  note: z.string().optional().describe("メモの履歴に追記する。経過・判断・次にやること"),
});

// 親と依存先が存在し、自分自身や循環を指していないことを確かめる
function assertLinks(id: string, parent: string | null | undefined, dependsOn: string[] | undefined): void {
  const { tasks } = readTasks();
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

export function createTask(input: NewTask): Task {
  assertMilestone(input.milestone);
  return locked(() => {
    const id = nextTaskId();
    assertLinks(id, input.parent, input.dependsOn);
    mkdirSync(paths.tasks(), { recursive: true });
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
      createdBy: input.createdBy ?? "ai",
      created: at,
      updated: at,
    });
    writeJson(taskFile(task.id), task);
    return task;
  });
}

export type TaskPatch = z.infer<typeof TaskUpdateInput> & { by?: Author };

export function updateTask(id: string, patch: TaskPatch): Task {
  if (patch.milestone !== undefined) assertMilestone(patch.milestone);
  return locked(() => {
    const current = getTask(id);
    assertLinks(id, patch.parent, patch.dependsOn);
    const { note, by = "ai", ...fields } = patch;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const at = now();
    const notes = note?.trim() ? [...current.notes, { at, text: note.trim(), by }] : current.notes;
    const task = Task.parse({ ...current, ...defined, notes, id: current.id, updated: at });
    writeJson(taskFile(id), task);
    return task;
  });
}

// 一覧の各タスクに、進め方の判断に使う情報を足したもの
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

const normalizePath = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "");
const contains = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);

// 範囲を書いていないタスクは、どこを触るか分からないので、すべてと重なるものとして扱う
function pathsOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  return a.map(normalizePath).some((x) => b.map(normalizePath).some((y) => contains(x, y) || contains(y, x)));
}

// ユーザーの確認や対応がないと先に進まない状態
const NEEDS_USER: readonly TaskStatus[] = ["review", "blocked"];

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
      else if (NEEDS_USER.includes(dep.status)) reason = `依存先 ${d} が${dep.status === "review" ? "確認待ち" : "ブロック"}`;
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
      .filter((t) => t.dependsOn.every((d) => finished(d) || order.has(d) || (byId.get(d)?.status === "doing")))
      .sort((x, y) => rank(x.priority) - rank(y.priority) || x.id.localeCompare(y.id));
    const pick = available[0];
    if (!pick) break; // 子を持つ親に依存しているなど、並べられないものは残す
    order.set(pick.id, order.size + 1);
    remaining.delete(pick.id);
  }

  const doing = tasks.filter((t) => t.status === "doing");
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
      overlaps: ACTIVE.includes(t.status) ? doing.filter((d) => d.id !== t.id && pathsOverlap(t.paths, d.paths)).map((d) => d.id) : [],
    };
  });
}

// 今すぐ着手できるタスクを、着手する順に返す
export function nextTasks(tasks: Task[]): TaskView[] {
  return describeTasks(tasks)
    .filter((t) => t.ready)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
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
  return locked(() => {
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
  return locked(() => {
    const d = readDecisions().find((x) => x.number === number);
    if (!d) throw new Error(`決定記録 ${number} は存在しない`);
    if (!/^-\s*状態:.*$/m.test(d.body)) throw new Error(`${d.file} に「- 状態:」の行がない`);
    const text = d.body.replace(/^-\s*状態:.*$/m, `- 状態: ${status}`);
    const name = d.file.replace(/^docs\/decisions\//, "");
    writeAtomic(join(paths.decisions(), name), text);
    return parseDecision(name, text);
  });
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function readGit(limit = 8): GitInfo {
  const branch = git(["branch", "--show-current"]) || null;
  const status = git(["status", "--porcelain"]);
  const log = git(["log", `-${limit}`, "--format=%h%x09%cs%x09%s"]);
  const commits = (log ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", date = "", subject = ""] = line.split("\t");
      return { hash, date, subject };
    });
  return { branch, dirty: status ? status.split("\n").filter(Boolean).length : 0, commits };
}

export function snapshot(): Snapshot {
  const errors: string[] = [];
  let project: Project = { name: "nagaya", summary: "", milestones: [] };
  try {
    project = readProject();
  } catch (e) {
    errors.push(`dev/project.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { tasks, errors: taskErrors } = readTasks();
  errors.push(...taskErrors);
  return { project, tasks, decisions: readDecisions(), git: readGit(), errors, generatedAt: now() };
}

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

function lessonsDir(): string {
  return join(paths.dev(), "lessons");
}

export function readLessons(): { lessons: Lesson[]; errors: string[] } {
  const dir = lessonsDir();
  if (!existsSync(dir)) return { lessons: [], errors: [] };
  const lessons: Lesson[] = [];
  const errors: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      lessons.push(Lesson.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
    } catch (e) {
      errors.push(`dev/lessons/${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { lessons, errors };
}

export function createLesson(input: z.infer<typeof LessonInput>): Lesson {
  if (input.task) getTask(input.task);
  return locked(() => {
    const dir = lessonsDir();
    mkdirSync(dir, { recursive: true });
    const numbers = readdirSync(dir)
      .map((f) => /^L-(\d+)\.json$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    const lesson = Lesson.parse({
      id: `L-${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, "0")}`,
      title: input.title,
      problem: input.problem,
      cause: input.cause ?? "",
      fix: input.fix,
      task: input.task ?? null,
      tags: input.tags ?? [],
      created: now(),
    });
    writeJson(join(dir, `${lesson.id}.json`), lesson);
    return lesson;
  });
}
