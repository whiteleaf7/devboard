// 差分に当たった教訓だけを出す（src/checklist.ts と devboard checklist、get_task の checklist）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { formatChecklist, matchLessons, parseDiff } from "../src/checklist.ts";
import { Lesson } from "../src/schema.ts";
import { useTempBoard } from "./temp-board.ts";

useTempBoard("checklist");
const store = await import("../src/store.ts");
const { applyOps } = await import("../src/ops.ts");
const { boardGetTask } = await import("../src/queries.ts");

const lesson = (id: string, trigger: unknown) =>
  Lesson.parse({ id, title: id, problem: "p", fix: "f", created: "2026-01-01T00:00:00Z", trigger });

const DIFF = `diff --git a/packages/daemon/src/title.ts b/packages/daemon/src/title.ts
index 1111111..2222222 100644
--- a/packages/daemon/src/title.ts
+++ b/packages/daemon/src/title.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const prompt = "old";
+const prompt = spawnSync("x");
--- a/not-a-header.sql
diff --git a/docs/notes.md b/docs/renamed.md
similarity index 90%
rename from docs/notes.md
rename to docs/renamed.md
@@ -1 +1 @@
-# old
+# new
diff --git a/apps/web/gone.ts b/apps/web/gone.ts
deleted file mode 100644
--- a/apps/web/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-readline.createInterface();
`;

test("差分を、ファイルごとの足した・消した行に分ける。見出しの行は数えず、名前を変えたら新しい名前、消したら元の名前", () => {
  assert.deepEqual(parseDiff(DIFF), [
    {
      path: "packages/daemon/src/title.ts",
      lines: ['const prompt = "old";', 'const prompt = spawnSync("x");', "-- a/not-a-header.sql"],
    },
    { path: "docs/renamed.md", lines: ["# old", "# new"] },
    { path: "apps/web/gone.ts", lines: ["readline.createInterface();"] },
  ]);
});

test("引き金のパスの下のファイルか、変えた行の語で当たり、当たらない教訓は出さない", () => {
  const lessons = [
    lesson("L-001", { paths: ["packages/daemon/src/title.ts"], check: "題を実際に付けさせる" }),
    lesson("L-002", { words: ["READLINE"], check: "LF だけで分ける" }),
    lesson("L-003", { paths: ["packages/daemon/"], words: ["readline"], check: "パスの下の行だけを見る" }),
    lesson("L-004", { paths: ["apps/desktop/"], check: "殻を確かめる" }),
    lesson("L-005", { paths: ["packages/daemon/src/title"], check: "区切りの途中では当てない" }),
    lesson("L-006", null),
  ];
  const items = matchLessons(lessons, parseDiff(DIFF));
  assert.deepEqual(
    items.map((i) => [i.id, i.matched]),
    [
      ["L-001", { path: "packages/daemon/src/title.ts", word: null }],
      ["L-002", { path: "apps/web/gone.ts", word: "READLINE" }],
    ],
  );
  assert.deepEqual(matchLessons(lessons, parseDiff("diff --git a/README.md b/README.md\n@@ -1 +1 @@\n+x\n")), []);
});

test("パスだけで当てるときは、範囲が重なれば当たり、語の引き金は当たらない", () => {
  const lessons = [
    lesson("L-001", { paths: ["packages/daemon/src/"], check: "c" }),
    lesson("L-002", { paths: ["packages/daemon/"], words: ["readline"], check: "c" }),
  ];
  assert.deepEqual(
    matchLessons(lessons, [{ path: "packages/", lines: [] }]).map((i) => i.id),
    ["L-001"],
  );
});

test("一覧の文は、当たった場所と確かめることを並べ、当たらなければ空", () => {
  const items = matchLessons([lesson("L-002", { words: ["readline"], check: "LF だけで分ける" })], parseDiff(DIFF));
  assert.equal(
    formatChecklist(items),
    "差分に当たった教訓 1 件。取り込む前に確かめる（devboard checklist）:\n- L-002 L-002（apps/web/gone.ts の「readline」）\n  確かめる: LF だけで分ける",
  );
  assert.equal(formatChecklist([]), "");
});

test("引き金は paths か words のどちらかと、確かめることが要る", () => {
  assert.throws(() => lesson("L-001", { check: "c" }), /paths か words/);
  assert.throws(() => lesson("L-001", { paths: ["a/"] }));
});

test("引き金の無い教訓にあとから付け外しでき、ほかの項目は変わらない。get_task は paths に当たった教訓を出す", () => {
  const [lessonId, taskId] = applyOps([
    { op: "add_lesson", args: { title: "デーモンの罠", problem: "p", fix: "f" } },
    { op: "create_task", args: { title: "デーモンを直す", paths: ["packages/daemon/"] } },
  ]);
  assert.equal(store.readLessons().lessons[0]?.trigger, null, "引き金の無い教訓も読める");
  assert.deepEqual(boardGetTask(taskId!).checklist, []);

  applyOps([
    { op: "update_lesson", args: { id: lessonId, trigger: { paths: ["packages/daemon/src/"], check: "再起動する" } } },
  ]);
  const updated = store.readLessons().lessons[0]!;
  assert.deepEqual(updated.trigger, { paths: ["packages/daemon/src/"], words: [], check: "再起動する" });
  assert.equal(updated.title, "デーモンの罠", "指定していない項目は変わらない");
  assert.deepEqual(
    boardGetTask(taskId!).checklist.map((i) => [i.id, i.check]),
    [[lessonId, "再起動する"]],
  );

  assert.throws(() => store.updateLesson("L-999", { trigger: null }), /L-999 は存在しない/);
  store.updateLesson(lessonId!, { trigger: null });
  assert.equal(store.readLessons().lessons[0]?.trigger, null, "null で外せる");
});

const SCRIPT = join(import.meta.dirname, "../src/checklist-cli.ts");
const checklistCli = (args: string[], input?: string) => {
  const result = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", input });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

test("devboard checklist は、標準入力の差分かパスに当たった教訓だけを出し、当たらなければ何も出さない", () => {
  store.createLesson({
    title: "readline は Unicode の改行でも分ける",
    problem: "p",
    fix: "f",
    trigger: { words: ["readline"], check: "LF だけで分ける" },
  });
  store.createLesson({
    title: "殻の Info.plist",
    problem: "p",
    fix: "f",
    trigger: { paths: ["apps/desktop/"], check: "postBuild で足す" },
  });

  const hit = checklistCli([], DIFF);
  assert.equal(hit.code, 0, hit.err);
  assert.match(hit.out, /readline は Unicode/);
  assert.doesNotMatch(hit.out, /Info\.plist/);

  const json = JSON.parse(checklistCli(["--json", "apps/desktop/src/bun/index.ts"]).out) as { lessons: { title: string }[] };
  assert.deepEqual(
    json.lessons.map((l) => l.title),
    ["殻の Info.plist"],
  );

  const miss = checklistCli([], "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n+x\n");
  assert.deepEqual([miss.code, miss.out], [0, ""]);
});
