// ボードの記録（タスク・決定記録）が、スキーマと CLAUDE.md の「作業するとき」の決まりに合っているかを調べる。
// ファイルを直接編集した場合は store.ts の検証を通らないので、ゲートと get_overview の両方からこれを使う。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DECISION_STATUSES, Lesson, Project, Task, paths } from "./store.ts";

export type BoardFile = { file: string; text: string };
export type BoardProblem = { check: string; file: string; message: string };

export type BoardInput = {
  project: BoardFile | null;
  tasks: BoardFile[];
  decisions: BoardFile[];
  lessons?: BoardFile[];
  // 基点（HEAD）にあったタスクのファイル。消されたものを見つけるために使う
  baseTaskFiles?: string[];
};

const OPEN = ["todo", "doing", "blocked", "review"];
const NEEDS_NOTE: Record<string, string> = {
  done: "done なのにメモが無い。何を確かめて終えたのかを note に残す",
  cancelled: "cancelled なのにメモが無い。不要になった理由を note に残す",
  blocked: "blocked なのにメモが無い。進められない理由と、ユーザーにしてほしいことを note に残す",
};

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "全体"}: ${issue.message}` : "形式が合わない";
};

function parse<T>(schema: z.ZodType<T>, { file, text }: BoardFile, check: string, problems: BoardProblem[]): T | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    problems.push({ check, file, message: "JSON として読めない" });
    return null;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) problems.push({ check, file, message: `スキーマに合わない（${firstIssue(parsed.error)}）` });
  return parsed.success ? parsed.data : null;
}

function lintTasks(input: BoardInput, problems: BoardProblem[]): void {
  const project = input.project ? parse(Project, input.project, "invalid-task", problems) : null;
  const milestones = new Set(project?.milestones.map((m) => m.id));
  const tasks = input.tasks.flatMap((source) => {
    const task = parse(Task, source, "invalid-task", problems);
    return task ? [{ file: source.file, task }] : [];
  });
  const byId = new Map(tasks.map(({ task }) => [task.id, task]));

  for (const { file, task } of tasks) {
    const add = (check: string, message: string) => problems.push({ check, file, message });
    if (!file.endsWith(`/${task.id}.json`)) add("invalid-task", `ファイル名と id（${task.id}）が合わない`);

    if (task.milestone && project && !milestones.has(task.milestone)) add("broken-link", `マイルストーン ${task.milestone} が dev/project.json に無い`);
    if (task.parent && !byId.has(task.parent)) add("broken-link", `親 ${task.parent} が存在しない`);
    for (const dep of task.dependsOn) if (!byId.has(dep)) add("broken-link", `依存先 ${dep} が存在しない`);
    if (reaches(task.id, task.dependsOn, (id) => byId.get(id)?.dependsOn ?? [])) add("broken-link", "依存が循環している");
    if (reaches(task.id, task.parent ? [task.parent] : [], (id) => [byId.get(id)?.parent].filter((p): p is string => Boolean(p)))) {
      add("broken-link", "親子関係が循環している");
    }

    const needsNote = NEEDS_NOTE[task.status];
    if (needsNote && task.notes.length === 0) add("unexplained-state", needsNote);
    if (task.status === "review" && task.createdBy === "ai") add("forbidden-review", "review は使わない。結果を自分で確かめて done にする");
    if (task.status === "done") {
      const open = tasks.filter(({ task: child }) => child.parent === task.id && OPEN.includes(child.status)).map(({ task: child }) => child.id);
      if (open.length) add("parent-closed-early", `子（${open.join(", ")}）が終わっていないのに done になっている`);
    }
  }

  const present = new Set(input.tasks.map((t) => t.file));
  for (const file of input.baseTaskFiles ?? []) {
    if (!present.has(file)) problems.push({ check: "deleted-task", file, message: "タスクのファイルが消えている。不要になったタスクは消さずに cancelled にする" });
  }
}

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

function lintDecisions(decisions: BoardFile[], problems: BoardProblem[]): void {
  const numbers = new Map<string, string>();
  for (const { file, text } of decisions) {
    const add = (message: string) => problems.push({ check: "invalid-decision", file, message });
    const name = file.split("/").pop() ?? file;
    const number = /^(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.md$/.exec(name)?.[1];
    if (!number) {
      add("ファイル名は NNNN-slug.md（英小文字・数字・ハイフン）にする");
      continue;
    }
    const other = numbers.get(number);
    if (other) add(`番号 ${number} が ${other} と重複している`);
    else numbers.set(number, file);

    const heading = /^#\s*(\d{4})\.\s*\S/m.exec(text)?.[1];
    if (!heading) add("先頭に「# NNNN. タイトル」の見出しが無い");
    else if (heading !== number) add(`見出しの番号（${heading}）がファイル名（${number}）と合わない`);

    const status = /^-\s*状態:\s*(.*)$/m.exec(text)?.[1]?.trim();
    if (status === undefined) add("「- 状態:」の行が無い");
    else if (!(DECISION_STATUSES as readonly string[]).includes(status)) add(`状態「${status}」は使えない（${DECISION_STATUSES.join("・")}）`);
    if (!/^-\s*日付:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(text)) add("「- 日付: YYYY-MM-DD」の行が無い");
    for (const section of ["背景", "決定", "影響"]) {
      if (!new RegExp(`^##\\s*${section}\\s*$`, "m").test(text)) add(`「## ${section}」の見出しが無い`);
    }
  }
}

function lintLessons(lessons: BoardFile[], problems: BoardProblem[]): void {
  for (const source of lessons) {
    const lesson = parse(Lesson, source, "invalid-lesson", problems);
    if (lesson && !source.file.endsWith(`/${lesson.id}.json`)) {
      problems.push({ check: "invalid-lesson", file: source.file, message: `ファイル名と id（${lesson.id}）が合わない` });
    }
  }
}

export function lintBoard(input: BoardInput): BoardProblem[] {
  const problems: BoardProblem[] = [];
  lintTasks(input, problems);
  lintDecisions(input.decisions, problems);
  lintLessons(input.lessons ?? [], problems);
  return problems;
}

// いまのディスクの上のボードを調べる（get_overview 用。消されたタスクは、基点が分かるゲートの側で見る）
export function boardProblems(): BoardProblem[] {
  const files = (dir: string, prefix: string, extension: string): BoardFile[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(extension))
          .sort()
          .map((name) => ({ file: `${prefix}/${name}`, text: readFileSync(join(dir, name), "utf8") }))
      : [];
  return lintBoard({
    project: existsSync(paths.project()) ? { file: "dev/project.json", text: readFileSync(paths.project(), "utf8") } : null,
    tasks: files(paths.tasks(), "dev/tasks", ".json"),
    decisions: files(paths.decisions(), "docs/decisions", ".md"),
    lessons: files(join(paths.dev(), "lessons"), "dev/lessons", ".json"),
  });
}
