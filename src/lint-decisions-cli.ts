// 決定記録の形式を検査する（`devboard lint-decisions`）。標準入力の JSON `[{"file": "docs/decisions/0001-x.md", "text": "本文"}]` を読み、
// 問題を JSON の配列で出す。問題があれば終了コード 1、入力が不正なら 2。ボードにもプロジェクトの場所にも触れないので、CI から使える

import { readFileSync } from "node:fs";
import { z } from "zod";
import { lintDecisions } from "./lint.ts";

const Input = z.array(z.object({ file: z.string(), text: z.string() }));

let input: unknown;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error('devboard lint-decisions: 標準入力が JSON ではない。[{"file": "docs/decisions/0001-x.md", "text": "本文"}] の形で渡す');
  process.exit(2);
}
const parsed = Input.safeParse(input);
if (!parsed.success) {
  console.error(`devboard lint-decisions: 入力の形が違う\n${z.prettifyError(parsed.error)}`);
  process.exit(2);
}
const problems = lintDecisions(parsed.data);
console.log(JSON.stringify(problems));
process.exit(problems.length ? 1 : 0);
