// pnpm recall（src/recall-cli.ts）を、一時的なボードに向けて動かす
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { useTempBoard } from "./temp-board.ts";

useTempBoard("devboard-recall-cli");
const store = await import("../src/store.ts");
store.createTask({ title: "変異テストを全対象で回す" });
store.createTask({ title: "変異テストの生き残りを埋める" });

const SCRIPT = join(import.meta.dirname, "../src/recall-cli.ts");
const recallCli = (...args: string[]) => {
  const result = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

test("見つかった記録を ID と題で並べ、--limit で件数を絞る", () => {
  const all = recallCli("変異テスト");
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /^T-00\d {2}変異テスト/m);
  assert.equal(all.out.match(/^T-/gm)?.length, 2);
  assert.equal(recallCli("--limit", "1", "変異テスト").out.match(/^T-/gm)?.length, 1);
});

test("--json では結果を JSON で返す", () => {
  const { out } = recallCli("--json", "変異テスト");
  assert.equal((JSON.parse(out) as { results: unknown[] }).results.length, 2);
});

test("見つからなければそう伝え、質問が無ければ使い方を出して失敗する", () => {
  assert.match(recallCli("無関係な語").out, /見つからなかった/);
  const empty = recallCli();
  assert.equal(empty.code, 1);
  assert.match(empty.err, /使い方/);
});
