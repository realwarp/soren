/**
 * The ring: a marking menu of dials. A dial has 4, 6 or 8 sides, and its slices sit at compass positions (the Dir
 * numbers below). These are the pure parts (positions, sizes, where a slice sits); the component that draws the dials
 * and the press that opens them are in components/Ring.tsx.
 *
 * A direction is a compass name numbered from 0 (north) clockwise: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW.
 * An 8-sided dial uses all of them, every 45 degrees. A 6-sided dial uses NW, N, NE, SE, S, SW every 60 degrees
 * (north is 0, north-west 300). A 4-sided dial uses NE, SE, SW, NW every 90 degrees (north-east is 45).
 */

export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Sides = 4 | 6 | 8;

export const ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"] as const;
export const DIR_NAMES = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;

export const N: Dir = 0;
export const NE: Dir = 1;
export const E: Dir = 2;
export const SE: Dir = 3;
export const S: Dir = 4;
export const SW: Dir = 5;
export const W: Dir = 6;
export const NW: Dir = 7;

/** The positions of a dial, in order clockwise from the first one at or after north. */
export const POSITIONS: Record<Sides, readonly Dir[]> = {
  8: [N, NE, E, SE, S, SW, W, NW],
  6: [N, NE, SE, S, SW, NW],
  4: [NE, SE, SW, NW],
};

/** Sizes and times, in pixels and milliseconds. */
export const RING = {
  /** The first ring is a donut of wedges: this is the inside edge, the outside edge, and the gap left between wedges. */
  inner: 46,
  outer: 132,
  gap: 2.5,
  /** Each ring added outside it is a band this thick; rings touch, with no gap between them. */
  band: 72,
  /** The most rings open at once (the tree is never deeper). */
  maxDepth: 3,
  /** How far the wedge under the pointer moves outward. */
  pop: 4,
  /** Inside this the pointer is in the dead zone: nothing is chosen (the flick's own test; the stick uses `stickOf`). */
  dead: 22,
  /** The dead zone of the virtual stick is this share of its reach. */
  deadShare: 0.25,
  /** A left-button press held still this long opens the ring. */
  holdMs: 350,
  /** ...and counts as still while it stays within this. */
  slop: 4,
  /** A right-button press that goes this far before the ring shows is a flick. */
  flick: 30,
  /** The right button shows the ring once it has been held this long. */
  showMs: 140,
} as const;

/** The inside and outside radius of ring number `level` (1 is the first). */
export function bandOf(level: number): { inner: number; outer: number } {
  if (level <= 1) return { inner: RING.inner, outer: RING.outer };
  const inner = RING.outer + (level - 2) * RING.band;
  return { inner, outer: inner + RING.band };
}

/**
 * The virtual stick of ring number `level` (the newest): it never goes further from the centre than `reach`, the middle
 * of that ring's band, so a sideways move turns the angle as much as the eye expects; inside `dead` nothing is chosen.
 */
export function stickOf(level: number): { reach: number; dead: number } {
  const band = bandOf(level);
  const reach = (band.inner + band.outer) / 2;
  return { reach, dead: reach * RING.deadShare };
}

/** The centre of a position on a dial, in degrees clockwise from north. */
export function angleOf(sides: Sides, dir: number): number {
  const i = POSITIONS[sides].indexOf(dir as Dir);
  return (Math.max(i, 0) * 360) / sides + (sides === 4 ? 45 : 0);
}

/** The position of an offset from the centre on a dial, or null inside the dead zone. */
export function dirOf(dx: number, dy: number, dead: number = RING.dead, sides: Sides = 8): Dir | null {
  if (Math.hypot(dx, dy) < dead) return null;
  // Angle clockwise from north, in degrees, 0 to 360.
  const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const span = 360 / sides;
  const first = sides === 4 ? 45 : 0;
  const i = Math.floor((((angle - first + span / 2) % 360) + 360) % 360 / span) % sides;
  return POSITIONS[sides][i];
}

/** The unit vector an angle (degrees clockwise from north) points along (x to the right, y down). */
export function unit(angle: number): { x: number; y: number } {
  const a = (angle * Math.PI) / 180;
  return { x: Math.round(Math.sin(a) * 1000) / 1000, y: Math.round(-Math.cos(a) * 1000) / 1000 };
}

/** How many rings the deepest path through a dial holds, itself included. */
export function dialDepth(dial: Dial): number {
  let deepest = 0;
  for (const s of dial.slices) if (s.children) deepest = Math.max(deepest, dialDepth(s.children));
  return 1 + deepest;
}

/** Where the ring's centre may sit inside a frame of this size so that `depth` rings stay visible. */
export function clampCentre(x: number, y: number, w: number, h: number, depth: number = RING.maxDepth): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  const margin = bandOf(depth).outer + RING.pop + 8;
  return { x: clamp(x, margin, w - margin), y: clamp(y, margin, h - margin) };
}

/**
 * The outline of one wedge of a ring, as an SVG path around the centre (0, 0). The wedge fills the span `dirOf` gives
 * its position on a dial of `sides`; its sides are pulled in so the strip left between neighbours is `gap` wide all along.
 */
export function wedgePath(sides: Sides, dir: number, inner: number = RING.inner, outer: number = RING.outer, gap: number = RING.gap): string {
  const centre = angleOf(sides, dir);
  const half = 180 / sides;
  const at = (r: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  };
  // At radius r the side must sit gap/2 off the sector's edge, which is this many degrees.
  const cut = (r: number) => (Math.asin(gap / 2 / r) * 180) / Math.PI;
  const so = centre - half + cut(outer);
  const eo = centre + half - cut(outer);
  const si = centre - half + cut(inner);
  const ei = centre + half - cut(inner);
  return `M ${at(outer, so)} A ${outer} ${outer} 0 0 1 ${at(outer, eo)} L ${at(inner, ei)} A ${inner} ${inner} 0 0 0 ${at(inner, si)} Z`;
}

/** One dial: how many sides it has and the slices on them (positions with none are drawn dim). */
export interface Dial {
  sides: Sides;
  slices: RingSlice[];
}

/** One slice: where it sits, what it says and what it does. */
export interface RingSlice {
  dir: Dir;
  /** The full name, shown in the middle of the wheel when the slice is under the pointer. */
  label: string;
  /** A name short enough for the wedge (about ten characters). */
  short?: string;
  /** Which small icon the wedge shows (a key of the table in components/Ring.tsx). */
  icon?: string;
  /** What it does. A slice has this or `children` or is `back`. */
  run?: () => void;
  danger?: boolean;
  /** The command it runs, so the palette can show the path to it. */
  id?: string;
  /** Other commands it can run (such as the second kind of paste), for the palette's paths. */
  alsoIds?: string[];
  /** Instead of acting, it opens this dial as a new ring outside the current one (which holds its own Back at north-west). */
  children?: Dial;
  /** Not available now: it keeps its place, dim, and cannot be chosen. */
  inert?: boolean;
  /** Takes the newest ring away again. */
  back?: boolean;
  /** Drawn red like Back (used by Exit). */
  red?: boolean;
}

/** The Back slice every sub-dial holds at north-west. */
export function backSlice(): RingSlice {
  return { dir: NW, label: "Back", short: "Back", icon: "undo", back: true };
}

/** The way to each command in a dial tree, as positions from the first ring (the shortest way when there are several). */
export function ringPaths(root: Dial): Map<string, Dir[]> {
  const out = new Map<string, Dir[]>();
  const note = (id: string, path: Dir[]) => {
    const had = out.get(id);
    if (!had || path.length < had.length) out.set(id, path);
  };
  const walk = (dial: Dial, prefix: Dir[]) => {
    for (const s of dial.slices) {
      if (s.back) continue;
      const path = [...prefix, s.dir];
      if (!s.inert) for (const id of [...(s.id ? [s.id] : []), ...(s.alsoIds ?? [])]) note(id, path);
      if (s.children) walk(s.children, path);
    }
  };
  walk(root, []);
  return out;
}
