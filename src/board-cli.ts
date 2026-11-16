// MCP が使えないエージェントやシェルから、ボードを読む CLI（`devboard show`）。
//   devboard show [overview]
//   devboard show tasks [--status todo] [--ready] [--milestone M1] [--label bug] [--parent T-001] [--detail]
//   devboard show task <T-NNN>
//   devboard show decisions
//   devboard show decision <番号>

import { boardGetDecision, boardGetTask, boardListDecisions, boardListTasks, boardOverview } from "./queries.ts";
import { TaskStatus } from "./store.ts";

const USAGE =
  "使い方: devboard show [overview | tasks [--status <状態>] [--ready] [--milestone <ID>] [--label <名>] [--parent <ID>] [--detail] | task <T-NNN> | decisions | decision <番号>]";

export function runCli(argv: string[]): unknown {
  const [sub = "overview", ...rest] = argv;
  switch (sub) {
    case "overview":
      if (rest.length) throw new Error(USAGE);
      return boardOverview();
    case "tasks": {
      let status: string | undefined;
      let ready: boolean | undefined;
      let milestone: string | undefined;
      let label: string | undefined;
      let parent: string | undefined;
      let detail = false;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        const next = () => {
          const v = rest[++i];
          if (!v) throw new Error(`${arg} の値が無い\n${USAGE}`);
          return v;
        };
        if (arg === "--status") status = next();
        else if (arg === "--ready") ready = true;
        else if (arg === "--milestone") milestone = next();
        else if (arg === "--label") label = next();
        else if (arg === "--parent") parent = next();
        else if (arg === "--detail") detail = true;
        else throw new Error(`知らない引数: ${arg}\n${USAGE}`);
      }
      const parsedStatus = status === undefined ? undefined : TaskStatus.parse(status);
      return boardListTasks({ status: parsedStatus, ready, milestone, label, parent, detail });
    }
    case "task": {
      if (rest.length !== 1) throw new Error(USAGE);
      return boardGetTask(rest[0]!);
    }
    case "decisions":
      if (rest.length) throw new Error(USAGE);
      return boardListDecisions();
    case "decision": {
      const n = Number(rest[0]);
      if (rest.length !== 1 || !Number.isInteger(n) || n <= 0) throw new Error(USAGE);
      return boardGetDecision(n);
    }
    default:
      throw new Error(`知らないサブコマンド: ${sub}\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(runCli(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error(`devboard show: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
