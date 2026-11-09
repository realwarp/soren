import { useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { COL_W, COL_X0, layoutStrip, pointTip, ROW_H, type Timeline } from "../flowTimeline";

const PAD = 8;
const WIDTH = 44;
const rowY = (row: number) => PAD + row * ROW_H + ROW_H / 2;
const colX = (col: number) => COL_X0 + col * COL_W;

/**
 * The history strip: a thin column down the left edge of the canvas that shows how the plan came about. Each dot is one
 * question or one agent turn; a box round dots means they were asked together; a second or third column is a branch
 * (an alternative from an earlier point). The filled dot is where the work stands.
 *
 * Pressing it and dragging up or down rewinds: the canvas shows that point's version, dimmed. The dots and the tooltip
 * are moved by hand; React is told once per point crossed, and not at all for the pointer moving.
 */
export function FlowStrip({
  timeline,
  viewing,
  onView,
  onPress,
  card,
}: {
  timeline: Timeline;
  /** The point being looked at, or null when the latest is shown. */
  viewing: string | null;
  /** Look at a point (null: the latest). Called at most once per point crossed. */
  onView: (id: string | null) => void;
  /** A press on the strip, for the ring of the dot under it. */
  onPress: (e: ReactPointerEvent, pointId: string | null) => void;
  /** A card to show beside one dot (the merge suggestions). */
  card?: { point: string; node: ReactNode } | null;
}) {
  const layout = useMemo(() => layoutStrip(timeline), [timeline]);
  const scroller = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const current = viewing ?? timeline.head;
  const height = PAD * 2 + layout.rows * ROW_H;

  /** The dot in the row under a pointer height. Clamped to the first and last rows when asked to. */
  function dotAt(clientY: number, clamp: boolean) {
    const top = svg.current?.getBoundingClientRect().top ?? 0;
    const row = Math.floor((clientY - top - PAD) / ROW_H);
    if (!clamp && (row < 0 || row >= layout.rows)) return undefined;
    return layout.dots[Math.min(layout.rows - 1, Math.max(0, row))];
  }

  // Stay at the newest dot, or at the one being looked at.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const at = layout.dots.find((d) => d.point.id === current);
    if (!at || !viewing) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const y = rowY(at.row);
    if (y < el.scrollTop + ROW_H || y > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = y - el.clientHeight / 2;
  }, [layout, current, viewing]);

  // The card stays beside its dot while the strip scrolls. It is moved by hand.
  useLayoutEffect(() => {
    const place = () => {
      const box = cardBox.current;
      const w = wrap.current;
      if (!box || !w || !card) return;
      const dot = svg.current?.querySelector<SVGElement>(`[data-id="${card.point}"]`);
      if (!dot) return;
      const top = dot.getBoundingClientRect().top - w.getBoundingClientRect().top;
      box.style.top = `${Math.max(4, Math.min(top - 14, w.clientHeight - box.offsetHeight - 8))}px`;
    };
    place();
    const el = scroller.current;
    el?.addEventListener("scroll", place);
    return () => el?.removeEventListener("scroll", place);
  });

  // A drag in progress is listened to on the window; make sure it ends with the strip.
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  function onPointerDown(e: ReactPointerEvent) {
    const hit = dotAt(e.clientY, false);
    onPress(e, hit?.point.id ?? null);
    if (e.button !== 0 || layout.rows === 0) return;
    const y0 = e.clientY;
    let moved = false;
    let shown = viewing ?? timeline.head;
    let pending: string | null | undefined;
    let frame = 0;
    const show = (id: string) => {
      if (id === shown) return;
      shown = id;
      pending = id === timeline.head ? null : id;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (pending !== undefined) onView(pending);
          pending = undefined;
        });
      }
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      const dot = dotAt(ev.clientY, true);
      if (dot) show(dot.point.id);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      stopDrag.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (pending !== undefined) onView(pending);
      pending = undefined;
    };
    const up = () => {
      // A press that did not move is a click on a dot: look at it.
      if (!moved && hit) show(hit.point.id);
      end();
    };
    stopDrag.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const box = tip.current;
    const w = wrap.current;
    if (!box || !w) return;
    const dot = e.buttons === 0 ? dotAt(e.clientY, false) : undefined;
    if (!dot) {
      box.style.display = "none";
      return;
    }
    box.textContent = pointTip(dot.point);
    box.style.display = "block";
    box.style.top = `${e.clientY - w.getBoundingClientRect().top - 12}px`;
  }

  return (
    <div className="flow-strip-wrap" ref={wrap}>
      <div
        className="flow-strip"
        ref={scroller}
        tabIndex={0}
        role="slider"
        aria-label="History: how the plan came about"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, layout.rows - 1)}
        aria-valuenow={Math.max(0, layout.dots.findIndex((d) => d.point.id === current))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          if (tip.current) tip.current.style.display = "none";
        }}
      >
        <svg ref={svg} width={WIDTH} height={Math.max(height, 1)} aria-hidden="true">
          {layout.groups.map((g) => (
            <rect key={`g${g.from}`} className="flow-strip-group" x={colX(g.col) - 8} y={rowY(g.from) - 9} width={16} height={(g.to - g.from) * ROW_H + 18} rx={8} />
          ))}
          {layout.links.map((l, i) => {
            const x1 = colX(l.from.col);
            const y1 = rowY(l.from.row);
            const x2 = colX(l.to.col);
            const y2 = rowY(l.to.row);
            const mid = (y1 + y2) / 2;
            return <path key={i} className={`flow-strip-link ${l.kind}`} d={x1 === x2 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`} />;
          })}
          {layout.dots.map((d) => (
            <circle
              key={d.point.id}
              data-id={d.point.id}
              className={`flow-strip-dot ${d.point.id === current ? "on" : ""} ${d.point.kind} ${d.point.pending ? "pending" : ""}`}
              cx={colX(d.col)}
              cy={rowY(d.row)}
              r={d.point.kind === "merge" ? 5 : 4}
            />
          ))}
        </svg>
      </div>
      <div className="flow-strip-tip" ref={tip} />
      {card && (
        <div className="flow-strip-card" ref={cardBox}>
          {card.node}
        </div>
      )}
    </div>
  );
}
