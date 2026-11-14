// 活動の画面の「依存関係」の図の配置。マイルストーンの中の依存（dependsOn）を、深さごとの段に並べる。副作用を持たない

type TaskRef = { id: string; title: string; status: string; milestone: string | null; dependsOn: string[] };

export type GraphNode = {
  id: string;
  title: string;
  status: string;
  milestone: string | null;
  // 0 が先頭の段。依存先のうち最も深いものの次の段に置く
  layer: number;
  // つながったタスクのまとまりの番号。まとまりごとに横に並べ、終わったまとまりを隠せるようにする
  component: number;
  // まとまりの段の中の並び（左から 0）
  order: number;
  // ほかのマイルストーンのタスク。つながりを示すために 1 歩だけ含める
  external: boolean;
  // このタスクが終わるのを（間接に）待っているタスクの数。多いものが詰まりどころになる
  downstream: number;
};

export type DependencyGraph = {
  nodes: GraphNode[];
  // from が終わると to に着手できる
  edges: { from: string; to: string }[];
  // 依存のつながりが無いので図に出していない、このマイルストーンのタスクの数
  unlinked: number;
};

const byId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function downstreamCounts(tasks: TaskRef[]): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.dependsOn) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const seen = new Set<string>();
    const walk = (id: string) => {
      for (const next of dependents.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        walk(next);
      }
    };
    walk(t.id);
    counts.set(t.id, seen.size);
  }
  return counts;
}

// 番号は、まとまりの中で最も小さいタスク ID の順に 0 から振る
function componentsOf(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const root = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const r = root.get(id) ?? id;
    return r === id ? id : find(r);
  };
  for (const e of edges) root.set(find(e.from), find(e.to));
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  const ordered = [...groups.values()].map((g) => g.toSorted(byId)).sort((a, b) => byId(a[0]!, b[0]!));
  return new Map(ordered.flatMap((g, i) => g.map((id) => [id, i] as const)));
}

export function dependencyGraph(tasks: TaskRef[], milestone: string): DependencyGraph {
  const task = new Map(tasks.map((t) => [t.id, t]));
  const mine = tasks.filter((t) => t.milestone === milestone);
  const edges = tasks
    .flatMap((t) => t.dependsOn.map((d) => ({ from: d, to: t.id })))
    .filter(
      (e) => task.has(e.from) && (task.get(e.from)?.milestone === milestone || task.get(e.to)?.milestone === milestone),
    );
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const parents = new Map(ids.map((id) => [id, edges.filter((e) => e.to === id).map((e) => e.from)]));

  const layers = new Map<string, number>();
  const layerOf = (id: string): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    const layer = Math.max(-1, ...(parents.get(id) ?? []).map(layerOf)) + 1;
    layers.set(id, layer);
    return layer;
  };
  for (const id of ids) layerOf(id);

  const components = componentsOf(ids, edges);

  // 交差を減らすため、まとまりの段ごとに、依存先の並びの平均の順に並べる
  const order = new Map<string, number>();
  const weight = (id: string) => {
    const ps = parents.get(id) ?? [];
    return ps.length ? ps.reduce((sum, p) => sum + (order.get(p) ?? 0), 0) / ps.length : 0;
  };
  const depth = Math.max(-1, ...layers.values()) + 1;
  for (let layer = 0; layer < depth; layer++) {
    for (const component of new Set(components.values())) {
      const row = ids.filter((id) => layers.get(id) === layer && components.get(id) === component);
      row.sort((a, b) => weight(a) - weight(b) || byId(a, b)).forEach((id, i) => order.set(id, i));
    }
  }

  const downstream = downstreamCounts(tasks);
  const nodes = ids
    .map((id) => {
      const t = task.get(id)!;
      return {
        id,
        title: t.title,
        status: t.status,
        milestone: t.milestone,
        layer: layers.get(id) ?? 0,
        component: components.get(id) ?? 0,
        order: order.get(id) ?? 0,
        external: t.milestone !== milestone,
        downstream: downstream.get(id) ?? 0,
      };
    })
    .sort((a, b) => a.component - b.component || a.layer - b.layer || a.order - b.order);
  const linked = new Set(ids);
  return { nodes, edges, unlinked: mine.filter((t) => !linked.has(t.id)).length };
}
