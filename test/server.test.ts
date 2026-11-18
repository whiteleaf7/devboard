import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { useTempBoard } from "./temp-board.ts";

useTempBoard("devboard-server");
const store = await import("../src/store.ts");
store.updateProject(() => ({
  name: "t",
  summary: "",
  milestones: [{ id: "M0", title: "m", goal: "", status: "active" }],
}));

const { startServer } = await import("../src/server.ts");
const TS = "mac.example.ts.net";
let base = "";
let close = () => {};

before(async () => {
  const s = startServer(0, [TS]);
  close = s.close;
  await new Promise((r) => s.server.once("listening", r));
  base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
});
after(() => close());

test("ボードへの書き込みの口は無く、GET 以外は 405 で断る", async () => {
  const send = (method: string, path: string) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ title: "画面から" }),
    });
  assert.equal((await send("POST", "/api/tasks")).status, 405);
  assert.equal((await send("PATCH", "/api/tasks/T-001")).status, 405);
  assert.equal((await send("DELETE", "/api/tasks/T-001")).status, 405);
  assert.deepEqual(store.readTasks().tasks, [], "何も書かない");
});

// fetch は Host ヘッダを差し替えられないので、node:http で送る
function raw(method: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("tailnet の名前は Host で許可し、それ以外は拒否する", async () => {
  assert.equal(await raw("GET", "/api/snapshot", { host: `${TS}:8448` }), 200);
  assert.equal(await raw("GET", "/api/snapshot", { host: "other.example.ts.net" }), 403);
  assert.equal(await raw("GET", "/api/snapshot", { host: "evil.example" }), 403);
});

test("tailnet の端末からも、ボードには書けない", async () => {
  // 以前はスマホ（tailscale serve が終端する https の Origin）から書けたので、その形でも断ることを確かめる
  for (const host of [`${TS}:8448`, new URL(base).host]) {
    for (const [method, path] of [
      ["POST", "/api/tasks"],
      ["PATCH", "/api/tasks/T-001"],
    ] as const)
      assert.equal(
        await raw(method, path, { host, origin: `https://${TS}:8448`, "content-type": "application/json" }),
        405,
        `${method} ${host}`,
      );
  }
  assert.deepEqual(store.readTasks().tasks, [], "何も書かない");
});

test("活動の画面と集計を返し、期間の指定が不正なら 400 で理由を返す", async () => {
  for (const path of ["/activity", "/base.css", "/theme.js", "/paging.js"])
    assert.equal((await fetch(base + path)).status, 200, path);

  store.updateTask(store.createTask({ title: "終えるもの" }).id, { status: "done", note: "終えた" });
  const res = await fetch(`${base}/api/activity?days=7`);
  assert.equal(res.status, 200);
  const activity = await res.json();
  assert.equal(activity.daily.length, 7);
  assert.equal(activity.totals.tasksDone, 1);
  // 一時的なボードの根は git のリポジトリではないので、PR は取れず、理由が付く
  assert.match(activity.sources.pullRequests, /PR を取得できない/);

  const bad = await fetch(`${base}/api/activity?days=abc`);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /days/);
});

test("設定で選べるテーマは、どれも CSS を返し、ボードの画面が読み込む", async () => {
  const themeJs = await (await fetch(`${base}/theme.js`)).text();
  const ids = [...themeJs.matchAll(/\{ id: "([a-z-]+)"/g)].map((m) => m[1] ?? "");
  assert.ok(ids.includes("business"), "既定の業務テーマがある");
  const index = await (await fetch(`${base}/`)).text();
  assert.equal((await fetch(`${base}/board.css`)).status, 200);
  for (const id of ids) {
    const res = await fetch(`${base}/themes/${id}.css`);
    assert.equal(res.status, 200, id);
    assert.match(await res.text(), new RegExp(`:root\\[data-theme="${id}"\\]`), `${id} はテーマの中に閉じている`);
    assert.ok(index.includes(`href="/themes/${id}.css"`), `${id} を読み込む`);
  }
  // public/themes/ に無い名前は返さない
  for (const path of ["/themes/nope.css", "/themes/business.css.map", "/themes/%2E%2E%2Fbase.css"])
    assert.equal((await fetch(base + path)).status, 404, path);
});
