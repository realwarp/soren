import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { ChevronRightIcon } from "../components/Icons";

export interface GutterPanel {
  id: string;
  title: string;
  body: ReactNode;
  /** A second popover, opened beside the first. */
  advanced?: { title: string; body: ReactNode };
}

interface GutterApi {
  activeId: string | null;
  toggle: (panel: GutterPanel, anchor: HTMLElement) => void;
  close: () => void;
}

const GutterContext = createContext<GutterApi | null>(null);

function useGutter(): GutterApi {
  const api = useContext(GutterContext);
  if (!api) throw new Error("Gutter used outside its provider");
  return api;
}

const MARGIN = 12;

/**
 * Popovers live in the right gutter whichever cell opened them. A panel lines up with its
 * cell; when the cell scrolls out of view the panel stays pinned to the top or bottom edge
 * on the side the cell left from.
 */
export function GutterProvider({
  scroller,
  children,
}: {
  scroller: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<{ panel: GutterPanel; anchor: HTMLElement } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tops, setTops] = useState({ panel: MARGIN, advanced: MARGIN });
  const host = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const advancedRow = useRef<HTMLButtonElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(null);
    setAdvancedOpen(false);
  }, []);

  const toggle = useCallback((panel: GutterPanel, anchor: HTMLElement) => {
    setAdvancedOpen(false);
    setOpen((current) => (current?.panel.id === panel.id ? null : { panel, anchor }));
  }, []);

  const place = useCallback(() => {
    if (!open || !host.current) return;
    const bounds = host.current.getBoundingClientRect();
    const clamp = (raw: number, height: number) =>
      Math.max(MARGIN, Math.min(raw, bounds.height - height - MARGIN));
    const panelHeight = panelRef.current?.offsetHeight ?? 0;
    const panelTop = clamp(open.anchor.getBoundingClientRect().top - bounds.top, panelHeight);
    let advancedTop = MARGIN;
    if (advancedOpen && advancedRow.current) {
      const advancedHeight = advancedRef.current?.offsetHeight ?? 0;
      const row = advancedRow.current.getBoundingClientRect().top - bounds.top;
      advancedTop = clamp(row, advancedHeight);
    }
    setTops((current) =>
      current.panel === panelTop && current.advanced === advancedTop
        ? current
        : { panel: panelTop, advanced: advancedTop },
    );
  }, [open, advancedOpen]);

  useLayoutEffect(place);

  useEffect(() => {
    if (!open) return;
    const element = scroller.current;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    element?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      element?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [open, place, scroller]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        advancedRef.current?.contains(target) ||
        open.anchor.closest(".s-cell")?.contains(target)
      ) {
        return;
      }
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (advancedOpen) setAdvancedOpen(false);
      else close();
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open, advancedOpen, close]);

  const panel = open?.panel;

  return (
    <GutterContext.Provider value={{ activeId: panel?.id ?? null, toggle, close }}>
      {children}
      <div className="s-gutter" ref={host}>
        {panel && (
          <div className="s-pop" ref={panelRef} style={{ top: tops.panel }} role="dialog" aria-label={panel.title}>
            <div className="s-pop-title">{panel.title}</div>
            <div className="s-pop-body">{panel.body}</div>
            {panel.advanced && (
              <button
                type="button"
                ref={advancedRow}
                className={`s-pop-advanced ${advancedOpen ? "on" : ""}`}
                onClick={() => setAdvancedOpen((value) => !value)}
                aria-expanded={advancedOpen}
              >
                <span>Advanced settings</span>
                <ChevronRightIcon size={14} />
              </button>
            )}
          </div>
        )}
        {panel?.advanced && advancedOpen && (
          <div
            className="s-pop s-pop-second"
            ref={advancedRef}
            style={{ top: tops.advanced }}
            role="dialog"
            aria-label={panel.advanced.title}
          >
            <div className="s-pop-title">{panel.advanced.title}</div>
            <div className="s-pop-body">{panel.advanced.body}</div>
          </div>
        )}
      </div>
    </GutterContext.Provider>
  );
}

/**
 * How much of the 12-column grid a setting takes: extra-small is 2 (six to a row), small 3
 * (four), medium 4 (three), large 6 (two) and extra-large 12 (one). A section therefore tiles
 * into 6, 4, 3, 2 or 1 columns without any cell naming a column count, and the stylesheet folds
 * the sizes as the page narrows.
 */
export type Size = "XS" | "S" | "M" | "L" | "XL";

/**
 * One setting in the 12-column grid, sized by class. With a `panel` it grows a chevron that
 * opens that panel in the gutter. `stack` puts the control on its own row under the text, for
 * controls too wide to sit beside it.
 */
export function Cell({
  size,
  stack,
  label,
  hint,
  control,
  panel,
  children,
}: {
  size: Size;
  stack?: boolean;
  label?: string;
  hint?: string;
  control?: ReactNode;
  panel?: Omit<GutterPanel, "id">;
  children?: ReactNode;
}) {
  const gutter = useGutter();
  const id = `${label ?? "cell"}`;
  const root = useRef<HTMLDivElement>(null);
  const active = panel ? gutter.activeId === id : false;

  return (
    <div
      ref={root}
      className={`s-cell s-${size} ${stack ? "stack" : ""} ${active ? "open" : ""}`}
    >
      {(label || control || panel) && (
        <div className="s-cell-head">
          <div className="s-cell-text">
            {label && <div className="s-cell-label">{label}</div>}
            {hint && <div className="s-cell-hint">{hint}</div>}
          </div>
          <div className="s-cell-control">
            {!stack && control}
            {panel && (
              <button
                type="button"
                className="s-chevron"
                aria-label={`${label} options`}
                aria-expanded={active}
                onClick={() => root.current && gutter.toggle({ ...panel, id }, root.current)}
              >
                <ChevronRightIcon size={15} />
              </button>
            )}
          </div>
        </div>
      )}
      {stack && control && <div className="s-cell-stack">{control}</div>}
      {children}
    </div>
  );
}
