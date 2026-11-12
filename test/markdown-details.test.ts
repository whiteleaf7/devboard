// Markdown の解析器の、境目の振る舞い（見出し・区切り線・リストの続き・引用・コード・インライン）を確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown } from "../public/markdown.js";

const text = (t: string) => ({ type: "text", text: t });
const para = (...lines: string[]) => ({ type: "paragraph", lines: lines.map((l) => [text(l)]) });
const list = (ordered: boolean, ...items: unknown[][]) => ({ type: "list", ordered, items });

test("見出しは # が 1〜6 個で、後ろに空白があるものだけ", () => {
  assert.deepEqual(parseMarkdown("### 三つ ###"), [{ type: "heading", level: 3, content: [text("三つ")] }]);
  assert.deepEqual(parseMarkdown("###### 六つ"), [{ type: "heading", level: 6, content: [text("六つ")] }]);
  assert.deepEqual(parseMarkdown("####### 七つ"), [para("####### 七つ")]);
  assert.deepEqual(parseMarkdown("#空白なし"), [para("#空白なし")]);
  assert.deepEqual(parseMarkdown("# `code` の見出し"), [{ type: "heading", level: 1, content: [{ type: "code", text: "code" }, text(" の見出し")] }]);
});

test("区切り線は、同じ記号が 3 つ以上", () => {
  for (const rule of ["***", "- - -", "___", "  -----  "]) assert.deepEqual(parseMarkdown(rule), [{ type: "rule" }], rule);
  assert.deepEqual(parseMarkdown("--"), [para("--")]);
  assert.deepEqual(parseMarkdown("-*-"), [para("-*-")]);
});

test("リストは記号の種類で分け、字下げで入れ子にする", () => {
  assert.deepEqual(parseMarkdown("1) 一\n2) 二"), [list(true, [para("一")], [para("二")])]);
  assert.deepEqual(parseMarkdown("* 一\n+ 二\n- 三"), [list(false, [para("一")], [para("二")], [para("三")])]);
  assert.deepEqual(parseMarkdown("- 親\n    - 深い子"), [list(false, [para("親"), list(false, [para("深い子")])])]);
  assert.deepEqual(parseMarkdown("- 親\n  1. 子"), [list(false, [para("親"), list(true, [para("子")])])]);
  assert.deepEqual(parseMarkdown("  - 字下げした項目\n  - 次"), [list(false, [para("字下げした項目")], [para("次")])]);
});

test("項目は、空行のあとの字下げした行までを含み、字下げの無い行で終わる", () => {
  assert.deepEqual(parseMarkdown("- 一\n\n  続き\n- 二"), [list(false, [para("一"), para("続き")], [para("二")])]);
  assert.deepEqual(parseMarkdown("- 一\n\n段落"), [list(false, [para("一")]), para("段落")]);
  assert.deepEqual(parseMarkdown("- 一\n\n"), [list(false, [para("一")])]);
  assert.deepEqual(parseMarkdown("- 一\n# 見出し"), [list(false, [para("一")]), { type: "heading", level: 1, content: [text("見出し")] }]);
  assert.deepEqual(parseMarkdown("本文\n- 項目"), [para("本文"), list(false, [para("項目")])]);
});

test("引用の中も解析し、コードブロックの中は解析しない", () => {
  assert.deepEqual(parseMarkdown("> - 一\n> - 二"), [{ type: "quote", children: [list(false, [para("一")], [para("二")])] }]);
  assert.deepEqual(parseMarkdown(">空白なし\n本文"), [{ type: "quote", children: [para("空白なし")] }, para("本文")]);
  assert.deepEqual(parseMarkdown("本文\n> 引用"), [para("本文"), { type: "quote", children: [para("引用")] }]);
  assert.deepEqual(parseMarkdown("```ts\nconst a = 1;\n# 見出しではない\n```\n後ろ"), [{ type: "code", text: "const a = 1;\n# 見出しではない" }, para("後ろ")]);
  assert.deepEqual(parseMarkdown("  ```\n  x\n  ```"), [{ type: "code", text: "  x" }]);
  assert.deepEqual(parseMarkdown("```\n```\n```\n二つ目\n```"), [{ type: "code", text: "" }, { type: "code", text: "二つ目" }]);
});

test("改行コードの違いと、空の入力を扱う", () => {
  assert.deepEqual(parseMarkdown("一\r\n二\r三"), [para("一", "二", "三")]);
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n \n\t\n"), []);
  assert.deepEqual(parseMarkdown("  前後の空白は落とす  "), [para("前後の空白は落とす")]);
});

test("インラインは、コード・太字・リンクを入れ子で解析する", () => {
  assert.deepEqual(parseInline("a `b` c `d`"), [text("a "), { type: "code", text: "b" }, text(" c "), { type: "code", text: "d" }]);
  assert.deepEqual(parseInline("**a `b`**"), [{ type: "strong", children: [text("a "), { type: "code", text: "b" }] }]);
  assert.deepEqual(parseInline("[**x**](https://e.com/a?b=1) 後ろ"), [
    { type: "link", href: "https://e.com/a?b=1", children: [{ type: "strong", children: [text("x")] }] },
    text(" 後ろ"),
  ]);
  assert.deepEqual(parseInline("[a](http://e.com)"), [{ type: "link", href: "http://e.com", children: [text("a")] }]);
  assert.deepEqual(parseInline("[a](ftp://e.com) と **未閉じ"), [text("[a](ftp://e.com) と **未閉じ")]);
  assert.deepEqual(parseInline("**一** と **二**"), [{ type: "strong", children: [text("一")] }, text(" と "), { type: "strong", children: [text("二")] }]);
  assert.deepEqual(parseInline(""), []);
});
