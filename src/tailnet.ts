// tailscale の CLI と、この端末の tailnet 上の名前を調べる。server.ts と tailscale.ts が使う。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function tailscaleCli(): string | null {
  try {
    execFileSync("tailscale", ["version"], { stdio: "ignore" });
    return "tailscale";
  } catch {
    return existsSync(APP_CLI) ? APP_CLI : null;
  }
}

// この端末の tailnet 上の名前（例: host.tailnet.ts.net）。Tailscale が無い・止まっているときは null
export function tailnetName(): string | null {
  const cli = tailscaleCli();
  if (!cli) return null;
  try {
    const out = execFileSync(cli, ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    const status = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string } };
    if (status.BackendState !== "Running") return null;
    return status.Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}
