// git の履歴にあるボード（dev/tasks、dev/lessons、dev/project.json）を、SQLite のボードにイベントとして再現する。
//   devboard import-history
// コミットの順に写しを読み、作業ツリーにまだファイルがあれば最後の写しとして足す。空のボードにだけ入れる。
// 入れたあと、ボードのいまの状態が最後の写しと一致するかを確かめる。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { appendEvent, board, boardFile, write } from "./board-db.ts";
import { eventsFromSnapshots, type BoardSnapshot } from "./history-import.ts";
import { Lesson, Project, Task } from "./schema.ts";
import { readLessons, readProject, readTasks, repoRoot } from "./store.ts";

const SOURCES = ["dev/tasks", "dev/lessons", "dev/project.json"];

const root = repoRoot();
const warnings: string[] = [];

function git(args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024 });
}

// 「<sha> blob <size>\n<中身>\n」が並ぶ git cat-file --batch の出力を、指定した順に読む
function readBlobs(specs: string[]): string[] {
  const out = git(["cat-file", "--batch"], specs.join("\n") + "\n");
  const blobs: string[] = [];
  let at = 0;
  for (const spec of specs) {
    const headerEnd = out.indexOf(0x0a, at);
    const header = out.subarray(at, headerEnd).toString();
    const size = Number(/ blob (\d+)$/.exec(header)?.[1]);
    if (!Number.isInteger(size)) throw new Error(`${spec} を読めなかった: ${header}`);
    blobs.push(out.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    at = headerEnd + 1 + size + 1;
  }
  return blobs;
}

function parse<T>(schema: z.ZodType<T>, where: string, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    warnings.push(`${where}: ${parsed.error.issues[0]?.message ?? "形式が合わない"}`);
  } catch {
    warnings.push(`${where}: JSON として読めない`);
  }
  return null;
}

function snapshotOf(at: string, files: { path: string; text: string; where: string }[]): BoardSnapshot {
  const pick = <T>(schema: z.ZodType<T>, prefix: string) =>
    files
      .filter((f) => f.path.startsWith(prefix) && f.path.endsWith(".json"))
      .flatMap((f) => parse(schema, f.where, f.text) ?? []);
  const projectFile = files.find((f) => f.path === "dev/project.json");
  return {
    at,
    tasks: pick(Task, "dev/tasks/"),
    lessons: pick(Lesson, "dev/lessons/"),
    project: projectFile ? parse(Project, projectFile.where, projectFile.text) : null,
  };
}

function historySnapshots(): BoardSnapshot[] {
  const commits = git(["log", "--reverse", "--format=%H%x09%cI", "--", ...SOURCES])
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t") as [string, string]);
  return commits.map(([sha, at]) => {
    const paths = git(["ls-tree", "-r", "--name-only", sha, "--", ...SOURCES])
      .toString()
      .split("\n")
      .filter(Boolean);
    const texts = readBlobs(paths.map((path) => `${sha}:${path}`));
    return snapshotOf(
      at,
      paths.map((path, i) => ({ path, text: texts[i] ?? "", where: `${sha.slice(0, 7)}:${path}` })),
    );
  });
}

function workingTreeSnapshot(): BoardSnapshot | null {
  if (!existsSync(join(root, "dev", "tasks"))) return null;
  const files = ["dev/tasks", "dev/lessons"].flatMap((dir) =>
    existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((name) => `${dir}/${name}`) : [],
  );
  if (existsSync(join(root, "dev", "project.json"))) files.push("dev/project.json");
  return snapshotOf(
    new Date().toISOString(),
    files.map((path) => ({ path, text: readFileSync(join(root, path), "utf8"), where: `作業ツリー:${path}` })),
  );
}

const numberOf = (id: string) => Number(id.replace(/^\D+-/, ""));
const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const db = board();
const existing = Number(db.prepare("SELECT count(*) AS n FROM events").get()?.n);
if (existing > 0) {
  console.error(
    `devboard import-history: ${boardFile()} はもう空ではない（イベント ${existing} 件）。移し直すなら、DEVBOARD_DB で別のファイルを指定する`,
  );
  process.exit(1);
}

const snapshots = historySnapshots();
const current = workingTreeSnapshot();
if (current) snapshots.push(current);
if (!snapshots.length) {
  console.error("devboard import-history: git の履歴にも作業ツリーにも、ボードのファイルが無い");
  process.exit(1);
}

// いまの状態は、それぞれのタスク・教訓が最後に見えた写し（ファイルを消したコミットがあっても、消さずに残す）
const latestTasks = new Map<string, Task>();
const latestLessons = new Map<string, Lesson>();
let latestProject: Project | null = null;
for (const s of snapshots) {
  for (const t of s.tasks) latestTasks.set(t.id, t);
  for (const l of s.lessons) latestLessons.set(l.id, l);
  latestProject = s.project ?? latestProject;
}

const events = eventsFromSnapshots(snapshots);
write(db, () => {
  for (const t of latestTasks.values())
    db.prepare("INSERT INTO tasks (id, number, data) VALUES (?, ?, ?)").run(t.id, numberOf(t.id), JSON.stringify(t));
  for (const l of latestLessons.values())
    db.prepare("INSERT INTO lessons (id, number, data) VALUES (?, ?, ?)").run(l.id, numberOf(l.id), JSON.stringify(l));
  if (latestProject) db.prepare("INSERT INTO project (id, data) VALUES (1, ?)").run(JSON.stringify(latestProject));
  for (const event of events) appendEvent(db, event);
});

// 最後の写し（作業ツリーがあればそれ）と、ボードのいまの状態を比べる
const last = snapshots.at(-1)!;
const tasks = byId(readTasks().tasks);
const lessons = byId(readLessons().lessons);
const mismatches = [
  ...last.tasks.filter((t) => !same(tasks.get(t.id), t)).map((t) => t.id),
  ...last.lessons.filter((l) => !same(lessons.get(l.id), l)).map((l) => l.id),
  ...(last.project && !same(readProject(), last.project) ? ["project"] : []),
];

console.log(`devboard import-history: ${boardFile()}`);
console.log(
  `  写し ${snapshots.length} 件（コミット ${snapshots.length - (current ? 1 : 0)}${current ? "、作業ツリー 1" : ""}）`,
);
console.log(`  タスク ${latestTasks.size}、教訓 ${latestLessons.size}、イベント ${events.length}`);
for (const warning of warnings) console.log(`  読めなかった: ${warning}`);
if (mismatches.length) {
  console.error(`devboard import-history: 最後の写しと一致しない: ${mismatches.join(", ")}`);
  process.exit(1);
}
console.log(`  最後の写し（${current ? "作業ツリー" : "最後のコミット"}）と一致した`);
