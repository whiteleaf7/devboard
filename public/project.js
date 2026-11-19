// ダッシュボードが見せているプロジェクト。URL の ?project=<id> で選び、無ければダッシュボードを起動したプロジェクト。
// API の呼び出しと画面の切り替えのリンクに付けて、ほかの画面へ移っても同じプロジェクトを見続ける

/** @typedef {{ id: string, name: string, home: boolean }} ProjectEntry */

/** @type {string | null} */
export const project = new URLSearchParams(location.search).get("project");

/**
 * path に、見ているプロジェクトの ?project= を付ける。起動したプロジェクトを見ているときは何も付けない
 * @param {string} path
 */
export function withProject(path) {
  if (!project) return path;
  const url = new URL(path, location.origin);
  url.searchParams.set("project", project);
  return url.pathname + url.search;
}

/**
 * 画面の切り替えのリンクにプロジェクトを付け、2 つ以上のプロジェクトを見られるなら、選ぶ欄を出す。
 * 選んだら、同じ画面のまま、そのプロジェクトを開き直す（開いていたタスクとマイルストーンの図の指定は外す）
 * @param {HTMLSelectElement} select
 */
export async function setupProjectPicker(select) {
  for (const a of document.querySelectorAll(".pages a")) a.setAttribute("href", withProject(a.getAttribute("href") ?? "/"));
  /** @type {ProjectEntry[]} */
  let list;
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) return;
    list = await res.json();
  } catch {
    return;
  }
  if (list.length < 2) return;
  const current = project ?? list.find((p) => p.home)?.id;
  select.replaceChildren(...list.map((p) => new Option(p.name, p.id, false, p.id === current)));
  select.hidden = false;
  select.onchange = () => {
    const url = new URL(location.href);
    url.searchParams.delete("task");
    url.searchParams.delete("graph");
    const chosen = list.find((p) => p.id === select.value);
    if (!chosen || chosen.home) url.searchParams.delete("project");
    else url.searchParams.set("project", chosen.id);
    location.assign(url);
  };
}
