// サーバの、経路・Host・変更通知の細かい振る舞いを確かめる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request, type IncomingHttpHeaders } from "node:http";
import { useTempBoard } from "./temp-board.ts";

const root = useTempBoard("devboard-server-details");
process.env.DEVBOARD_HOSTS = " extra.example.ts.net , ,second.example.ts.net";
mkdirSync(join(root, "docs", "decisions"), { recursive: true });
const store = await import("../src/store.ts");
store.updateProject(() => ({ name: "t", summary: "", milestones: [] }));

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
function send(method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("時間内に条件を満たさなかった");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("画面・解析器・API を返し、キャッシュさせない", async () => {
  const page = await send("GET", "/");
  assert.deepEqual(
    [page.status, page.headers["content-type"], page.headers["cache-control"]],
    [200, "text/html; charset=utf-8", "no-store"],
  );
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
});

test("書き込みの口は無く、同じ Origin からの JSON でも 405 で断る", async () => {
  const before = store.readTasks().tasks.length;
  const headers = { origin: base, "content-type": "application/json" };
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    for (const path of ["/api/tasks", "/api/tasks/T-001", "/"]) {
      const reply = await send(method, path, headers);
      assert.deepEqual([reply.status, reply.headers["cache-control"]], [405, "no-store"], `${method} ${path}`);
    }
  }
  assert.equal(store.readTasks().tasks.length, before, "何も書かない");
});

test("画面には、追加・編集・ドラッグでの状態変更の口が無い", async () => {
  const page = (await send("GET", "/")).body;
  for (const control of ['id="new-task"', 'id="view-edit"', 'id="task-form"', "draggable", "method: "])
    assert.ok(!page.includes(control), control);
  assert.match(page, /id="view-close"/, "詳細を見て閉じる口は残す");
});

test("Host は、ポートと大文字小文字の違いを無視して比べる", async () => {
  for (const host of ["127.0.0.1", "LOCALHOST:9999", "[::1]:4848", TS.toUpperCase()]) {
    assert.equal((await send("GET", "/api/hosts", { host })).status, 200, host);
  }
  for (const host of ["127.0.0.1.evil.example", "evil.example:4848", `x${TS}`, "extra.example.ts.net"]) {
    assert.equal((await send("GET", "/api/hosts", { host })).status, 403, host);
  }
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
    const changes = () => received.split("event: change\ndata: {}\n\n").length;
    // 一時ファイル（書きかけ）では知らせない。前の書き込みの通知は、負荷が高いと遅れて届くので、静かになるまで待つ
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let count = -1, i = 0; count !== changes() && i < 10; i++) {
      count = changes();
      await sleep(1000);
    }
    const before = changes();
    writeFileSync(join(root, "docs", "decisions", "0900-sample.md.123.tmp"), "{}");
    await sleep(1000);
    assert.equal(changes(), before, "一時ファイルで知らせた");
    writeFileSync(join(root, "docs", "decisions", "0900-sample.md"), "# 0900. 見本\n");
    await until(() => changes() > before);
    // ボード（SQLite）への書き込みでも知らせる。別のプロセスが書いたときと同じく、イベントの番号で気づく
    const afterDecision = changes();
    store.createTask({ title: "通知の確認" });
    await until(() => changes() > afterDecision);
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

test("ポートを指定されていなければ、使われている番号を飛ばして次の番号で待ち受け、実際の URL を記録する", async () => {
  // ほかのプロジェクトのダッシュボードが先に使っている番号の代わり
  const { createServer } = await import("node:http");
  const taken = createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const port = (taken.address() as AddressInfo).port;

  const s = startServer(port, [], true);
  await new Promise((r) => s.server.once("listening", r));
  const actual = (s.server.address() as AddressInfo).port;
  assert.ok(actual > port, `${actual} は ${port} より後ろの番号`);
  assert.equal(JSON.parse(readFileSync(instanceFile(), "utf8")).url, `http://127.0.0.1:${actual}/`);
  assert.equal((await fetch(`http://127.0.0.1:${actual}/api/snapshot`)).status, 200);
  s.close();
  taken.close();
});
