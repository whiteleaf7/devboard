// git にあったボードの JSON（コミットごとの写し）から、SQLite のイベントを作る。
// 写しの間の変化しか分からないので、コミットの間の複数の変更は 1 つのイベントにまとまる。git には触らない

import type { EventKind } from "./board-db.ts";
import type { Lesson, Project, Task } from "./schema.ts";

export type BoardSnapshot = { at: string; tasks: Task[]; lessons: Lesson[]; project: Project | null };
export type ImportedEvent = { at: string; actor: string | null; kind: EventKind; subject: string; data: unknown };

function changesOf(before: Task, after: Task): Record<string, { from: unknown; to: unknown }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => k !== "notes" && k !== "updated"));
  return Object.fromEntries(
    [...keys]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => [k, { from: before[k] ?? null, to: after[k] ?? null }]),
  );
}

function noteEvents(task: Task, from: number): ImportedEvent[] {
  return task.notes
    .slice(from)
    .map((note) => ({ at: note.at, actor: note.by ?? null, kind: "task.noted", subject: task.id, data: { note } }));
}

// 項目の変更をした人は記録に無い。同じ時刻に足されたメモがあれば、その書き手とみなす
function actorOf(task: Task): string | null {
  return task.notes.find((n) => n.at === task.updated)?.by ?? null;
}

export function eventsFromSnapshots(snapshots: BoardSnapshot[]): ImportedEvent[] {
  const events: ImportedEvent[] = [];
  let tasks = new Map<string, Task>();
  let lessons = new Set<string>();
  let project: Project | null = null;

  for (const snapshot of snapshots) {
    for (const task of snapshot.tasks) {
      const before = tasks.get(task.id);
      if (!before) {
        // 最初に見えた写しを、作った時の姿とする（作ってから最初のコミットまでの変更は、ここに含まれる）
        events.push({
          at: task.created,
          actor: task.createdBy,
          kind: "task.created",
          subject: task.id,
          data: { task: { ...task, notes: [] } },
        });
        events.push(...noteEvents(task, 0));
        continue;
      }
      const changes = changesOf(before, task);
      if (Object.keys(changes).length)
        events.push({
          at: task.updated,
          actor: actorOf(task),
          kind: "task.changed",
          subject: task.id,
          data: { changes },
        });
      events.push(...noteEvents(task, before.notes.length));
    }
    for (const lesson of snapshot.lessons) {
      if (!lessons.has(lesson.id))
        events.push({ at: lesson.created, actor: "ai", kind: "lesson.created", subject: lesson.id, data: { lesson } });
    }
    if (snapshot.project && JSON.stringify(snapshot.project) !== JSON.stringify(project)) {
      events.push({
        at: snapshot.at,
        actor: null,
        kind: "project.changed",
        subject: "project",
        data: { from: project, to: snapshot.project },
      });
    }
    tasks = new Map([...tasks, ...snapshot.tasks.map((t) => [t.id, t] as const)]);
    lessons = new Set([...lessons, ...snapshot.lessons.map((l) => l.id)]);
    project = snapshot.project ?? project;
  }
  // 時刻の順に並べる。同じ時刻なら、作った順（作成 → 変更 → メモ）を保つ
  return events
    .map((event, i) => ({ event, i }))
    .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.i - b.i)
    .map(({ event }) => event);
}
