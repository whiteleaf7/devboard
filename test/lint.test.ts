import { test } from "node:test";
import assert from "node:assert/strict";
import { lintBoard, type BoardFile } from "../src/lint.ts";

const project: BoardFile = { file: "dev/project.json", text: JSON.stringify({ name: "t", milestones: [{ id: "M0", title: "m", status: "active" }] }) };
const note = { at: "2026-11-12T00:00:00.000Z", text: "確かめた", by: "ai" };
const task = (id: string, fields: Record<string, unknown> = {}): BoardFile => ({
  file: `dev/tasks/${id}.json`,
  text: JSON.stringify({ id, title: id, status: "todo", created: "2026-11-12T00:00:00.000Z", updated: "2026-11-12T00:00:00.000Z", ...fields }),
});
const decision = (number: string, text?: string): BoardFile => ({
  file: `docs/decisions/${number}-sample.md`,
  text: text ?? `# ${number}. 決める\n\n- 状態: 採用\n- 日付: 2026-11-12\n\n## 背景\n\nb\n\n## 決定\n\nd\n\n## 影響\n\ne\n`,
});
const checksOf = (tasks: BoardFile[], decisions: BoardFile[] = [], baseTaskFiles: string[] = []) =>
  lintBoard({ project, tasks, decisions, baseTaskFiles }).map((p) => p.check);

test("決まりどおりのボードには何も言わない", () => {
  const tasks = [
    task("T-001", { status: "done", notes: [note], milestone: "M0" }),
    task("T-002", { parent: "T-001", status: "cancelled", notes: [note] }),
    task("T-003", { dependsOn: ["T-001"] }),
    task("T-004", { status: "review", createdBy: "user" }),
  ];
  assert.deepEqual(checksOf(tasks, [decision("0001"), decision("0002")], tasks.map((t) => t.file)), []);
});

test("読めないタスクと、スキーマに合わないタスクを見つける", () => {
  assert.deepEqual(checksOf([{ file: "dev/tasks/T-001.json", text: "{" }]), ["invalid-task"]);
  assert.deepEqual(checksOf([task("T-001", { status: "wip" })]), ["invalid-task"]);
  assert.deepEqual(checksOf([task("task-1")]), ["invalid-task"]);
  assert.deepEqual(checksOf([{ ...task("T-001"), file: "dev/tasks/T-002.json" }]), ["invalid-task"]);
});

test("切れたつながりと循環を見つける", () => {
  assert.deepEqual(checksOf([task("T-001", { parent: "T-009" })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { dependsOn: ["T-009"] })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { milestone: "M9" })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { dependsOn: ["T-001"] })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { dependsOn: ["T-002"] }), task("T-002", { dependsOn: ["T-001"] })]), ["broken-link", "broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { parent: "T-002" }), task("T-002", { parent: "T-001" })]), ["broken-link", "broken-link"]);
});

test("説明の無い状態、review、早すぎる親の完了、消されたタスクを見つける", () => {
  for (const status of ["done", "cancelled", "blocked"]) assert.deepEqual(checksOf([task("T-001", { status })]), ["unexplained-state"], status);
  assert.deepEqual(checksOf([task("T-001", { status: "doing" })]), []);
  assert.deepEqual(checksOf([task("T-001", { status: "review" })]), ["forbidden-review"]);
  assert.deepEqual(checksOf([task("T-001", { status: "done", notes: [note] }), task("T-002", { parent: "T-001", status: "doing" })]), ["parent-closed-early"]);
  assert.deepEqual(checksOf([task("T-001")], [], ["dev/tasks/T-001.json", "dev/tasks/T-002.json"]), ["deleted-task"]);
});

test("形式の崩れた決定記録を見つける", () => {
  const good = decision("0001").text;
  const broken = (text: string, file = "docs/decisions/0001-sample.md") => checksOf([], [{ file, text }]);
  assert.deepEqual(broken(good.replace("- 状態: 採用\n", "")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("採用", "承認")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("- 日付: 2026-11-12\n", "")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("## 影響", "## 結果")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("# 0001.", "# 0002.")), ["invalid-decision"]);
  assert.deepEqual(broken(good, "docs/decisions/Sample.md"), ["invalid-decision"]);
  assert.deepEqual(checksOf([], [decision("0001"), { ...decision("0001"), file: "docs/decisions/0001-other.md" }]), ["invalid-decision"]);
});
