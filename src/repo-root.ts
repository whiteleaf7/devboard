// ボードの道具が読み書きするプロジェクトの場所。devboard は各プロジェクトの外にある共通のコマンドなので、
// 自分の置き場所ではなく、コマンドを打った場所（cwd）から決める。テストや別の場所からは DEVBOARD_ROOT で向ける

import { projectRootOf } from "./worktree.ts";

export function repoRoot(): string {
  // fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
  return process.env.DEVBOARD_ROOT ?? process.env.NAGAYA_ROOT ?? projectRootOf(process.cwd());
}
