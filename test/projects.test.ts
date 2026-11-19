// 1 つのダッシュボードで、ほかのプロジェクトのボードを切り替えて見る（projects.ts と server.ts の ?project=）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { useTempBoard } from "./temp-board.ts";

// 起動するプロジェクトは一時的なボード（DEVBOARD_DB）。ほかのプロジェクトのボードは、一時的な DEVBOARD_HOME に置く
const homeRoot = realpathSync(useTempBoard("devboard-projects"));
const devboardHome = join(homeRoot, "devboard-home");
process.env.DEVBOARD_HOME = devboardHome;
const boards = join(devboardHome, "boards");

const store = await import("../src/store.ts");
store.updateProject(() => ({ name: "起動した", summary: "", milestones: [] }));
const { startServer } = await import("../src/server.ts");

const BIN = join(import.meta.dirname, "../bin/devboard.ts");
// ほかのプロジェクトで打つ devboard。プロジェクトとボードは cwd から決め、ボードは DEVBOARD_HOME に置く
const devboard = (cwd: string, args: string[], extra: Record<string, string> = {}) => {
  const { DEVBOARD_ROOT, NAGAYA_ROOT, DEVBOARD_DB, NAGAYA_BOARD, NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8", env: { ...env, ...extra } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const apply = (cwd: string, ops: unknown[]) => devboard(cwd, ["apply", JSON.stringify(ops)]);

const other = join(homeRoot, "other");
mkdirSync(join(other, "apps"), { recursive: true });
execFileSync("git", ["init", "-q", other]);
mkdirSync(join(other, "docs", "decisions"), { recursive: true });
writeFileSync(join(other, "docs", "decisions", "0001-other.md"), "# 0001. ほかの決定\n\n- 状態: 採用\n- 日付: 2026-11-19\n");

let base = "";
let close = () => {};

before(async () => {
  // サブディレクトリから打っても、場所はプロジェクトの根を書く
  devboard(join(other, "apps"), ["show", "overview"]);
  apply(other, [
    { op: "set_project", args: { name: "ほかの", summary: "" } },
    { op: "create_task", args: { title: "ほかのタスク" } },
  ]);
  const s = startServer(0, []);
  close = s.close;
  await new Promise((r) => s.server.once("listening", r));
  base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
});
after(() => close());

const json = async (path: string) => {
  const res = await fetch(base + path);
  assert.equal(res.status, 200, path);
  return res.json();
};

test("ボードを開いたプロセスは、ボードの隣にプロジェクトの根を書く。DEVBOARD_DB の写しでは書かない", () => {
  assert.equal(readFileSync(join(boards, "other.root"), "utf8"), `${other}\n`);
  const copy = join(homeRoot, "copy.sqlite");
  devboard(other, ["snapshot", copy]);
  devboard(other, ["show", "overview"], { DEVBOARD_DB: copy });
  assert.ok(!existsSync(join(homeRoot, "copy.root")), "写しの隣に書いた");
});

test("切り替えられるプロジェクトの一覧は、起動したプロジェクトを先頭に、場所の分かるボードを並べる", async () => {
  // 場所の無いボードと、書いたあとに場所を移したボードは出さない
  writeFileSync(join(boards, "noroot.sqlite"), "");
  const moved = join(homeRoot, "moved");
  mkdirSync(moved);
  devboard(moved, ["show", "overview"]);
  renameSync(moved, join(homeRoot, "moved-away"));

  assert.deepEqual(await json("/api/projects"), [
    { id: basename(homeRoot), name: "起動した", home: true },
    { id: "other", name: "ほかの", home: false },
  ]);
});

test("?project= で、ほかのプロジェクトのボード・決定記録・git・活動を返し、指定が無ければ起動したプロジェクトのもの", async () => {
  const snap = await json("/api/snapshot?project=other");
  assert.equal(snap.project.name, "ほかの");
  assert.deepEqual(
    snap.tasks.map((t: { title: string }) => t.title),
    ["ほかのタスク"],
  );
  assert.deepEqual(
    snap.decisions.map((d: { title: string }) => d.title),
    ["ほかの決定"],
  );
  assert.ok(snap.git.dirty > 0, "ほかのプロジェクトの git を読む");
  assert.equal((await json("/api/activity?days=7&project=other")).projectName, "ほかの");

  const own = await json("/api/snapshot");
  assert.equal(own.project.name, "起動した");
  assert.deepEqual(own.tasks, []);
  assert.equal((await json(`/api/snapshot?project=${basename(homeRoot)}`)).project.name, "起動した");
  assert.deepEqual(store.readTasks().tasks, [], "起動したプロジェクトのボードは変わらない");
});

test("一覧に無い id は 404 で断り、パスとして解釈しない", async () => {
  for (const id of ["noroot", "moved", "../other", "nothing", ""]) {
    for (const path of ["/api/snapshot", "/api/activity", "/api/events"]) {
      const res = await fetch(`${base}${path}?project=${encodeURIComponent(id)}`);
      assert.equal(res.status, 404, `${path} ${id}`);
      await res.body?.cancel();
    }
  }
});

test("ほかのプロジェクトのボードが変わると、そのプロジェクトを見ている画面に知らせる", async () => {
  let received = "";
  const req = request(`${base}/api/events?project=other`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      received += chunk;
    });
  });
  req.end();
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(ok());
  };
  try {
    await until(() => received.includes(": connected\n\n"));
    const changes = () => received.split("event: change\ndata: {}\n\n").length;
    // 接続の前の書き込みの通知が落ち着くのを待つ
    await new Promise((r) => setTimeout(r, 1000));
    const before = changes();
    apply(other, [{ op: "create_task", args: { title: "通知の確認" } }]);
    await until(() => changes() > before);
  } finally {
    req.destroy();
  }
});

test("画面は、切り替えの欄とプロジェクトを付けて呼ぶ道具を読み込む", async () => {
  const res = await fetch(`${base}/project.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  assert.match(await res.text(), /export function withProject/);
  for (const page of ["/", "/activity"]) {
    const html = await (await fetch(base + page)).text();
    assert.match(html, /id="project"/, page);
    assert.match(html, /from "\.\/project\.js"/, page);
  }
});
