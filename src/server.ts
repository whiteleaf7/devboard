// 開発ダッシュボードの HTTP サーバ。127.0.0.1 のみで待ち受ける。
//   GET /               画面（public/index.html）
//   GET /markdown.js    画面が使う Markdown の解析器（public/markdown.js）
//   GET /api/snapshot   ボードの全データ
//   GET /api/events     変更通知（Server-Sent Events）。ボード（SQLite）と docs/decisions/ と .git の変更で送る
//   POST  /api/tasks       タスクの追加（画面から。createdBy: user）
//   PATCH /api/tasks/:id   タスクの更新（画面から。メモは by: user）
//   GET /api/hosts      許可している Host の一覧（tailscale.ts が確認に使う）
// 書き込みは、この画面と同じ Origin からの JSON だけを受け付ける。
// tailscale serve で中継するときは、tailnet 上の名前（*.ts.net）も Host と Origin に許可する。
// 許可する名前は起動時に `tailscale status` から取る。NAGAYA_DEV_HOSTS（カンマ区切り）で足せる。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, watch, writeFileSync, mkdirSync, rmSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { board, latestSeq } from "./board-db.ts";
import { tailnetName } from "./tailnet.ts";
import { paths, repoRoot, snapshot, createTask, updateTask, TaskCreateInput, TaskUpdateInput } from "./store.ts";

export const DEFAULT_PORT = 4848;
const BOARD_POLL_MS = 500;

export function instanceFile(): string {
  return join(repoRoot(), ".dev", "devboard.json");
}

const asset = (name: string) => readFileSync(join(import.meta.dirname, "..", "public", name));

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function remoteHosts(): string[] {
  const extra = (process.env.NAGAYA_DEV_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const ts = tailnetName();
  return [...new Set([...extra, ...(ts ? [ts] : [])])];
}

const hostname = (host: string) => host.replace(/:\d+$/, "").toLowerCase();

// DNS リバインディング対策: Host が loopback か、許可した tailnet の名前のときだけ応答する
function hostAllowed(req: IncomingMessage, remote: string[]): boolean {
  const host = hostname(req.headers.host ?? "");
  return LOOPBACK.includes(host) || remote.includes(host);
}

// 書き込みは、この画面からの fetch に限る。
// 他のサイトのページからの送信は Origin が一致しないので拒否する。JSON 以外を拒否するのは、
// フォーム送信のようにプリフライトなしで届くリクエストを通さないため。
// loopback は http、tailnet の名前は tailscale serve が終端する https の Origin だけを認める
function writeAllowed(req: IncomingMessage, remote: string[]): boolean {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) return false;
  let origin: URL;
  try {
    origin = new URL(req.headers.origin ?? "");
  } catch {
    return false;
  }
  const host = origin.hostname.toLowerCase();
  if (LOOPBACK.includes(host) || host === "::1") return origin.protocol === "http:" && origin.host === req.headers.host;
  return origin.protocol === "https:" && remote.includes(host);
}

const MAX_BODY = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("本文が大きすぎる");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function errorMessage(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".") || "入力"}: ${i.message}`).join("\n");
  return e instanceof Error ? e.message : String(e);
}

async function handleWrite(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  remote: string[],
): Promise<void> {
  if (!writeAllowed(req, remote))
    return send(res, 403, "text/plain; charset=utf-8", "この画面以外からの書き込みは受け付けない");
  const json = (status: number, value: unknown) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
  try {
    const body = await readJson(req);
    if (req.method === "POST" && pathname === "/api/tasks") {
      return json(201, createTask({ ...TaskCreateInput.parse(body), createdBy: "user" }));
    }
    const id = /^\/api\/tasks\/(T-\d{3,})$/.exec(pathname)?.[1];
    if (req.method === "PATCH" && id) {
      return json(200, updateTask(id, { ...TaskUpdateInput.parse(body), by: "user" }));
    }
    return send(res, 404, "text/plain", "not found");
  } catch (e) {
    return json(400, { error: errorMessage(e) });
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
export function startServer(port = Number(process.env.NAGAYA_DEV_PORT ?? DEFAULT_PORT), remote = remoteHosts()) {
  const clients = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | undefined;

  // 保存時は複数のイベントが続けて来るので、まとめて 1 回だけ通知する
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const res of clients) res.write(`event: change\ndata: {}\n\n`);
    }, 200);
  };

  // ボードは SQLite なので、イベントの番号が増えたかを見る
  const db = board();
  let seen = latestSeq(db);
  const poll = setInterval(() => {
    const seq = latestSeq(db);
    if (seq !== seen) {
      seen = seq;
      notify();
    }
  }, BOARD_POLL_MS);

  const watchers: FSWatcher[] = [];
  for (const dir of [paths.decisions(), join(repoRoot(), ".git")]) {
    try {
      watchers.push(
        watch(dir, { recursive: true }, (_event, file) => {
          if (String(file ?? "").endsWith(".tmp")) return;
          notify();
        }),
      );
    } catch {
      // ディレクトリがまだ無い場合は監視しない
    }
  }

  const server = createServer((req, res) => {
    if (!hostAllowed(req, remote)) return send(res, 403, "text/plain", "forbidden host");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" || req.method === "PATCH") return void handleWrite(req, res, url.pathname, remote);
    if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
    switch (url.pathname) {
      case "/":
        return send(res, 200, "text/html; charset=utf-8", asset("index.html"));
      case "/markdown.js":
        return send(res, 200, "text/javascript; charset=utf-8", asset("markdown.js"));
      case "/api/hosts":
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify([...LOOPBACK, ...remote]));
      case "/api/snapshot":
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify(snapshot()));
      case "/api/events":
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      default:
        return send(res, 404, "text/plain", "not found");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    mkdirSync(join(repoRoot(), ".dev"), { recursive: true });
    writeFileSync(instanceFile(), JSON.stringify({ url, pid: process.pid }) + "\n");
    console.log(`nagaya devboard: ${url}`);
    if (remote.length) console.log(`許可している tailnet の名前: ${remote.join(", ")}`);
  });

  const close = () => {
    clearInterval(poll);
    for (const w of watchers) w.close();
    for (const res of clients) res.end();
    rmSync(instanceFile(), { force: true });
    server.close();
  };
  return { server, close };
}

if (import.meta.main) {
  const { close } = startServer();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      close();
      process.exit(0);
    });
  }
}
