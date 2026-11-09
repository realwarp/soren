import type { ComponentType } from "react";
import {
  DatabaseIcon,
  EyeIcon,
  PaletteIcon,
  SlidersIcon,
  SparkIcon,
  WorkflowIcon,
  WrenchIcon,
} from "../components/Icons";
import type { CoreSettings } from "../types";
import type { Size } from "./gutter";

/**
 * The page runs from the settings anyone touches to the ones almost no one should. A tier
 * is a stretch of that slope; the order of SECTIONS, and of the groups inside a section, is
 * the order they appear in, so adding a setting means choosing how far down it belongs.
 */
export const TIERS = [
  { id: "General", sub: "Everyday" },
  { id: "Working style", sub: "How Soren behaves" },
  { id: "Advanced", sub: "Limits and storage" },
  { id: "Hyper-advanced", sub: "Repair" },
] as const;

export type Tier = (typeof TIERS)[number]["id"];

export const SECTIONS = [
  { id: "models", title: "Models", sub: "Source · reasoning", tier: "General", icon: SparkIcon },
  { id: "appearance", title: "Appearance", sub: "Theme · scale", tier: "General", icon: PaletteIcon },
  { id: "interface", title: "Interface", sub: "Slots · keys", tier: "Working style", icon: SlidersIcon },
  { id: "routing", title: "Model routing", sub: "Limits · cloud model", tier: "Advanced", icon: WorkflowIcon },
  { id: "look", title: "Look & feel", sub: "Accent · type", tier: "Advanced", icon: EyeIcon },
  { id: "data", title: "Data & privacy", sub: "Export", tier: "Advanced", icon: DatabaseIcon },
  { id: "maintenance", title: "Maintenance", sub: "Reset", tier: "Hyper-advanced", icon: WrenchIcon },
] as const satisfies readonly {
  id: string;
  title: string;
  sub: string;
  tier: Tier;
  icon: ComponentType<{ size?: number }>;
}[];

export type SectionId = (typeof SECTIONS)[number]["id"];

export type ActionId =
  | "copySettings"
  | "openFolder"
  | "resetInterface"
  | "resetBehaviour"
  | "resetAll";

export type CustomId = "accent" | "import";

interface Base {
  id: string;
  section: SectionId;
  /** The small heading above a run of related cells. */
  group: string;
  label: string;
  hint?: string;
  size: Size;
  /** Fuller explanation, shown in the gutter beside the cell. */
  note?: string;
}

type Option = { value: string | number; label: string };

export type Def = Base &
  (
    | { kind: "toggle"; store: "pref" | "core"; key: string }
    | { kind: "choice"; store: "pref" | "core"; key: string; options: Option[] }
    | {
        kind: "number";
        store: "pref" | "core";
        key: string;
        min: number;
        max: number;
        step: number;
        unit?: string;
        format?: (value: number) => string;
      }
    | { kind: "text"; store: "core"; key: string; placeholder: string }
    | { kind: "key"; key: string }
    | {
        /** Sets several core settings at once; selected while they all match. */
        kind: "preset";
        options: { id: string; label: string; patch: Partial<CoreSettings> }[];
      }
    | { kind: "action"; action: ActionId; button: string; danger?: boolean }
    | { kind: "custom"; custom: CustomId }
  );

const hundredths = (value: number) => (value / 100).toFixed(2);

export const DEFS: Def[] = [
  // ── General · Appearance ────────────────────────────────────────────────
  {
    id: "uiScale", section: "appearance", group: "Size", label: "Text size",
    hint: "Scales the whole interface", size: "L",
    kind: "number", store: "pref", key: "uiScale", min: 80, max: 140, step: 10, unit: "%",
  },
  {
    id: "followSystem", section: "appearance", group: "Size", label: "Follow system",
    hint: "Switch light and dark with macOS", size: "L",
    kind: "toggle", store: "pref", key: "followSystem",
    note: "When on, the theme you pick above is used in its light form by day and its dark twin when the system is dark: Light and Dark pair up, as do the two Solarized themes.",
  },

  // ── Working style · Interface ───────────────────────────────────────────
  {
    id: "slotFreshDays", section: "interface", group: "Clipboard slots", label: "Stays green for",
    hint: "A stored container is green until then", size: "M",
    kind: "number", store: "pref", key: "slotFreshDays", min: 0, max: 365, step: 1, unit: "d",
  },
  {
    id: "slotYellowDays", section: "interface", group: "Clipboard slots", label: "Yellow at",
    hint: "Fades from green to yellow by this age", size: "M",
    kind: "number", store: "pref", key: "slotYellowDays", min: 0, max: 365, step: 1, unit: "d",
  },
  {
    id: "slotRedDays", section: "interface", group: "Clipboard slots", label: "Red at",
    hint: "Fades from yellow to red by this age", size: "M",
    kind: "number", store: "pref", key: "slotRedDays", min: 0, max: 365, step: 1, unit: "d",
  },
  {
    id: "motion", section: "interface", group: "Accessibility", label: "Motion",
    hint: "System follows macOS “Reduce motion”", size: "M",
    kind: "choice", store: "pref", key: "motion",
    options: [
      { value: "system", label: "System" },
      { value: "reduce", label: "Reduced" },
      { value: "full", label: "Full" },
    ],
  },
  {
    id: "highContrast", section: "interface", group: "Accessibility", label: "High contrast",
    hint: "Stronger text and edges", size: "M",
    kind: "toggle", store: "pref", key: "highContrast",
  },
  {
    id: "shortcutSettings", section: "interface", group: "Shortcuts", label: "Open settings",
    hint: "Click, then press a key", size: "M",
    kind: "key", key: "shortcutSettings",
  },

  // ── Advanced · Model routing ────────────────────────────────────────────
  {
    id: "temperaturePct", section: "routing", group: "Sampling and limits", label: "Temperature",
    hint: "Lower is steadier", size: "M",
    kind: "number", store: "core", key: "temperaturePct", min: 0, max: 100, step: 5, format: hundredths,
  },
  {
    id: "requestTimeoutSecs", section: "routing", group: "Sampling and limits", label: "Request timeout",
    hint: "One trip to the model", size: "M",
    kind: "number", store: "core", key: "requestTimeoutSecs", min: 20, max: 600, step: 10, unit: "s",
  },

  // ── Advanced · Look & feel ──────────────────────────────────────────────
  {
    id: "accent", section: "look", group: "Colour", label: "Custom accent",
    hint: "Any colour, in place of the swatches", size: "L",
    kind: "custom", custom: "accent",
  },
  {
    id: "glow", section: "look", group: "Colour", label: "Background glow",
    hint: "The soft tint behind the canvas", size: "L",
    kind: "toggle", store: "pref", key: "glow",
  },
  {
    id: "uiFont", section: "look", group: "Type", label: "Interface font",
    hint: "Serif and mono use the app's own faces", size: "XL",
    kind: "choice", store: "pref", key: "uiFont",
    options: [
      { value: "system", label: "System" },
      { value: "serif", label: "Serif" },
      { value: "mono", label: "Mono" },
    ],
  },

  // ── Advanced · Data & privacy ───────────────────────────────────────────
  {
    id: "copySettings", section: "data", group: "Export and import", label: "Settings",
    hint: "Without any keys", size: "M",
    kind: "action", action: "copySettings", button: "Copy",
  },
  {
    id: "importSettings", section: "data", group: "Export and import", label: "Import settings",
    hint: "Paste what you copied", size: "XL",
    kind: "custom", custom: "import",
  },
  {
    id: "openFolder", section: "data", group: "On this device", label: "Data folder",
    hint: "Settings and usage counts", size: "L",
    kind: "action", action: "openFolder", button: "Show in Finder",
  },

  {
    id: "cloudAgentEnabled", section: "routing", group: "Cloud model", label: "Use the cloud model",
    hint: "Draws workflows and writes step prompts", size: "M",
    kind: "toggle", store: "core", key: "cloudAgentEnabled",
    note: "The workflow button and Polish send the workflow to this cloud model. Off, they do nothing and prompts stay as the template wrote them. Past the caps below, requests wait or stop.",
  },
  {
    id: "cloudAgentModel", section: "routing", group: "Cloud model", label: "Model",
    hint: "Uses your Gemini key", size: "XL",
    kind: "text", store: "core", key: "cloudAgentModel", placeholder: "gemini-3.5-flash-lite",
  },
  {
    id: "cloudAgentDailyCap", section: "routing", group: "Cloud model", label: "Daily cap",
    hint: "Requests a day, then it stops", size: "M",
    kind: "number", store: "core", key: "cloudAgentDailyCap", min: 0, max: 5000, step: 50,
  },
  {
    id: "cloudAgentPerMinute", section: "routing", group: "Cloud model", label: "Per minute",
    size: "M",
    kind: "number", store: "core", key: "cloudAgentPerMinute", min: 1, max: 60, step: 1,
  },

  // ── Hyper-advanced · Maintenance ────────────────────────────────────────
  {
    id: "resetInterface", section: "maintenance", group: "Reset", label: "Interface",
    hint: "Motion, keys, slot ages", size: "M",
    kind: "action", action: "resetInterface", button: "Reset",
  },
  {
    id: "resetBehaviour", section: "maintenance", group: "Reset", label: "Behaviour",
    hint: "Limits and the cloud model", size: "M",
    kind: "action", action: "resetBehaviour", button: "Reset",
  },
  {
    id: "resetAll", section: "maintenance", group: "Reset", label: "Everything",
    hint: "Also theme. Keys stay.", size: "M",
    kind: "action", action: "resetAll", button: "Reset all…", danger: true,
  },
];

/** The definitions of one section, grouped in the order they are declared. */
export function groupsOf(section: SectionId): { group: string; defs: Def[] }[] {
  const out: { group: string; defs: Def[] }[] = [];
  for (const def of DEFS) {
    if (def.section !== section) continue;
    const last = out[out.length - 1];
    if (last && last.group === def.group) last.defs.push(def);
    else out.push({ group: def.group, defs: [def] });
  }
  return out;
}
