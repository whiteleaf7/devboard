import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/lock.ts";

const root = mkdtempSync(join(tmpdir(), "autodev-lock-"));
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
const lockDir = () => join(root, `lock-${++count}`);

test("ロックを取って関数を動かし、終わったら外す。関数が投げても外す", () => {
  const dir = lockDir();
  assert.equal(
    withLock(dir, () => existsSync(dir)),
    true,
  );
  assert.equal(existsSync(dir), false);
  assert.throws(() =>
    withLock(dir, () => {
      throw new Error("失敗");
    }),
  );
  assert.equal(existsSync(dir), false);
});

test("ほかのプロセスが持つロックは、外れるまで待つ", async () => {
  const dir = lockDir();
  mkdirSync(dir);
  const holder = spawn(process.execPath, [
    "-e",
    `setTimeout(() => require("node:fs").rmdirSync(${JSON.stringify(dir)}), 300)`,
  ]);
  await new Promise((resolve) => holder.on("spawn", resolve));
  const started = Date.now();
  assert.equal(
    withLock(dir, () => "取れた"),
    "取れた",
  );
  assert.ok(Date.now() - started >= 200, "外れる前に取ってはいけない");
});

test("途中で落ちたプロセスが残した古いロックは、外して取る", () => {
  const dir = lockDir();
  mkdirSync(dir);
  const old = new Date(Date.now() - 60_000);
  utimesSync(dir, old, old);
  assert.equal(
    withLock(dir, () => "取れた"),
    "取れた",
  );
});

test("ロックが置けない理由が「使用中」でなければ、待たずに投げる", () => {
  const started = Date.now();
  assert.throws(
    () => withLock(join(root, "missing", "lock"), () => "x"),
    (e: NodeJS.ErrnoException) => e.code === "ENOENT",
  );
  assert.ok(Date.now() - started < 1000);
});

test("関数の間にロックが外されていても、終わるときに失敗しない", () => {
  const dir = lockDir();
  assert.equal(
    withLock(dir, () => {
      rmdirSync(dir);
      return "終えた";
    }),
    "終えた",
  );
});
