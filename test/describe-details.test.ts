// 次に着手するタスクを決めるロジック（describeTasks）の、状態ごとの扱いを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTasks, nextTasks, type Task } from "../src/store.ts";

const base = {
  milestone: null,
  labels: [],
  paths: [],
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
const byId = (tasks: Task[]) => new Map(describeTasks(tasks).map((v) => [v.id, v]));

test("依存先の状態ごとに、待ち・着手できるか・順番・進められない理由を決める", () => {
  const tasks = [
    t("T-001", { status: "doing" }),
    t("T-002", { dependsOn: ["T-001"] }),
    t("T-003", { dependsOn: ["T-009"] }),
    t("T-004", { status: "blocked" }),
    t("T-005", { dependsOn: ["T-004"] }),
    t("T-006", { status: "done" }),
    t("T-007", { dependsOn: ["T-006"], priority: "low" }),
    t("T-008", { dependsOn: ["T-006", "T-001"] }),
    t("T-010", { status: "cancelled" }),
    t("T-011", { dependsOn: ["T-010", "T-006"], priority: "high" }),
  ];
  const view = byId(tasks);
  const pick = <K extends keyof NonNullable<ReturnType<typeof view.get>>>(key: K) =>
    Object.fromEntries([...view].map(([id, v]) => [id, v[key]]));

  assert.deepEqual(pick("waitingOn"), {
    "T-001": [],
    "T-002": [{ id: "T-001", status: "doing" }],
    "T-003": [{ id: "T-009", status: "missing" }],
    "T-004": [],
    "T-005": [{ id: "T-004", status: "blocked" }],
    "T-006": [],
    "T-007": [],
    "T-008": [{ id: "T-001", status: "doing" }],
    "T-010": [],
    "T-011": [],
  });
  assert.deepEqual(
    [...view].filter(([, v]) => v.ready).map(([id]) => id),
    ["T-007", "T-011"],
    "未着手で、依存先がすべて終わったものだけ",
  );
  assert.deepEqual(pick("order"), {
    "T-001": null,
    "T-002": 2,
    "T-003": null,
    "T-004": null,
    "T-005": null,
    "T-006": null,
    "T-007": 4,
    "T-008": 3,
    "T-010": null,
    "T-011": 1,
  });
  assert.deepEqual(pick("stuck"), {
    "T-001": null,
    "T-002": null,
    "T-003": "依存先 T-009 が存在しない",
    "T-004": null,
    "T-005": "依存先 T-004 がブロック",
    "T-006": null,
    "T-007": null,
    "T-008": null,
    "T-010": null,
    "T-011": null,
  });
  assert.deepEqual(
    nextTasks(tasks).map((v) => v.id),
    ["T-011", "T-007"],
  );
});

test("優先度は高い順、同じなら ID 順。ただし依存の順を先に守る", () => {
  const tasks = [
    t("T-001", { priority: "low" }),
    t("T-002", { priority: "high", dependsOn: ["T-001"] }),
    t("T-003"),
    t("T-004", { priority: "high" }),
    t("T-005"),
  ];
  assert.deepEqual(
    [...byId(tasks)].map(([id, v]) => [id, v.order]),
    [
      ["T-001", 4],
      ["T-002", 5],
      ["T-003", 2],
      ["T-004", 1],
      ["T-005", 3],
    ],
  );
  assert.deepEqual(
    nextTasks(tasks).map((v) => v.id),
    ["T-004", "T-003", "T-005", "T-001"],
  );
});

test("親は、子がすべて終わっていて自分がまだ終わっていないときだけ閉じられる", () => {
  const view = byId([
    t("T-001", { status: "doing" }),
    t("T-002", { parent: "T-001", status: "done" }),
    t("T-003", { status: "done" }),
    t("T-004", { parent: "T-003", status: "done" }),
    t("T-005"),
    t("T-006", { parent: "T-005", status: "done" }),
    t("T-007", { parent: "T-005" }),
    t("T-008", { status: "blocked" }),
    t("T-009", { parent: "T-008", status: "cancelled" }),
  ]);
  assert.deepEqual(
    [...view].filter(([, v]) => v.closable).map(([id]) => id),
    ["T-001", "T-008"],
  );
  assert.deepEqual(view.get("T-005")?.children, ["T-006", "T-007"]);
  assert.deepEqual(
    [view.get("T-005")?.ready, view.get("T-005")?.order, view.get("T-007")?.ready, view.get("T-007")?.order],
    [false, null, true, 1],
  );
  assert.equal(view.get("T-002")?.closable, false, "子を持たないものは対象にしない");
});

test("子を持つ親に依存するものは、並べずに残す", () => {
  const view = byId([
    t("T-001"),
    t("T-002", { parent: "T-001" }),
    t("T-003", { dependsOn: ["T-001"] }),
    t("T-004", { dependsOn: ["T-003"] }),
  ]);
  assert.deepEqual(
    [...view].map(([id, v]) => [id, v.order, v.ready, v.stuck]),
    [
      ["T-001", null, false, null],
      ["T-002", 1, true, null],
      ["T-003", null, false, null],
      ["T-004", null, false, null],
    ],
  );
});

test("確認待ちの先にあるものは、何段たどっても進められない", () => {
  const view = byId([
    t("T-001", { status: "review" }),
    t("T-002", { dependsOn: ["T-001"] }),
    t("T-003", { dependsOn: ["T-002"] }),
    t("T-004", { dependsOn: ["T-003"] }),
  ]);
  assert.equal(view.get("T-002")?.stuck, "依存先 T-001 が確認待ち");
  assert.equal(view.get("T-004")?.stuck, "T-003 経由: T-002 経由: 依存先 T-001 が確認待ち");
  assert.deepEqual(
    [...view].map(([, v]) => v.order),
    [null, null, null, null],
  );
});
