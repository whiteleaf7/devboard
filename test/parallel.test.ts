// 複数の worktree・プロセスから同じボードを使うときの振る舞い（決定記録 0010）
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mainWorktreeOf } from "../src/worktree.ts";

// git のフックから動くと GIT_DIR などが渡ってくる。残すと、一時ディレクトリの git が本物のリポジトリを指す
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];

const store = join(import.meta.dirname, "..", "src", "store.ts");

test("linked worktree の中からでも、main の worktree をボードの根にする", (t) => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "nagaya-main-")));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(main, "init", "-q", "-b", "main");
  git(
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "chore: first",
  );
  const linked = join(main, ".claude", "worktrees", "a");
  git(main, "worktree", "add", "-q", "-b", "a", linked);

  assert.equal(mainWorktreeOf(linked), main);
  assert.equal(mainWorktreeOf(main), main);
  const plain = mkdtempSync(join(tmpdir(), "nagaya-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(mainWorktreeOf(plain), plain, "git の管理下でなければ、そのまま");

  // submodule の .git も gitdir を指すファイルだが、指す先に commondir が無い
  const submodule = join(plain, "sub");
  mkdirSync(join(plain, "modules", "sub"), { recursive: true });
  mkdirSync(submodule);
  writeFileSync(join(submodule, ".git"), "gitdir: ../modules/sub\n");
  assert.equal(mainWorktreeOf(submodule), submodule, "submodule は、それ自体を根にする");
});

test("複数のプロセスが同時に作っても、番号が重ならず、どれも消えず、イベントがそろう", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nagaya-parallel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boardFile = join(root, "board.sqlite");
  const script = `
    const s = await import(${JSON.stringify(store)});
    for (let i = 0; i < 10; i++) s.createTask({ title: "t" + i });
    for (let i = 0; i < 3; i++) s.createLesson({ title: "l", problem: "p", fix: "f" });
    for (let i = 0; i < 3; i++) s.createDecision({ title: "d", slug: "d-" + process.pid + "-" + i, context: "c", decision: "d", consequences: "e" });
  `;
  const run = promisify(execFile);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      run(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, NAGAYA_ROOT: root, NAGAYA_BOARD: boardFile },
      }),
    ),
  );

  const db = new DatabaseSync(boardFile);
  const count = (sql: string) => Number(db.prepare(sql).get()?.n);
  assert.equal(count("SELECT count(DISTINCT number) AS n FROM tasks"), 40);
  assert.equal(count("SELECT count(DISTINCT number) AS n FROM lessons"), 12);
  assert.equal(count("SELECT count(*) AS n FROM events WHERE kind = 'task.created'"), 40);
  const numbers = readdirSync(join(root, "docs", "decisions")).map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, 12, "決定記録の番号が重ならない");
  assert.deepEqual(readdirSync(join(root, ".dev")), [], "ロックが残らない");
});
