// devboard コマンドの入口（bin/devboard.ts と src/commands.ts）を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommand } from "../src/commands.ts";

const BIN = join(import.meta.dirname, "../bin/devboard.ts");

test("サブコマンドを、動かすスクリプトと引数に分ける", () => {
  assert.deepEqual(resolveCommand(["show", "tasks", "--ready"]), { ok: true, script: "board-cli.ts", args: ["tasks", "--ready"] });
  assert.deepEqual(resolveCommand(["mcp"]), { ok: true, script: "mcp.ts", args: [] });
  assert.deepEqual(resolveCommand(["import-history"]), { ok: true, script: "board-import.ts", args: [] });
});

test("コマンドが無い・help のときは使い方を、知らないコマンドは失敗として返す", () => {
  for (const argv of [[], ["help"], ["--help"]]) {
    const r = resolveCommand(argv);
    assert.ok(!r.ok && r.help && r.message.includes("使い方"));
  }
  const unknown = resolveCommand(["nothing"]);
  assert.ok(!unknown.ok && !unknown.help && unknown.message.includes("nothing"));
  assert.ok(!resolveCommand(["toString"]).ok, "オブジェクトの組み込みの名前をコマンドとして扱わない");
});

// 本物のボードに触れないよう、HOME を一時ディレクトリにする。プロジェクトやボードの指定の環境変数は外す。
// NODE_TEST_CONTEXT（本物のボードへの書き込みを止めるガード）は、HOME を分けたこのテストでは外してよい
const run = (cwd: string, home: string, ...args: string[]) => {
  const { DEVBOARD_ROOT, NAGAYA_ROOT, DEVBOARD_DB, NAGAYA_BOARD, NODE_TEST_CONTEXT, ...env } = process.env;
  return spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8", env: { ...env, HOME: home } });
};

test("プロジェクトは、サブディレクトリから打っても、その git の根から決まる", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "devboard-bin-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "myproject");
  mkdirSync(join(project, "apps", "web"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  mkdirSync(join(project, "docs", "decisions"), { recursive: true });
  writeFileSync(join(project, "docs", "decisions", "0001-first.md"), "# 0001. はじめの決定\n\n- 状態: 採用\n- 日付: 2026-11-16\n\n## 背景\n\nなし\n\n## 決定\n\nなし\n\n## 影響\n\nなし\n");

  const fromSub = run(join(project, "apps", "web"), home, "show", "decisions");
  assert.equal(fromSub.status, 0, fromSub.stderr);
  assert.match(fromSub.stdout, /はじめの決定/);

  const overview = run(join(project, "apps", "web"), home, "show", "overview");
  assert.equal(overview.status, 0, overview.stderr);
  assert.ok(existsSync(join(home, ".devboard", "boards", "myproject.sqlite")), "ボードの名前はプロジェクトのディレクトリ名");
});

test("知らないコマンドは、使い方を出して失敗する", () => {
  const r = run(tmpdir(), tmpdir(), "nothing");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /使い方/);
});
