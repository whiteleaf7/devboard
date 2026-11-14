// 決定記録（リポジトリの docs/decisions/NNNN-slug.md）を読み書きする

import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "./lock.ts";
import { repoRoot } from "./repo-root.ts";
import type { DECISION_STATUSES, Decision } from "./schema.ts";

export const decisionsDir = () => join(repoRoot(), "docs", "decisions");

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 書きかけのファイルを読まれないよう、一時ファイルに書いてから rename する
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// 番号を決めてから書くまでを、ほかのプロセスと 1 つずつ行う
function lockedDecisions<T>(fn: () => T): T {
  const dir = join(repoRoot(), ".dev");
  mkdirSync(dir, { recursive: true });
  return withLock(join(dir, "decisions.lock"), fn);
}

// 先頭にある「# NNNN. タイトル」「- 状態: 」「- 日付: 」を読む
function parseDecision(file: string, text: string): Decision {
  const number = Number(/^(\d{4})-/.exec(file)?.[1] ?? NaN);
  const title = /^#\s*\d{4}\.\s*(.+)$/m.exec(text)?.[1]?.trim() ?? file;
  const status = /^-\s*状態:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "不明";
  const date = /^-\s*日付:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  return { number, file: `docs/decisions/${file}`, title, status, date, body: text };
}

export function readDecisions(): Decision[] {
  const dir = decisionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .sort()
    .map((f) => parseDecision(f, readFileSync(join(dir, f), "utf8")));
}

export type NewDecision = {
  title: string;
  slug: string;
  status?: (typeof DECISION_STATUSES)[number];
  context: string;
  decision: string;
  consequences: string;
};

export function createDecision(input: NewDecision): Decision {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) {
    throw new Error("slug は英小文字・数字・ハイフンだけにする（例: app-architecture）");
  }
  const body = [
    `- 状態: ${input.status ?? "提案"}`,
    `- 日付: ${today()}`,
    "",
    "## 背景",
    "",
    input.context.trim(),
    "",
    "## 決定",
    "",
    input.decision.trim(),
    "",
    "## 影響",
    "",
    input.consequences.trim(),
    "",
  ].join("\n");
  return lockedDecisions(() => {
    const dir = decisionsDir();
    mkdirSync(dir, { recursive: true });
    const numbers = readDecisions().map((d) => d.number);
    const nnnn = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(4, "0");
    const file = `${nnnn}-${input.slug}.md`;
    const text = `# ${nnnn}. ${input.title}\n\n${body}`;
    writeAtomic(join(dir, file), text);
    return parseDecision(file, text);
  });
}

export function setDecisionStatus(number: number, status: (typeof DECISION_STATUSES)[number]): Decision {
  return lockedDecisions(() => {
    const d = readDecisions().find((x) => x.number === number);
    if (!d) throw new Error(`決定記録 ${number} は存在しない`);
    if (!/^-\s*状態:.*$/m.test(d.body)) throw new Error(`${d.file} に「- 状態:」の行がない`);
    const text = d.body.replace(/^-\s*状態:.*$/m, `- 状態: ${status}`);
    const name = d.file.replace(/^docs\/decisions\//, "");
    writeAtomic(join(decisionsDir(), name), text);
    return parseDecision(name, text);
  });
}
