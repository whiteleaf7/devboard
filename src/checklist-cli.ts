// 差分に当たった教訓を出す（`devboard checklist`）。当たらなければ何も出さない。止めはしないので、いつも終了コード 0。
//   git diff --cached | devboard checklist [--json]   標準入力の差分（unified）の、変えたファイルと行で当てる
//   devboard checklist [--json] <パス>...              パスの接頭辞だけで当てる（着手のときのタスクの paths など）

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatChecklist, matchLessons, parseDiff, type ChangedFile } from "./checklist.ts";
import { readLessons } from "./store.ts";

const USAGE = "使い方: git diff | devboard checklist [--json]  または  devboard checklist [--json] <パス>...";

const { values, positionals } = parseArgs({
  options: { json: { type: "boolean", default: false } },
  allowPositionals: true,
});

if (!positionals.length && process.stdin.isTTY) {
  console.error(USAGE);
  process.exit(1);
}
const files: ChangedFile[] = positionals.length
  ? positionals.map((path) => ({ path, lines: [] }))
  : parseDiff(readFileSync(0, "utf8"));
const items = matchLessons(readLessons().lessons, files);
if (values.json) console.log(JSON.stringify({ lessons: items }, null, 2));
else if (items.length) console.log(formatChecklist(items));
