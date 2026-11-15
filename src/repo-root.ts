// ボードの道具が読み書きするリポジトリの場所。テストは DEVBOARD_ROOT で一時ディレクトリに向ける

import { resolve } from "node:path";
import { mainWorktreeOf } from "./worktree.ts";

// 作業用の worktree から呼ばれても、main の worktree の決定記録を使う（決定記録 0010）
const ownRoot = mainWorktreeOf(resolve(import.meta.dirname, "../../.."));

export function repoRoot(): string {
  // fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
  return process.env.DEVBOARD_ROOT ?? process.env.NAGAYA_ROOT ?? ownRoot;
}
