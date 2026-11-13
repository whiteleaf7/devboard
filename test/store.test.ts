import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useTempBoard } from "./temp-board.ts";

const root = useTempBoard("devboard");
const store = await import("../src/store.ts");
const { board } = await import("../src/board-db.ts");

before(() => {
  store.updateProject(() => ({ name: "t", summary: "", milestones: [{ id: "M0", title: "m", goal: "", status: "active" }] }));
});

test("タスクを採番して作成し、更新でメモが積まれる", () => {
  const a = store.createTask({ title: "a", milestone: "M0" });
  const b = store.createTask({ title: "b" });
  assert.equal(a.id, "T-001");
  assert.equal(b.id, "T-002");
  const u = store.updateTask("T-001", { status: "doing", note: "着手" });
  assert.equal(u.status, "doing");
  assert.equal(u.milestone, "M0");
  assert.equal(u.notes.length, 1);
  assert.equal(store.updateTask("T-001", { note: "続き" }).notes.length, 2);
});

test("存在しないマイルストーンは拒否する", () => {
  assert.throws(() => store.createTask({ title: "x", milestone: "M9" }), /M9/);
});

test("壊れた行はエラーとして返し、他は読める", () => {
  board().prepare("INSERT INTO tasks (id, number, data) VALUES (?, ?, ?)").run("T-900", 900, "{");
  const { tasks, errors } = store.readTasks();
  assert.ok(tasks.length >= 2);
  assert.equal(errors.length, 1);
});

test("決定記録を採番して作成し、状態を変えられる", () => {
  const d = store.createDecision({ title: "決める", slug: "decide-x", context: "c", decision: "d", consequences: "e" });
  assert.equal(d.number, 1);
  assert.equal(d.status, "提案");
  assert.equal(store.createDecision({ title: "次", slug: "next", context: "c", decision: "d", consequences: "e" }).number, 2);
  const s = store.setDecisionStatus(1, "採用");
  assert.equal(s.status, "採用");
  assert.match(readFileSync(join(root, s.file), "utf8"), /- 状態: 採用/);
  assert.throws(() => store.createDecision({ title: "x", slug: "Bad Slug", context: "", decision: "", consequences: "" }));
});

test("親子・依存を検証し、次に着手できるタスクを優先度順に返す", () => {
  const parent = store.createTask({ title: "依頼" });
  const a = store.createTask({ title: "先", parent: parent.id });
  const b = store.createTask({ title: "後", parent: parent.id, dependsOn: [a.id] });
  const c = store.createTask({ title: "急ぎ", priority: "high" });
  assert.throws(() => store.createTask({ title: "x", parent: "T-999" }), /T-999/);
  assert.throws(() => store.updateTask(a.id, { dependsOn: [b.id] }), /循環/);
  assert.throws(() => store.updateTask(parent.id, { parent: a.id }), /循環/);

  const ids = () => store.nextTasks(store.readTasks().tasks).map((t) => t.id);
  assert.equal(ids()[0], c.id);
  assert.ok(ids().includes(a.id));
  assert.ok(!ids().includes(b.id), "依存先が終わるまでは出さない");
  assert.ok(!ids().includes(parent.id), "子を持つ親は出さない");
  store.updateTask(a.id, { status: "cancelled", note: "不要になった" });
  assert.ok(ids().includes(b.id), "依存先が中止なら着手できる");
});
