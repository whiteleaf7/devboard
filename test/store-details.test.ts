// store.ts の、細かい振る舞い（採番、日付、git の読み取り、決定記録の読み取り）を確かめる。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// git のフックから動くと GIT_DIR などが渡ってくる。残すと、一時ディレクトリの git が本物のリポジトリを指す
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];

const root = mkdtempSync(join(tmpdir(), "nagaya-devboard-details-"));
process.env.NAGAYA_ROOT = root;
const store = await import("../src/store.ts");

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

before(() => {
  mkdirSync(join(root, "dev", "tasks"), { recursive: true });
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  writeFileSync(join(root, "dev", "project.json"), JSON.stringify({ name: "t", milestones: [{ id: "M0", title: "m", status: "active" }] }));
});

test("タスクの番号は、いちばん大きい番号の次を 3 桁でそろえる", () => {
  assert.equal(store.createTask({ title: "a" }).id, "T-001");
  writeFileSync(join(root, "dev", "tasks", "T-041.json"), JSON.stringify({ id: "T-041", title: "手で足した", status: "todo", created: "", updated: "" }));
  assert.equal(store.createTask({ title: "b" }).id, "T-042", "件数ではなく、いちばん大きい番号の次");
  writeFileSync(join(root, "dev", "tasks", "T-1234.json"), JSON.stringify({ id: "T-1234", title: "4 桁", status: "todo", created: "", updated: "" }));
  assert.equal(store.createTask({ title: "c" }).id, "T-1235");
});

test("作成したタスクは既定値を持ち、ファイルに書かれる", () => {
  const task = store.createTask({ title: "既定値", description: "説明", labels: ["x"], branch: "feat/x" });
  assert.deepEqual(
    { ...task, id: "", created: "", updated: "" },
    { id: "", title: "既定値", status: "todo", milestone: null, parent: null, dependsOn: [], priority: "normal", labels: ["x"], paths: [], description: "説明", branch: "feat/x", notes: [], createdBy: "ai", created: "", updated: "" },
  );
  assert.equal(task.created, task.updated);
  assert.ok(!Number.isNaN(Date.parse(task.created)));
  const onDisk = readFileSync(join(root, "dev", "tasks", `${task.id}.json`), "utf8");
  assert.deepEqual(JSON.parse(onDisk), task);
  assert.ok(onDisk.endsWith("}\n") && onDisk.includes('\n  "title"'), "2 文字の字下げと、末尾の改行");
  assert.deepEqual(readdirSync(join(root, "dev", "tasks")).filter((f) => f.endsWith(".tmp")), [], "一時ファイルを残さない");
  assert.equal(store.createTask({ title: "ユーザーから", createdBy: "user" }).createdBy, "user");
});

test("更新は渡した項目だけを変え、メモは前後の空白を落として追記する", async () => {
  const task = store.createTask({ title: "更新", priority: "high", labels: ["a"] });
  await new Promise((r) => setTimeout(r, 5));
  const updated = store.updateTask(task.id, { status: "doing", note: "  着手した  ", by: "user" });
  assert.deepEqual([updated.priority, updated.labels, updated.title, updated.created], ["high", ["a"], "更新", task.created]);
  assert.deepEqual(updated.notes.map((n) => [n.text, n.by]), [["着手した", "user"]]);
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
});

test("決定記録は今日の日付で作り、ファイル名の番号順に読む", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const created = store.createDecision({ title: "決める", slug: "decide-2", status: "採用", context: " 背景 ", decision: "決定", consequences: "影響" });
  assert.deepEqual([created.number, created.status, created.date, created.title, created.file], [1, "採用", today, "決める", "docs/decisions/0001-decide-2.md"]);
  assert.equal(created.body, `# 0001. 決める\n\n- 状態: 採用\n- 日付: ${today}\n\n## 背景\n\n背景\n\n## 決定\n\n決定\n\n## 影響\n\n影響\n`);

  const dir = join(root, "docs", "decisions");
  writeFileSync(join(dir, "0012-later.md"), "# 0012. あと\n\n- 状態: 提案\n- 日付: 2026-01-02\n");
  writeFileSync(join(dir, "0003-bare.md"), "見出しも状態も無い\n");
  writeFileSync(join(dir, "README.md"), "# 決定記録ではない\n");
  writeFileSync(join(dir, "12-short.md"), "# 12. 番号が短い\n");
  assert.deepEqual(
    store.readDecisions().map((d) => [d.number, d.title, d.status, d.date]),
    [[1, "決める", "採用", today], [3, "0003-bare.md", "不明", ""], [12, "あと", "提案", "2026-01-02"]],
  );
  assert.equal(store.createDecision({ title: "次", slug: "next", context: "c", decision: "d", consequences: "e" }).number, 13, "いちばん大きい番号の次");
  assert.equal(store.setDecisionStatus(12, "置き換え").status, "置き換え");
  assert.match(readFileSync(join(dir, "0012-later.md"), "utf8"), /^# 0012\. あと\n\n- 状態: 置き換え\n- 日付: 2026-01-02\n$/);
  assert.throws(() => store.setDecisionStatus(3, "採用"), /状態/);
  assert.throws(() => store.setDecisionStatus(99, "採用"), /99/);
});

test("git の状態（ブランチ、未コミットの件数、最近のコミット）を読む", () => {
  assert.deepEqual(store.readGit(), { branch: null, dirty: 0, commits: [] }, "git の管理下でなければ空");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "dev/\ndocs/\n");
  for (const subject of ["chore: first", "feat: second", "fix: third"]) {
    writeFileSync(join(root, "a.txt"), subject);
    git("add", "a.txt", ".gitignore");
    git("commit", "-q", "-m", subject);
  }
  writeFileSync(join(root, "a.txt"), "changed");
  writeFileSync(join(root, "b.txt"), "new");
  const info = store.readGit(2);
  assert.deepEqual([info.branch, info.dirty], ["main", 2]);
  assert.deepEqual(info.commits.map((c) => c.subject), ["fix: third", "feat: second"]);
  assert.match(info.commits[0]?.hash ?? "", /^[0-9a-f]{7,}$/);
  assert.match(info.commits[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.readGit().commits.length, 3);
});

test("スナップショットは、壊れたファイルがあっても残りを返す", () => {
  const snapshot = store.snapshot();
  assert.deepEqual([snapshot.project.name, snapshot.errors.length, snapshot.git.branch], ["t", 0, "main"]);
  assert.ok(snapshot.tasks.length >= 5 && snapshot.decisions.length === 4);
  assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
  writeFileSync(join(root, "dev", "project.json"), "{");
  const broken = store.snapshot();
  assert.deepEqual([broken.project.name, broken.project.milestones.length, broken.errors.length], ["nagaya", 0, 1]);
  assert.match(broken.errors[0] ?? "", /^dev\/project\.json: /);
});

test("知らない項目は、更新しても消さない（新しい版のコードが書いたものを、古い版が書き戻すとき）", () => {
  const project = join(root, "dev", "project.json");
  writeFileSync(project, JSON.stringify({ name: "t", owner: "me", milestones: [{ id: "M0", title: "m", status: "active", color: "red" }] }));
  const task = store.createTask({ title: "新しい項目つき", milestone: "M0" });
  const file = join(root, "dev", "tasks", `${task.id}.json`);
  const future = { ...JSON.parse(readFileSync(file, "utf8")), future: ["x"], notes: [{ at: "2026-01-01T00:00:00.000Z", text: "a", mood: "ok" }] };
  writeFileSync(file, JSON.stringify(future));
  store.updateTask(task.id, { status: "doing", note: "b" });
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([after.future, after.notes[0].mood, after.status], [["x"], "ok", "doing"]);

  store.updateProject((p) => p);
  const saved = JSON.parse(readFileSync(project, "utf8"));
  assert.deepEqual([saved.owner, saved.milestones[0].color], ["me", "red"]);
});
