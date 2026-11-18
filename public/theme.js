// 描画前にテーマと文字の大きさを当てて、ちらつきを防ぐ。テーマの既定は業務（OS の設定には合わせない）。
// テーマはボードの画面の見た目（public/themes/<id>.css）で、明るいか暗いか（scheme）もテーマが決める。
// 活動の画面とダイアログは scheme だけを見て、明るい面か暗い面にする。
// 設定はボードの画面で変え、開いているほかの画面にも storage イベントで反映する

/** @typedef {{ id: string, label: string, scheme: "light" | "dark", color: string }} Theme */

const THEME_KEY = "devboard-theme";
/** @type {Theme[]} 設定の画面に出す順。color はブラウザの枠の色 */
const THEMES = [
  { id: "business", label: "業務", scheme: "light", color: "#f6f7f9" },
  { id: "poster", label: "ポスター（黒）", scheme: "dark", color: "#0c0c0c" },
  { id: "poster-light", label: "ポスター（白）", scheme: "light", color: "#121212" },
  { id: "terminal", label: "管制室", scheme: "dark", color: "#0e0b06" },
  { id: "paper", label: "朝刊", scheme: "light", color: "#f3efe4" },
  { id: "pop", label: "ポップ", scheme: "light", color: "#ffffff" },
  { id: "tategaki", label: "縦書き", scheme: "light", color: "#f4efe2" },
  { id: "motion", label: "無重力", scheme: "dark", color: "#07041a" },
];
const DEFAULT_THEME = "business";

/**
 * @param {string | null} id 知らない ID（ライト／ダークだったころの値も）は既定のテーマにする
 * @returns {Theme}
 */
const themeOf = (id) => THEMES.find((t) => t.id === id) ?? /** @type {Theme} */ (THEMES.find((t) => t.id === DEFAULT_THEME));

/** @param {string} id */
function applyTheme(id) {
  const theme = themeOf(id);
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.scheme = theme.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.color);
}

const storedTheme = () => themeOf(localStorage.getItem(THEME_KEY)).id;

/** @typedef {"small" | "normal" | "large" | "xlarge"} FontSize */

const FONT_SIZE_KEY = "devboard-font-size";
/** @type {FontSize[]} */
const FONT_SIZES = ["small", "normal", "large", "xlarge"];

/** @param {FontSize} size 既定の normal は属性を外し、既定の大きさにする */
function applyFontSize(size) {
  if (size === "normal") delete document.documentElement.dataset.fontSize;
  else document.documentElement.dataset.fontSize = size;
}

/** @returns {FontSize} */
const storedFontSize = () => {
  const value = localStorage.getItem(FONT_SIZE_KEY);
  return FONT_SIZES.find((s) => s === value) ?? "normal";
};

applyTheme(storedTheme());
applyFontSize(storedFontSize());
addEventListener("storage", (e) => {
  if (e.key === THEME_KEY) applyTheme(storedTheme());
  if (e.key === FONT_SIZE_KEY) applyFontSize(storedFontSize());
});
