import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

export const SIDE_DEFAULT = 392;
export const SIDE_MIN = 300;
const KEY = "soren.sideWidth";
const CLOSED_KEY = "soren.sideClosed";
const STEP = 16;
/** How far past the smallest width the edge must be pulled before the pane closes: a deliberate shove, not a slip. */
const CLOSE_SLACK = 100;

/** The widest the right pane may be: it never takes more than the window leaves for the page beside it. */
function widest(): number {
  return Math.max(SIDE_MIN, Math.min(760, window.innerWidth - 480));
}

function clamp(width: number): number {
  return Math.round(Math.min(widest(), Math.max(SIDE_MIN, width)));
}

export function loadSideWidth(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return Number.isFinite(saved) && saved >= SIDE_MIN ? clamp(saved) : SIDE_DEFAULT;
  } catch {
    return SIDE_DEFAULT;
  }
}

export function loadSideClosed(): boolean {
  try {
    return localStorage.getItem(CLOSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSideClosed(closed: boolean): void {
  try {
    localStorage.setItem(CLOSED_KEY, closed ? "1" : "0");
  } catch {
    // Storage can be blocked; the pane still stays as it is for this session.
  }
}

export function saveSideWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    // Storage can be blocked; the width still holds for this session.
  }
}

/**
 * The strip on the left edge of the right-hand pane. Dragging it changes the pane's width.
 * While the pointer is down it reports each frame through `onLive`, which the page applies
 * straight to a CSS variable so nothing redraws; the final width goes to `onCommit`, which
 * remembers it. Pulling the edge well past the smallest width closes the pane at once, and
 * pulling back while still holding opens it again at that width: closed or open is whatever
 * the pointer says at the moment it is released. Double-click puts the width back, and the
 * arrow keys nudge it (Right, at the smallest width, closes).
 *
 * The drag listens on the window rather than the strip, because once the pane is closed the
 * strip is no longer on screen.
 */
export function SideResizer({
  width,
  onLive,
  onCommit,
  onClose,
  onReopen,
}: {
  width: number;
  onLive: (width: number) => void;
  onCommit: (width: number) => void;
  onClose: () => void;
  onReopen: () => void;
}) {
  // The newest props, for a drag that began a few renders ago.
  const latest = useRef({ onLive, onCommit, onClose, onReopen });
  latest.current = { onLive, onCommit, onClose, onReopen };
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    // The interface can be scaled with CSS zoom, which makes a pixel of mouse movement and a pixel of the
    // pane's width different sizes. Their ratio is measured here rather than assumed, and the pane
    // starts from the width it really has, which a narrow window may have cut below the saved one.
    const pane = e.currentTarget.parentElement;
    const real = pane?.offsetWidth ?? 0;
    const measured = pane && real > 0 ? pane.getBoundingClientRect().width / real : 1;
    const scale = measured > 0 ? measured : 1;
    const start = { x: e.clientX, width: real > 0 ? real : width };
    let last = width;
    let closed = false;
    let frame = 0;
    document.body.classList.add("side-resizing");

    const move = (ev: globalThis.PointerEvent) => {
      // The pane is on the right, so pulling the edge left makes it wider.
      const wanted = start.width + (start.x - ev.clientX) / scale;
      const shut = wanted < SIDE_MIN - CLOSE_SLACK;
      if (shut !== closed) {
        closed = shut;
        if (shut) latest.current.onClose();
        else latest.current.onReopen();
      }
      if (shut) return;
      last = clamp(wanted);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          latest.current.onLive(last);
        });
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      cancelAnimationFrame(frame);
      document.body.classList.remove("side-resizing");
      stop.current = null;
    };
    const up = () => {
      end();
      // Let go closed and it stays closed; let go open and the width it ended at is kept.
      if (!closed) latest.current.onCommit(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    stop.current = end;
  }

  function key(e: KeyboardEvent<HTMLDivElement>) {
    const grow = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
    if (!grow) return;
    e.preventDefault();
    if (grow < 0 && width <= SIDE_MIN) onClose();
    else onCommit(clamp(width + grow));
  }

  return (
    <div
      className="side-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side pane"
      aria-valuenow={width}
      aria-valuemin={SIDE_MIN}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={down}
      onDoubleClick={() => onCommit(SIDE_DEFAULT)}
      onKeyDown={key}
    />
  );
}
