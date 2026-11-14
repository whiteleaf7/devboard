// MCP サーバを子プロセスで起動し、ツールの振る舞いを外から確かめる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { useTempBoard } from "./temp-board.ts";

useTempBoard("devboard-mcp");
const store = await import("../src/store.ts");
store.updateProject(() => ({
  name: "t",
  summary: "s",
  milestones: [{ id: "M0", title: "m", goal: "", status: "active" }],
}));

const client = new Client({ name: "devboard-test", version: "0.0.0" });

before(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../src/mcp.ts")], env }),
  );
});
after(() => client.close());

type Reply = { isError: boolean; text: string };

async function call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? "" };
}

// 成功した呼び出しの結果を JSON として読む
async function ok<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const reply = await call(name, args);
  assert.equal(reply.isError, false, reply.text);
  return JSON.parse(reply.text) as T;
}

type TaskRow = {
  id: string;
  ready: boolean;
  order: number | null;
  stuck: string | null;
  closable: boolean;
  description?: string;
  lastNote?: { text: string; by: string } | null;
};
type TaskList = { summary: { total: number; ready: number; stuck: number; closable: number }; tasks: TaskRow[] };

test("ツールの一覧に、ボードを扱うものがそろっている", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of [
    "get_overview",
    "list_tasks",
    "get_task",
    "create_task",
    "update_task",
    "set_milestone",
    "list_decisions",
    "get_decision",
    "create_decision",
    "set_decision_status",
    "open_dashboard",
    "recall",
    "add_lesson",
  ]) {
    assert.ok(names.includes(name), name);
  }
  // 読むだけのツールは、クライアントが確認なしで呼べるよう印を付ける
  assert.deepEqual(
    tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name),
    ["get_overview", "list_tasks", "get_task", "list_decisions", "get_decision", "open_dashboard", "recall"],
  );
});

test("タスクを足して、一覧と概要で進め方の情報を返す", async () => {
  const parent = await ok<{ id: string }>("create_task", { title: "依頼", milestone: "M0" });
  const first = await ok<{ id: string }>("create_task", {
    title: "先にやる",
    parent: parent.id,
    labels: ["ui"],
    description: "説明",
  });
  const second = await ok<{ id: string }>("create_task", {
    title: "後でやる",
    parent: parent.id,
    dependsOn: [first.id],
  });
  const urgent = await ok<{ id: string }>("create_task", { title: "急ぎ", priority: "high", milestone: "M0" });
  const refused = await call("create_task", { title: "メモの無い blocked", status: "blocked" });
  assert.ok(refused.isError && /メモ/.test(refused.text), "メモの無い blocked は作らせない");
  const waiting = await ok<{ id: string }>("create_task", { title: "ユーザー待ち" });
  await ok("update_task", { id: waiting.id, status: "blocked", note: "ユーザーの判断を待つ" });
  const behind = await ok<{ id: string }>("create_task", { title: "待ちの後ろ", dependsOn: [waiting.id] });

  const todo = await ok<TaskList>("list_tasks", { status: "todo" });
  assert.deepEqual(
    todo.tasks.map((t) => t.id),
    [urgent.id, first.id, second.id, parent.id, behind.id],
    "着手する順、その後は ID 順",
  );
  assert.deepEqual(todo.summary, { total: 5, ready: 2, stuck: 1, closable: 0 });
  assert.equal(todo.tasks[0]?.description, undefined, "detail を付けなければ説明は返さない");

  assert.deepEqual(
    (await ok<TaskList>("list_tasks", { ready: true })).tasks.map((t) => t.id),
    [urgent.id, first.id],
  );
  assert.deepEqual(
    (await ok<TaskList>("list_tasks", { status: ["blocked", "done"] })).tasks.map((t) => t.id),
    [waiting.id],
  );
  assert.deepEqual(
    (await ok<TaskList>("list_tasks", { milestone: "M0" })).tasks.map((t) => t.id),
    [urgent.id, parent.id],
  );
  assert.deepEqual(
    (await ok<TaskList>("list_tasks", { label: "ui" })).tasks.map((t) => t.id),
    [first.id],
  );
  assert.deepEqual(
    (await ok<TaskList>("list_tasks", { parent: parent.id })).tasks.map((t) => t.id),
    [first.id, second.id],
  );

  await ok("update_task", { id: first.id, status: "doing", note: "着手" });
  const detail = await ok<TaskList>("list_tasks", { parent: parent.id, detail: true });
  assert.deepEqual(
    detail.tasks.map((t) => t.id),
    [second.id, first.id],
    "未着手を先に、進行中は後ろに並べる",
  );
  const started = detail.tasks.find((t) => t.id === first.id);
  assert.deepEqual([started?.description, started?.lastNote?.text, started?.lastNote?.by], ["説明", "着手", "ai"]);

  const overview = await ok<{
    project: { name: string; summary: string };
    milestones: { id: string; tasks: number; done: number }[];
    count: Record<string, number>;
    doing: { id: string }[];
    blocked: { id: string }[];
    next: { id: string }[];
    stuck: { id: string; reason: string }[];
    closable: { id: string }[];
    problems: { check: string; file: string }[];
    errors: string[];
  }>("get_overview");
  assert.deepEqual(overview.project, { name: "t", summary: "s" });
  assert.deepEqual(overview.count, { todo: 4, doing: 1, review: 0, blocked: 1, done: 0, cancelled: 0 });
  assert.deepEqual(
    overview.milestones.map((m) => [m.id, m.tasks, m.done]),
    [["M0", 2, 0]],
  );
  assert.deepEqual(
    overview.doing.map((t) => t.id),
    [first.id],
  );
  assert.deepEqual(
    overview.blocked.map((t) => t.id),
    [waiting.id],
  );
  assert.deepEqual(
    overview.next.map((t) => t.id),
    [urgent.id],
    "依存先が進行中のうちは、次には出さない",
  );
  assert.deepEqual(
    overview.stuck.map((t) => t.id),
    [behind.id],
  );
  assert.match(overview.stuck[0]?.reason ?? "", /ブロック/);
  assert.deepEqual(overview.problems, [], "書く時点で弾くので、問題は残らない");
  assert.deepEqual(overview.errors, []);

  await ok("update_task", { id: first.id, status: "done", note: "確かめた" });
  await ok("update_task", { id: second.id, status: "cancelled", note: "不要" });
  assert.deepEqual(
    (await ok<{ closable: { id: string }[] }>("get_overview")).closable.map((t) => t.id),
    [parent.id],
  );
  const milestone = (await ok<{ milestones: { id: string; done: number }[] }>("get_overview")).milestones[0];
  assert.equal(milestone?.done, 0, "子が終わっても、親を閉じるまでマイルストーンの完了数は増えない");

  const history = (
    await ok<{ history: { kind: string; by: string; changes?: Record<string, { from: unknown; to: unknown }> }[] }>(
      "get_task",
      { id: first.id },
    )
  ).history;
  assert.deepEqual(
    history.map((e) => [e.kind, e.by, e.changes?.status?.to ?? null]),
    [
      ["task.created", "ai", null],
      ["task.changed", "ai", "doing"],
      ["task.changed", "ai", "done"],
    ],
    "誰がいつ状態を変えたかを返す（メモはタスクの notes にある）",
  );
  const got = await ok<{ id: string; children: { id: string; status: string }[] }>("get_task", { id: parent.id });
  assert.deepEqual(got.children, [
    { id: first.id, title: "先にやる", status: "done" },
    { id: second.id, title: "後でやる", status: "cancelled" },
  ]);
});

test("概要の next は 5 件までにする", async () => {
  for (let i = 0; i < 6; i++) await ok("create_task", { title: `追加 ${i}` });
  assert.equal((await ok<{ next: unknown[] }>("get_overview")).next.length, 5);
});

test("存在しないものや不正な入力は、理由つきのエラーにする", async () => {
  const missing = await call("get_task", { id: "T-999" });
  assert.deepEqual([missing.isError, /T-999/.test(missing.text)], [true, true]);
  assert.equal((await call("update_task", { id: "T-999", status: "done" })).isError, true);
  assert.equal((await call("create_task", { title: "x", milestone: "M9" })).isError, true);
  assert.equal((await call("get_decision", { number: 99 })).isError, true);
  assert.equal((await call("set_milestone", { id: "M7" })).isError, true, "新しいマイルストーンには title が要る");
});

test("マイルストーンを足し、既存のものは渡した項目だけ変える", async () => {
  type Milestones = { id: string; title: string; goal: string; status: string }[];
  const added = await ok<Milestones>("set_milestone", { id: "M1", title: "次", goal: "動く" });
  assert.deepEqual(added.at(-1), { id: "M1", title: "次", goal: "動く", status: "planned" });
  const updated = await ok<Milestones>("set_milestone", { id: "M1", status: "active" });
  assert.deepEqual(updated.at(-1), { id: "M1", title: "次", goal: "動く", status: "active" });
  assert.equal(updated.length, 2);
});

test("決定記録を足し、一覧・本文・状態の変更ができる", async () => {
  const created = await ok<{ number: number; status: string; file: string }>("create_decision", {
    title: "決める",
    slug: "decide",
    context: "背景",
    decision: "決定",
    consequences: "影響",
  });
  assert.deepEqual([created.number, created.status, created.file], [1, "提案", "docs/decisions/0001-decide.md"]);
  await ok("create_decision", {
    title: "次",
    slug: "next",
    status: "採用",
    context: "c",
    decision: "d",
    consequences: "e",
  });
  assert.deepEqual(
    (await ok<{ number: number; status: string }[]>("list_decisions")).map((d) => [d.number, d.status]),
    [
      [1, "提案"],
      [2, "採用"],
    ],
  );
  assert.match(
    (await ok<{ body: string }>("get_decision", { number: 1 })).body,
    /## 背景\n\n背景\n\n## 決定\n\n決定\n\n## 影響\n\n影響/,
  );
  assert.equal((await ok<{ status: string }>("set_decision_status", { number: 1, status: "却下" })).status, "却下");
  assert.deepEqual(
    (await ok<{ recentDecisions: { number: number; status: string }[] }>("get_overview")).recentDecisions.map((d) => [
      d.number,
      d.status,
    ]),
    [
      [1, "却下"],
      [2, "採用"],
    ],
  );
});

test("教訓を残して、recall で引ける", async () => {
  const lesson = await ok<{ id: string }>("add_lesson", {
    title: "複製で pnpm が install を始める",
    problem: "node_modules を消そうとした",
    fix: "環境変数で止める",
  });
  assert.equal(lesson.id, "L-001");
  const hits = await ok<{ id: string; kind: string }[]>("recall", {
    query: "pnpm が install を始めてしまう",
    limit: 3,
  });
  assert.deepEqual([hits[0]?.id, hits[0]?.kind], ["L-001", "lesson"]);
  assert.ok(hits.length <= 3);
});
