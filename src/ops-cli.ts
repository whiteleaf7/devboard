// ボードへの操作を当てる（`devboard apply '<JSON の配列>'`）。形は ops.ts
//   例: devboard apply '[{"op":"update_task","args":{"id":"T-012","status":"done","note":"確かめた"}}]'

import { applyOps } from "./ops.ts";

const [json] = process.argv.slice(2);
try {
  const ops: unknown = JSON.parse(json ?? "");
  if (!Array.isArray(ops)) throw new Error("操作は JSON の配列で渡す");
  console.log(JSON.stringify({ ids: applyOps(ops) }));
} catch (e) {
  console.error(`devboard apply: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
