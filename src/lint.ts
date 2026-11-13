// ボードの問題を探す。タスクの決まりは rules.ts（書く時点でも同じものを使う）、決定記録はリポジトリのファイルの形式を見る。
// 決定記録は手で書くこともあるので、ゲート（tools/harness の records の検査）と get_overview の両方からこれを使う

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ruleProblems } from "./rules.ts";
import { DECISION_STATUSES, paths, readProject, readTasks } from "./store.ts";

export type BoardFile = { file: string; text: string };
export type BoardProblem = { check: string; file: string; message: string };

export function lintDecisions(decisions: BoardFile[]): BoardProblem[] {
  const problems: BoardProblem[] = [];
  const numbers = new Map<string, string>();
  for (const { file, text } of decisions) {
    const add = (message: string) => problems.push({ check: "invalid-decision", file, message });
    const name = file.split("/").pop() ?? file;
    const number = /^(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.md$/.exec(name)?.[1];
    if (!number) {
      add("ファイル名は NNNN-slug.md（英小文字・数字・ハイフン）にする");
      continue;
    }
    const other = numbers.get(number);
    if (other) add(`番号 ${number} が ${other} と重複している`);
    else numbers.set(number, file);

    const heading = /^#\s*(\d{4})\.\s*\S/m.exec(text)?.[1];
    if (!heading) add("先頭に「# NNNN. タイトル」の見出しが無い");
    else if (heading !== number) add(`見出しの番号（${heading}）がファイル名（${number}）と合わない`);

    const status = /^-\s*状態:\s*(.*)$/m.exec(text)?.[1]?.trim();
    if (status === undefined) add("「- 状態:」の行が無い");
    else if (!(DECISION_STATUSES as readonly string[]).includes(status)) add(`状態「${status}」は使えない（${DECISION_STATUSES.join("・")}）`);
    if (!/^-\s*日付:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(text)) add("「- 日付: YYYY-MM-DD」の行が無い");
    for (const section of ["背景", "決定", "影響"]) {
      if (!new RegExp(`^##\\s*${section}\\s*$`, "m").test(text)) add(`「## ${section}」の見出しが無い`);
    }
  }
  return problems;
}

export function boardProblems(): BoardProblem[] {
  const dir = paths.decisions();
  const decisions = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => ({ file: `docs/decisions/${name}`, text: readFileSync(join(dir, name), "utf8") }))
    : [];
  const { tasks, errors } = readTasks();
  const milestones = new Set(readProject().milestones.map((m) => m.id));
  return [
    ...errors.map((message) => ({ check: "invalid-task", file: "board", message })),
    ...ruleProblems(tasks, milestones).map(({ task, check, message }) => ({ check, file: task, message })),
    ...lintDecisions(decisions),
  ];
}
