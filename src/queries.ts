// ボードの読み取りクエリ。MCP サーバ（mcp.ts）と CLI（board-cli.ts）の両方が使う。

import { matchLessons } from "./checklist.ts";
import { boardProblems } from "./lint.ts";
import {
  describeTasks,
  getTask,
  nextTasks,
  readDecisions,
  readLessons,
  readTasks,
  snapshot,
  taskHistory,
  TaskStatus,
  type TaskStatus as TaskStatusType,
} from "./store.ts";

export function boardOverview() {
  const s = snapshot();
  const count = Object.fromEntries(TaskStatus.options.map((st) => [st, s.tasks.filter((t) => t.status === st).length]));
  const pick = (st: string) =>
    s.tasks
      .filter((t) => t.status === st)
      .map((t) => ({ id: t.id, title: t.title, milestone: t.milestone, branch: t.branch }));
  return {
    project: { name: s.project.name, summary: s.project.summary },
    milestones: s.project.milestones.map((m) => ({
      ...m,
      tasks: s.tasks.filter((t) => t.milestone === m.id).length,
      done: s.tasks.filter((t) => t.milestone === m.id && t.status === "done").length,
    })),
    count,
    doing: pick("doing"),
    blocked: pick("blocked"),
    review: pick("review"),
    next: nextTasks(s.tasks)
      .slice(0, 5)
      .map((t) => ({ id: t.id, title: t.title, priority: t.priority, parent: t.parent, milestone: t.milestone })),
    stuck: s.tasks.filter((t) => t.stuck).map((t) => ({ id: t.id, title: t.title, reason: t.stuck })),
    closable: s.tasks.filter((t) => t.closable).map((t) => ({ id: t.id, title: t.title })),
    recentDecisions: s.decisions.slice(-5).map(({ number, title, status, date }) => ({ number, title, status, date })),
    git: s.git,
    errors: s.errors,
    problems: boardProblems(),
  };
}

export type ListTasksFilter = {
  status?: TaskStatusType | TaskStatusType[];
  ready?: boolean;
  milestone?: string;
  label?: string;
  parent?: string;
  detail?: boolean;
};

export function boardListTasks({ status, ready, milestone, label, parent, detail }: ListTasksFilter = {}) {
  const { tasks, errors } = readTasks();
  const statuses = status === undefined ? null : Array.isArray(status) ? status : [status];
  const items = describeTasks(tasks)
    .filter(
      (t) =>
        (!statuses || statuses.includes(t.status)) &&
        (ready === undefined || t.ready === ready) &&
        (!milestone || t.milestone === milestone) &&
        (!label || t.labels.includes(label)) &&
        (!parent || t.parent === parent),
    )
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id))
    .map(({ notes, description, created, createdBy, ...t }) =>
      detail ? { ...t, createdBy, description, lastNote: notes.at(-1) ?? null } : { ...t, createdBy },
    );
  const summary = {
    total: items.length,
    ready: items.filter((t) => t.ready).length,
    stuck: items.filter((t) => t.stuck).length,
    closable: items.filter((t) => t.closable).length,
  };
  return errors.length ? { summary, tasks: items, errors } : { summary, tasks: items };
}

export function boardGetTask(id: string) {
  const task = getTask(id);
  const children = readTasks()
    .tasks.filter((t) => t.parent === id)
    .map(({ id, title, status }) => ({ id, title, status }));
  const history = taskHistory(id).map(({ at, actor, kind, data }) => ({
    at,
    by: actor,
    kind,
    ...(typeof data === "object" && data !== null ? data : {}),
  }));
  // 着手のときに、触る範囲に当たる過去の教訓を、探さなくても目に入るようにする
  const checklist = matchLessons(
    readLessons().lessons,
    task.paths.map((path) => ({ path, lines: [] })),
  );
  return { ...task, children, checklist, history: history.filter((e) => e.kind !== "task.noted") };
}

export function boardListDecisions() {
  return readDecisions().map(({ number, title, status, date, file }) => ({ number, title, status, date, file }));
}

export function boardGetDecision(number: number) {
  const d = readDecisions().find((x) => x.number === number);
  if (!d) throw new Error(`決定記録 ${number} は存在しない`);
  return d;
}
