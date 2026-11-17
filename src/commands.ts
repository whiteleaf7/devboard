// devboard コマンドのサブコマンドと、それを実行するスクリプトの対応

const COMMANDS = {
  start: { script: "server.ts", summary: "ダッシュボードを前面で起動する" },
  open: { script: "open.ts", summary: "ダッシュボードを裏で起動して、ブラウザで開く" },
  tailscale: { script: "tailscale.ts", summary: "ダッシュボードを Tailscale で公開して URL を出す（off で公開をやめる）" },
  mcp: { script: "mcp.ts", summary: "MCP サーバ（stdio）を起動する" },
  show: { script: "board-cli.ts", summary: "ボードを読む（overview・tasks・task・decisions・decision）" },
  apply: { script: "ops-cli.ts", summary: "ボードに操作の JSON の配列を当てる" },
  recall: { script: "recall-cli.ts", summary: "過去のタスク・決定記録・教訓を探す" },
  checklist: { script: "checklist-cli.ts", summary: "差分（標準入力）かパスに引き金が当たった教訓を出す" },
  snapshot: { script: "snapshot-cli.ts", summary: "ボードの写しを SQLite のファイルとして書き出す" },
  tools: { script: "tools-cli.ts", summary: "MCP のツールの名前を JSON の配列で出す" },
  "lint-decisions": { script: "lint-decisions-cli.ts", summary: "標準入力の決定記録（JSON）の形式を検査して、問題を JSON で出す" },
  "import-history": { script: "board-import.ts", summary: "git の履歴にある古いボードを、空の SQLite のボードに取り込む" },
} as const;

export const USAGE = [
  "使い方: devboard <コマンド> [引数...]",
  "プロジェクトは、コマンドを打った場所の git の main の worktree。DEVBOARD_ROOT で別の場所を指せる",
  "",
  ...Object.entries(COMMANDS).map(([name, { summary }]) => `  ${name.padEnd(15)}${summary}`),
].join("\n");

export type Resolved = { ok: true; script: string; args: string[] } | { ok: false; message: string; help: boolean };

export function resolveCommand(argv: readonly string[]): Resolved {
  const [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "-h" || name === "--help") {
    return { ok: false, message: USAGE, help: true };
  }
  if (!Object.hasOwn(COMMANDS, name)) {
    return { ok: false, message: `${name} というコマンドは無い\n\n${USAGE}`, help: false };
  }
  return { ok: true, script: COMMANDS[name as keyof typeof COMMANDS].script, args };
}
