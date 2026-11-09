import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import {
  allPrefs,
  getPref,
  importPrefs,
  resetPrefs,
  setPref,
  subscribePrefs,
} from "../prefs";
import type { PrefId } from "../prefs";
import { PROVIDER_META, PROVIDER_ORDER } from "../providers";
import type {
  CoreSettings,
  Effort,
  LiveProviderId,
  ProviderConfig,
  ProviderConfigUpdate,
  ProviderId,
  ProviderProfile,
  ProviderProfiles,
  ProviderProfileUpdate,
} from "../types";
import { CloseIcon } from "./Icons";
import {
  Bars,
  KeyCapture,
  OptionList,
  Segmented,
  Stepper,
  TextField,
  Toggle,
} from "../settings/controls";
import { Cell, GutterProvider } from "../settings/gutter";
import { SECTIONS, TIERS, groupsOf } from "../settings/registry";
import type { ActionId, Def, SectionId } from "../settings/registry";
import { FamilyGlyph, ThemePreview } from "../settings/ThemePreview";
import { ACCENTS, FAMILIES, applyTheme, isCustomAccent, savedTheme } from "../theme";
import type { ThemeFamily } from "../theme";
import { ConfirmDelete } from "../settings/ConfirmDelete";
import "../settings/settings.css";

interface Props {
  config: ProviderConfig;
  onSave: (update: ProviderConfigUpdate) => Promise<void>;
  onEffort: (effort: Effort) => void;
  /** The backend's config after a behaviour setting changed. */
  onConfig: (config: ProviderConfig) => void;
  onClose: () => void;
}

const EMPTY_QUEUE: Record<LiveProviderId, string[]> = {
  local: [],
  openai: [],
  gemini: [],
  nvidia: [],
  opencode: [],
};

const EMPTY_REMOVED: Record<LiveProviderId, number[]> = {
  local: [],
  openai: [],
  gemini: [],
  nvidia: [],
  opencode: [],
};

const EMPTY_KEYS: Record<LiveProviderId, string> = {
  local: "",
  openai: "",
  gemini: "",
  nvidia: "",
  opencode: "",
};

const EFFORTS: { id: Effort; label: string; hint: string; level: number }[] = [
  { id: "auto", label: "Auto", hint: "The provider decides", level: 0 },
  { id: "low", label: "Low", hint: "Fast, light thinking", level: 1 },
  { id: "medium", label: "Medium", hint: "Balanced depth", level: 2 },
  { id: "high", label: "High", hint: "Slow, deep thinking", level: 3 },
];

const DEFAULT_THEME = { family: "solarized-light" as ThemeFamily, accent: "default" };

/** What the registry-driven cells need from the page around them. */
interface Page {
  core: CoreSettings;
  setCore: (patch: Partial<CoreSettings>) => void;
  run: (action: ActionId) => Promise<string | undefined>;
  theme: { family: ThemeFamily; accent: string };
  pickTheme: (family: ThemeFamily, accent: string) => void;
  applyImport: (text: string) => Promise<string>;
}

const PageContext = createContext<Page | null>(null);

function usePage(): Page {
  const page = useContext(PageContext);
  if (!page) throw new Error("A setting was drawn outside the settings page");
  return page;
}

/** The pref a definition reads, if it is one. */
function prefKeyOf(def: Def): PrefId | null {
  if (def.kind === "key") return def.key as PrefId;
  if ("store" in def && def.store === "pref") return def.key as PrefId;
  return null;
}

function ImportCell({ def }: { def: Def }) {
  const page = usePage();
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function apply() {
    setBusy(true);
    try {
      setMessage(await page.applyImport(text));
      setText("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Cell size={def.size} label={def.label} hint={def.hint}>
      <textarea
        className="s-import"
        rows={3}
        value={text}
        placeholder='{"soren": "settings", …}'
        spellCheck={false}
        aria-label="Settings to import"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="s-import-row">
        <button
          type="button"
          className="btn"
          disabled={busy || text.trim().length === 0}
          onClick={() => void apply()}
        >
          Apply
        </button>
        {message && <span className="s-action-note">{message}</span>}
      </div>
    </Cell>
  );
}

function AccentCell({ def }: { def: Def }) {
  const page = usePage();
  const custom = isCustomAccent(page.theme.accent);
  return (
    <Cell size={def.size} label={def.label} hint={def.hint}>
      <div className="s-accent-row">
        <input
          type="color"
          aria-label="Custom accent colour"
          value={custom ? page.theme.accent.toLowerCase() : "#2aa198"}
          onChange={(event) => page.pickTheme(page.theme.family, event.target.value)}
        />
        <code>{custom ? page.theme.accent.toLowerCase() : "not set"}</code>
        <button
          type="button"
          className="btn quiet small"
          disabled={!custom}
          onClick={() => page.pickTheme(page.theme.family, "default")}
        >
          Use a preset
        </button>
      </div>
    </Cell>
  );
}

function ActionCell({ def, action }: { def: Def; action: ActionId }) {
  const page = usePage();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (def.kind !== "action") return null;

  async function go() {
    setBusy(true);
    try {
      const said = await page.run(action);
      setNote(said ?? null);
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setNote(null), 3500);
    }
  }

  return (
    <Cell
      size={def.size}
      label={def.label}
      hint={note ?? def.hint}
      control={
        <button
          type="button"
          className={`btn ${def.danger ? "quiet danger-text" : ""}`}
          disabled={busy}
          onClick={() => void go()}
        >
          {def.button}
        </button>
      }
    />
  );
}

/** One registry-defined setting, drawn by the kind of control it needs. */
function SettingCell({ def }: { def: Def }) {
  const page = usePage();
  const key = prefKeyOf(def);
  const prefValue = useSyncExternalStore(subscribePrefs, () => (key ? getPref(key) : undefined));

  if (def.kind === "custom") {
    return def.custom === "accent" ? <AccentCell def={def} /> : <ImportCell def={def} />;
  }
  if (def.kind === "action") return <ActionCell def={def} action={def.action} />;

  const panel = def.note
    ? { title: def.label, body: <p className="s-pop-note s-pop-first">{def.note}</p> }
    : undefined;
  const frame = { size: def.size, label: def.label, panel } as const;

  if (def.kind === "preset") {
    const current = def.options.find((option) =>
      Object.entries(option.patch).every(
        ([name, value]) => page.core[name as keyof CoreSettings] === value,
      ),
    );
    return (
      <Cell
        {...frame}
        stack
        hint={current ? def.hint : "Custom thresholds are set under Local helpers"}
        control={
          <Segmented
            label={def.label}
            value={current?.id ?? ""}
            onChange={(id) => {
              const option = def.options.find((entry) => entry.id === id);
              if (option) page.setCore(option.patch);
            }}
            options={def.options.map((option) => ({ id: option.id, label: option.label }))}
          />
        }
      />
    );
  }

  const value = key ? prefValue : page.core[def.key as keyof CoreSettings];
  const write = (next: unknown) => {
    if (key) setPref(key, next as never);
    else if ("key" in def) page.setCore({ [def.key]: next } as Partial<CoreSettings>);
  };

  switch (def.kind) {
    case "toggle":
      return (
        <Cell
          {...frame}
          hint={def.hint}
          control={<Toggle label={def.label} on={Boolean(value)} onChange={write} />}
        />
      );
    case "choice":
      return (
        <Cell
          {...frame}
          stack
          hint={def.hint}
          control={
            <Segmented
              label={def.label}
              value={String(value)}
              onChange={(id) => {
                const option = def.options.find((entry) => String(entry.value) === id);
                if (option) write(option.value);
              }}
              options={def.options.map((option) => ({
                id: String(option.value),
                label: option.label,
              }))}
            />
          }
        />
      );
    case "number":
      return (
        <Cell
          {...frame}
          stack
          hint={def.hint}
          control={
            <Stepper
              label={def.label}
              value={Number(value)}
              min={def.min}
              max={def.max}
              step={def.step}
              unit={def.unit}
              format={def.format}
              onChange={write}
            />
          }
        />
      );
    case "text":
      return (
        <Cell
          {...frame}
          stack
          hint={def.hint}
          control={
            <TextField
              label={def.label}
              value={String(value)}
              placeholder={def.placeholder}
              onCommit={write}
            />
          }
        />
      );
    case "key":
      return (
        <Cell
          {...frame}
          hint={def.hint}
          control={
            <KeyCapture
              label={def.label}
              value={String(value)}
              taken={[]}
              onChange={write}
            />
          }
        />
      );
    default:
      return null;
  }
}

/** The registry's cells for a section, grouped under their small headings. */
function Rows({ section, group }: { section: SectionId; group?: string }) {
  return (
    <>
      {groupsOf(section)
        .filter((entry) => !group || entry.group === group)
        .map((entry) => (
          <Fragment key={entry.group}>
            <h3>{entry.group}</h3>
            <div className="s-grid">
              {entry.defs.map((def) => (
                <SettingCell key={def.id} def={def} />
              ))}
            </div>
          </Fragment>
        ))}
    </>
  );
}

const FAMILY_IDS = FAMILIES.map((entry) => entry.id as string);

export function Settings({ config, onSave, onEffort, onConfig, onClose }: Props) {
  const [mode, setMode] = useState<ProviderId>(config.mode);
  const [profiles, setProfiles] = useState<ProviderProfiles>({
    local: { ...config.local },
    openai: { ...config.openai },
    gemini: { ...config.gemini },
    nvidia: { ...config.nvidia },
    opencode: { ...config.opencode },
  });
  const [keys, setKeys] = useState<Record<LiveProviderId, string>>(EMPTY_KEYS);
  const [queued, setQueued] = useState<Record<LiveProviderId, string[]>>(EMPTY_QUEUE);
  const [removed, setRemoved] = useState<Record<LiveProviderId, number[]>>(EMPTY_REMOVED);
  const [confirming, setConfirming] = useState<{ id: LiveProviderId; index: number } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ActionId | null>(null);
  const [theme, setTheme] = useState(savedTheme);
  const [hovered, setHovered] = useState<{ family: ThemeFamily; accent: string } | null>(null);
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  const scroller = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [core, setCoreState] = useState<CoreSettings>(config.settings);
  const [coreError, setCoreError] = useState<string | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const unsaved = useRef(0);

  function pickTheme(family: ThemeFamily, accent: string) {
    setTheme({ family, accent });
    applyTheme(family, accent);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const spy = () => {
      const line = element.getBoundingClientRect().top + element.clientHeight * 0.3;
      let current: string = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const node = element.querySelector<HTMLElement>(`#s-${section.id}`);
        if (node && node.getBoundingClientRect().top <= line) current = section.id;
      }
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 2) {
        current = SECTIONS[SECTIONS.length - 1].id;
      }
      setActiveSection(current);
    };
    spy();
    element.addEventListener("scroll", spy, { passive: true });
    return () => element.removeEventListener("scroll", spy);
  }, []);

  function jump(id: string) {
    scroller.current
      ?.querySelector(`#s-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /**
   * Behaviour settings save as they change. Saves go one after another so two quick
   * clicks on the same stepper land in order, and the page shows the new value at once.
   */
  function setCore(patch: Partial<CoreSettings>) {
    setCoreState((current) => ({ ...current, ...patch }));
    setCoreError(null);
    unsaved.current += 1;
    saveQueue.current = saveQueue.current
      .then(() => api.setSettings(patch))
      .then((saved) => {
        onConfig(saved);
        // Once nothing is waiting, show what the backend settled on (it clamps).
        if (unsaved.current === 1) setCoreState(saved.settings);
      })
      .catch(async (cause: unknown) => {
        setCoreError(cause instanceof Error ? cause.message : String(cause));
        const fresh = await api.getConfig().catch(() => null);
        if (fresh) {
          setCoreState(fresh.settings);
          onConfig(fresh);
        }
      })
      .finally(() => {
        unsaved.current -= 1;
      });
  }

  async function resetBehaviour() {
    const saved = await api.resetSettings();
    setCoreState(saved.settings);
    onConfig(saved);
  }

  function exportSettings() {
    return JSON.stringify(
      {
        soren: "settings",
        version: 1,
        prefs: allPrefs(),
        theme: savedTheme(),
        behaviour: core,
      },
      null,
      2,
    );
  }

  async function applyImport(text: string): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("That is not JSON. Paste exactly what “Copy” produced.");
    }
    const data = parsed as Record<string, any> | null;
    if (!data || typeof data !== "object" || data.soren !== "settings") {
      throw new Error("That does not look like exported Soren settings.");
    }
    let applied = 0;
    if (data.prefs && typeof data.prefs === "object") applied += importPrefs(data.prefs);

    const wanted = data.theme;
    if (wanted && FAMILY_IDS.includes(wanted.family)) {
      const accent = String(wanted.accent ?? "default");
      const known =
        accent === "default" || isCustomAccent(accent) || ACCENTS.some((entry) => entry.id === accent);
      pickTheme(wanted.family as ThemeFamily, known ? accent : "default");
      applied += 1;
    }

    const behaviour = data.behaviour;
    if (behaviour && typeof behaviour === "object") {
      const patch: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(behaviour)) {
        if (name in core && typeof value === typeof core[name as keyof CoreSettings]) patch[name] = value;
      }
      if (Object.keys(patch).length > 0) {
        const saved = await api.setSettings(patch as Partial<CoreSettings>);
        setCoreState(saved.settings);
        onConfig(saved);
        applied += Object.keys(patch).length;
      }
    }
    if (applied === 0) throw new Error("Nothing in that was a setting Soren recognises.");
    return `Applied ${applied} setting${applied === 1 ? "" : "s"}.`;
  }

  /** Run an action from a cell. The text it returns is shown in place of the cell's hint. */
  async function run(action: ActionId): Promise<string | undefined> {
    switch (action) {
      case "copySettings":
        await copyText(exportSettings());
        return "Copied";
      case "openFolder":
        return await api.openDataFolder();
      case "resetInterface":
        resetPrefs();
        return "Reset";
      case "resetBehaviour":
        await resetBehaviour();
        return "Reset";
      case "resetAll":
        setConfirmAction(action);
        return undefined;
    }
  }

  async function confirmed(action: ActionId) {
    setConfirmAction(null);
    if (action === "resetAll") {
      resetPrefs();
      pickTheme(DEFAULT_THEME.family, DEFAULT_THEME.accent);
      await resetBehaviour();
    }
  }

  const active = mode === "demo" ? null : profiles[mode];
  const typedKey = mode === "demo" ? "" : keys[mode].trim();
  // A server on this machine has no key to give, so the local preset never asks
  // for one. Everything else still does.
  const needsKey = mode !== "demo" && mode !== "local";
  const valid =
    mode === "demo" ||
    (active !== null &&
      active.model.trim().length > 0 &&
      (!needsKey ||
        typedKey.length > 0 ||
        remainingSaved(mode) > 0 ||
        queued[mode].length > 0) &&
      (mode === "local" || mode !== "openai" || (active.baseUrl ?? "").trim().length > 0));

  function updateProfile(id: LiveProviderId, patch: Partial<ProviderProfile>) {
    setProfiles((current) => {
      const next = { ...current };
      next[id] = { ...next[id], ...patch };
      return next;
    });
  }

  function updateActive(patch: Partial<ProviderProfile>) {
    if (mode === "demo") return;
    updateProfile(mode, patch);
  }

  function updateKey(id: LiveProviderId, value: string) {
    setKeys((current) => ({ ...current, [id]: value }));
  }

  /** Saved keys that survive this edit. */
  function remainingSaved(id: LiveProviderId): number {
    return profiles[id].keyHints.length - removed[id].length;
  }

  function queueKey(id: LiveProviderId) {
    const key = keys[id].trim();
    if (!key || queued[id].includes(key)) return;
    setQueued((current) => ({ ...current, [id]: [...current[id], key] }));
    setKeys((current) => ({ ...current, [id]: "" }));
  }

  function dropQueued(id: LiveProviderId, position: number) {
    setQueued((current) => ({
      ...current,
      [id]: current[id].filter((_, index) => index !== position),
    }));
  }

  function removeSaved(id: LiveProviderId, position: number) {
    setRemoved((current) => ({ ...current, [id]: [...current[id], position] }));
    setConfirming(null);
  }

  function profileStatus(id: ProviderId): string {
    if (id === "demo") return "Scripted";
    if (id === "local") return "No key needed";
    const count = remainingSaved(id) + queued[id].length + (keys[id].trim() ? 1 : 0);
    if (count === 0) return "No key";
    return count === 1 ? "1 key" : `${count} keys`;
  }

  function profileUpdate(id: LiveProviderId): ProviderProfileUpdate {
    const typed = keys[id].trim();
    const add = [...queued[id], ...(typed.length > 0 ? [typed] : [])];
    const base: ProviderProfileUpdate = {
      ...(add.length > 0 ? { addKeys: add } : {}),
      ...(removed[id].length > 0 ? { removeKeys: removed[id] } : {}),
      model: profiles[id].model.trim(),
      ...(id === "openai" || id === "local"
        ? { baseUrl: (profiles[id].baseUrl ?? "").trim() }
        : {}),
    };
    if (id === "gemini") {
      return {
        ...base,
        liveModel: (profiles.gemini as any).liveModel?.trim() || "",
        delegateModel: (profiles.gemini as any).delegateModel?.trim() || "",
        thinkingModel: (profiles.gemini as any).thinkingModel?.trim() || "",
      };
    }
    return base;
  }

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        mode,
        local: profileUpdate("local"),
        openai: profileUpdate("openai"),
        gemini: profileUpdate("gemini"),
        nvidia: profileUpdate("nvidia"),
        opencode: profileUpdate("opencode"),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }

  const page: Page = {
    core,
    setCore,
    run,
    theme,
    pickTheme,
    applyImport,
  };

  const confirmCopy: Partial<Record<ActionId, { title: string; detail: string; label: string }>> = {
    resetAll: {
      title: "Reset everything?",
      detail:
        "Interface, behaviour and theme settings go back to their defaults. Your model source and API keys are not touched.",
      label: "Reset all",
    },
  };
  const pending = confirmAction ? confirmCopy[confirmAction] : undefined;

  function body(id: SectionId) {
    switch (id) {
      case "models":
        return (
          <>
            <h3>Model source</h3>
            <div className="s-grid">
              <Cell size="XL">
                <div className="field-label">Model source</div>
                <div className="provider-grid" aria-label="Model source">
                  {PROVIDER_ORDER.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`provider-choice ${mode === id ? "active" : ""}`}
                      onClick={() => setMode(id)}
                      aria-pressed={mode === id}
                    >
                      <span className="provider-choice-name">{PROVIDER_META[id].label}</span>
                      <span className="provider-choice-status">{profileStatus(id)}</span>
                    </button>
                  ))}
                </div>

                {mode === "demo" || !active ? (
                  <p className="settings-note">{PROVIDER_META.demo.description}</p>
                ) : (
                  <>
                    {PROVIDER_META[mode].showBaseUrl && (
                      <label className="field-label">
                        Base URL
                        <input
                          value={active.baseUrl ?? ""}
                          onChange={(event) => updateActive({ baseUrl: event.target.value })}
                          placeholder="https://api.openai.com/v1"
                          spellCheck={false}
                        />
                      </label>
                    )}
                    <label className="field-label">
                      Model
                      <input
                        value={active.model}
                        onChange={(event) => updateActive({ model: event.target.value })}
                        placeholder={PROVIDER_META[mode].modelPlaceholder}
                        spellCheck={false}
                      />
                    </label>
                    {mode !== "local" && (
                      <>
                        <div className="field-label">API keys</div>
                        <ul className="s-keys">
                          {active.keyHints.map((hint, index) =>
                            removed[mode].includes(index) ? null : (
                              <li key={`saved-${index}`}>
                                <code>{hint}</code>
                                <span className="s-key-tag">
                                  {index === 0 ? "tried first" : `backup ${index}`}
                                </span>
                                <span className="s-key-grow" />
                                <button
                                  type="button"
                                  className="key-remove"
                                  onClick={() => setConfirming({ id: mode, index })}
                                >
                                  Delete
                                </button>
                              </li>
                            ),
                          )}
                          {queued[mode].map((queuedKey, position) => (
                            <li key={`new-${position}`}>
                              <code>{`…${queuedKey.slice(-4)}`}</code>
                              <span className="s-key-tag">new, saved with Save</span>
                              <span className="s-key-grow" />
                              <button
                                type="button"
                                className="key-remove"
                                onClick={() => dropQueued(mode, position)}
                              >
                                Discard
                              </button>
                            </li>
                          ))}
                        </ul>
                        <div className="s-key-row">
                          <label className="field-label">
                            <input
                              type="password"
                              value={keys[mode]}
                              onChange={(event) => updateKey(mode, event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  queueKey(mode);
                                }
                              }}
                              placeholder={PROVIDER_META[mode].keyPlaceholder}
                              spellCheck={false}
                              autoComplete="new-password"
                            />
                          </label>
                          <button
                            type="button"
                            className="btn quiet"
                            disabled={keys[mode].trim().length === 0}
                            onClick={() => queueKey(mode)}
                          >
                            Add key
                          </button>
                        </div>
                        <p className="settings-note">
                          Keys are tried in this order. When one runs out of quota, Soren
                          switches to the next and retries once; if that fails too, it stops.
                        </p>
                      </>
                    )}
                    <p className="settings-note">{PROVIDER_META[mode].description}</p>
                    {PROVIDER_META[mode].endpoint && (
                      <div className="settings-endpoint">
                        <span>Endpoint</span>
                        <code>{PROVIDER_META[mode].endpoint}</code>
                      </div>
                    )}
                    {mode === "local" ? (
                      <p className="settings-note">
                        No key is sent. Start the server first, for example
                        <code>llama-server -m model.gguf --jinja --port 8080</code>
                        and check that it answers before sending a turn.
                      </p>
                    ) : (
                      <p className="settings-note">
                        Saved keys are write-only in the app: a key is never returned to
                        this interface after saving. It stays in Soren's local config
                        file, readable by your user account. Keychain storage is a later
                        step.
                      </p>
                    )}
                  </>
                )}

                {error && <div className="settings-error">{error}</div>}
              </Cell>
            </div>
            <h3>Reasoning</h3>
            <div className="s-grid">
              <Cell
                size="XL"
                stack
                label="Default effort"
                hint="How hard Soren thinks"
                control={
                  <Segmented
                    label="Default effort"
                    value={config.effort}
                    onChange={onEffort}
                    options={EFFORTS.map((entry) => ({
                      id: entry.id,
                      label: entry.label,
                      glyph: <Bars level={entry.level} />,
                    }))}
                  />
                }
                panel={{
                  title: "Effort",
                  body: (
                    <OptionList
                      label="Effort"
                      value={config.effort}
                      onChange={onEffort}
                      options={EFFORTS.map((entry) => ({
                        id: entry.id,
                        label: entry.label,
                        hint: entry.hint,
                        glyph: <Bars level={entry.level} />,
                      }))}
                    />
                  ),
                }}
              />
            </div>
          </>
        );

      case "appearance":
        return (
          <>
            <h3>Theme</h3>
            <div className="s-grid">
              <Cell
                size="XL"
                stack
                label="Theme"
                hint={FAMILIES.find((entry) => entry.id === theme.family)?.hint}
                control={
                  <Segmented
                    label="Theme"
                    value={theme.family}
                    onChange={(family) =>
                      pickTheme(
                        family,
                        FAMILIES.find((entry) => entry.id === family)?.defaultAccent ?? "default",
                      )
                    }
                    options={FAMILIES.map((entry) => ({
                      id: entry.id,
                      label: entry.label.replace("Solarized ", "Sol. "),
                      glyph: <FamilyGlyph family={entry.id} />,
                    }))}
                  />
                }
              />
              <Cell size="XL" label="Accent" hint="Hover to preview, click to apply">
                <div className="s-swatches" role="radiogroup" aria-label="Accent">
                  {[{ id: "default", label: "Default", color: "" }, ...ACCENTS].map((accent) => (
                    <button
                      key={accent.id}
                      type="button"
                      role="radio"
                      aria-checked={theme.accent === accent.id}
                      aria-label={accent.label}
                      title={accent.label}
                      className={`s-swatch ${theme.accent === accent.id ? "on" : ""}`}
                      style={{
                        background:
                          accent.color ||
                          `linear-gradient(135deg, var(--paper-sunk) 50%, var(--teal) 50%)`,
                      }}
                      onMouseEnter={() => setHovered({ family: theme.family, accent: accent.id })}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => pickTheme(theme.family, accent.id)}
                    />
                  ))}
                </div>
              </Cell>
              <Cell size="XL" label="Preview" hint="A drawing of the app, not the app itself">
                <div style={{ marginTop: 12 }}>
                  <ThemePreview
                    family={hovered?.family ?? theme.family}
                    accent={hovered?.accent ?? theme.accent}
                  />
                </div>
              </Cell>
            </div>
            <Rows section="appearance" />
          </>
        );

      default:
        return <Rows section={id} />;
    }
  }

  return (
    <div className="settings-page" role="dialog" aria-modal="true" aria-label="Settings">
      {confirming && (
        <ConfirmDelete
          title="Delete this API key?"
          detail={`The key ending ${profiles[confirming.id].keyHints[confirming.index]} is removed when you save. This can't be undone; you would need to paste it again.`}
          confirmLabel="Delete key"
          onConfirm={() => removeSaved(confirming.id, confirming.index)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirmAction && pending && (
        <ConfirmDelete
          title={pending.title}
          detail={pending.detail}
          confirmLabel={pending.label}
          onConfirm={() => void confirmed(confirmAction)}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      <PageContext.Provider value={page}>
        <GutterProvider scroller={scroller}>
          <nav className="s-rail" aria-label="Settings sections">
            {TIERS.map((tier) => (
              <Fragment key={tier.id}>
                <div className="s-rail-tier">{tier.id}</div>
                {SECTIONS.filter((section) => section.tier === tier.id).map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={`s-rail-item ${activeSection === section.id ? "on" : ""}`}
                    onClick={() => jump(section.id)}
                    aria-current={activeSection === section.id}
                    title={section.sub}
                  >
                    <section.icon size={18} />
                    <span className="s-rail-title">{section.title}</span>
                  </button>
                ))}
              </Fragment>
            ))}
          </nav>

          <div className="s-scroll" ref={scroller}>
            <div className="s-center">
              <header className="s-top">
                <h1>Settings</h1>
                <div className="s-top-actions">
                  <button type="button" className="btn quiet" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!valid || saving}
                    onClick={save}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={onClose}
                    aria-label="Close settings"
                  >
                    <CloseIcon size={16} />
                  </button>
                </div>
              </header>

              {coreError && (
                <div className="settings-error" role="alert">
                  {coreError}
                </div>
              )}

              {TIERS.map((tier) => (
                <div className="s-tier-band" key={tier.id}>
                  <div className="s-tier-head">
                    <span>{tier.id}</span>
                    <em>{tier.sub}</em>
                  </div>
                  {SECTIONS.filter((section) => section.tier === tier.id).map((section) => (
                    <section
                      id={`s-${section.id}`}
                      key={section.id}
                      className={`s-section ${section.id === SECTIONS[SECTIONS.length - 1].id ? "s-last" : ""}`}
                    >
                      <h2>{section.title}</h2>
                      {body(section.id)}
                    </section>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </GutterProvider>
      </PageContext.Provider>
    </div>
  );
}
