// 複数のセッション（worktree ごとの MCP、ダッシュボード）が同じボードに書くので、採番と書き込みを 1 つずつにする。
// store の関数は同期なので、ロックも同期で待つ。mkdir が原子的なことを使う

import { mkdirSync, rmdirSync, statSync } from "node:fs";

const WAIT_MS = 10_000;
// 書き込みは数ミリ秒で終わる。これより古いロックは、途中で落ちたプロセスが残したものとみなす
const STALE_MS = 30_000;

const errorCode = (e: unknown) => (e instanceof Error && "code" in e ? e.code : undefined);

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStale(dir: string): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs > STALE_MS;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false; // 待つ間に外された
    throw e;
  }
}

function release(dir: string): void {
  try {
    rmdirSync(dir);
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
}

export function withLock<T>(dir: string, fn: () => T): T {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;
      if (isStale(dir)) release(dir);
      else if (Date.now() > deadline) {
        throw new Error(
          `ボードのロック ${dir} が ${WAIT_MS / 1000} 秒たっても外れない。書き込み中のプロセスが無ければ、このディレクトリを消す`,
        );
      } else sleep(5 + Math.random() * 20);
    }
  }
  try {
    return fn();
  } finally {
    release(dir);
  }
}
