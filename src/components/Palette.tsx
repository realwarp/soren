import { useEffect, useMemo, useRef, useState } from "react";
import { searchCommands, type Command } from "../commands";
import { ARROWS, type Dir } from "../ring";

/**
 * The command palette: every action in one searchable list. Command-K opens it anywhere in the studio. Each row shows the
 * action, its shortcut if it has one, and the whole path to it through the ring as arrows (such as "↖ ↑ →"), so searching
 * teaches the way.
 */
export function Palette({
  commands,
  scope,
  initialQuery = "",
  paths,
  onClose,
}: {
  /** What this opening can do, best first. */
  commands: Command[];
  /** When it was opened for one thing, what that is ("Step · Write the tests"); the list then holds only its actions. */
  scope?: { label: string; commands: Command[] };
  initialQuery?: string;
  /** The ring path to each command, by id. */
  paths?: Map<string, Dir[]>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [wide, setWide] = useState(!scope);
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const pool = wide ? (scope ? [...scope.commands, ...commands.filter((c) => !scope.commands.includes(c))] : commands) : scope!.commands;
  const found = useMemo(() => searchCommands(pool, query), [pool, query]);

  useEffect(() => {
    input.current?.focus();
    input.current?.setSelectionRange(initialQuery.length, initialQuery.length);
  }, [initialQuery]);
  useEffect(() => setIndex(0), [query, wide]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function pick(cmd: Command | undefined) {
    if (!cmd) return;
    onClose();
    // After the palette is gone, so a command that opens a box finds the focus free.
    window.setTimeout(cmd.run, 0);
  }

  return (
    <div className="palette-scrim" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(found.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(found[index]);
          } else if (e.key === "Backspace" && query === "" && !wide) {
            // Nothing left to delete: open the search out to everything.
            e.preventDefault();
            setWide(true);
          }
        }}
      >
        <div className="palette-head">
          {scope && !wide && <span className="palette-scope">{scope.label}</span>}
          <input
            ref={input}
            className="palette-input"
            value={query}
            placeholder={scope && !wide ? "Search this thing's actions" : "Search every action"}
            aria-label="Search actions"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul ref={list} className="palette-list" role="listbox">
          {found.length === 0 && <li className="palette-none">Nothing matches.</li>}
          {found.slice(0, 80).map((cmd, i) => {
            const path = paths?.get(cmd.id);
            const arrow = path ? path.map((d) => ARROWS[d]).join(" ") : "";
            return (
              <li
                key={cmd.id}
                data-i={i}
                role="option"
                aria-selected={i === index}
                className={`palette-row ${i === index ? "on" : ""} ${cmd.danger ? "danger" : ""}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => pick(cmd)}
              >
                <span className="palette-name">{cmd.name}</span>
                {cmd.tag && <span className="palette-tag">{cmd.tag}</span>}
                {cmd.keys && <kbd className="palette-keys">{cmd.keys}</kbd>}
                <span className="palette-arrow" aria-label={arrow ? "Path through the ring" : undefined}>
                  {arrow}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="palette-foot">
          <span>↑↓ choose · Enter run · Esc close</span>
          {scope && !wide && <span>Backspace on an empty search shows everything</span>}
        </div>
      </div>
    </div>
  );
}
