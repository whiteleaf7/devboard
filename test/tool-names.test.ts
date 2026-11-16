// MCP のツール名の一覧（src/tool-names.ts）と、ボードの写し（src/snapshot-cli.ts）を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolNames, toolNamesIn } from "../src/tool-names.ts";
import { useTempBoard } from "./temp-board.ts";

test("registerTool の最初の引数の文字列を、ツール名として拾う", () => {
  assert.deepEqual(toolNamesIn('server.registerTool(\n  "get_overview",\n  {});\nserver.registerTool("create_task", {});\n'), [
    "get_overview",
    "create_task",
  ]);
});

test("mcp.ts に登録されたツールをすべて拾う", () => {
  const registered = readFileSync(join(import.meta.dirname, "../src/mcp.ts"), "utf8").match(/registerTool\(/g)?.length;
  assert.equal(toolNames().length, registered);
  assert.ok(toolNames().includes("get_overview"));
});

test("devboard snapshot は、ボードの写しを書き出し、あるファイルには上書きしない", () => {
  const root = useTempBoard("devboard-snapshot");
  const run = (...args: string[]) =>
    spawnSync("node", [join(import.meta.dirname, "../bin/devboard.ts"), "snapshot", ...args], { encoding: "utf8", env: process.env });
  const out = join(root, "copy.sqlite");
  // NODE_TEST_CONTEXT は DEVBOARD_DB を指定していれば効かない
  const first = run(out);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(out));
  const second = run(out);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /もうある/);
});

test("devboard lint-decisions は、標準入力の決定記録を検査し、問題があれば終了コード 1、入力が不正なら 2", () => {
  const run = (input: string) =>
    spawnSync("node", [join(import.meta.dirname, "../bin/devboard.ts"), "lint-decisions"], { input, encoding: "utf8" });
  const good = "# 0001. はじめ\n\n- 状態: 採用\n- 日付: 2026-11-16\n\n## 背景\n\n a\n\n## 決定\n\n b\n\n## 影響\n\n c\n";
  const ok = run(JSON.stringify([{ file: "docs/decisions/0001-first.md", text: good }]));
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), []);

  const bad = run(JSON.stringify([{ file: "docs/decisions/0001-first.md", text: "# 0001. はじめ\n" }]));
  assert.equal(bad.status, 1);
  const problems = JSON.parse(bad.stdout) as { check: string; file: string }[];
  assert.ok(problems.length > 0 && problems.every((p) => p.check === "invalid-decision" && p.file.endsWith("0001-first.md")));

  assert.equal(run("これは JSON ではない").status, 2);
  assert.equal(run('{"file":"x"}').status, 2);
});
