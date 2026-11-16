// ボードの写しを SQLite のファイルとして書き出す（`devboard snapshot <出力ファイル>`）。バックアップや、ボードを複製して試すときに使う。
// 書き込み中のボードからでも、一貫した状態の写しが取れる（VACUUM INTO）

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { board } from "./board-db.ts";

const [target] = process.argv.slice(2);
if (!target) {
  console.error("使い方: devboard snapshot <出力ファイル>");
  process.exit(1);
}
const file = resolve(target);
if (existsSync(file)) {
  console.error(`devboard snapshot: ${file} はもうある。別のファイル名にする`);
  process.exit(1);
}
board().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
console.log(file);
