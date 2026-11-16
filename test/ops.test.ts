import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useTempBoard } from "./temp-board.ts";

useTempBoard("ops");
const store = await import("../src/store.ts");
const { applyOps } = await import("../src/ops.ts");
const { runCli } = await import("../src/board-cli.ts");

before(() => {
  store.updateProject(() => ({ name: "t", summary: "", milestones: [] }));
});

test("MCP のツールと同じ形の操作を順に当て、$N を前の操作の ID に置き換える", () => {
  const ids = applyOps([
    { op: "set_milestone", args: { id: "M1", title: "検証" } },
    { op: "create_task", args: { title: "親", milestone: "M1" } },
    { op: "create_task", args: { title: "子", parent: "$1", dependsOn: [] } },
    { op: "update_task", args: { id: "$2", status: "done", note: "確かめた" } },
    { op: "add_lesson", args: { title: "罠", problem: "p", fix: "f", task: "$2" } },
    { op: "create_decision", args: { title: "判断", slug: "choice", context: "c", decision: "d", consequences: "i" } },
    { op: "set_decision_status", args: { number: 1, status: "採用" } },
  ]);
  assert.deepEqual(ids, ["M1", "T-001", "T-002", "T-002", "L-001", "D-0001", "D-0001"]);
  assert.equal(store.getTask("T-002").parent, "T-001");
  assert.equal(store.taskHistory("T-002").at(-1)?.actor, "ai", "AI の書き込みとして残る");
  const overview = runCli(["overview"]) as { count: Record<string, number> };
  assert.equal(overview.count.done, 1);
  const tasks = runCli(["tasks", "--status", "todo", "--detail"]) as {
    summary: { closable: number };
    tasks: { id: string }[];
  };
  assert.equal(tasks.summary.closable, 1);
  assert.deepEqual(
    tasks.tasks.map((t) => t.id),
    ["T-001"],
  );
  const task = runCli(["task", "T-001"]) as { children: { id: string }[] };
  assert.deepEqual(
    task.children.map((c) => c.id),
    ["T-002"],
  );
  const decisions = runCli(["decisions"]) as { number: number; status: string }[];
  assert.equal(decisions[0]?.status, "採用");
  const decision = runCli(["decision", "1"]) as { title: string };
  assert.equal(decision.title, "判断");
});

test("断られた操作は、何番目かと理由を返す", () => {
  assert.throws(
    () =>
      applyOps([
        { op: "create_task", args: { title: "x" } },
        { op: "update_task", args: { id: "$0", status: "done" } },
      ]),
    /操作 1（update_task）: .*メモ/,
  );
  assert.throws(() => applyOps([{ op: "create_task", args: { title: "x", status: "wip" } }]), /操作 0/);
  assert.throws(() => applyOps([{ op: "delete_task", args: { id: "T-001" } }]), /操作 0/, "知らない操作");
  assert.throws(
    () => applyOps([{ op: "update_task", args: { id: "T-001", by: "user", status: "done" } }]),
    /操作 0.*by/s,
    "書き手を変える項目は受け付けない（AI の書き込みとして扱う）",
  );
});

test("set_project は、表示名と概要を、指した分だけ書き換える", () => {
  applyOps([{ op: "set_project", args: { name: "新しい製品", summary: "概要" } }]);
  assert.equal(store.readProject().name, "新しい製品");
  applyOps([{ op: "set_project", args: { summary: "概要だけ変える" } }]);
  assert.deepEqual([store.readProject().name, store.readProject().summary], ["新しい製品", "概要だけ変える"]);
  assert.throws(() => applyOps([{ op: "set_project", args: {} }]), /name か summary/);
});
