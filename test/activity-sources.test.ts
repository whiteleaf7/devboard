// 活動の画面が gh から PR を読むところ。本物の gh の代わりに、呼ばれた回数を数える偽物を PATH に置く
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempBoard } from "./temp-board.ts";

const root = useTempBoard("devboard-activity-sources");
const { loadActivity } = await import("../src/activity-sources.ts");

const originalPath = process.env.PATH;
after(() => {
  process.env.PATH = originalPath;
});

test("PR は gh から読み、続けて開いたときは gh を呼び直さない", async () => {
  const bin = join(root, "bin");
  const calls = join(root, "gh-calls");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho called >> ${JSON.stringify(calls)}\necho '[]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;

  const first = await loadActivity(7);
  await loadActivity(7);
  assert.equal(first.sources.pullRequests, null);
  assert.equal(readFileSync(calls, "utf8").split("\n").filter(Boolean).length, 1);
});

test("gh が無ければ、そう伝える", async () => {
  // 前のテストの読み取りを使い回さないよう、別のリポジトリの根にする
  process.env.NAGAYA_ROOT = mkdtempSync(join(root, "other-"));
  process.env.PATH = mkdtempSync(join(root, "empty-path-"));
  const activity = await loadActivity(7);
  assert.match(activity.sources.pullRequests ?? "", /gh が見つからない/);
});
