import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTasks, type Task } from "../src/store.ts";

const base = {
  milestone: null,
  labels: [],
  paths: [],
  causedBy: [],
  description: "",
  branch: null,
  notes: [],
  createdBy: "ai" as const,
  created: "",
  updated: "",
};
const t = (id: string, fields: Partial<Task> = {}): Task => ({
  ...base,
  id,
  title: id,
  status: "todo",
  parent: null,
  dependsOn: [],
  priority: "normal",
  ...fields,
});

test("未着手を依存と優先度の順に並べる", () => {
  const view = describeTasks([
    t("T-001"),
    t("T-002", { dependsOn: ["T-003"] }),
    t("T-003"),
    t("T-004", { priority: "high", dependsOn: ["T-001"] }),
  ]);
  const order = Object.fromEntries(view.map((v) => [v.id, v.order]));
  assert.deepEqual(order, { "T-001": 1, "T-004": 2, "T-003": 3, "T-002": 4 });
  assert.deepEqual(
    view.filter((v) => v.ready).map((v) => v.id),
    ["T-001", "T-003"],
  );
});

test("確認待ちやブロックに依存するものは、たどった先まで stuck にする", () => {
  const view = describeTasks([
    t("T-001", { status: "review" }),
    t("T-002", { dependsOn: ["T-001"] }),
    t("T-003", { dependsOn: ["T-002"] }),
    t("T-004", { dependsOn: ["T-999"] }),
    t("T-005"),
  ]);
  const by = new Map(view.map((v) => [v.id, v]));
  assert.match(by.get("T-002")!.stuck!, /T-001 が確認待ち/);
  assert.match(by.get("T-003")!.stuck!, /T-002 経由/);
  assert.match(by.get("T-004")!.stuck!, /存在しない/);
  assert.equal(by.get("T-002")!.order, null);
  assert.equal(by.get("T-005")!.order, 1);
  assert.equal(by.get("T-005")!.stuck, null);
});

test("依存が循環していても、たどるのを止めて返す", () => {
  const view = describeTasks([t("T-001", { dependsOn: ["T-002"] }), t("T-002", { dependsOn: ["T-001"] })]);
  assert.deepEqual(
    view.map((v) => [v.id, v.stuck]),
    [
      ["T-001", null],
      ["T-002", null],
    ],
  );
});

test("子を持つ親は着手対象にせず、子がすべて終われば closable にする", () => {
  const view = describeTasks([
    t("T-001"),
    t("T-002", { parent: "T-001", status: "done" }),
    t("T-003", { parent: "T-001", status: "cancelled" }),
  ]);
  const parent = view.find((v) => v.id === "T-001")!;
  assert.equal(parent.ready, false);
  assert.equal(parent.order, null);
  assert.equal(parent.closable, true);
});

test("触る範囲が、進行中のタスクと重なるかを返す", () => {
  const view = describeTasks([
    t("T-001", { status: "doing", paths: ["tools/devboard/"] }),
    t("T-002", { status: "doing", paths: ["docs/harness.md", "tools/verify/"] }),
    t("T-003", { paths: ["tools/devboard/src/store.ts"] }),
    t("T-004", { paths: ["tools/dev"] }),
    t("T-005", { paths: ["tools/harness/", "docs/"] }),
    t("T-006"),
    t("T-007", { status: "done", paths: ["tools/devboard/"] }),
  ]);
  const overlaps = Object.fromEntries(view.map((v) => [v.id, v.overlaps]));
  assert.deepEqual(overlaps["T-003"], ["T-001"], "範囲の中のファイル");
  assert.deepEqual(overlaps["T-004"], [], "名前の途中までが同じだけなら重ならない");
  assert.deepEqual(overlaps["T-005"], ["T-002"], "どれか 1 つでも重なれば重なる");
  assert.deepEqual(overlaps["T-006"], ["T-001", "T-002"], "範囲が無ければ、すべての進行中のタスクと重なる");
  assert.deepEqual(overlaps["T-001"], [], "自分自身とは比べない");
  assert.deepEqual(overlaps["T-007"], [], "終わったタスクは比べない");

  const withParent = describeTasks([
    t("T-010", { status: "doing" }),
    t("T-011", { status: "doing", parent: "T-010", paths: ["a/"] }),
    t("T-012", { paths: ["b/"] }),
  ]);
  assert.deepEqual(
    withParent.find((v) => v.id === "T-012")!.overlaps,
    [],
    "子を持つ親は、作業そのものではないので比べない",
  );
});
