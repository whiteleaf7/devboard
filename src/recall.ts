// 過去の記録（タスク・決定記録・教訓）から、質問に関係の深いものを探す。
// 日本語は単語に分けず、2 文字ずつの組で突き合わせる（辞書も外部のサービスも使わない）。

import type { Decision, Lesson, Task } from "./store.ts";

export type RecallDoc = { id: string; kind: "task" | "decision" | "lesson"; title: string; body: string };
export type RecallHit = { id: string; kind: RecallDoc["kind"]; title: string; score: number; excerpt: string };

// BM25 の定数
const K1 = 1.2;
const B = 0.75;
// タイトルの語は、本文の語より重く数える
const TITLE_WEIGHT = 3;
// ひらがなだけの組（助詞や活用）は、内容を表さないので軽くする
const KANA_ONLY_WEIGHT = 0.3;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.normalize("NFKC").toLowerCase().match(/[a-z0-9]+|[\p{L}\p{N}ー]+/gu) ?? []) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length > 1) tokens.push(run);
    } else if (run.length === 1) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

export function buildDocs(tasks: Task[], decisions: Decision[], lessons: Lesson[]): RecallDoc[] {
  return [
    ...tasks.map((t): RecallDoc => ({
      id: t.id,
      kind: "task",
      title: t.title,
      body: [t.description, ...t.notes.map((n) => n.text), t.labels.join(" ")].join("\n"),
    })),
    ...decisions.map((d): RecallDoc => ({ id: `D-${String(d.number).padStart(4, "0")}`, kind: "decision", title: d.title, body: d.body })),
    ...lessons.map((l): RecallDoc => ({ id: l.id, kind: "lesson", title: l.title, body: [l.problem, l.cause, l.fix, l.tags.join(" ")].join("\n") })),
  ];
}

export function recall(query: string, docs: RecallDoc[], limit = 5): RecallHit[] {
  const indexed = docs.map((doc) => {
    const title = tokenize(doc.title);
    const tokens = [...Array.from({ length: TITLE_WEIGHT }, () => title).flat(), ...tokenize(doc.body)];
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { doc, counts, length: tokens.length };
  });
  const average = indexed.reduce((sum, d) => sum + d.length, 0) / (indexed.length || 1);
  const terms = [...new Set(tokenize(query))].map((term) => {
    const containing = indexed.filter((d) => d.counts.has(term)).length;
    const idf = Math.log(1 + (indexed.length - containing + 0.5) / (containing + 0.5));
    return { term, weight: idf * (/^[ぁ-ゖ]+$/.test(term) ? KANA_ONLY_WEIGHT : 1) };
  });

  return indexed
    .map(({ doc, counts, length }) => {
      const score = terms.reduce((sum, { term, weight }) => {
        const count = counts.get(term) ?? 0;
        return sum + (weight * count * (K1 + 1)) / (count + K1 * (1 - B + (B * length) / average));
      }, 0);
      return { id: doc.id, kind: doc.kind, title: doc.title, score: Math.round(score * 100) / 100, excerpt: excerpt(doc.body, terms) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// 質問の語をいちばん多く含む行
function excerpt(body: string, terms: { term: string; weight: number }[]): string {
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const scored = lines.map((line) => {
    const tokens = new Set(tokenize(line));
    return { line, score: terms.reduce((sum, { term, weight }) => sum + (tokens.has(term) ? weight : 0), 0) };
  });
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return (best?.line ?? "").slice(0, 160);
}
