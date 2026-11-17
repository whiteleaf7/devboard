// 教訓のうち、引き金（trigger）が差分に当たったものだけを、確かめることの一覧にする。
// 過去の失敗を覚えておかなくても、同じ所を変えたときに出てくるようにするため。止めはしない（出すだけ）

import { pathsOverlap } from "./paths.ts";
import type { Lesson } from "./schema.ts";

// 変えたファイルと、その中で足した・消した行。着手のときのように行が無いものは、パスだけで当てる
export type ChangedFile = { path: string; lines: string[] };

export type ChecklistItem = {
  id: string;
  title: string;
  check: string;
  // どのファイル（と、どの語）で当たったか
  matched: { path: string; word: string | null };
};

// git diff（unified）の出力を、ファイルごとの変えた行に分ける。パスは diff --git の行の b/ の側（名前を変えたら新しい名前）。
// 最初の @@ より前の --- と +++ はファイルの見出しなので数えない（中身の行も -- や ++ で始まりうるので、位置で見分ける）
export function parseDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  let inHeader = false;
  for (const line of diff.split("\n")) {
    const header = /^diff --git .*? "?b\/(.+?)"?$/.exec(line);
    if (header) {
      current = { path: header[1]!, lines: [] };
      files.push(current);
      inHeader = true;
    } else if (!current) continue;
    else if (line.startsWith("@@")) inHeader = false;
    else if (!inHeader && (line.startsWith("+") || line.startsWith("-"))) current.lines.push(line.slice(1));
  }
  return files;
}

function matchOne(trigger: NonNullable<Lesson["trigger"]>, file: ChangedFile): ChecklistItem["matched"] | null {
  if (trigger.paths.length && !trigger.paths.some((p) => pathsOverlap(p, file.path))) return null;
  if (!trigger.words.length) return { path: file.path, word: null };
  const text = file.lines.join("\n").toLowerCase();
  const word = trigger.words.find((w) => text.includes(w.toLowerCase()));
  return word === undefined ? null : { path: file.path, word };
}

export function matchLessons(lessons: Lesson[], files: ChangedFile[]): ChecklistItem[] {
  return lessons.flatMap((lesson) => {
    if (!lesson.trigger) return [];
    for (const file of files) {
      const matched = matchOne(lesson.trigger, file);
      if (matched) return [{ id: lesson.id, title: lesson.title, check: lesson.trigger.check, matched }];
    }
    return [];
  });
}

export function formatChecklist(items: ChecklistItem[]): string {
  if (!items.length) return "";
  return [
    `差分に当たった教訓 ${items.length} 件。取り込む前に確かめる（devboard checklist）:`,
    ...items.map(({ id, title, check, matched }) => {
      const where = matched.word ? `${matched.path} の「${matched.word}」` : matched.path;
      return `- ${id} ${title}（${where}）\n  確かめる: ${check}`;
    }),
  ].join("\n");
}
