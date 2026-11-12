// Tailscale でダッシュボードを tailnet 内（スマホなど）に公開する。
// サーバは 127.0.0.1 で待ち受けたまま、`tailscale serve` に HTTPS で中継させる。
//
//   pnpm board:tailscale       ダッシュボードを起動し、tailscale serve で公開して URL を出す
//   pnpm board:tailscale off   公開をやめる（ダッシュボードは止めない）
//
// 既存の serve 設定を壊さないよう、専用の HTTPS ポート（既定 8448、NAGAYA_DEV_TS_PORT で変更）だけを使う。

import { execFileSync } from "node:child_process";
import { tailscaleCli, tailnetName } from "./tailnet.ts";

// fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
export const tsPort = () => Number(process.env.NAGAYA_DEV_TS_PORT ?? 8448);

if (import.meta.main) {
  const cli = tailscaleCli();
  if (!cli) {
    console.error("tailscale が見つからない。Tailscale をインストールしてログインする");
    process.exit(1);
  }
  const name = tailnetName();
  if (!name) {
    console.error("Tailscale が動いていない。アプリを起動してログインする");
    process.exit(1);
  }
  const port = tsPort();
  if (process.argv[2] === "off") {
    execFileSync(cli, ["serve", `--https=${port}`, "off"], { stdio: "inherit" });
    console.log(`公開をやめた: https://${name}:${port}/`);
  } else {
    const { ensureServer } = await import("./launcher.ts");
    const { url, started } = await ensureServer();
    // ダッシュボードが Tailscale より先に起動していると ts.net の Host を許可していない。そのときは起動し直す
    if (!started) {
      const res = await fetch(new URL("/api/hosts", url)).catch(() => null);
      const hosts = res?.ok ? ((await res.json()) as string[]) : [];
      if (!hosts.includes(name)) {
        console.error(`起動中のダッシュボードは ${name} を許可していない。止めてから、もう一度実行する`);
        process.exit(1);
      }
    }
    const target = new URL(url);
    execFileSync(cli, ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${target.port}`], { stdio: "inherit" });
    console.log(`\ntailnet 内の端末から開く: https://${name}:${port}/`);
  }
}
