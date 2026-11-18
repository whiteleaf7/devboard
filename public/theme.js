// 描画前にテーマと文字の大きさを当てて、ちらつきを防ぐ。テーマの既定はライト（OS の設定には合わせない）。
// 設定はボードの画面で変え、開いているほかの画面にも storage イベントで反映する

/** @typedef {"light" | "dark"} Theme */

const THEME_KEY = "devboard-theme";
const THEME_COLOR = { light: "#f6f5f2", dark: "#1b1a18" };

/** @param {Theme} theme */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/** @returns {Theme} */
const storedTheme = () => (localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");

/** @typedef {"small" | "normal" | "large" | "xlarge"} FontSize */

const FONT_SIZE_KEY = "devboard-font-size";
/** @type {FontSize[]} */
const FONT_SIZES = ["small", "normal", "large", "xlarge"];

/** @param {FontSize} size 既定の normal は属性を外し、base.css の既定の大きさにする */
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
