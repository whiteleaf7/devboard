// リポジトリの中のパスの接頭辞どうしを比べる。タスクの触る範囲（paths）と、教訓の引き金が使う

export const normalizePath = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "");

// 区切りの途中では当てない（apps/web は apps/web/x に当たり、apps/webview には当たらない）
const contains = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);

export function pathsOverlap(a: string, b: string): boolean {
  const [x, y] = [normalizePath(a), normalizePath(b)];
  return contains(x, y) || contains(y, x);
}
