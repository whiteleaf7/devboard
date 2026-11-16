// ボードは main の worktree に 1 つだけ持つ。linked worktree の中から呼ばれても、main の worktree を返す。
// git を起動せずに .git を読む（store は呼ばれるたびにパスを組み立てるので、軽く保つ）

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function mainWorktreeOf(dir: string): string {
  const dotGit = join(dir, ".git");
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return dir;
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  if (!gitdir) return dir;
  const worktreeGitDir = resolve(dir, gitdir);
  const commondirFile = join(worktreeGitDir, "commondir");
  // commondir が無いのは submodule。それ自体が 1 つのリポジトリなので、そのまま使う
  if (!existsSync(commondirFile)) return dir;
  const common = resolve(worktreeGitDir, readFileSync(commondirFile, "utf8").trim());
  return basename(common) === ".git" ? dirname(common) : dir;
}

// コマンドを打った場所は、リポジトリの中のサブディレクトリかもしれない。.git のある一番近い親から main の worktree を求める。
// git の管理下でなければ、その場所をそのまま使う
export function projectRootOf(dir: string): string {
  const start = resolve(dir);
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return mainWorktreeOf(current);
    if (dirname(current) === current) return start;
  }
}
