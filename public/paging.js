// 長い一覧を先頭から limit 件だけ見せ、残りは「さらに表示」で step 件ずつ開く

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 */
export function page(items, limit) {
  return { shown: items.slice(0, limit), rest: Math.max(0, items.length - limit) };
}

/**
 * @param {number} limit
 * @param {number} step
 * @param {number} total
 */
export function nextLimit(limit, step, total) {
  return Math.min(limit + step, total);
}
