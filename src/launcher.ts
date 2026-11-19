// ダッシュボードが動いていなければ裏で起動し、URL を返す。open.ts と MCP の open_dashboard が使う。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./store.ts";
import { instanceFile } from "./server.ts";

async function alive(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/snapshot", url), { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// 記録したサーバのプロセスが生きているか。落ちたあとに同じポートを別のプロジェクトのダッシュボードが使っていても、
// そちらを開かないようにする
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function recordedUrl(): string | null {
  const file = instanceFile();
  if (!existsSync(file)) return null;
  try {
    const { url, pid } = JSON.parse(readFileSync(file, "utf8")) as { url: string; pid: number };
    return running(pid) ? url : null;
  } catch {
    return null;
  }
}

export async function ensureServer(): Promise<{ url: string; started: boolean }> {
  const existing = recordedUrl();
  if (existing && (await alive(existing))) return { url: existing, started: false };

  mkdirSync(join(repoRoot(), ".dev"), { recursive: true });
  const log = openSync(join(repoRoot(), ".dev", "devboard.log"), "a");
  const child = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], {
    cwd: repoRoot(),
    detached: true,
    stdio: ["ignore", log, log],
    // 裏で動くことを伝える。コードの更新で立て直すとき、端末に居座らずに入れ替わる（server.ts）
    env: { ...process.env, DEVBOARD_BACKGROUND: "1" },
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const url = recordedUrl();
    if (url && (await alive(url))) return { url, started: true };
  }
  throw new Error("ダッシュボードを起動できなかった。.dev/devboard.log を確認する");
}
