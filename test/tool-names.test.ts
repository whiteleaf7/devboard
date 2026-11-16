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
