/**
 * Themes are sets of the same CSS variables the stylesheet already uses, so a theme is
 * applied by writing those variables, not by a second stylesheet. A preview applies the
 * same variables to one element instead of the document.
 */
import { getPref } from "./prefs";

export type ThemeFamily = "light" | "dark" | "solarized-light" | "solarized-dark";

export interface Accent {
  id: string;
  label: string;
  color: string;
}

/** Solarized's eight accents. "default" keeps each family's own. */
export const ACCENTS: Accent[] = [
  { id: "yellow", label: "Yellow", color: "#b58900" },
  { id: "orange", label: "Orange", color: "#cb4b16" },
  { id: "red", label: "Red", color: "#dc322f" },
  { id: "magenta", label: "Magenta", color: "#d33682" },
  { id: "violet", label: "Violet", color: "#6c71c4" },
  { id: "blue", label: "Blue", color: "#268bd2" },
  { id: "cyan", label: "Cyan", color: "#2aa198" },
  { id: "green", label: "Green", color: "#859900" },
];

export const FAMILIES: { id: ThemeFamily; label: string; hint: string; defaultAccent: string }[] = [
  { id: "light", label: "Light", hint: "Neutral grays on white", defaultAccent: "default" },
  { id: "dark", label: "Dark", hint: "Neutral grays on near-black", defaultAccent: "default" },
  { id: "solarized-light", label: "Solarized light", hint: "Warm beige with a choice of accents", defaultAccent: "default" },
  { id: "solarized-dark", label: "Solarized dark", hint: "Deep teal-black with a choice of accents", defaultAccent: "cyan" },
];

type Base = Record<string, string>;

const BASES: Record<ThemeFamily, Base> = {
  light: {
    paper: "#f4f4f4", "paper-raised": "#ffffff", "paper-sunk": "#e9e9e9",
    ink: "#161616", "ink-soft": "#3a3a3a", muted: "#6b6b6b", faint: "#9a9a9a",
    line: "#d8d8d8", "line-soft": "#e6e6e6", amber: "#8a6a2a", "amber-wash": "#ece6d8",
    red: "#a23a30", "red-wash": "#f1dedb",
  },
  dark: {
    paper: "#161616", "paper-raised": "#202020", "paper-sunk": "#101010",
    ink: "#ececec", "ink-soft": "#cacaca", muted: "#9a9a9a", faint: "#707070",
    line: "#343434", "line-soft": "#2a2a2a", amber: "#c99a4a", "amber-wash": "#2e2820",
    red: "#d9685c", "red-wash": "#33211f",
  },
  "solarized-light": {
    paper: "#f5f1e8", "paper-raised": "#fbf8f1", "paper-sunk": "#efe8da",
    ink: "#1b1915", "ink-soft": "#3f3a32", muted: "#72695b", faint: "#9a9080",
    line: "#ded4c2", "line-soft": "#e9e1d2", amber: "#a8651c", "amber-wash": "#f5e7d0",
    red: "#8b3a30", "red-wash": "#f2ddd8",
  },
  "solarized-dark": {
    paper: "#002b36", "paper-raised": "#073642", "paper-sunk": "#00212b",
    ink: "#eee8d5", "ink-soft": "#93a1a1", muted: "#839496", faint: "#657b83",
    line: "#0f4856", "line-soft": "#0a3d4a", amber: "#b58900", "amber-wash": "#1c3a30",
    red: "#dc322f", "red-wash": "#2e2a2c",
  },
};

/** Each family's own accent when none is picked. */
const DEFAULT_ACCENT: Record<ThemeFamily, string> = {
  light: "#2f2f2f",
  dark: "#d4d4d4",
  "solarized-light": "#1f5c56",
  "solarized-dark": "#2aa198",
};

function parse(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16)) as [number, number, number];
}

function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (from: number, to: number) => Math.round(from + (to - from) * amount);
  return `#${[channel(ar, br), channel(ag, bg), channel(ab, bb)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Relative luminance of a hex colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, bl] = parse(hex).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

/** A hex colour the person typed or picked, as the accent id. */
export const isCustomAccent = (id: string) => /^#[0-9a-f]{6}$/i.test(id);

/** The variables for a family and accent, ready to write onto any element. */
export function themeVars(
  family: ThemeFamily,
  accentId: string,
  contrast = false,
): Record<string, string> {
  const base = { ...BASES[family] };
  const chosen = isCustomAccent(accentId)
    ? accentId.toLowerCase()
    : ACCENTS.find((entry) => entry.id === accentId)?.color;
  const accent = chosen ?? DEFAULT_ACCENT[family];
  const dark = family === "dark" || family === "solarized-dark";
  if (contrast) {
    // Pull the quiet greys and hairlines toward the ink so small text and edges survive.
    base.muted = mix(base.muted, base.ink, 0.6);
    base.faint = mix(base.faint, base.ink, 0.55);
    base.line = mix(base.line, base.ink, 0.5);
    base["line-soft"] = mix(base["line-soft"], base.ink, 0.4);
  }
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) vars[`--${name}`] = value;
  vars["--teal"] = accent;
  vars["--teal-deep"] = dark ? mix(accent, "#ffffff", 0.3) : mix(accent, "#000000", 0.35);
  vars["--teal-wash"] = mix(accent, base.paper, dark ? 0.78 : 0.85);
  // Text that sits on an accent fill: light on dark accents, dark on light ones.
  vars["--on-accent"] = luminance(accent) > 0.5 ? "#161616" : "#fffdf8";
  // Stronger amber and red for text and hover fills; they lighten in dark themes to stay readable.
  vars["--amber-deep"] = dark ? mix(base.amber, "#ffffff", 0.3) : mix(base.amber, "#000000", 0.35);
  vars["--red-deep"] = dark ? mix(base.red, "#ffffff", 0.2) : mix(base.red, "#000000", 0.2);
  return vars;
}

const KEY_FAMILY = "soren.theme";
const KEY_ACCENT = "soren.accent";

export function savedTheme(): { family: ThemeFamily; accent: string } {
  try {
    const family = localStorage.getItem(KEY_FAMILY) as ThemeFamily | null;
    const accent = localStorage.getItem(KEY_ACCENT);
    if (family && family in BASES) {
      return { family, accent: accent ?? "default" };
    }
  } catch {
    // Fall through to the default.
  }
  return { family: "solarized-light", accent: "default" };
}

const PAIRS: Record<ThemeFamily, { light: ThemeFamily; dark: ThemeFamily }> = {
  light: { light: "light", dark: "dark" },
  dark: { light: "light", dark: "dark" },
  "solarized-light": { light: "solarized-light", dark: "solarized-dark" },
  "solarized-dark": { light: "solarized-light", dark: "solarized-dark" },
};

/** The family actually shown: the chosen one, or its light or dark twin when following the system. */
export function effectiveFamily(family: ThemeFamily): ThemeFamily {
  if (!getPref("followSystem")) return family;
  const dark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  return PAIRS[family][dark ? "dark" : "light"];
}

export function applyTheme(family: ThemeFamily, accent: string): void {
  const root = document.documentElement;
  const shown = effectiveFamily(family);
  for (const [name, value] of Object.entries(themeVars(shown, accent, getPref("highContrast")))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = shown;
  root.style.colorScheme = shown === "dark" || shown === "solarized-dark" ? "dark" : "light";
  try {
    localStorage.setItem(KEY_FAMILY, family);
    localStorage.setItem(KEY_ACCENT, accent);
  } catch {
    // Lasts until reload when storage is unavailable.
  }
}
