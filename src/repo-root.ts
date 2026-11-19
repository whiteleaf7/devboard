// ボードの道具が読み書きするプロジェクトの場所。devboard は各プロジェクトの外にある共通のコマンドなので、
// 自分の置き場所ではなく、コマンドを打った場所（cwd）から決める。テストや別の場所からは DEVBOARD_ROOT で向ける。
// ダッシュボードは 1 つのプロセスでほかのプロジェクトのボードも見せるので、inProject の中では、そのプロジェクトの場所を返す

import { AsyncLocalStorage } from "node:async_hooks";
import { projectRootOf } from "./worktree.ts";

const scope = new AsyncLocalStorage<string>();

// fn の中（その先の非同期の処理も含む）では、repoRoot() が root を返す
export const inProject = <T>(root: string, fn: () => T): T => scope.run(root, fn);

// inProject の中なら、その場所。コマンドを打った場所から決めたものではない
export const scopedRoot = (): string | undefined => scope.getStore();

export function repoRoot(): string {
  // fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
  return scope.getStore() ?? process.env.DEVBOARD_ROOT ?? process.env.NAGAYA_ROOT ?? projectRootOf(process.cwd());
}
