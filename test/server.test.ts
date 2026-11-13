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

const call = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: JSON.stringify(body),
  });

test("画面からタスクを追加・更新でき、ユーザーの操作として記録される", async () => {
  const res = await call("POST", "/api/tasks", { title: "手で足した", milestone: "M0", priority: "high" });
  assert.equal(res.status, 201);
  const task = await res.json();
  assert.equal(task.createdBy, "user");

  const upd = await call("PATCH", `/api/tasks/${task.id}`, { status: "doing", note: "着手した" });
  assert.equal(upd.status, 200);
  const updated = await upd.json();
  assert.equal(updated.status, "doing");
  assert.equal(updated.priority, "high");
  assert.deepEqual(
    updated.notes.map((n: { by: string }) => n.by),
    ["user"],
  );
});

test("不正な入力は 400 で理由を返す", async () => {
  const res = await call("POST", "/api/tasks", { title: "" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /title/);
  const bad = await call("PATCH", "/api/tasks/T-001", { status: "unknown" });
  assert.equal(bad.status, 400);
  const missing = await call("PATCH", "/api/tasks/T-999", { status: "done" });
  assert.equal(missing.status, 400);
});

test("別の Origin や JSON 以外からの書き込みは拒否する", async () => {
  assert.equal((await call("POST", "/api/tasks", { title: "x" }, { origin: "https://evil.example" })).status, 403);
  const noOrigin = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await call("POST", "/api/tasks", { title: "x" }, { "content-type": "text/plain" })).status, 403);
  assert.equal((await call("DELETE", "/api/tasks/T-001", {})).status, 405);
});

// fetch は Host ヘッダを差し替えられないので、node:http で送る
function raw(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("tailnet の名前は Host と https の Origin で許可し、それ以外は拒否する", async () => {
  assert.equal(await raw("GET", "/api/snapshot", { host: `${TS}:8448` }), 200);
  assert.equal(await raw("GET", "/api/snapshot", { host: "other.example.ts.net" }), 403);
  assert.equal(await raw("GET", "/api/snapshot", { host: "evil.example" }), 403);

  // tailscale serve が Host を ts.net のまま中継しても、127.0.0.1 に書き換えても通ること
  for (const host of [`${TS}:8448`, new URL(base).host]) {
    assert.equal(
      await raw("POST", "/api/tasks", { host, origin: `https://${TS}:8448` }, { title: "スマホから" }),
      201,
      host,
    );
  }
  assert.equal(
    await raw("POST", "/api/tasks", { host: `${TS}:8448`, origin: `http://${TS}:8448` }, { title: "x" }),
    403,
  );
  assert.equal(
    await raw("POST", "/api/tasks", { host: `${TS}:8448`, origin: "https://other.example.ts.net" }, { title: "x" }),
    403,
  );
  assert.equal(
    await raw(
      "POST",
      "/api/tasks",
      { host: `${TS}:8448`, origin: `https://${TS}:8448`, "content-type": "text/plain" },
      { title: "x" },
    ),
    403,
  );
});
