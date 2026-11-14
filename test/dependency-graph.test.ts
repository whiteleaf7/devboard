import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyGraph } from "../src/dependency-graph.ts";

const t = (id: string, dependsOn: string[] = [], milestone: string | null = "M1", status = "todo") => ({
  id,
  title: id,
  status,
  milestone,
  dependsOn,
});

test("依存先のうち最も深いものの次の段に置き、つながりの無いタスクは数だけ返す", () => {
  const g = dependencyGraph(
    [t("T-1"), t("T-2", ["T-1"]), t("T-3", ["T-1", "T-2"]), t("T-4"), t("T-5", ["T-1"], "M2")],
    "M1",
  );
  const layer = Object.fromEntries(g.nodes.map((n) => [n.id, n.layer]));
  assert.deepEqual(layer, { "T-1": 0, "T-2": 1, "T-3": 2, "T-5": 1 });
  assert.equal(g.unlinked, 1);
  assert.deepEqual(
    g.edges.map((e) => `${e.from}>${e.to}`),
    ["T-1>T-2", "T-1>T-3", "T-2>T-3", "T-1>T-5"],
  );
});

test("ほかのマイルストーンのタスクは、1 歩だけ含めて印を付ける", () => {
  const g = dependencyGraph(
    [t("T-1", [], "M0"), t("T-2", ["T-1"]), t("T-3", ["T-2"], "M2"), t("T-4", ["T-3"], "M2")],
    "M1",
  );
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.external]),
    [
      ["T-1", true],
      ["T-2", false],
      ["T-3", true],
    ],
  );
});

test("後ろに続くタスクの数は、間接に待っているものも数える", () => {
  const g = dependencyGraph([t("T-1"), t("T-2", ["T-1"]), t("T-3", ["T-1"]), t("T-4", ["T-2", "T-3"])], "M1");
  const downstream = Object.fromEntries(g.nodes.map((n) => [n.id, n.downstream]));
  assert.deepEqual(downstream, { "T-1": 3, "T-2": 1, "T-3": 1, "T-4": 0 });
});

test("段の中は、依存先の並びに合わせて並べる", () => {
  const g = dependencyGraph([t("T-1"), t("T-2"), t("T-3", ["T-2"]), t("T-4", ["T-1"])], "M1");
  const row = (layer: number) =>
    g.nodes
      .filter((n) => n.layer === layer)
      .sort((a, b) => a.order - b.order)
      .map((n) => n.id);
  assert.deepEqual(row(0), ["T-1", "T-2"]);
  assert.deepEqual(row(1), ["T-4", "T-3"]);
});

test("つながったまとまりごとに番号を振り、段の中の並びはまとまりごとに数える", () => {
  const g = dependencyGraph([t("T-1"), t("T-2", ["T-1"]), t("T-3"), t("T-4", ["T-3"]), t("T-5", ["T-3"])], "M1");
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.component, n.layer, n.order]),
    [
      ["T-1", 0, 0, 0],
      ["T-2", 0, 1, 0],
      ["T-3", 1, 0, 0],
      ["T-4", 1, 1, 0],
      ["T-5", 1, 1, 1],
    ],
  );
});
