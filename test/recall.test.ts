import { test, before } from "node:test";
import assert from "node:assert/strict";
import { buildDocs, recall, tokenize, type RecallDoc } from "../src/recall.ts";
import { useTempBoard } from "./temp-board.ts";

useTempBoard("recall");
const store = await import("../src/store.ts");

before(() => {
  store.updateProject(() => ({ name: "t", summary: "", milestones: [] }));
});

const docs: RecallDoc[] = [
  {
    id: "D-0004",
    kind: "decision",
    title: "UI とデーモンの通信: WebSocket の上に JSON-RPC 2.0",
    body: "型は zod で共有する。HTTP のポーリングは遅いので選ばなかった。",
  },
  {
    id: "D-0005",
    kind: "decision",
    title: "保存: 会話は Claude の記録を読む",
    body: "autodev のメタデータは JSON ファイルで持つ。",
  },
  {
    id: "T-021",
    kind: "task",
    title: "サーバのアドレスは Tailscale の URL を貼る",
    body: "ユーザーはスマホなど別の端末から開く。",
  },
];

test("英数字は単語に、日本語は 2 文字ずつの組に分ける", () => {
  assert.deepEqual(tokenize("JSON-RPC 2.0 を使う"), ["json", "rpc", "を使", "使う"]);
  assert.deepEqual(tokenize("ＷｅｂＳｏｃｋｅｔ"), ["websocket"], "全角の英字は半角にそろえる");
});

test("質問に関係の深い記録を先に返す", () => {
  assert.equal(recall("UI とデーモンのあいだの通信方式はどう決めた？", docs)[0]?.id, "D-0004");
  assert.equal(recall("会話の保存の方法", docs)[0]?.id, "D-0005");
  assert.equal(recall("別の端末から開けるようにアドレスをどう伝えるか", docs)[0]?.id, "T-021");
  assert.match(recall("ポーリングを選ばなかった理由", docs)[0]?.excerpt ?? "", /ポーリング/);
  assert.equal(recall("会話", docs, 1).length, 1);
  assert.deepEqual(recall("zzzz qqqq", docs), []);
});

test("タイトルに出る語は、本文に出る語より重く数える", () => {
  const hits = recall("Tailscale", [
    { id: "T-001", kind: "task", title: "別の話", body: "Tailscale にも触れる。ほかの内容がいくつか続く。" },
    { id: "T-002", kind: "task", title: "Tailscale の URL", body: "ほかの内容がいくつか続く。別の話にも触れる。" },
  ]);
  assert.deepEqual(
    hits.map((h) => h.id),
    ["T-002", "T-001"],
  );
});

test("教訓を採番して残し、タスク・決定記録と一緒に探せる", () => {
  const task = store.createTask({ title: "評価のランナーを作る" });
  const lesson = store.createLesson({
    title: "pnpm が複製の中で install を始める",
    problem: "複製でゲートを走らせたら、リンク先の node_modules を消そうとした",
    fix: "pnpm_config_verify_deps_before_run=false を付ける",
    task: task.id,
    tags: ["pnpm"],
  });
  assert.equal(lesson.id, "L-001");
  assert.equal(store.createLesson({ title: "次", problem: "p", fix: "f" }).id, "L-002");
  assert.throws(() => store.createLesson({ title: "x", problem: "p", fix: "f", task: "T-999" }), /T-999/);

  const { lessons, errors } = store.readLessons();
  assert.deepEqual([lessons.length, errors.length], [2, 0]);
  const found = recall("複製で pnpm install が走ってしまう", buildDocs(store.readTasks().tasks, [], lessons));
  assert.deepEqual([found[0]?.id, found[0]?.kind], ["L-001", "lesson"]);
});

test("held-out を触ったタスクと、それに結び付いた教訓は、タイトルだけで中身を返さない", () => {
  const heldout = store.createTask({
    title: "held-out のシナリオを足す",
    description: "秘密の目印の行を説明に書いた",
    paths: ["docs/harness.md", "tools/harness/eval/heldout/"],
  });
  store.updateTask(heldout.id, { note: "秘密の目印の行をメモに書いた" });
  store.createLesson({ title: "held-out の教訓", problem: "秘密の目印の行を教訓に書いた", fix: "f", task: heldout.id });
  const open = store.createTask({ title: "公開のシナリオを足す", paths: ["tools/harness/eval/public/"] });
  store.updateTask(open.id, { note: "目印の行を公開のメモに書いた" });

  const docs = buildDocs(store.readTasks().tasks, [], store.readLessons().lessons);
  const hits = recall("held-out の目印の行", docs, 20);
  const sealed = hits.filter((h) => h.title.startsWith("held-out"));
  assert.equal(sealed.length, 2, "タイトルでは引ける");
  for (const hit of sealed) assert.match(hit.excerpt, /held-out のシナリオを触った記録/);
  assert.equal(recall("秘密", docs).length, 0, "説明・メモ・教訓の本文では引けない");
  assert.match(hits.find((h) => h.id === open.id)?.excerpt ?? "", /公開のメモ/);
});
