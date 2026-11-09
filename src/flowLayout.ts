import { addStartNode, isWork, toTasks, type Flow, type FlowNode } from "./flowModel";
import { GRAPH, layoutWorkflow } from "./workflowGraph";

/**
 * Where nodes sit on the freeform canvas. Every node carries its own position;
 * these helpers only give a node one when it has none (a flow made before
 * positions existed, or a node that was just added) and draw the wires.
 */
/** The grid's smallest square, in world units. Steps snap to it and are built from it. */
export const GRID = 24;
/** A step is two of the grid's heavy squares wide (4 squares of 24, twice) and one tall: 192 by 96. */
export const NODE_W = GRID * 8;
export const NODE_H = GRID * 4;
const MARGIN = GRID;
// Gaps are whole squares too, so a row of steps keeps landing on grid lines.
const GAP_X = GRID * 4;
const GAP_Y = GRID * 2;

/** Round to the nearest grid line. */
export function snap(value: number, step = GRID): number {
  return Math.round(value / step) * step;
}

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boxOf(node: FlowNode): Box {
  return { id: node.id, x: node.pos?.x ?? MARGIN, y: node.pos?.y ?? MARGIN, width: NODE_W, height: NODE_H };
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < NODE_W + 12 && Math.abs(a.y - b.y) < NODE_H + 12;
}

/** The first free spot reading left to right, top to bottom, five to a row. */
export function freeSlot(taken: Array<{ x: number; y: number }>): { x: number; y: number } {
  for (let i = 0; ; i += 1) {
    const slot = {
      x: MARGIN + (i % 5) * (NODE_W + GAP_X),
      y: MARGIN + Math.floor(i / 5) * (NODE_H + GAP_Y),
    };
    if (!taken.some((t) => overlaps(slot, t))) return slot;
  }
}

/**
 * Give every node without a position one. A flow with no positions at all is
 * laid out once the old way, in columns by dependency, so existing workflows
 * look the same the first time; after that nothing moves unless the person moves it.
 */
// The old column layout was built for smaller cards; spread it out to suit the new size.
const SCALE_X = (NODE_W + GAP_X) / (GRAPH.nodeWidth + GRAPH.columnGap);
const SCALE_Y = (NODE_H + GAP_Y) / (GRAPH.nodeHeight + GRAPH.rowGap);

export function ensurePositions(flow: Flow): Flow {
  if (flow.nodes.every((n) => n.pos)) return flow;
  const auto = layoutWorkflow(toTasks(flow));
  const minX = Math.min(...auto.nodes.map((n) => n.x));
  const minY = Math.min(...auto.nodes.map((n) => n.y));
  const placed: Array<{ x: number; y: number }> = flow.nodes.filter((n) => n.pos).map((n) => n.pos!);
  const everyoneNew = placed.length === 0;
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.pos) return node;
      const spot = auto.byId.get(node.id);
      const pos = everyoneNew && spot
        ? { x: snap((spot.x - minX) * SCALE_X + MARGIN), y: snap((spot.y - minY) * SCALE_Y + MARGIN) }
        : freeSlot(placed);
      placed.push(pos);
      return { ...node, pos };
    }),
  };
}

export type Side = "right" | "left" | "top" | "bottom";
export interface Pt {
  x: number;
  y: number;
}

/** The middle of one side of a box, where wires attach. */
export function anchor(box: Box, side: Side): Pt {
  switch (side) {
    case "right":
      return { x: box.x + box.width, y: box.y + box.height / 2 };
    case "left":
      return { x: box.x, y: box.y + box.height / 2 };
    case "top":
      return { x: box.x + box.width / 2, y: box.y };
    default:
      return { x: box.x + box.width / 2, y: box.y + box.height };
  }
}

/**
 * Which sides a wire joins: the two that face each other. Boxes that are
 * mostly side by side use right and left; boxes mostly above and below use
 * bottom and top.
 */
export function pickSides(from: Box, to: Box): [Side, Side] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const gapX = Math.abs(dx) - (from.width + to.width) / 2;
  const gapY = Math.abs(dy) - (from.height + to.height) / 2;
  if (gapX >= gapY) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export interface Route {
  points: Pt[];
  /** Where the draggable middle segment sits, and which way dragging moves it. */
  mid: Pt;
  axis: "x" | "y";
}

/** How far a wire runs straight out of an output circle, and into an input circle, before it turns. */
const STUB = 24;

/**
 * A right-angle wire between two steps. It always leaves from the output circle on the right of one step
 * and arrives at the input circle on the left of the other, so the circles are the only places a wire
 * ever touches a step. When the target is to the right it runs out, turns, runs across and turns again
 * into the circle, as draw.io does. When the target is beside, under or behind its source it runs out,
 * goes around through the gap between the two steps (or over the top when they share a row) and comes
 * back into the input circle. `bend` slides the middle line. It does not search around other steps; if a
 * wire crosses one, move the step.
 */
export function route(from: Box, to: Box, bend = 0): Route {
  const p = anchor(from, "right");
  const q = anchor(to, "left");
  if (q.x - p.x >= STUB * 2) {
    const mx = (p.x + q.x) / 2 + bend;
    const points = p.y === q.y && bend === 0 ? [p, q] : [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q];
    return { points, mid: { x: mx, y: (p.y + q.y) / 2 }, axis: "x" };
  }
  const x1 = p.x + STUB;
  const x2 = q.x - STUB;
  const fromBottom = from.y + from.height;
  const toBottom = to.y + to.height;
  let my: number;
  if (fromBottom <= to.y) my = (fromBottom + to.y) / 2; // the source is above: run in the gap between them
  else if (toBottom <= from.y) my = (toBottom + from.y) / 2; // the source is below
  else my = Math.min(from.y, to.y) - GRID; // they share a row: go over the top of both
  my += bend;
  return {
    points: [p, { x: x1, y: p.y }, { x: x1, y: my }, { x: x2, y: my }, { x: x2, y: q.y }, q],
    mid: { x: (x1 + x2) / 2, y: my },
    axis: "y",
  };
}

/** Straight segments with softly rounded corners. */
export function roundedPath(points: Pt[], radius = 10): string {
  if (points.length === 0) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [prev, cur, next] = [points[i - 1], points[i], points[i + 1]];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      path += ` L ${cur.x} ${cur.y}`;
      continue;
    }
    const before = { x: cur.x - ((cur.x - prev.x) / inLen) * r, y: cur.y - ((cur.y - prev.y) / inLen) * r };
    const after = { x: cur.x + ((next.x - cur.x) / outLen) * r, y: cur.y + ((next.y - cur.y) / outLen) * r };
    path += ` L ${before.x} ${before.y} Q ${cur.x} ${cur.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

/** How big the canvas must be to hold every box with room around it. */
export function extent(boxes: Box[], pad = 48): { width: number; height: number } {
  return {
    width: Math.max(0, ...boxes.map((b) => b.x + b.width)) + pad,
    height: Math.max(0, ...boxes.map((b) => b.y + b.height)) + pad,
  };
}

export interface GridLayer {
  /** Distance between this layer's lines, in screen pixels. */
  spacing: number;
  alpha: number;
  /** Line thickness in screen pixels. */
  width: number;
}

/**
 * The lines of a multi-scale grid for a zoom level `k`: three layers, each four times
 * coarser than the one before. How strong a layer looks depends only on how far apart
 * its lines are on screen, so as you zoom out the thick lines turn into the thin ones
 * and a new, coarser set becomes the thick ones, with nothing popping at the hand-over.
 * Zooming in does the reverse.
 */
export function gridLayers(k: number): GridLayer[] {
  let unit = 24;
  while (unit * k < 10) unit *= 4;
  while (unit * k >= 40 && unit > 6) unit /= 4;
  const smooth = (d: number, from: number, to: number) => {
    const t = Math.min(1, Math.max(0, (d - from) / (to - from)));
    return t * t * (3 - 2 * t);
  };
  return [0, 1, 2].map((i) => {
    const spacing = unit * 4 ** i * k;
    const strength = smooth(spacing, 10, 64) * (1 - smooth(spacing, 300, 700));
    return { spacing, alpha: 0.34 * strength, width: 1 + 0.5 * smooth(spacing, 10, 64) };
  });
}


/**
 * Make sure a workflow has its Start. One that has none (an older workflow, or a new empty
 * one) gets a Start placed to the left of its first steps, and those steps are wired to it.
 * Nothing else moves, and the flow stays as locked and as old as it was.
 */
export function withStart(flow: Flow): Flow {
  if (flow.nodes.some((n) => n.kind === "start")) return flow;
  const entries = flow.nodes.filter((n) => isWork(n) && n.inputs.length === 0);
  const withNode = addStartNode(flow);
  const start = withNode.nodes[withNode.nodes.length - 1];
  const placed = entries.filter((n) => n.pos);
  const pos =
    placed.length > 0
      ? {
          x: snap(Math.min(...placed.map((n) => n.pos!.x)) - NODE_W - GAP_X),
          y: snap(placed.reduce((sum, n) => sum + n.pos!.y, 0) / placed.length),
        }
      : flow.nodes.length === 0
        ? { x: GRID * 4, y: GRID * 4 }
        : undefined;
  const entryIds = new Set(entries.map((n) => n.id));
  return {
    ...withNode,
    locked: flow.locked,
    revision: flow.revision,
    updatedAt: flow.updatedAt,
    nodes: withNode.nodes.map((n) => {
      if (n.id === start.id) return pos ? { ...n, pos } : n;
      return entryIds.has(n.id) ? { ...n, inputs: [{ node: start.id, port: start.outputs[0].id }] } : n;
    }),
  };
}


/**
 * How far a container has turned into a solid tile. Zoomed in it is a see-through box with a border, and
 * as you zoom out it fills in with its colour and its name moves to the middle, like a labelled region
 * on a map. 0 is the box, 1 is the tile.
 */
export function containerCover(k: number): number {
  const t = Math.min(1, Math.max(0, (0.55 - k) / (0.55 - 0.28)));
  return t * t * (3 - 2 * t);
}

/** Whether a container's rectangle overlaps a box at all. */
export function coversBox(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return b.x < a.x + a.w && b.x + b.width > a.x && b.y < a.y + a.h && b.y + b.height > a.y;
}
