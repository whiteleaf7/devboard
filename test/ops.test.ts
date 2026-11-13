import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useTempBoard } from "./temp-board.ts";

useTempBoard("ops");
const store = await import("../src/store.ts");
const { applyOps } = await import("../src/ops.ts");

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
  ]);
  assert.deepEqual(ids, ["M1", "T-001", "T-002", "T-002", "L-001"]);
  assert.equal(store.getTask("T-002").parent, "T-001");
  assert.equal(store.taskHistory("T-002").at(-1)?.actor, "ai", "AI の書き込みとして残る");
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
