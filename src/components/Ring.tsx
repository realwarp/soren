import { useLayoutEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { flushSync } from "react-dom";
import { angleOf, ARROWS, bandOf, clampCentre, dialDepth, dirOf, POSITIONS, RING, stickOf, unit, wedgePath, type Dial, type Dir, type RingSlice } from "../ring";
import {
  AlertIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  DatabaseIcon,
  EyeIcon,
  ExpandIcon,
  ListIcon,
  PencilIcon,
  PlusIcon,
  RetryIcon,
  SettingsIcon,
  SlidersIcon,
  SparkIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon,
} from "./Icons";

/**
 * The ring: a dial of 4, 6 or 8 wedges around the pointer, with a hub in the middle. A wedge may open a sub-dial, which
 * appears as a new ring outside the current one; older rings stay, greyed and inert, and only the newest is chosen from.
 * It is drawn when it opens and again only when a ring is added or taken away. Moving the pointer over it only toggles
 * a class on the wedge under it and rewrites the hub's text, by hand, so choosing costs no React renders. A position
 * with no action keeps its wedge, dim, so a dial keeps its shape.
 *
 * The pointer is read as a virtual stick: a point that starts at the centre, moves by the mouse's movement and is held to
 * the middle of the newest ring's band (so the angle follows the eye on every ring). The real cursor is hidden (and the pointer locked when the browser allows), so it cannot slide off.
 * The stick drives the newest ring only, and goes back to the centre when a ring is added or taken away.
 *
 * It opens three ways: a double-click on empty canvas (it then stays until Esc or a click), a right-button press, and a
 * left-button press held still. Held, a slice fires when the button is let go over it. A right-button press that moves
 * more than a few pixels and is let go before the ring shows is a flick and fires the slice in that direction without
 * the ring ever being drawn.
 *
 * Letting go or clicking on a wedge that opens a sub-dial adds its ring and leaves the dial open, waiting for clicks. Back
 * is north-west in every sub-dial; a right click also takes the newest ring away, and Esc closes the whole ring.
 */

export interface RingOpen {
  /** Where the centre sits in the canvas, in pixels. */
  x: number;
  y: number;
  /** The same point on the screen, in the units pointer events use. */
  cx: number;
  cy: number;
  dial: Dial;
  /** The button still down, or null for a ring that waits for a click. */
  held: 0 | 2 | null;
  /** The pointer that pressed, so the ring can keep its events while the button is down. */
  pointerId?: number;
}

/** Where a ring opened at a screen point sits in a canvas whose box is `rect`, kept far enough from the edges to fit. */
export function placeRing(rect: DOMRect, clientX: number, clientY: number, dial: Dial, held: 0 | 2 | null, pointerId?: number): RingOpen {
  const at = clampCentre(clientX - rect.left, clientY - rect.top, rect.width, rect.height, dialDepth(dial));
  return { x: at.x, y: at.y, cx: rect.left + at.x, cy: rect.top + at.y, dial, held, pointerId };
}

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/** The icons a slice may name. */
const ICONS: Record<string, IconType> = {
  ask: SparkIcon,
  add: PlusIcon,
  chat: ChatIcon,
  list: ListIcon,
  note: PencilIcon,
  copy: CopyIcon,
  paste: ListIcon,
  more: ListIcon,
  delete: TrashIcon,
  branch: BranchIcon,
  open: ExpandIcon,
  eye: EyeIcon,
  undo: UndoIcon,
  repeat: RetryIcon,
  store: DatabaseIcon,
  alert: AlertIcon,
  check: CheckIcon,
  clock: ClockIcon,
  close: CloseIcon,
  settings: SettingsIcon,
  sliders: SlidersIcon,
  terminal: TerminalIcon,
};

/** The icon's size. */
const ICON = 16;

export function Ring({ ring, onClose }: { ring: RingOpen; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  // The rings showing, innermost first, and which position opened each next one. It changes only when a ring is added
  // or taken away, never as the pointer moves.
  const [view, setView] = useState<{ dials: Dial[]; via: Array<Dir | null> }>({ dials: [ring.dial], via: [null] });

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    /** The rings open so far (the first is the one that opened), and the position that opened the ring after each. */
    const levels: Dial[] = [ring.dial];
    const vias: Array<Dir | null> = [null];
    const current = () => levels[levels.length - 1];
    const sliceOf = (dir: number) => current().slices.find((s) => s.dir === dir);
    let sticky = ring.held === null;
    let hot: number | null = null;
    /** The virtual stick, relative to the centre. */
    let vx = 0;
    let vy = 0;
    let lastX: number | undefined;
    let lastY: number | undefined;
    let locked = false;
    /** In a click-to-choose ring: which slice the press began on (null: none), or undefined when no press is down. */
    let down: number | null | undefined;
    let closed = false;
    const hub = el.querySelector<HTMLElement>(".flow-ring-hub");
    const hubArrow = hub?.querySelector<HTMLElement>(".hub-arrow");
    let hotEl: Element | null = null;
    const hubLabel = hub?.querySelector<HTMLElement>(".hub-label");

    const sliceAt = (): number | null => {
      const d = dirOf(vx, vy, stickOf(levels.length).dead, current().sides);
      const s = d === null ? undefined : sliceOf(d);
      return d !== null && s && !s.inert ? d : null;
    };
    const inDead = () => Math.hypot(vx, vy) < stickOf(levels.length).dead;
    const light = (dir: number | null) => {
      if (dir === hot) return;
      hotEl?.classList.remove("hot");
      hotEl = dir === null ? null : el.querySelector(`.flow-ring-level.cur [data-dir="${dir}"]`);
      hotEl?.classList.add("hot");
      hot = dir;
      // The hub says what the wedge under the pointer does, or a quiet hint when none is.
      const slice = dir === null ? undefined : sliceOf(dir);
      hub?.classList.toggle("hot", !!slice);
      hub?.classList.toggle("danger", !!slice?.danger);
      if (hubArrow) hubArrow.textContent = slice ? ARROWS[slice.dir] : "";
      if (hubLabel) hubLabel.textContent = slice ? (slice.children && !slice.back ? `${slice.label} ›` : slice.label) : "";
    };
    /** Draw the rings now open: the newest takes the stick, back in the middle. */
    const relevel = () => {
      hotEl?.classList.remove("hot");
      hotEl = null;
      vx = 0;
      vy = 0;
      hot = null;
      hub?.classList.remove("hot", "danger");
      if (hubArrow) hubArrow.textContent = "";
      if (hubLabel) hubLabel.textContent = "";
      flushSync(() => setView({ dials: [...levels], via: [...vias] }));
    };
    const enter = (slice: RingSlice) => {
      vias[levels.length - 1] = slice.dir;
      levels.push(slice.children!);
      vias.push(null);
      relevel();
    };
    const goBack = () => {
      if (levels.length < 2) return;
      levels.pop();
      vias.pop();
      vias[levels.length - 1] = null;
      relevel();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      onClose();
    };
    // Cursor off, and keep the pointer's events: capture while a button is down, lock where the browser allows.
    document.documentElement.classList.add("ring-open");
    const grab = (id: number | undefined) => {
      if (id === undefined) return;
      try {
        el.setPointerCapture(id);
      } catch {
        /* the pointer is gone or capture is refused */
      }
    };
    grab(ring.pointerId);
    try {
      const asked: unknown = el.requestPointerLock();
      if (asked instanceof Promise) asked.catch(() => {});
    } catch {
      /* refused: movement deltas alone still work */
    }
    const onLock = () => {
      if (document.pointerLockElement === el) locked = true;
      else if (locked) close();
    };
    document.addEventListener("pointerlockchange", onLock);
    // After a hold, the release can arrive as a click on whatever was pressed; it is not meant for it.
    const swallowClick = (always = false) => {
      if (!always && ring.held !== 0) return;
      const eat = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener("click", eat, true);
      window.setTimeout(() => window.removeEventListener("click", eat, true), 60);
    };
    const fire = (run: () => void) => {
      close();
      swallowClick();
      // After the rest of this event's handlers, so a select or a deselect they make cannot undo what the slice did.
      window.setTimeout(run, 0);
    };
    /** Let go or click on a slice: Back and sub-rings change the ring (and leave it waiting for clicks); the rest fire. */
    const act = (slice: RingSlice) => {
      if (!slice.back && !slice.children) {
        if (slice.run) fire(slice.run);
        return;
      }
      if (slice.back) goBack();
      else enter(slice);
      if (!sticky) {
        sticky = true;
        el.classList.add("sticky");
      }
      swallowClick(true);
    };

    const onMove = (ev: PointerEvent) => {
      // Movement as the mouse reports it; where it does not, the change in position.
      const hasMove = typeof ev.movementX === "number" && typeof ev.movementY === "number";
      const dx = hasMove ? ev.movementX : lastX === undefined ? 0 : ev.clientX - lastX;
      const dy = hasMove ? ev.movementY : lastY === undefined ? 0 : ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      vx += dx;
      vy += dy;
      const len = Math.hypot(vx, vy);
      const reach = stickOf(levels.length).reach;
      if (len > reach) {
        vx = (vx / len) * reach;
        vy = (vy / len) * reach;
      }
      light(sliceAt());
    };
    const onUp = (ev: PointerEvent) => {
      if (!sticky) {
        if (ev.button !== ring.held) return;
        const d = sliceAt();
        if (d !== null) return act(sliceOf(d)!);
        // Let go in the middle: the ring stays and waits for a click. Let go anywhere else: it was a cancel.
        if (inDead()) {
          sticky = true;
          el.classList.add("sticky");
          swallowClick();
        } else close();
        return;
      }
      if (down === undefined) return;
      const began = down;
      down = undefined;
      const d = sliceAt();
      if (d !== null && d === began) act(sliceOf(d)!);
      else close();
    };
    const onDown = (ev: PointerEvent) => {
      if (!sticky) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.button !== 0) {
        // A right click steps back out of a sub-ring, or closes the ring at the top.
        if (levels.length > 1) {
          goBack();
          swallowClick(true);
        } else close();
        return;
      }
      grab(ev.pointerId);
      down = sliceAt();
      // A press on nothing closes it at once, so the canvas under it is not touched.
      if (down === null) {
        down = undefined;
        close();
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    };
    const onMenu = (ev: Event) => ev.preventDefault();

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", onMenu, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerlockchange", onLock);
      document.documentElement.classList.remove("ring-open");
      try {
        if (ring.pointerId !== undefined && el.hasPointerCapture(ring.pointerId)) el.releasePointerCapture(ring.pointerId);
      } catch {
        /* already released */
      }
      try {
        if (document.pointerLockElement === el) document.exitPointerLock();
      } catch {
        /* not locked */
      }
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onMenu, true);
      window.removeEventListener("blur", close);
    };
    // The ring is drawn once: a new ring is a new element, so this runs once per ring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = view.dials.length - 1;
  const reach = bandOf(view.dials.length).outer + RING.pop + 6;
  return (
    <div ref={root} className={`flow-ring ${ring.held === null ? "sticky" : ""}`} role="menu" aria-label="Actions">
      <div className="flow-ring-core" style={{ left: ring.x, top: ring.y }}>
        {view.dials.map((_, i) => {
          const band = bandOf(i + 1);
          return (
            <span
              key={i}
              className={`flow-ring-blur ${i === last ? "cur" : "old"}`}
              style={{ left: -band.outer, top: -band.outer, width: band.outer * 2, height: band.outer * 2, "--bi": `${band.inner}px`, "--bo": `${band.outer}px` } as React.CSSProperties}
            />
          );
        })}
        <svg className="flow-ring-wheel" width={reach * 2} height={reach * 2} viewBox={`${-reach} ${-reach} ${reach * 2} ${reach * 2}`} aria-hidden="true">
          {view.dials.map((dial, i) => {
            const band = bandOf(i + 1);
            const mid = (band.inner + band.outer) / 2;
            const cur = i === last;
            return (
              <g key={i} className={`flow-ring-level ${cur ? "cur" : "old"}`}>
                {POSITIONS[dial.sides].map((d) => {
                  const s = dial.slices.find((x) => x.dir === d);
                  const angle = angleOf(dial.sides, d);
                  const u = unit(angle);
                  const a = (angle * Math.PI) / 180;
                  const cx = Math.sin(a) * mid;
                  const cy = -Math.cos(a) * mid;
                  const Icon = s?.icon ? ICONS[s.icon] : undefined;
                  const live = !!s && !s.inert;
                  return (
                    <g
                      key={d}
                      data-dir={cur && live ? d : undefined}
                      role={s ? "menuitem" : undefined}
                      aria-disabled={s?.inert ? true : undefined}
                      className={`flow-ring-wedge ${live ? "" : "dim"} ${s?.danger ? "danger" : ""} ${s?.back || s?.red ? "back" : ""} ${view.via[i] === d ? "via" : ""}`}
                      style={{ "--ux": u.x, "--uy": u.y } as React.CSSProperties}
                    >
                      <path d={wedgePath(dial.sides, d, band.inner, band.outer)} />
                      {s?.children && !s.back && (
                        <path className="flow-ring-chev" d="M -3.5 2.2 L 0 -1.3 L 3.5 2.2" transform={`translate(${(Math.sin(a) * (band.outer - 8)).toFixed(2)} ${(-Math.cos(a) * (band.outer - 8)).toFixed(2)}) rotate(${angle})`} />
                      )}
                      {s && Icon && <Icon x={cx - ICON / 2} y={cy - ICON - 3} size={ICON} />}
                      {s && (
                        <text x={cx} y={Icon ? cy + 10 : cy} textAnchor="middle" dominantBaseline="central">
                          {s.short ?? s.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
        <div className="flow-ring-hub">
          <span className="hub-arrow" />
          <span className="hub-label" />
          <span className="hub-hint hub-held">Move to choose</span>
          <span className="hub-hint hub-sticky">Move, then click</span>
        </div>
      </div>
    </div>
  );
}

export interface PressInit {
  button: 0 | 2;
  clientX: number;
  clientY: number;
  pointerId?: number;
  /** The canvas's box on the screen, to place the ring in it. */
  frame: () => DOMRect | null;
  /** Called once the press has become a ring or a flick: selects what was pressed and says what the first dial holds. */
  prepare: () => Dial;
  /** Draw the ring. */
  show: (ring: RingOpen) => void;
  /** A left-button hold is about to open the ring: let go of whatever else the press had begun. */
  onHold?: () => void;
}

/**
 * Follow one button press that might become a ring. A left press that moves more than a few pixels is a plain drag and is
 * left alone; held still it opens the ring. A right press shows the ring after a moment, fires a slice at once if it is
 * flicked and let go first, and a quick click with no movement opens a ring that waits for a click.
 */
export function startPress(init: PressInit): void {
  const x0 = init.clientX;
  const y0 = init.clientY;
  let lastX = x0;
  let lastY = y0;
  let flicked = false;
  let timer = 0;

  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", stop, true);
  };
  const open = (sticky: boolean) => {
    stop();
    if (init.button === 0) init.onHold?.();
    const dial = init.prepare();
    const rect = init.frame();
    if (dial.slices.length === 0 || !rect) return;
    init.show(placeRing(rect, x0, y0, dial, sticky ? null : init.button, init.pointerId));
  };
  function move(ev: PointerEvent) {
    lastX = ev.clientX;
    lastY = ev.clientY;
    const dist = Math.hypot(lastX - x0, lastY - y0);
    // The left button is for dragging: moving off before the hold means this was a drag.
    if (init.button === 0) {
      if (dist > RING.slop) stop();
    } else if (dist > RING.flick) flicked = true;
  }
  function up(ev: PointerEvent) {
    if (ev.button !== init.button) return;
    stop();
    if (init.button !== 2) return;
    if (flicked) {
      const dial = init.prepare();
      const d = dirOf(lastX - x0, lastY - y0, RING.flick / 2, dial.sides);
      const slice = d === null ? undefined : dial.slices.find((s) => s.dir === d);
      // Only a slice that acts fires from a flick; one that opens a sub-ring opens the ring instead.
      if (slice?.run && !slice.inert) window.setTimeout(slice.run, 0);
      else if (slice?.children) open(true);
      return;
    }
    open(true);
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", stop, true);
  timer = window.setTimeout(() => open(false), init.button === 2 ? RING.showMs : RING.holdMs);
}
