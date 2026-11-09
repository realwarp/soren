import { useSyncExternalStore } from "react";

/**
 * Preferences that only the interface reads. They live in this device's local storage, one
 * key each, and a change reaches every subscriber at once. Settings the backend acts on
 * (model limits, the cloud caps) are the other kind: they travel in the config
 * file and are changed through `api.setSettings`.

 * The theme keeps its own module and keys; this is for the rest.
 */
export interface Prefs {
  /** Interface scale, in percent. */
  uiScale: number;
  motion: "system" | "reduce" | "full";
  highContrast: boolean;
  uiFont: "system" | "serif" | "mono";
  glow: boolean;
  /** Follow the operating system's light or dark appearance. */
  followSystem: boolean;
  /** The key that, with Cmd or Ctrl, opens settings. */
  shortcutSettings: string;
  /** Days a stored container stays fully green, when it turns fully yellow, and when it is fully red. */
  slotFreshDays: number;
  slotYellowDays: number;
  slotRedDays: number;
}

export type PrefId = keyof Prefs;

interface Meta<T> {
  default: T;
  /** The values an enumerated preference may take. */
  choices?: readonly string[];
  min?: number;
  max?: number;
}

type MetaTable = { [K in PrefId]: Meta<Prefs[K]> };

export const PREF_META: MetaTable = {
  uiScale: { default: 100, min: 80, max: 140 },
  motion: { default: "system", choices: ["system", "reduce", "full"] },
  highContrast: { default: false },
  uiFont: { default: "system", choices: ["system", "serif", "mono"] },
  glow: { default: true },
  followSystem: { default: false },
  shortcutSettings: { default: "," },
  slotFreshDays: { default: 1, min: 0, max: 365 },
  slotYellowDays: { default: 7, min: 0, max: 365 },
  slotRedDays: { default: 14, min: 0, max: 365 },
};

const PREFIX = "soren.pref.";

/** A value of the right kind and in range, or `undefined`. */
export function checkPref<K extends PrefId>(id: K, value: unknown): Prefs[K] | undefined {
  const meta = PREF_META[id] as Meta<Prefs[K]>;
  if (typeof value !== typeof meta.default) return undefined;
  if (meta.choices) {
    return meta.choices.includes(value as string) ? (value as Prefs[K]) : undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Math.min(meta.max ?? value, Math.max(meta.min ?? value, value)) as Prefs[K];
  }
  if (typeof value === "string") {
    const key = value.length === 1 ? value.toLowerCase() : "";
    return (key || undefined) as Prefs[K] | undefined;
  }
  return value as Prefs[K];
}

const cache = new Map<PrefId, unknown>();
const listeners = new Set<() => void>();

function read<K extends PrefId>(id: K): Prefs[K] {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (raw !== null) {
      const checked = checkPref(id, JSON.parse(raw));
      if (checked !== undefined) return checked;
    }
  } catch {
    // Storage can be unavailable or hold something unreadable; the default stands.
  }
  return PREF_META[id].default as Prefs[K];
}

export function getPref<K extends PrefId>(id: K): Prefs[K] {
  if (!cache.has(id)) cache.set(id, read(id));
  return cache.get(id) as Prefs[K];
}

function notify() {
  listeners.forEach((listener) => listener());
}

export function setPref<K extends PrefId>(id: K, value: Prefs[K]): void {
  const checked = checkPref(id, value);
  if (checked === undefined) return;
  cache.set(id, checked);
  try {
    if (checked === PREF_META[id].default) localStorage.removeItem(PREFIX + id);
    else localStorage.setItem(PREFIX + id, JSON.stringify(checked));
  } catch {
    // Lasts until reload when storage is unavailable.
  }
  notify();
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePref<K extends PrefId>(id: K): Prefs[K] {
  return useSyncExternalStore(subscribePrefs, () => getPref(id));
}

export function allPrefs(): Prefs {
  const out = {} as Record<string, unknown>;
  for (const id of Object.keys(PREF_META) as PrefId[]) out[id] = getPref(id);
  return out as unknown as Prefs;
}

/** Whether a preference differs from its default. */
export function isChanged(id: PrefId): boolean {
  return getPref(id) !== PREF_META[id].default;
}

export function resetPrefs(): void {
  for (const id of Object.keys(PREF_META) as PrefId[]) {
    cache.set(id, PREF_META[id].default);
    try {
      localStorage.removeItem(PREFIX + id);
    } catch {
      // Nothing to remove when storage is unavailable.
    }
  }
  notify();
}

/** Apply the preferences found in `values`, ignoring any that are unknown or invalid. Returns how many took. */
export function importPrefs(values: Record<string, unknown>): number {
  let applied = 0;
  for (const id of Object.keys(PREF_META) as PrefId[]) {
    if (!(id in values)) continue;
    const checked = checkPref(id, values[id]);
    if (checked === undefined) continue;
    setPref(id, checked as never);
    applied += 1;
  }
  return applied;
}
