import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** ON is filled green, OFF is filled red. */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`s-toggle ${on ? "on" : "off"}`}
      onClick={() => onChange(!on)}
    >
      {on ? "ON" : "OFF"}
    </button>
  );
}

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  /** A small picture of what the option does, so the choice reads before the label. */
  glyph?: ReactNode;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="s-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={option.id === value ? "on" : ""}
          onClick={() => onChange(option.id)}
        >
          {option.glyph}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Rising bars: the visual language for "how much". */
export function Bars({ level, of = 3 }: { level: number; of?: number }) {
  return (
    <svg className="s-bars" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
      {Array.from({ length: of }, (_, index) => {
        const height = 4 + (index * 8) / Math.max(of - 1, 1);
        return (
          <rect
            key={index}
            x={index * 5}
            y={12 - height}
            width="3.5"
            height={height}
            rx="1"
            opacity={index < level ? 1 : 0.22}
          />
        );
      })}
    </svg>
  );
}

/** A number with minus/plus and a fill meter; no browser spinner. */
export function Stepper({
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** How the number reads, for values stored as a different unit than they are shown in. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
  label: string;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <div className="s-stepper" role="group" aria-label={label}>
      <div className="s-stepper-row">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - step))}
        >
          −
        </button>
        <span className="s-stepper-value">
          {format ? format(value) : value}
          {unit && <em>{unit}</em>}
        </span>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + step))}
        >
          +
        </button>
      </div>
      <div className="s-stepper-meter">
        <span style={{ width: `${((value - min) / (max - min)) * 100}%` }} />
      </div>
    </div>
  );
}

/** Vertical options, each with a one-line hint. */
export function OptionList<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; hint: string; glyph?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="s-list" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={option.id === value ? "on" : ""}
          onClick={() => onChange(option.id)}
        >
          <span className="s-list-glyph">{option.glyph}</span>
          <span className="s-list-text">
            <strong>{option.label}</strong>
            <small>{option.hint}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

/** A single-line text setting. It commits on blur or Enter, so a half-typed address is never saved. */
export function TextField({
  value,
  onCommit,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <input
      className="s-text"
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

/** Keys that already mean something to the system or the page, so a shortcut cannot take them. */
const RESERVED_KEYS = new Set(["a", "c", "v", "x", "z", "q", "w", "r", "h", "m", "f", "p"]);

/** Records the next key pressed as a shortcut. The modifier is fixed; only the key is chosen. */
export function KeyCapture({
  value,
  taken,
  onChange,
  label,
}: {
  value: string;
  /** Keys another shortcut already uses. */
  taken: string[];
  onChange: (value: string) => void;
  label: string;
}) {
  const [listening, setListening] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setListening(false);
        return;
      }
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (RESERVED_KEYS.has(key)) {
        setRefused(`${key.toUpperCase()} is used by the system`);
        return;
      }
      if (taken.includes(key)) {
        setRefused(`${key.toUpperCase()} is already a shortcut`);
        return;
      }
      setRefused(null);
      onChange(key);
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, taken, onChange]);

  return (
    <div className="s-keycap">
      <button
        type="button"
        className={listening ? "listening" : ""}
        aria-label={label}
        onClick={() => {
          setRefused(null);
          setListening((on) => !on);
        }}
      >
        {listening ? "Press a key…" : <>⌘ <kbd>{value.toUpperCase()}</kbd></>}
      </button>
      {refused && <small role="alert">{refused}</small>}
    </div>
  );
}
