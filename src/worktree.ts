// ボードは main の worktree に 1 つだけ持つ（決定記録 0010）。linked worktree の中から呼ばれても、main の worktree を返す。
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
