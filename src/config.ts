// プロジェクトごとの設定。プロジェクトの根の .devboard.json（任意）から読む。
// devboard は全プロジェクトで共有するので、特定のプロジェクトの名前や場所はコードに持たず、ここで受け取る

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { repoRoot, scopedRoot } from "./repo-root.ts";

export const CONFIG_FILE = ".devboard.json";

export const ProjectConfig = z.strictObject({
  // 決定記録を置くディレクトリ（プロジェクトの根からの相対）
  decisionsDir: z.string().min(1).default("docs/decisions"),
  // recall が、触ったタスクの説明・メモ・結び付いた教訓の本文を返さないパスの接頭辞（最終評価用の資料など、見せたくないもの）
  hiddenPaths: z.array(z.string().min(1)).default([]),
  rules: z
    .strictObject({
      // autodev: 書き込みの決まり（メモの無い done、AI のタスクの review など）を使う。none: 使わない
      profile: z.enum(["autodev", "none"]).default("autodev"),
      // 「動かした: `コマンド` → 結果」の書き方の案内の続き。プロジェクトの確かめる手段（文書や道具の名前）を書く
      verificationHint: z.string().default(""),
    })
    .default({ profile: "autodev", verificationHint: "" }),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

const cache = new Map<string, { stamp: string; config: ProjectConfig }>();

// 設定は、コマンドを打った場所から上へたどって最初に見つかったものを使う（linked worktree では、その作業ブランチの設定になる）。
// 見つからなければ、プロジェクトの根（main の worktree）のもの。DEVBOARD_ROOT で場所を指しているときと、
// ダッシュボードがほかのプロジェクトを見せているとき（inProject）は、そこだけを見る
function configFile(): string {
  const atRoot = join(repoRoot(), CONFIG_FILE);
  if (scopedRoot() ?? process.env.DEVBOARD_ROOT ?? process.env.NAGAYA_ROOT) return atRoot;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return atRoot;
  }
}

export function readConfig(): ProjectConfig {
  const file = configFile();
  if (!existsSync(file)) return ProjectConfig.parse({});
  const { mtimeMs, size } = statSync(file);
  const stamp = `${mtimeMs}:${size}`;
  const cached = cache.get(file);
  if (cached?.stamp === stamp) return cached.config;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} が JSON として読めない。{"decisionsDir": "docs/decisions", "hiddenPaths": [], "rules": {"profile": "autodev"}} のような形にする`);
  }
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} の中身が違う\n${z.prettifyError(parsed.error)}`);
  cache.set(file, { stamp, config: parsed.data });
  return parsed.data;
}

// 決定記録のディレクトリの、プロジェクトの根からの相対パス（末尾の / は除く）。ファイルの表示や git の変更の判定に使う
export const decisionsRelativeDir = (): string => readConfig().decisionsDir.replace(/\/+$/, "");
