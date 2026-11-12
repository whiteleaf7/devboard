// タスクの説明と決定記録を画面で読みやすくするための、小さな Markdown の解析器。
// ボードで実際に使う書き方（見出し・段落・箇条書きと入れ子・引用・コードブロック・区切り線、
// インラインのコード・太字・リンク）だけを扱う。HTML は解釈せず、描画側で DOM を組み立てる。

/**
 * @typedef {{ type: "text", text: string }
 *   | { type: "code", text: string }
 *   | { type: "strong", children: Inline[] }
 *   | { type: "link", href: string, children: Inline[] }} Inline
 * @typedef {{ type: "heading", level: number, content: Inline[] }
 *   | { type: "paragraph", lines: Inline[][] }
 *   | { type: "list", ordered: boolean, items: Block[][] }
 *   | { type: "quote", children: Block[] }
 *   | { type: "code", text: string }
 *   | { type: "rule" }} Block
 */

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** @param {string} line */
const indentOf = (line) => /^\s*/.exec(line)?.[0].length ?? 0;
/** @param {string} line */
const isBlank = (line) => line.trim() === "";
/** @param {string} line */
const startsBlock = (line) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);

/**
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

/**
 * @param {string[]} lines
 * @returns {Block[]}
 */
function parseBlocks(lines) {
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      i++;
    } else if (FENCE.test(line)) {
      const end = lines.findIndex((l, j) => j > i && FENCE.test(l));
      const stop = end === -1 ? lines.length : end;
      blocks.push({ type: "code", text: lines.slice(i + 1, stop).join("\n") });
      i = stop + 1;
    } else if (HEADING.test(line)) {
      const [, marks = "", content = ""] = HEADING.exec(line) ?? [];
      blocks.push({ type: "heading", level: marks.length, content: parseInline(content) });
      i++;
    } else if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
    } else if (QUOTE.test(line)) {
      const start = i;
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) i++;
      blocks.push({ type: "quote", children: parseBlocks(lines.slice(start, i).map((l) => l.replace(QUOTE, ""))) });
    } else if (LIST_ITEM.test(line)) {
      i = parseList(lines, i, blocks);
    } else {
      const start = i;
      i++;
      while (i < lines.length && !isBlank(lines[i] ?? "") && !startsBlock(lines[i] ?? "")) i++;
      blocks.push({ type: "paragraph", lines: lines.slice(start, i).map((l) => parseInline(l.trim())) });
    }
  }
  return blocks;
}

/**
 * 同じ深さの項目が続くあいだを 1 つのリストにする。項目より深く字下げされた行は、その項目の中身として再帰的に解析する。
 * @param {string[]} lines
 * @param {number} start
 * @param {Block[]} blocks 解析したリストを足す先
 * @returns {number} リストの次の行
 */
function parseList(lines, start, blocks) {
  const base = indentOf(lines[start] ?? "");
  const ordered = /\d/.test(LIST_ITEM.exec(lines[start] ?? "")?.[2] ?? "");
  /** @type {Block[][]} */
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i] ?? "");
    if (!match || indentOf(lines[i] ?? "") !== base || /\d/.test(match[2] ?? "") !== ordered) break;
    const body = [match[3] ?? ""];
    i++;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (isBlank(line)) {
        const next = lines.slice(i).find((l) => !isBlank(l));
        if (next === undefined || indentOf(next) <= base) break;
        body.push("");
      } else if (indentOf(line) > base) {
        body.push(line.slice(Math.min(indentOf(line), base + 2)));
      } else if (!startsBlock(line)) {
        body.push(line.trim());
      } else {
        break;
      }
      i++;
    }
    items.push(parseBlocks(body));
  }
  blocks.push({ type: "list", ordered, items });
  return i;
}

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * @param {string} text
 * @returns {Inline[]}
 */
export function parseInline(text) {
  /** @type {Inline[]} */
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ type: "strong", children: parseInline(m[2]) });
    else out.push({ type: "link", href: m[4] ?? "", children: parseInline(m[3] ?? "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
