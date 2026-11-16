// MCP サーバ（mcp.ts）が登録しているツールの名前。ドキュメントや設定が指すツールが実在するかを、外から確かめるのに使う

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function toolNamesIn(source: string): string[] {
  return [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]!);
}

export const toolNames = () => toolNamesIn(readFileSync(join(import.meta.dirname, "mcp.ts"), "utf8"));
