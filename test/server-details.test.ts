// サーバの、経路・Host・Origin・本文の大きさ・変更通知の細かい振る舞いを確かめる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request, type IncomingHttpHeaders } from "node:http";

const root = mkdtempSync(join(tmpdir(), "nagaya-devboard-server-details-"));
process.env.NAGAYA_ROOT = root;
process.env.NAGAYA_DEV_HOSTS = " extra.example.ts.net , ,second.example.ts.net";
mkdirSync(join(root, "dev", "tasks"), { recursive: true });
mkdirSync(join(root, "docs", "decisions"), { recursive: true });
writeFileSync(join(root, "dev", "project.json"), JSON.stringify({ name: "t", milestones: [] }));

const { startServer, instanceFile, remoteHosts } = await import("../src/server.ts");
const TS = "mac.example.ts.net";
let base = "";
let hostPort = "";
let close = () => {};

before(async () => {
  const s = startServer(0, [TS]);
  close = s.close;
  await new Promise((r) => s.server.once("listening", r));
  hostPort = `127.0.0.1:${(s.server.address() as AddressInfo).port}`;
  base = `http://${hostPort}`;
});
after(() => close());

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

// fetch は Host ヘッダを差し替えられないので、node:http で送る
function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const write = (method: string, path: string, body: string, headers: Record<string, string> = {}) =>
  send(method, path, { "content-type": "application/json", origin: base, ...headers }, body);

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("時間内に条件を満たさなかった");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("画面・解析器・API を返し、キャッシュさせない", async () => {
  const page = await send("GET", "/");
  assert.deepEqual([page.status, page.headers["content-type"], page.headers["cache-control"]], [200, "text/html; charset=utf-8", "no-store"]);
  assert.match(page.body, /<html/i);

  const script = await send("GET", "/markdown.js");
  assert.deepEqual([script.status, script.headers["content-type"]], [200, "text/javascript; charset=utf-8"]);
  assert.match(script.body, /export function parseMarkdown/);

  const hosts = await send("GET", "/api/hosts");
  assert.equal(hosts.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(hosts.body), ["127.0.0.1", "localhost", "[::1]", TS]);

  const snapshot = await send("GET", "/api/snapshot?x=1");
  assert.deepEqual([snapshot.status, JSON.parse(snapshot.body).project.name], [200, "t"]);
  assert.equal((await send("GET", "/nope")).status, 404);
  assert.equal((await send("PUT", "/api/tasks")).status, 405);
});

test("Host は、ポートと大文字小文字の違いを無視して比べる", async () => {
  for (const host of ["127.0.0.1", "LOCALHOST:9999", "[::1]:4848", TS.toUpperCase()]) {
    assert.equal((await send("GET", "/api/hosts", { host })).status, 200, host);
  }
  for (const host of ["127.0.0.1.evil.example", "evil.example:4848", `x${TS}`, "extra.example.ts.net"]) {
    assert.equal((await send("GET", "/api/hosts", { host })).status, 403, host);
  }
});

test("書き込みは、同じ Origin からの JSON だけを受け付ける", async () => {
  const body = JSON.stringify({ title: "書き込み" });
  assert.equal((await write("POST", "/api/tasks", body)).status, 201);
  assert.equal((await write("POST", "/api/tasks", body, { "content-type": "application/json; charset=utf-8" })).status, 201);
  assert.equal((await write("POST", "/api/tasks", body, { origin: `https://${hostPort}` })).status, 403, "loopback は http だけ");
  assert.equal((await write("POST", "/api/tasks", body, { origin: `http://localhost:${hostPort.split(":")[1]}` })).status, 403, "Host と違う名前");
  assert.equal((await write("POST", "/api/tasks", body, { origin: "http://127.0.0.1:1" })).status, 403, "Host と違うポート");
  assert.equal((await write("POST", "/api/tasks", body, { origin: "null" })).status, 403);
  assert.equal((await write("POST", "/api/tasks", body, { "content-type": "text/json" })).status, 403);
  const refused = await write("POST", "/api/tasks", body, { origin: "https://evil.example" });
  assert.match(refused.body, /受け付けない/);
});

test("書き込みの経路と本文を確かめ、理由つきで断る", async () => {
  const created = JSON.parse((await write("POST", "/api/tasks", JSON.stringify({ title: "経路" }))).body);
  assert.equal((await write("PATCH", `/api/tasks/${created.id}`, JSON.stringify({ priority: "low" }))).status, 200);
  assert.equal((await write("POST", "/api/other", "{}")).status, 404);
  assert.equal((await write("POST", `/api/tasks/${created.id}`, "{}")).status, 404, "更新は PATCH だけ");
  assert.equal((await write("PATCH", "/api/tasks", "{}")).status, 404);
  assert.equal((await write("PATCH", "/api/tasks/T-1", "{}")).status, 404, "ID は 3 桁以上");
  assert.equal((await write("PATCH", `/api/tasks/${created.id}x`, "{}")).status, 404);

  const broken = await write("POST", "/api/tasks", "{");
  assert.equal(broken.status, 400);
  assert.equal(typeof JSON.parse(broken.body).error, "string");
  assert.match(JSON.parse((await write("POST", "/api/tasks", JSON.stringify({ title: "" }))).body).error, /^title: /);
  assert.match(JSON.parse((await write("POST", "/api/tasks", "[]")).body).error, /^入力: /);
  assert.match(JSON.parse((await write("PATCH", "/api/tasks/T-999", "{}")).body).error, /T-999/);

  const limit = 1024 * 1024;
  const sized = (bytes: number) => JSON.stringify({ title: "big", description: "a".repeat(bytes - JSON.stringify({ title: "big", description: "" }).length) });
  assert.equal(Buffer.byteLength(sized(limit)), limit);
  assert.equal((await write("POST", "/api/tasks", sized(limit))).status, 201, "上限ちょうどは受け付ける");
  const tooLarge = await write("POST", "/api/tasks", sized(limit + 1));
  assert.equal(tooLarge.status, 400);
  assert.match(JSON.parse(tooLarge.body).error, /大きすぎる/);
});

test("ボードのファイルが変わると、画面に知らせる", async () => {
  let received = "";
  const req = request(base + "/api/events", (res) => {
    assert.deepEqual([res.statusCode, res.headers["content-type"]], [200, "text/event-stream"]);
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      received += chunk;
    });
  });
  req.end();
  try {
    await until(() => received.includes(": connected\n\n"));
    // 一時ファイル（書きかけ）では知らせない。先に書いて、通知が来ないことを次の通知までの間で確かめる
    writeFileSync(join(root, "dev", "tasks", "T-900.json.123.tmp"), "{}");
    await new Promise((r) => setTimeout(r, 600));
    const before = received.split("event: change\ndata: {}\n\n").length;
    writeFileSync(join(root, "docs", "decisions", "0900-sample.md"), "# 0900. 見本\n");
    await until(() => received.split("event: change\ndata: {}\n\n").length > before);
  } finally {
    req.destroy();
  }
});

test("許可する名前は、環境変数から空白と空の項目を除いて読む", () => {
  assert.deepEqual(remoteHosts().slice(0, 2), ["extra.example.ts.net", "second.example.ts.net"]);
  assert.equal(new Set(remoteHosts()).size, remoteHosts().length, "重複させない");
});

test("起動中の URL と PID を記録し、閉じたら消す", async () => {
  const second = startServer(0, []);
  await new Promise((r) => second.server.once("listening", r));
  const recorded = JSON.parse(readFileSync(instanceFile(), "utf8"));
  assert.equal(recorded.pid, process.pid);
  assert.match(recorded.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(instanceFile(), join(root, ".dev", "devboard.json"));
  second.close();
  assert.ok(!existsSync(instanceFile()));
});
