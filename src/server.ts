// 開発ダッシュボードの HTTP サーバ。127.0.0.1 のみで待ち受ける。
//   GET /               ボードの画面（public/index.html）
//   GET /activity       活動の画面（public/activity.html）
//   GET /base.css, /theme.js, /markdown.js, /paging.js  画面が共有するスタイル・テーマ・Markdown の解析器・一覧の省略（public/）
//   GET /board.css, /themes/<id>.css  ボードの画面の土台とテーマ（public/themes/）
//   GET /api/snapshot   ボードの全データ
//   GET /api/activity?days=N  直近 N 日の活動の集計（0 は全期間。activity.ts）
//   GET /api/events     変更通知（Server-Sent Events）。ボード（SQLite）と決定記録のディレクトリと .git の変更で送る
//   GET /api/hosts      許可している Host の一覧（tailscale.ts が確認に使う）
// ポートは DEVBOARD_PORT。指定が無ければ 4848 から、ほかのプロジェクトのダッシュボードが使っていない番号を探す。
// 使った URL は .dev/devboard.json に記録し、launcher.ts と tailscale.ts はそれを見る。
// devboard のコードが更新されたら（リポジトリの HEAD が変わったら）、同じポートで新しいコードのサーバに立て直す
// 読み取り専用。ボードへの書き込みは MCP と `devboard apply` だけが行う。
// tailscale serve で中継するときは、tailnet 上の名前（*.ts.net）も Host に許可する。
// 許可する名前は起動時に `tailscale status` から取る。DEVBOARD_HOSTS（カンマ区切り）で足せる。

import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, watch, writeFileSync, mkdirSync, rmSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadActivity } from "./activity-sources.ts";
import { board, latestSeq } from "./board-db.ts";
import { tailnetName } from "./tailnet.ts";
import { decisionsDir, repoRoot, snapshot } from "./store.ts";

export const DEFAULT_PORT = 4848;
// 指定が無いとき、4848 から数えて何番まで探すか
const PORT_TRIES = 20;
const CODE_POLL_MS = 5000;
const BOARD_POLL_MS = 500;

export function instanceFile(): string {
  return join(repoRoot(), ".dev", "devboard.json");
}

const asset = (name: string) => readFileSync(join(import.meta.dirname, "..", "public", name));

// 返してよいテーマの CSS。名前は public/themes/ にあるものだけにし、パスを組み立てて外へ出られないようにする
const THEME_FILES = new Set(readdirSync(join(import.meta.dirname, "..", "public", "themes")).filter((f) => /^[a-z-]+\.css$/.test(f)));

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function remoteHosts(): string[] {
  const extra = (process.env.DEVBOARD_HOSTS ?? process.env.NAGAYA_DEV_HOSTS ?? "")
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

const ActivityDays = z.coerce.number().int().min(0).max(366);

async function handleActivity(res: ServerResponse, url: URL): Promise<void> {
  const days = ActivityDays.safeParse(url.searchParams.get("days") ?? "30");
  if (!days.success) return send(res, 400, "text/plain; charset=utf-8", "days は 0〜366 の整数（0 は全期間）");
  try {
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(await loadActivity(days.data)));
  } catch (e) {
    return send(res, 500, "text/plain; charset=utf-8", e instanceof Error ? e.message : String(e));
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
const configuredPort = () => process.env.DEVBOARD_PORT ?? process.env.NAGAYA_DEV_PORT;

// fallback が真なら、port が使われているときに次の番号を順に試す。ポートを指定されたときは、その番号だけを使う
export function startServer(
  port = Number(configuredPort() ?? DEFAULT_PORT),
  remote = remoteHosts(),
  fallback = configuredPort() === undefined,
) {
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
  for (const dir of [decisionsDir(), join(repoRoot(), ".git")]) {
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
    if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
    switch (url.pathname) {
      case "/":
        return send(res, 200, "text/html; charset=utf-8", asset("index.html"));
      case "/activity":
        return send(res, 200, "text/html; charset=utf-8", asset("activity.html"));
      case "/base.css":
      case "/board.css":
        return send(res, 200, "text/css; charset=utf-8", asset(url.pathname.slice(1)));
      case "/theme.js":
      case "/markdown.js":
      case "/paging.js":
        return send(res, 200, "text/javascript; charset=utf-8", asset(url.pathname.slice(1)));
      case "/api/activity":
        return void handleActivity(res, url);
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
      default: {
        const theme = url.pathname.match(/^\/themes\/([a-z-]+\.css)$/)?.[1];
        if (theme && THEME_FILES.has(theme)) return send(res, 200, "text/css; charset=utf-8", asset(`themes/${theme}`));
        return send(res, 404, "text/plain", "not found");
      }
    }
  });

  let tries = 0;
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE" || !fallback || ++tries >= PORT_TRIES) throw e;
    server.listen(port + tries, "127.0.0.1");
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    mkdirSync(join(repoRoot(), ".dev"), { recursive: true });
    writeFileSync(instanceFile(), JSON.stringify({ url, pid: process.pid }) + "\n");
    console.log(`devboard: ${url}`);
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

// devboard のコードの版。リポジトリの HEAD のコミットで見る（保存のたびではなく、切り替え・pull・コミットのときに変わる）。
// git が無ければ null で、立て直しはしない
function codeVersion(): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dirname, ".."), timeout: 3000 }, (err, out) =>
      resolve(err ? null : out.trim()),
    ),
  );
}

if (import.meta.main) {
  const { server, close } = startServer();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(versionPoll);
    close();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stop();
      process.exit(0);
    });
  }

  // 画面のファイル（public/）はリクエストのたびに読むが、サーバのコードは起動したときのまま。
  // コードが変わったら、新しい画面に古いサーバが答えて食い違わないよう、同じポートで立て直す
  const started = await codeVersion();
  const versionPoll = setInterval(async () => {
    const now = await codeVersion();
    if (!started || !now || now === started || stopped) return;
    const port = String((server.address() as AddressInfo).port);
    console.log(`devboard のコードが更新された（${started.slice(0, 7)} → ${now.slice(0, 7)}）。立て直す`);
    stop();
    await new Promise((r) => server.once("close", r));
    const env = { ...process.env, DEVBOARD_PORT: port };
    if (process.env.DEVBOARD_BACKGROUND) {
      // devboard open が裏で起動したもの: 新しいサーバを同じく裏で起動し、自分は終わる
      spawn(process.execPath, [import.meta.filename], { cwd: process.cwd(), env, detached: true, stdio: "inherit" }).unref();
      process.exit(0);
    }
    // devboard start で前面にいるもの: 端末に居座ったまま新しいサーバを子として動かし、止める合図を渡す
    const child = spawn(process.execPath, [import.meta.filename], { cwd: process.cwd(), env, stdio: "inherit" });
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
    child.on("exit", (code) => process.exit(code ?? 0));
  }, CODE_POLL_MS);
}
