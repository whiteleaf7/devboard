// 本物の tailscale の代わりに、状態を決めて返す偽物を PATH に置く
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailnetName } from "../src/tailnet.ts";

const bin = mkdtempSync(join(tmpdir(), "nagaya-tailnet-"));
const originalPath = process.env.PATH;
process.env.PATH = `${bin}:${originalPath}`;
after(() => {
  process.env.PATH = originalPath;
  rmSync(bin, { recursive: true, force: true });
});

function fakeTailscale(status: unknown): void {
  const file = join(bin, "tailscale");
  writeFileSync(file, `#!/bin/sh\n[ "$1" = status ] && echo '${JSON.stringify(status)}'\nexit 0\n`);
  chmodSync(file, 0o755);
}

test("動いている tailnet の名前を、末尾の点を落として返す", () => {
  fakeTailscale({ BackendState: "Running", Self: { DNSName: "mac.example.ts.net." } });
  assert.equal(tailnetName(), "mac.example.ts.net");
});

test("止まっている、または名前が無いときは null", () => {
  fakeTailscale({ BackendState: "Stopped", Self: { DNSName: "mac.example.ts.net." } });
  assert.equal(tailnetName(), null);
  fakeTailscale({ BackendState: "Running", Self: {} });
  assert.equal(tailnetName(), null);
});
