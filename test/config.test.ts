// プロジェクトの設定（.devboard.json）で、devboard の挙動が変わることを確かめる
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempBoard } from "./temp-board.ts";

const root = useTempBoard("devboard-config");
const store = await import("../src/store.ts");
const { readConfig } = await import("../src/config.ts");
const { buildDocs, recall } = await import("../src/recall.ts");

const configure = (config: unknown) => writeFileSync(join(root, ".devboard.json"), JSON.stringify(config));

beforeEach(() => {
  store.updateProject(() => ({ name: "t", summary: "", milestones: [] }));
  configure({});
});

test("設定が無い・空のときは、既定の決まりで動く", () => {
  assert.deepEqual(readConfig(), { decisionsDir: "docs/decisions", hiddenPaths: [], rules: { profile: "autodev", verificationHint: "" } });
});

test("decisionsDir を変えると、決定記録をそのディレクトリに書いて、読める", () => {
  configure({ decisionsDir: "adr/" });
  const made = store.createDecision({ title: "別の置き場", slug: "elsewhere", context: "c", decision: "d", consequences: "i" });
  assert.equal(made.file, "adr/0001-elsewhere.md");
  assert.ok(existsSync(join(root, "adr", "0001-elsewhere.md")));
  assert.deepEqual(store.readDecisions().map((d) => d.file), ["adr/0001-elsewhere.md"]);
  assert.equal(existsSync(join(root, "docs", "decisions")), false, "既定の場所は使わない");
});

test("hiddenPaths が空なら、どのタスクの中身も隠さない", () => {
  const task = store.createTask({ title: "資料を足す", description: "本文の目印", paths: ["tools/harness/eval/heldout/"] });
  store.updateTask(task.id, { note: "メモの目印" });
  const docs = buildDocs(store.readTasks().tasks, [], []);
  assert.ok(recall("本文の目印", docs).length > 0, "設定が無ければ、中身で引ける");
});

test("profile none では、書き込みの決まり（メモの無い done・review・子が残る親の done）を使わず、つながりの検査は残る", () => {
  configure({ rules: { profile: "none" } });
  const child = store.createTask({ title: "子" });
  const parent = store.createTask({ title: "親" });
  store.updateTask(child.id, { parent: parent.id });
  assert.equal(store.updateTask(parent.id, { status: "done" }).status, "done", "メモも、子の終わりも要らない");
  const feature = store.createTask({ title: "振る舞いを変える", paths: ["src/"] });
  assert.equal(store.updateTask(feature.id, { status: "done", note: "テストが通った" }).status, "done", "動かした結果も要らない");
  assert.throws(() => store.createTask({ title: "孤児", parent: "T-999" }), /存在しない/, "つながりの検査は、いつも使う");
});

test("rules.verificationHint があれば、動かした結果の案内の続きに使い、無ければ一般的な案内にする", () => {
  const unverified = () => {
    const feature = store.createTask({ title: "振る舞いを変える", paths: ["src/"] });
    try {
      store.updateTask(feature.id, { status: "done", note: "テストが通った" });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };
  assert.match(unverified(), /動かした.*devboard apply/s);
  assert.doesNotMatch(unverified(), /プロジェクトの確かめ方/);
  configure({ rules: { verificationHint: "手段はプロジェクトの確かめ方の文書にある" } });
  assert.match(unverified(), /プロジェクトの確かめ方の文書/);
});

test("設定が JSON でない・知らない項目を含むときは、ファイル名を添えて断る", () => {
  writeFileSync(join(root, ".devboard.json"), "これは JSON ではない");
  assert.throws(() => readConfig(), /\.devboard\.json が JSON として読めない/);
  configure({ nothing: true });
  assert.throws(() => readConfig(), /\.devboard\.json の中身が違う/);
});

test("DEVBOARD_ROOT が無いときは、コマンドを打った場所から上へたどって見つけた設定を使う", async () => {
  const { mkdirSync, mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const project = realpathSync(mkdtempSync(join(tmpdir(), "devboard-config-walk-")));
  try {
    mkdirSync(join(project, "apps", "web"), { recursive: true });
    writeFileSync(join(project, ".devboard.json"), JSON.stringify({ decisionsDir: "adr" }));
    const { DEVBOARD_ROOT, NAGAYA_ROOT, DEVBOARD_DB, NAGAYA_BOARD, NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync("node", [join(import.meta.dirname, "./config-probe.ts")], { cwd: join(project, "apps", "web"), env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).decisionsDir, "adr");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
