// ボードの保存先。git の外の SQLite に、変更をイベントとして追記し、いまの状態の表を同じトランザクションで更新する。
// どの worktree から使っても同じファイルを読み書きする。

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { repoRoot } from "./repo-root.ts";

// 書き込みが重なったときに待つ時間。書き込みは数ミリ秒で終わる
const BUSY_TIMEOUT_MS = 10_000;

const SCHEMA = `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_subject ON events (subject, seq);
  CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events は追記だけにする'); END;
  CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events は追記だけにする'); END;
  CREATE TABLE tasks (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
  CREATE TABLE lessons (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
  CREATE TABLE project (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
`;

export function boardFile(): string {
  // fl-ignore lib/server-only-missing: Next.js ではなく Node で直接動かす開発ツールのため
  // pnpm --filter はパッケージのディレクトリで動くので、相対パスは呼び出したディレクトリ（INIT_CWD）から解決する
  const explicit = process.env.DEVBOARD_DB || process.env.NAGAYA_BOARD;
  if (explicit) return resolve(process.env.INIT_CWD ?? process.cwd(), explicit);
  // node --test の中から本物のボードに書かないように止める
  if (process.env.NODE_TEST_CONTEXT)
    throw new Error("テストでは DEVBOARD_DB に一時ファイルを指定する（本物のボードに書かないため）");
  return join(homedir(), ".devboard", "boards", `${basename(repoRoot())}.sqlite`);
}

// WAL への切り替えは、待ち時間の設定が効かずにすぐ SQLITE_BUSY を返すことがある（新しいファイルを複数のプロセスが同時に開いたとき）
function whenUnlocked(fn: () => void): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      const busy = e instanceof Error && "errcode" in e && (e.errcode === 5 || e.errcode === 6);
      if (!busy || Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.random() * 40);
    }
  }
}

const opened = new Map<string, DatabaseSync>();

// テストは DEVBOARD_DB を変えて別のボードを使うので、ファイルごとに開いておく
export function board(): DatabaseSync {
  const file = boardFile();
  const existing = opened.get(file);
  if (existing) return existing;
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file) && !process.env.DEVBOARD_DB && !process.env.NAGAYA_BOARD) {
    const legacy = join(homedir(), ".nagaya-dev", "boards", basename(file));
    if (existsSync(legacy)) {
      const src = new DatabaseSync(legacy, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
      try {
        src.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
      } finally {
        src.close();
      }
    }
  }
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  whenUnlocked(() => db.exec("PRAGMA journal_mode = WAL"));
  if ((db.prepare("PRAGMA user_version").get()?.user_version ?? 0) === 0) {
    write(db, () => {
      // 別のプロセスが先に作っていたら、そのまま使う
      if ((db.prepare("PRAGMA user_version").get()?.user_version ?? 0) !== 0) return;
      db.exec(SCHEMA);
      db.exec("PRAGMA user_version = 1");
    });
  }
  opened.set(file, db);
  return db;
}

// 読んでから書くまで（採番を含む）を 1 つのトランザクションにする。IMMEDIATE で始めるので、書き込み同士は順番に並ぶ
export function write<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// rule.observed: observe の決まりに当たった書き込み（断らずに記録だけする。rules.ts の CHECK_MODES）
export type EventKind =
  | "task.created"
  | "task.changed"
  | "task.noted"
  | "rule.observed"
  | "lesson.created"
  | "lesson.changed"
  | "project.changed";
export type BoardEvent = {
  seq: number;
  at: string;
  actor: string | null;
  kind: EventKind;
  subject: string;
  data: unknown;
};

export function appendEvent(db: DatabaseSync, event: Omit<BoardEvent, "seq">): void {
  db.prepare("INSERT INTO events (at, actor, kind, subject, data) VALUES (?, ?, ?, ?, ?)").run(
    event.at,
    event.actor,
    event.kind,
    event.subject,
    JSON.stringify(event.data),
  );
}

const toEvent = (row: Record<string, SQLOutputValue>): BoardEvent => ({
  seq: Number(row.seq),
  at: String(row.at),
  actor: row.actor === null ? null : String(row.actor),
  kind: String(row.kind) as EventKind,
  subject: String(row.subject),
  data: JSON.parse(String(row.data)),
});

export function eventsOf(db: DatabaseSync, subject: string): BoardEvent[] {
  return db
    .prepare("SELECT seq, at, actor, kind, subject, data FROM events WHERE subject = ? ORDER BY seq")
    .all(subject)
    .map(toEvent);
}

export function allEvents(db: DatabaseSync): BoardEvent[] {
  return db.prepare("SELECT seq, at, actor, kind, subject, data FROM events ORDER BY seq").all().map(toEvent);
}

// ダッシュボードが変更を知るため。ほかのプロセスの書き込みも、自分の書き込みも、イベントの番号が増える
export function latestSeq(db: DatabaseSync): number {
  return Number(db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM events").get()?.seq ?? 0);
}
