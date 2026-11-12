// ダッシュボードを（必要なら起動して）ブラウザで開く。
import { execFileSync } from "node:child_process";
import { ensureServer } from "./launcher.ts";

const { url, started } = await ensureServer();
console.log(`${started ? "起動した" : "起動済み"}: ${url}`);
execFileSync("open", [url]);
