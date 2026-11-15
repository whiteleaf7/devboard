// 開発用の MCP サーバ（stdio）。.mcp.json や .codex/config.toml から devboard として登録している。
// タスク・マイルストーン・決定記録を読み書きする。データはダッシュボードと共有（store.ts）。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  TaskStatus,
  TaskCreateInput,
  TaskUpdateInput,
  DECISION_STATUSES,
  readTasks,
  createTask,
  updateTask,
  readDecisions,
  createDecision,
  setDecisionStatus,
  setMilestone,
  MilestoneInput,
  LessonInput,
  createLesson,
  readLessons,
  readProject,
} from "./store.ts";
import { ensureServer } from "./launcher.ts";
import { boardGetDecision, boardGetTask, boardListDecisions, boardListTasks, boardOverview } from "./queries.ts";
import { buildDocs, recall } from "./recall.ts";

const INSTRUCTIONS = `${readProject().name} の開発ボード。
作業を始めるときは get_overview で現在のマイルストーン、進行中のタスク、次に着手できるタスク（next）、進められないタスク（stuck）を確認する。
「未着手をすべて進めて」のような一括の依頼は、list_tasks(status: "todo") で全体を見て、ready のものを order の順に進め、1 件終わるたびに list_tasks を取り直す。ready が 0 件になったら終える。stuck のものは理由を添えてユーザーに返す。
ユーザーの大まかな依頼は、依頼そのものを親タスクとして登録し（説明に依頼文をそのまま残す）、1 セッションで終わる大きさの子タスク（parent）に分ける。順番があるものは dependsOn でつなぐ。
不要になったタスクは消さずに cancelled にし、理由を note に残す。
ダッシュボードは見るだけで、ボードに書くのは AI だけ。ユーザーの依頼を受けて、AI が登録・編集する。過去に画面から書かれた createdBy: user のタスクや by: user のメモは、ユーザーの指示として扱う。
作業に入るタスクは update_task で status を doing にし、区切りごとに note で経過を残す。結果は自分で確かめて done にする（ユーザーの確認待ちの review は使わない）。paths に docs 以外があるタスクは、テストだけでなく実際に動かし、done のメモに「動かした: \`コマンド\` → 結果」の行を入れる（手段は docs/verification.md）。
方針の判断も AI が行い、理由を create_decision か note に残す。AI に物理的にできないこと（ログイン、支払い、外部への公開など）だけ blocked にして、ユーザーにしてほしいことを note に書く。
設計上の判断をしたら create_decision で docs/decisions/ に記録する（後から覆すときは新しい記録を作り、古い方を「置き換え」にする）。
ユーザーに見せたいときは、pnpm board:tailscale を実行して出力された Tailscale の URL を返す（ユーザーは別の端末から開く。ブラウザで開くのはユーザー）。Tailscale が動いていないときだけ open_dashboard のローカルの URL を返し、理由を添える。`;

const server = new McpServer({ name: "devboard", version: "0.1.0" }, { instructions: INSTRUCTIONS });

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const tool = <T>(fn: () => T | Promise<T>) =>
  Promise.resolve()
    .then(fn)
    .then(json)
    .catch((e: unknown) => ({
      isError: true,
      content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
    }));

server.registerTool(
  "get_overview",
  {
    description:
      "マイルストーン、状態ごとのタスク数、進行中・ブロック中のタスク、最近の決定記録、git の状態をまとめて返す。git.uncommittedDecisions は main の worktree に残った未コミットの決定記録（作業者が書いたもの。司令塔が自分のブランチに移して取り込む）",
    annotations: { readOnlyHint: true },
  },
  () => tool(() => boardOverview()),
);

server.registerTool(
  "list_tasks",
  {
    description: `タスクの一覧。未着手（todo）は着手する順（order）に並び、それ以外は ID 順。
各タスクに ready（今すぐ着手できる）、waitingOn（終わっていない依存先）、stuck（AI だけでは進められない理由）、children、closable（子がすべて終わった親）、overlaps（触る範囲 paths が重なる進行中のタスク）が付く。
「未着手をすべて進める」ときは status: todo で全体を見て、ready のものから順に進める。worktree で並行して着手するのは、ready で overlaps が空のものだけ。説明も要るときは detail: true`,
    inputSchema: {
      status: z
        .union([TaskStatus, z.array(TaskStatus)])
        .optional()
        .describe('この状態だけに絞る。複数なら配列（例: ["todo", "doing"]）'),
      ready: z.boolean().optional().describe("true なら今すぐ着手できるものだけ"),
      milestone: z.string().optional().describe("このマイルストーン ID だけに絞る"),
      label: z.string().optional().describe("このラベルを持つものだけに絞る"),
      parent: z.string().optional().describe("このタスクの子だけに絞る"),
      detail: z.boolean().optional().describe("true なら説明と最新のメモも含める"),
    },
    annotations: { readOnlyHint: true },
  },
  (filter) => tool(() => boardListTasks(filter)),
);

server.registerTool(
  "get_task",
  {
    description:
      "タスク 1 件の全項目（説明・メモを含む）と、子タスクの一覧、変更の履歴（history: いつ・誰が（user / ai）・何を変えたか）。ユーザーが変えた状態や優先度を戻す前に history を見る",
    inputSchema: { id: z.string().describe("例: T-001") },
    annotations: { readOnlyHint: true },
  },
  ({ id }) => tool(() => boardGetTask(id)),
);

server.registerTool(
  "create_task",
  {
    description:
      "タスクを追加する。ID は自動採番（T-001 形式）。大きな依頼は親タスクを作ってから、parent を指定した子タスクに分ける",
    inputSchema: TaskCreateInput.shape,
  },
  (input) => tool(() => createTask(input)),
);

server.registerTool(
  "update_task",
  {
    description: "タスクを更新する。指定した項目だけ変わる。note を渡すとメモの履歴に追記される",
    inputSchema: { id: z.string(), ...TaskUpdateInput.shape },
  },
  ({ id, ...patch }) => tool(() => updateTask(id, patch)),
);

server.registerTool(
  "set_milestone",
  {
    description: "マイルストーンを追加、または既存のものを更新する（ID が一致すれば更新）",
    inputSchema: MilestoneInput.shape,
  },
  (input) => tool(() => setMilestone(input).milestones),
);

server.registerTool(
  "list_decisions",
  {
    description: "決定記録（docs/decisions/）の一覧",
    annotations: { readOnlyHint: true },
  },
  () => tool(() => boardListDecisions()),
);

server.registerTool(
  "get_decision",
  {
    description: "決定記録 1 件の本文",
    inputSchema: { number: z.number().int().positive() },
    annotations: { readOnlyHint: true },
  },
  ({ number }) => tool(() => boardGetDecision(number)),
);

server.registerTool(
  "create_decision",
  {
    description: "決定記録を docs/decisions/NNNN-slug.md として追加する。番号は自動採番",
    inputSchema: {
      title: z.string().min(1),
      slug: z.string().describe("ファイル名に使う英小文字とハイフン（例: app-architecture）"),
      status: z.enum(DECISION_STATUSES).optional().describe("既定は 提案"),
      context: z.string().describe("背景: なぜ決める必要があったか、検討した選択肢"),
      decision: z.string().describe("決定: 何を選んだか"),
      consequences: z.string().describe("影響: 良くなること、諦めたこと、後で見直す条件"),
    },
  },
  (input) => tool(() => createDecision(input)),
);

server.registerTool(
  "set_decision_status",
  {
    description: "決定記録の状態を変える（提案 → 採用 など）",
    inputSchema: { number: z.number().int().positive(), status: z.enum(DECISION_STATUSES) },
  },
  ({ number, status }) => tool(() => setDecisionStatus(number, status)),
);

server.registerTool(
  "open_dashboard",
  {
    description: "ダッシュボードが動いていなければ起動し、URL を返す",
    annotations: { readOnlyHint: true },
  },
  () => tool(() => ensureServer()),
);

server.registerTool(
  "recall",
  {
    description:
      "過去のタスク・決定記録・教訓から、質問に関係の深いものを探す。似た作業を始める前や、なぜそう決めたかを知りたいときに使う",
    inputSchema: {
      query: z.string().min(1).describe("探したいこと。日本語の文でよい"),
      limit: z.number().int().positive().max(20).optional().describe("返す件数。既定は 5"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ query, limit }) =>
    tool(() => recall(query, buildDocs(readTasks().tasks, readDecisions(), readLessons().lessons), limit ?? 5)),
);

server.registerTool(
  "add_lesson",
  {
    description:
      "教訓をボードに残す。うまくいかなかったこと、遠回りしたこと、環境の罠と、その対処を書く。次のセッションが recall で引き出す",
    inputSchema: LessonInput.shape,
  },
  (input) => tool(() => createLesson(input)),
);

await server.connect(new StdioServerTransport());
