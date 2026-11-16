#!/usr/bin/env node
// devboard コマンドの入口。サブコマンドに対応するスクリプトを、このコマンドを打った場所のまま起動する

import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolveCommand } from "../src/commands.ts";

const resolved = resolveCommand(process.argv.slice(2));
if (!resolved.ok) {
  (resolved.help ? console.log : console.error)(resolved.message);
  process.exit(resolved.help ? 0 : 2);
}

const child = spawn(process.execPath, [join(import.meta.dirname, "../src", resolved.script), ...resolved.args], {
  stdio: "inherit",
});
// MCP サーバのように長く動くものを、入口が先に終わっても取り残さない
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
