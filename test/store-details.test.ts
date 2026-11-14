// store.ts の、細かい振る舞い（採番、日付、履歴、書く時点の決まり、git の読み取り、決定記録の読み取り）を確かめる。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useTempBoard } from "./temp-board.ts";

// git のフックから動くと GIT_DIR などが渡ってくる。残すと、一時ディレクトリの git が本物のリポジトリを指す
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];

const root = useTempBoard("devboard-details");
const store = await import("../src/store.ts");
const { board } = await import("../src/board-db.ts");

const rawRow = (table: "tasks" | "project", id: string | number) =>
  JSON.parse(String(board().prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id)?.data));
const insertTask = (id: string, number: number) =>
  board()
    .prepare("INSERT INTO tasks (id, number, data) VALUES (?, ?, ?)")
    .run(id, number, JSON.stringify({ id, title: "手で足した", status: "todo", created: "", updated: "" }));

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

before(() => {
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  store.updateProject(() => ({
    name: "t",
    summary: "",
    milestones: [{ id: "M0", title: "m", goal: "", status: "active" }],
  }));
});

test("タスクの番号は、いちばん大きい番号の次を 3 桁でそろえる", () => {
  assert.equal(store.createTask({ title: "a" }).id, "T-001");
  insertTask("T-041", 41);
  assert.equal(store.createTask({ title: "b" }).id, "T-042", "件数ではなく、いちばん大きい番号の次");
  insertTask("T-1234", 1234);
  assert.equal(store.createTask({ title: "c" }).id, "T-1235");
});

test("作成したタスクは既定値を持ち、ボードと作成のイベントに残る", () => {
  const task = store.createTask({ title: "既定値", description: "説明", labels: ["x"], branch: "feat/x" });
  assert.deepEqual(
    { ...task, id: "", created: "", updated: "" },
    {
      id: "",
      title: "既定値",
      status: "todo",
      milestone: null,
      parent: null,
      dependsOn: [],
      priority: "normal",
      labels: ["x"],
      paths: [],
      description: "説明",
      branch: "feat/x",
      notes: [],
      createdBy: "ai",
      created: "",
      updated: "",
    },
  );
  assert.equal(task.created, task.updated);
  assert.ok(!Number.isNaN(Date.parse(task.created)));
  assert.deepEqual(rawRow("tasks", task.id), task);
  assert.deepEqual(
    store.taskHistory(task.id).map((e) => [e.kind, e.actor, e.at]),
    [["task.created", "ai", task.created]],
  );
  assert.equal(store.createTask({ title: "ユーザーから", createdBy: "user" }).createdBy, "user");
});

test("更新は渡した項目だけを変え、メモは前後の空白を落として追記する", async () => {
  const task = store.createTask({ title: "更新", priority: "high", labels: ["a"] });
  await new Promise((r) => setTimeout(r, 5));
  const updated = store.updateTask(task.id, { status: "doing", note: "  着手した  ", by: "user" });
  assert.deepEqual(
    [updated.priority, updated.labels, updated.title, updated.created],
    ["high", ["a"], "更新", task.created],
  );
  assert.deepEqual(
    updated.notes.map((n) => [n.text, n.by]),
    [["着手した", "user"]],
  );
  assert.ok(updated.updated > task.updated, "更新の時刻が進む");
  assert.equal(updated.notes[0]?.at, updated.updated);

  const again = store.updateTask(task.id, { note: "   ", labels: [] });
  assert.equal(again.notes.length, 1, "空白だけのメモは足さない");
  assert.deepEqual(again.labels, []);
  assert.equal(store.updateTask(task.id, { note: "続き" }).notes.at(-1)?.by, "ai", "書いた人の既定は ai");
  assert.equal(store.updateTask(task.id, { milestone: null, parent: null }).milestone, null);
  assert.throws(() => store.updateTask(task.id, { milestone: "M9" }), /M9/);
  assert.throws(() => store.updateTask(task.id, { dependsOn: [task.id] }), /循環/);
  assert.throws(() => store.updateTask(task.id, { parent: task.id }), /循環/);
  assert.throws(() => store.updateTask(task.id, { dependsOn: ["T-999"] }), /T-999/);
  assert.throws(() => store.getTask("T-999"), /T-999/);

  const history = store.taskHistory(task.id).map((e) => [e.kind, e.actor, e.data]);
  assert.deepEqual(
    history[1],
    ["task.changed", "user", { changes: { status: { from: "todo", to: "doing" } } }],
    "誰が何をどう変えたか",
  );
  assert.deepEqual(history[2]?.slice(0, 2), ["task.noted", "user"]);
  assert.deepEqual(
    history[3],
    ["task.changed", "ai", { changes: { labels: { from: ["a"], to: [] } } }],
    "空白だけのメモはイベントにしない",
  );
  assert.throws(() => board().prepare("UPDATE events SET actor = 'user'").run(), /追記/, "イベントは書き換えられない");
  assert.throws(() => board().prepare("DELETE FROM events").run(), /追記/, "イベントは消せない");
});

test("AI の書き込みは、ボードの決まりに新しく反するなら断る。ユーザーの書き込みは断らない", () => {
  const parent = store.createTask({ title: "親" });
  const child = store.createTask({ title: "子", parent: parent.id });
  assert.throws(() => store.updateTask(child.id, { status: "done" }), /メモ/, "メモの無い done");
  assert.throws(() => store.updateTask(child.id, { status: "blocked" }), /メモ/, "メモの無い blocked");
  assert.throws(() => store.updateTask(child.id, { status: "review", note: "見て" }), /review/, "AI のタスクの review");
  assert.throws(() => store.updateTask(parent.id, { status: "done", note: "終えた" }), /子/, "子が残っている親の done");
  assert.equal(store.getTask(parent.id).status, "todo", "断ったら何も書かない");
  assert.equal(store.taskHistory(parent.id).length, 1);

  assert.equal(
    store.updateTask(child.id, { status: "done", note: "確かめた" }).status,
    "done",
    "同じ呼び出しでメモを足せばよい",
  );
  assert.equal(store.updateTask(parent.id, { status: "done", note: "子が終わった" }).status, "done");
  assert.equal(
    store.updateTask(store.createTask({ title: "画面から" }).id, { status: "done", by: "user" }).status,
    "done",
    "ユーザーは断らない",
  );

  const feature = store.createTask({ title: "振る舞いを変える", paths: ["tools/devboard/src/"] });
  assert.throws(
    () => store.updateTask(feature.id, { status: "done", note: "pnpm test と pnpm typecheck が通った" }),
    /動かした.*docs\/verification\.md/s,
    "テストだけのメモでは閉じない",
  );
  assert.equal(
    store.updateTask(feature.id, { status: "done", note: "動かした: `pnpm board:apply '[]'` → 断られた" }).status,
    "done",
  );

  // ユーザーが壊した状態は、AI がほかの項目を変えても断らない（新しく増えた問題だけを止める）
  const reopened = store.updateTask(child.id, { status: "todo", by: "user" });
  assert.equal(store.updateTask(parent.id, { priority: "high" }).priority, "high");
  assert.equal(reopened.status, "todo");
  store.createTask({ title: "M0 のもの", milestone: "M0" });
  assert.throws(
    () => store.updateProject((p) => ({ ...p, milestones: [] })),
    /マイルストーン.*M0/,
    "使われているマイルストーンは消せない",
  );
});

test("決定記録は今日の日付で作り、ファイル名の番号順に読む", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const created = store.createDecision({
    title: "決める",
    slug: "decide-2",
    status: "採用",
    context: " 背景 ",
    decision: "決定",
    consequences: "影響",
  });
  assert.deepEqual(
    [created.number, created.status, created.date, created.title, created.file],
    [1, "採用", today, "決める", "docs/decisions/0001-decide-2.md"],
  );
  assert.equal(
    created.body,
    `# 0001. 決める\n\n- 状態: 採用\n- 日付: ${today}\n\n## 背景\n\n背景\n\n## 決定\n\n決定\n\n## 影響\n\n影響\n`,
  );

  const dir = join(root, "docs", "decisions");
  writeFileSync(join(dir, "0012-later.md"), "# 0012. あと\n\n- 状態: 提案\n- 日付: 2026-01-02\n");
  writeFileSync(join(dir, "0003-bare.md"), "見出しも状態も無い\n");
  writeFileSync(join(dir, "README.md"), "# 決定記録ではない\n");
  writeFileSync(join(dir, "12-short.md"), "# 12. 番号が短い\n");
  assert.deepEqual(
    store.readDecisions().map((d) => [d.number, d.title, d.status, d.date]),
    [
      [1, "決める", "採用", today],
      [3, "0003-bare.md", "不明", ""],
      [12, "あと", "提案", "2026-01-02"],
    ],
  );
  assert.equal(
    store.createDecision({ title: "次", slug: "next", context: "c", decision: "d", consequences: "e" }).number,
    13,
    "いちばん大きい番号の次",
  );
  assert.equal(store.setDecisionStatus(12, "置き換え").status, "置き換え");
  assert.match(
    readFileSync(join(dir, "0012-later.md"), "utf8"),
    /^# 0012\. あと\n\n- 状態: 置き換え\n- 日付: 2026-01-02\n$/,
  );
  assert.throws(() => store.setDecisionStatus(3, "採用"), /状態/);
  assert.throws(() => store.setDecisionStatus(99, "採用"), /99/);
});

test("git の状態（ブランチ、未コミットの件数、最近のコミット）を読む", () => {
  assert.deepEqual(store.readGit(), { branch: null, dirty: 0, commits: [] }, "git の管理下でなければ空");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "docs/\nboard.sqlite*\n");
  for (const subject of ["chore: first", "feat: second", "fix: third"]) {
    writeFileSync(join(root, "a.txt"), subject);
    git("add", "a.txt", ".gitignore");
    git("commit", "-q", "-m", subject);
  }
  writeFileSync(join(root, "a.txt"), "changed");
  writeFileSync(join(root, "b.txt"), "new");
  const info = store.readGit(2);
  assert.deepEqual([info.branch, info.dirty], ["main", 2]);
  assert.deepEqual(
    info.commits.map((c) => c.subject),
    ["fix: third", "feat: second"],
  );
  assert.match(info.commits[0]?.hash ?? "", /^[0-9a-f]{7,}$/);
  assert.match(info.commits[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.readGit().commits.length, 3);
});

test("スナップショットは、壊れた行があっても残りを返す", () => {
  const snapshot = store.snapshot();
  assert.deepEqual([snapshot.project.name, snapshot.errors.length, snapshot.git.branch], ["t", 0, "main"]);
  assert.ok(snapshot.tasks.length >= 5 && snapshot.decisions.length === 4);
  assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
  board().prepare("UPDATE project SET data = '{' WHERE id = 1").run();
  const broken = store.snapshot();
  assert.deepEqual([broken.project.milestones.length, broken.errors.length], [0, 1]);
  assert.match(broken.errors[0] ?? "", /^project: /);
});

test("知らない項目は、更新しても消さない（新しい版のコードが書いたものを、古い版が書き戻すとき）", () => {
  board()
    .prepare("UPDATE project SET data = ? WHERE id = 1")
    .run(
      JSON.stringify({
        name: "t",
        owner: "me",
        milestones: [{ id: "M0", title: "m", status: "active", color: "red" }],
      }),
    );
  const task = store.createTask({ title: "新しい項目つき", milestone: "M0" });
  const future = {
    ...rawRow("tasks", task.id),
    future: ["x"],
    notes: [{ at: "2026-01-01T00:00:00.000Z", text: "a", mood: "ok" }],
  };
  board().prepare("UPDATE tasks SET data = ? WHERE id = ?").run(JSON.stringify(future), task.id);
  store.updateTask(task.id, { status: "doing", note: "b" });
  const after = rawRow("tasks", task.id);
  assert.deepEqual([after.future, after.notes[0].mood, after.status], [["x"], "ok", "doing"]);

  store.updateProject((p) => p);
  const saved = rawRow("project", 1);
  assert.deepEqual([saved.owner, saved.milestones[0].color], ["me", "red"]);
});
