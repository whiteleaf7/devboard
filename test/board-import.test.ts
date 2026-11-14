// pnpm board:import（src/board-import.ts）を、一時的な git のリポジトリと空のボードに向けて動かす。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

// git のフックから動くと GIT_DIR などが渡ってくる。残すと、一時ディレクトリの git が本物のリポジトリを指す
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const SCRIPT = join(import.meta.dirname, "../src/board-import.ts");

const task = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  title: `${id} の題（複数バイト）`,
  status: "todo",
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
  ...fields,
});
const lesson = { id: "L-001", title: "教訓", problem: "起きた", fix: "直した", created: "2026-01-02T00:00:00.000Z" };
const project = { name: "p", summary: "要約", milestones: [] };

function makeRepo(): { root: string; write: (path: string, value: unknown) => void; commit: () => void } {
  const root = mkdtempSync(join(tmpdir(), "nagaya-board-import-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  git("init", "-q");
  return {
    root,
    write: (path, value) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value, null, 2));
    },
    commit: () => {
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--no-verify", "-m", "chore: board");
    },
  };
}

function importBoard(root: string) {
  const file = join(root, "board.sqlite");
  const result = spawnSync("node", [SCRIPT], {
    env: { ...env, NAGAYA_ROOT: root, NAGAYA_BOARD: file },
    encoding: "utf8",
  });
  const rows = (table: string) => {
    const db = new DatabaseSync(file);
    try {
      return db
        .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => JSON.parse(String(row.data)) as Record<string, unknown>);
    } finally {
      db.close();
    }
  };
  return { code: result.status, out: result.stdout + result.stderr, rows };
}

// 1 つ目のコミットに T-001 と project、2 つ目で T-001 を終え、T-002 と教訓を足す。ボードではないファイルも混ぜる
function commitHistory(repo: ReturnType<typeof makeRepo>) {
  repo.write("dev/tasks/T-001.json", task("T-001"));
  repo.write("dev/project.json", project);
  repo.commit();
  repo.write("dev/tasks/T-001.json", task("T-001", { status: "done", updated: "2026-01-02T00:00:00.000Z" }));
  repo.write("dev/tasks/T-002.json", task("T-002"));
  repo.write("dev/tasks/README.md", "ボードではない");
  repo.write("dev/lessons/L-001.json", lesson);
  repo.commit();
}

test("コミットの写しと作業ツリーを順に読み、最後の姿をボードに入れる", () => {
  const repo = makeRepo();
  commitHistory(repo);
  repo.write("dev/tasks/T-002.json", task("T-002", { status: "doing", updated: "2026-01-03T00:00:00.000Z" }));

  const { code, out, rows } = importBoard(repo.root);
  assert.equal(code, 0, out);
  assert.match(out, /写し 3 件（コミット 2、作業ツリー 1）/);
  assert.match(out, /タスク 2、教訓 1/);
  assert.match(out, /最後の写し（作業ツリー）と一致した/);
  assert.doesNotMatch(out, /読めなかった/);
  assert.deepEqual(
    rows("tasks").map((t) => [t.id, t.status, t.title]),
    [
      ["T-001", "done", "T-001 の題（複数バイト）"],
      ["T-002", "doing", "T-002 の題（複数バイト）"],
    ],
  );
  assert.deepEqual(
    rows("lessons").map((l) => l.id),
    ["L-001"],
  );
  assert.equal(rows("project")[0]?.summary, "要約");
  assert.ok(rows("events").length > 0);
});

test("作業ツリーにボードのファイルが無ければ、最後のコミットまでを入れる", () => {
  const repo = makeRepo();
  commitHistory(repo);
  rmSync(join(repo.root, "dev"), { recursive: true });

  const { code, out } = importBoard(repo.root);
  assert.equal(code, 0, out);
  assert.match(out, /写し 2 件（コミット 2）/);
  assert.match(out, /最後の写し（最後のコミット）と一致した/);
});

test("読めない写しは、場所を添えて知らせ、残りを入れる", () => {
  const repo = makeRepo();
  commitHistory(repo);
  repo.write("dev/tasks/T-003.json", "{ 壊れている");

  const { code, out } = importBoard(repo.root);
  assert.equal(code, 0, out);
  assert.match(out, /読めなかった: 作業ツリー:dev\/tasks\/T-003\.json: JSON として読めない/);
});

test("空ではないボードと、ボードのファイルが無いリポジトリには入れない", () => {
  const repo = makeRepo();
  commitHistory(repo);
  assert.equal(importBoard(repo.root).code, 0);
  const again = importBoard(repo.root);
  assert.equal(again.code, 1);
  assert.match(again.out, /もう空ではない/);

  const empty = makeRepo();
  empty.write("README.md", "x");
  empty.commit();
  const none = importBoard(empty.root);
  assert.equal(none.code, 1);
  assert.match(none.out, /ボードのファイルが無い/);
});
