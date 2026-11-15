import { test } from "node:test";
import assert from "node:assert/strict";
import { lintDecisions, type BoardFile } from "../src/lint.ts";
import { closingProblems, hasRunEvidence, introducedProblems, ruleProblems } from "../src/rules.ts";
import { Task } from "../src/schema.ts";

const note = { at: "2026-11-12T00:00:00.000Z", text: "確かめた", by: "ai" };
const task = (id: string, fields: Record<string, unknown> = {}) =>
  Task.parse({
    id,
    title: id,
    status: "todo",
    created: "2026-11-12T00:00:00.000Z",
    updated: "2026-11-12T00:00:00.000Z",
    ...fields,
  });
const decision = (number: string, text?: string): BoardFile => ({
  file: `docs/decisions/${number}-sample.md`,
  text:
    text ?? `# ${number}. 決める\n\n- 状態: 採用\n- 日付: 2026-11-12\n\n## 背景\n\nb\n\n## 決定\n\nd\n\n## 影響\n\ne\n`,
});
const checksOf = (tasks: Task[]) => ruleProblems(tasks, new Set(["M0"])).map((p) => p.check);
const decisionChecks = (decisions: BoardFile[]) => lintDecisions(decisions).map((p) => p.check);

test("決まりどおりのボードには何も言わない", () => {
  const tasks = [
    task("T-001", { status: "done", notes: [note], milestone: "M0" }),
    task("T-002", { parent: "T-001", status: "cancelled", notes: [note] }),
    task("T-003", { dependsOn: ["T-001"] }),
    task("T-004", { status: "review", createdBy: "user" }),
  ];
  assert.deepEqual(checksOf(tasks), []);
  assert.deepEqual(decisionChecks([decision("0001"), decision("0002")]), []);
});

test("切れたつながりと循環を見つける", () => {
  assert.deepEqual(checksOf([task("T-001", { parent: "T-009" })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { dependsOn: ["T-009"] })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { milestone: "M9" })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { dependsOn: ["T-001"] })]), ["broken-link"]);
  assert.deepEqual(checksOf([task("T-001", { dependsOn: ["T-002"] }), task("T-002", { dependsOn: ["T-001"] })]), [
    "broken-link",
    "broken-link",
  ]);
  assert.deepEqual(checksOf([task("T-001", { parent: "T-002" }), task("T-002", { parent: "T-001" })]), [
    "broken-link",
    "broken-link",
  ]);
});

test("説明の無い状態、review、早すぎる親の完了を見つける", () => {
  for (const status of ["done", "cancelled", "blocked"])
    assert.deepEqual(checksOf([task("T-001", { status })]), ["unexplained-state"], status);
  assert.deepEqual(checksOf([task("T-001", { status: "doing" })]), []);
  assert.deepEqual(checksOf([task("T-001", { status: "review" })]), ["forbidden-review"]);
  assert.deepEqual(
    checksOf([task("T-001", { status: "done", notes: [note] }), task("T-002", { parent: "T-001", status: "doing" })]),
    ["parent-closed-early"],
  );
});

test("変更で新しく増えた問題だけを返す", () => {
  const before = ruleProblems([task("T-001", { status: "done" })], new Set());
  const after = ruleProblems([task("T-001", { status: "done" }), task("T-002", { status: "blocked" })], new Set());
  assert.deepEqual(
    introducedProblems(before, after).map((p) => [p.task, p.check]),
    [["T-002", "unexplained-state"]],
  );
});

test("動かしたコマンドと結果の行だけを、動かした証拠とみなす", () => {
  const ran = [
    "動かした: `pnpm --filter @repo/verify screenshot http://127.0.0.1:5173/ .dev/verify/a.png --wait-for .card` → 一覧に 3 件出た",
    "修正した。\n- 動かした：`DEVBOARD_DB=/tmp/b.sqlite pnpm board:apply '[]'` -> `{\"ids\":[]}`",
    "動かした: `pnpm test` → 通った\n動かした: `pnpm harness:selftest` → 45/45",
    "動かした: `node tools/x.ts a->b` → 出力が 2 行",
    "動かした: `./scripts/smoke.sh` → 通った",
  ];
  for (const text of ran) assert.equal(hasRunEvidence(text), true, text);
  const notRun = [
    "テストで確かめた",
    "pnpm test と pnpm typecheck が通った",
    "動かした: `pnpm test` → 120 件通った",
    "動かした: `pnpm --filter @repo/devboard typecheck` → エラー無し",
    "動かした: `node --test test/` → 通った",
    "動かした: `CI=1 pnpm run lint` → 0 件",
    "動かした: `bun test` → 通った",
    "動かした: `pnpm --silent` → 通った",
    "動かした: `pnpm board:apply '[]'` で断られた",
    "動かした: `pnpm board:apply '[]'`",
    "動かした: `pnpm board:apply '[]'` → ",
    "動かした: pnpm board:apply → 通った",
    "`pnpm board:apply '[]'` → 通った",
  ];
  for (const text of notRun) assert.equal(hasRunEvidence(text), false, text);
});

test("振る舞いを変えるタスクを、動かした証拠なしで done にしたときだけ見つける", () => {
  const ran = { ...note, text: "動かした: `pnpm board:apply '[]'` → 断られた" };
  const closing = (
    fields: Record<string, unknown>,
    before = task("T-001", { status: "doing", ...fields }),
    committed: string[] = [],
  ) =>
    closingProblems([before], [task("T-001", { status: "done", ...fields })], (id) =>
      id === "T-001" ? committed : [],
    ).map((p) => p.check);
  const code = { paths: ["tools/devboard/src/"] };
  assert.deepEqual(closing({ ...code, notes: [note] }), ["unverified-done"]);
  assert.deepEqual(closing({ paths: ["docs/", "CLAUDE.md"], notes: [note] }), [], "docs だけ");
  assert.deepEqual(closing({ notes: [note] }), [], "paths もコミットも無い");
  const doingNoPaths = task("T-001", { status: "doing" });
  assert.deepEqual(
    closing({ notes: [note] }, doingNoPaths, ["tools/devboard/src/rules.ts"]),
    ["unverified-done"],
    "paths が無くても、コミットがコードを変えている",
  );
  assert.deepEqual(
    closing({ paths: ["docs/"], notes: [note] }, task("T-001", { status: "doing", paths: ["docs/"] }), ["a.ts"]),
    ["unverified-done"],
    "paths は docs だけでも、コミットがコードを変えている",
  );
  assert.deepEqual(
    closing({ notes: [note] }, doingNoPaths, ["docs/harness.md", "README.md"]),
    [],
    "コミットも docs だけ",
  );
  assert.deepEqual(closing({ ...code, notes: [ran, note] }), [], "前のメモに証拠がある");
  assert.deepEqual(closing({ ...code, notes: [note] }, task("T-001", { status: "done" })), [], "前から done");
  assert.deepEqual(
    closingProblems([], [task("T-001", { status: "done", ...code, notes: [note] })]).length,
    1,
    "作るときに done",
  );
});

test("形式の崩れた決定記録を見つける", () => {
  const good = decision("0001").text;
  const broken = (text: string, file = "docs/decisions/0001-sample.md") => decisionChecks([{ file, text }]);
  assert.deepEqual(broken(good.replace("- 状態: 採用\n", "")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("採用", "承認")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("- 日付: 2026-11-12\n", "")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("## 影響", "## 結果")), ["invalid-decision"]);
  assert.deepEqual(broken(good.replace("# 0001.", "# 0002.")), ["invalid-decision"]);
  assert.deepEqual(broken(good, "docs/decisions/Sample.md"), ["invalid-decision"]);
  assert.deepEqual(decisionChecks([decision("0001"), { ...decision("0001"), file: "docs/decisions/0001-other.md" }]), [
    "invalid-decision",
  ]);
});
