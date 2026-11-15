// テスト用の一時的なボード（SQLite）と、決定記録を置く一時的なリポジトリの根。store を import する前に呼ぶ
import { mkdtempSync, rmSync } from "node:fs";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useTempBoard(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `autodev-${name}-`));
  after(() => rmSync(root, { recursive: true, force: true }));
  process.env.DEVBOARD_ROOT = root;
  process.env.DEVBOARD_DB = join(root, "board.sqlite");
  return root;
}
