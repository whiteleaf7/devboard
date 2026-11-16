// ボードの決まり（CLAUDE.md の「作業するとき」）に合わない状態を探す。
// store は書く前と後で比べ、新しく増えた問題があれば書かない。get_overview の problems にも使う。
// done にする瞬間だけに見る決まり（closingProblems）は、決まりができる前に閉じたタスクを problems に出さないために分けている

import { readConfig } from "./config.ts";
import type { Task } from "./schema.ts";

export type RuleProblem = { task: string; check: string; message: string };

const OPEN = ["todo", "doing", "blocked", "review"];
const NEEDS_NOTE: Record<string, string> = {
  done: "done にするときはメモが要る。何を確かめて終えたのかを note に残す",
  cancelled: "cancelled にするときはメモが要る。不要になった理由を note に残す",
  blocked: "blocked にするときはメモが要る。進められない理由と、ユーザーにしてほしいことを note に残す",
};

// start から links をたどって、start 自身に戻ってくるか
function reaches(start: string, first: string[], links: (id: string) => string[]): boolean {
  const seen = new Set<string>();
  const queue = [...first];
  while (queue.length) {
    const id = queue.pop()!;
    if (id === start) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...links(id));
  }
  return false;
}

export function ruleProblems(tasks: Task[], milestones: Set<string>): RuleProblem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const problems: RuleProblem[] = [];
  // 書き込みの決まり（状態の理由、review、親子の終わり方）は、設定の rules.profile が autodev のときだけ使う。つながりの検査は、いつも使う
  const policy = readConfig().rules.profile === "autodev";
  for (const task of tasks) {
    const add = (check: string, message: string) => problems.push({ task: task.id, check, message });
    if (task.milestone && !milestones.has(task.milestone))
      add("broken-link", `マイルストーン ${task.milestone} が無い`);
    if (task.parent && !byId.has(task.parent)) add("broken-link", `親 ${task.parent} が存在しない`);
    for (const dep of task.dependsOn) if (!byId.has(dep)) add("broken-link", `依存先 ${dep} が存在しない`);
    if (task.dependsOn.includes(task.id) || reaches(task.id, task.dependsOn, (id) => byId.get(id)?.dependsOn ?? []))
      add("broken-link", "依存が循環している");
    if (
      reaches(task.id, task.parent ? [task.parent] : [], (id) =>
        [byId.get(id)?.parent].filter((p): p is string => Boolean(p)),
      )
    ) {
      add("broken-link", "親子関係が循環している");
    }
    const needsNote = NEEDS_NOTE[task.status];
    if (policy && needsNote && task.notes.length === 0) add("unexplained-state", needsNote);
    if (policy && task.status === "review" && task.createdBy === "ai")
      add("forbidden-review", "AI のタスクは review にしない。結果を自分で確かめて done にする");
    if (policy && task.status === "done") {
      const open = tasks
        .filter((child) => child.parent === task.id && OPEN.includes(child.status))
        .map((child) => child.id);
      if (open.length) add("parent-closed-early", `子（${open.join(", ")}）が終わっていないのに done になっている`);
    }
  }
  return problems;
}

const key = (p: RuleProblem) => `${p.task}\0${p.check}\0${p.message}`;

// 変更の前には無かった問題。移行で持ち込んだ古い問題は断らず、新しく壊すことだけを止める
export function introducedProblems(before: RuleProblem[], after: RuleProblem[]): RuleProblem[] {
  const existing = new Set(before.map(key));
  return after.filter((p) => !existing.has(key(p)));
}

// テストと静的な検査。コードとテストは同じ思い込みで書くので、これらが通っても「書いたとおり」にしかならない
const CHECK_ONLY = new Set([
  "test",
  "typecheck",
  "lint",
  "check",
  "format",
  "build",
  "install",
  "tsc",
  "vitest",
  "oxlint",
  "biome",
]);
const OPTION_WITH_VALUE = new Set(["--filter", "-F", "--dir", "-C"]);

function isCheckOnly(command: string): boolean {
  const words = command.trim().split(/\s+/).filter(Boolean);
  while (words[0] && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
  const [head, ...rest] = words;
  if (head === "node") return rest[0] === "--test";
  if (head !== "pnpm" && head !== "bun" && head !== "yarn") return head === undefined || CHECK_ONLY.has(head);
  let skipValue = false;
  for (const word of rest) {
    if (skipValue) skipValue = false;
    else if (OPTION_WITH_VALUE.has(word)) skipValue = true;
    else if (!word.startsWith("-") && word !== "run" && word !== "exec") return CHECK_ONLY.has(word);
  }
  return true;
}

// 「動かした: `コマンド` → 結果」の行。テストと静的な検査ではないコマンドと、その結果の両方が要る
export function hasRunEvidence(text: string): boolean {
  return [...text.matchAll(/^[\s>*-]*動かした\s*[:：](.*)$/gm)].some(([, line = ""]) => {
    // コマンドの中の矢印（`a -> b`）で区切らないように、コードの中身を伏せてから探す
    const arrow = line.replace(/`[^`]*`/g, (code) => "_".repeat(code.length)).search(/→|->/);
    if (arrow < 0) return false;
    const result = line
      .slice(arrow)
      .replace(/^(→|->)/, "")
      .trim();
    const commands = [...line.slice(0, arrow).matchAll(/`([^`]+)`/g)].map(([, command = ""]) => command);
    return Boolean(result) && commands.some((command) => !isCheckOnly(command));
  });
}

// docs だけを変えるタスクは、読めば確かめられる
const isDocument = (path: string) => path.startsWith("docs/") || path.endsWith(".md");

// 動かした結果の書き方の案内の続き。プロジェクトの確かめる手段は、設定の rules.verificationHint で渡す
const GENERIC_HINT =
  "（例: 動かした: `<コマンド>` → 一覧に 3 件出た）。CLI やサーバは起動して出力を見る、ボードの操作は DEVBOARD_DB の写しに devboard apply";

const unverifiedMessage = (): string =>
  "振る舞いを変えるタスク（paths か、`Task:` の行でこのタスクを指したコミットに docs 以外がある）は、" +
  "実際に動かした結果をメモに残してから done にする。" +
  "テスト・型チェック・lint・ビルドだけでは足りない。note に「動かした: `コマンド` → 結果」の行を書く" +
  (readConfig().rules.verificationHint || GENERIC_HINT);

// この変更で done になったタスクのうち、動かした結果の無いもの。
// 振る舞いを変えたかは、予定（paths）と、コミットが実際に変えたファイル（committedFiles）の両方で見る。paths を書かずに閉じても抜けられないように
export function closingProblems(
  before: Task[],
  after: Task[],
  committedFiles: (id: string) => string[] = () => [],
): RuleProblem[] {
  if (readConfig().rules.profile === "none") return [];
  const wasDone = new Set(before.filter((t) => t.status === "done").map((t) => t.id));
  return after
    .filter((t) => t.status === "done" && !wasDone.has(t.id))
    .filter((t) => !t.notes.some((note) => hasRunEvidence(note.text)))
    .filter((t) => [...t.paths, ...committedFiles(t.id)].some((path) => !isDocument(path)))
    .map((t) => ({ task: t.id, check: "unverified-done", message: unverifiedMessage() }));
}
