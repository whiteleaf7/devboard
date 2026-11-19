// ダッシュボードが切り替えて見せるプロジェクト。ボードのディレクトリ（board-db.ts の boardsDir）に並ぶボードのうち、
// 隣の <名前>.root にリポジトリの場所が書いてあり、その場所が今もあるもの。
// 場所は、そのプロジェクトで devboard（MCP・apply・show・start など）を一度でも使うと書かれる

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { boardsDir, rootFileOf } from "./board-db.ts";
import { inProject, repoRoot } from "./repo-root.ts";
import { readProject } from "./store.ts";

// id はボードのファイルの名前（= リポジトリのディレクトリの名前）。画面の URL の ?project= に使う
export type ProjectEntry = { id: string; name: string; home: boolean };

// ほかのプロジェクトの id から、リポジトリの場所。ボードのディレクトリが無ければ空
export function knownRoots(): Map<string, string> {
  const roots = new Map<string, string>();
  let files: string[];
  try {
    files = readdirSync(boardsDir());
  } catch {
    return roots;
  }
  for (const file of files) {
    const id = /^(.+)\.sqlite$/.exec(file)?.[1];
    if (!id) continue;
    let root: string;
    try {
      root = readFileSync(rootFileOf(join(boardsDir(), file)), "utf8").trim();
    } catch {
      continue;
    }
    // ボードはディレクトリの名前で決まるので、名前の合わない場所（書いたあとに移したものなど）は使わない
    if (isAbsolute(root) && basename(root) === id && existsSync(root)) roots.set(id, root);
  }
  return roots;
}

// 名前が読めないボードも一覧からは落とさず、id で出す
function nameOf(id: string): string {
  try {
    return readProject().name || id;
  } catch {
    return id;
  }
}

// 先頭は、ダッシュボードを起動したプロジェクト（home）。ほかは id の順
export function listProjects(): ProjectEntry[] {
  const home = basename(repoRoot());
  const others = [...knownRoots()]
    .filter(([id]) => id !== home)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, root]) => ({ id, name: inProject(root, () => nameOf(id)), home: false }));
  return [{ id: home, name: nameOf(home), home: true }, ...others];
}
