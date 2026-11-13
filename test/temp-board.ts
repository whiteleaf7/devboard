// テスト用の一時的なボード（SQLite）と、決定記録を置く一時的なリポジトリの根。store を import する前に呼ぶ
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useTempBoard(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `nagaya-${name}-`));
  process.env.NAGAYA_ROOT = root;
  process.env.NAGAYA_BOARD = join(root, "board.sqlite");
  return root;
}
