import { getPref, subscribePrefs } from "./prefs";
import { applyTheme, savedTheme } from "./theme";

const FONTS = {
  system: "",
  serif: "var(--serif)",
  mono: "var(--mono)",
} as const;

/** Write every interface preference onto the document, where the stylesheet reads it. */
export function applyPrefs(): void {
  const root = document.documentElement;
  const scale = getPref("uiScale");
  // `zoom` scales used values, but 100vh is the real window, so full-height boxes divide it back.
  root.style.setProperty("zoom", scale === 100 ? "" : String(scale / 100));
  root.style.setProperty("--ui-zoom", String(scale / 100));
  root.dataset.glow = getPref("glow") ? "on" : "off";
  root.dataset.contrast = getPref("highContrast") ? "high" : "normal";

  const motion = getPref("motion");
  const systemReduces =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.dataset.motion = motion === "reduce" || (motion === "system" && systemReduces) ? "reduce" : "full";

  const font = FONTS[getPref("uiFont")];
  if (font) root.style.setProperty("--sans", font);
  else root.style.removeProperty("--sans");

  const theme = savedTheme();
  applyTheme(theme.family, theme.accent);
}

/** Apply now, and again whenever a preference or the operating system's appearance changes. */
export function installPrefEffects(): void {
  applyPrefs();
  subscribePrefs(applyPrefs);
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyPrefs);
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", applyPrefs);
  }
}
