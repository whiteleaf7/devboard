// 過去の記録を探す。ルートの `pnpm recall [--json] [--limit 件数] <質問>` から呼ぶ。

import { parseArgs } from "node:util";
import { buildDocs, recall } from "./recall.ts";
import { readDecisions, readLessons, readTasks } from "./store.ts";

const { values, positionals } = parseArgs({
  options: { json: { type: "boolean", default: false }, limit: { type: "string", default: "5" } },
  allowPositionals: true,
});
const query = positionals.join(" ").trim();
if (!query) {
  console.error("使い方: pnpm recall [--json] [--limit 件数] <質問>");
  process.exit(1);
}

const results = recall(query, buildDocs(readTasks().tasks, readDecisions(), readLessons().lessons), Number(values.limit) || 5);
if (values.json) console.log(JSON.stringify({ results }, null, 2));
else if (results.length === 0) console.log("関係する記録は見つからなかった");
else for (const hit of results) console.log(`${hit.id}  ${hit.title}\n    ${hit.excerpt}`);
