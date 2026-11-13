import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown } from "../public/markdown.js";

const text = (t: string) => ({ type: "text", text: t });
const para = (...lines: string[]) => ({ type: "paragraph", lines: lines.map((l) => [text(l)]) });

test("段落は空行で分け、段落の中の改行は行として残す", () => {
  assert.deepEqual(parseMarkdown("一行目\n二行目\n\n次の段落"), [para("一行目", "二行目"), para("次の段落")]);
});

test("決定記録の形（見出し・箇条書き・入れ子）を解析する", () => {
  const md = [
    "# 0003. 構成",
    "",
    "- 状態: 採用",
    "- 見直す条件:",
    "  - Bun で動かない",
    "  - 不安定",
    "",
    "## 背景",
    "本文",
  ].join("\n");
  assert.deepEqual(parseMarkdown(md), [
    { type: "heading", level: 1, content: [text("0003. 構成")] },
    {
      type: "list",
      ordered: false,
      items: [
        [para("状態: 採用")],
        [para("見直す条件:"), { type: "list", ordered: false, items: [[para("Bun で動かない")], [para("不安定")]] }],
      ],
    },
    { type: "heading", level: 2, content: [text("背景")] },
    para("本文"),
  ]);
});

test("番号付きリストと箇条書きが続いたら別のリストにする", () => {
  const blocks = parseMarkdown("1. 一\n2. 二\n- 点");
  assert.deepEqual(
    blocks.map((b) => b.type === "list" && [b.ordered, b.items.length]),
    [
      [true, 2],
      [false, 1],
    ],
  );
});

test("項目の後ろの字下げしていない行は、その項目の続きとして扱う", () => {
  assert.deepEqual(parseMarkdown("- 項目\n続き"), [{ type: "list", ordered: false, items: [[para("項目", "続き")]] }]);
});

test("引用・コードブロック・区切り線", () => {
  assert.deepEqual(parseMarkdown("> 依頼\n> 二行目\n\n```\n- リストにしない\n```\n---"), [
    { type: "quote", children: [para("依頼", "二行目")] },
    { type: "code", text: "- リストにしない" },
    { type: "rule" },
  ]);
});

test("閉じていないコードブロックは最後までをコードにする", () => {
  assert.deepEqual(parseMarkdown("```\na\nb"), [{ type: "code", text: "a\nb" }]);
});

test("インラインのコード・太字・リンクを解析し、http(s) 以外のリンクは文字のまま残す", () => {
  assert.deepEqual(parseInline("`pnpm test` を **必ず** 通す [docs](https://example.com) [x](javascript:alert(1))"), [
    { type: "code", text: "pnpm test" },
    text(" を "),
    { type: "strong", children: [text("必ず")] },
    text(" 通す "),
    { type: "link", href: "https://example.com", children: [text("docs")] },
    text(" [x](javascript:alert(1))"),
  ]);
});

test("コードの中の記号は解釈しない", () => {
  assert.deepEqual(parseInline("`**a**`"), [{ type: "code", text: "**a**" }]);
});
