// 描画前にテーマを当てて、ちらつきを防ぐ。既定はライト（OS の設定には合わせない）。
// 設定はボードの画面で変え、開いているほかの画面にも storage イベントで反映する

/** @typedef {"light" | "dark"} Theme */

const THEME_KEY = "nagaya-devboard-theme";
const THEME_COLOR = { light: "#f6f5f2", dark: "#1b1a18" };

/** @param {Theme} theme */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/** @returns {Theme} */
const storedTheme = () => (localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");

applyTheme(storedTheme());
addEventListener("storage", (e) => {
  if (e.key === THEME_KEY) applyTheme(storedTheme());
});
