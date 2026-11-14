// リポジトリの git の状態を読む。git が無い・リポジトリでないときは、空の結果として扱う

import { execFileSync } from "node:child_process";
import { repoRoot } from "./repo-root.ts";
import type { GitInfo } from "./schema.ts";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// `Task:` の行でこのタスクを指したコミットが変えたファイル。取り込む前の worktree のブランチも見るため --all
export function committedFiles(id: string): string[] {
  const log = git(["log", "--all", "-i", "-E", `--grep=^Task:.*${id}([^0-9]|$)`, "--name-only", "--format="]);
  return (log ?? "").split("\n").filter(Boolean);
}

// `git status --porcelain` の 1 行のパス。git() が出力を trim するので、先頭の行は状態の列の空白が欠けている。名前の変更は変更後を取る
function changedPath(line: string): string {
  const path = line.replace(/^\s*\S{1,2}\s+/, "");
  return path.split(" -> ").at(-1) ?? path;
}

export function readGit(limit = 8): GitInfo {
  const branch = git(["branch", "--show-current"]) || null;
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  const log = git(["log", `-${limit}`, "--format=%h%x09%cs%x09%s"]);
  const commits = (log ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", date = "", subject = ""] = line.split("\t");
      return { hash, date, subject };
    });
  const changed = (status ?? "").split("\n").filter(Boolean);
  return {
    branch,
    dirty: changed.length,
    uncommittedDecisions: changed.map(changedPath).filter((file) => file.startsWith("docs/decisions/")),
    commits,
  };
}
