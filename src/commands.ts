import { E, N, NE, NW, S, SE, SW, W, type Dir } from "./ring";

/**
 * Every action the studio has, as one list. The palette shows all of them; the ring shows the ones that have a slot in
 * the dial for what you pointed at, and the rest sit in its More sub-dial (see ringTree.ts). A command that names a target
 * and a slot sits in that target's first dial at the direction below. The empty canvas is the exception: its dial is fixed
 * in ringTree.ts and its commands have no slot.
 *
 * Same verb, same direction, on every target: Delete is south, More is north-west, Copy is west, Duplicate is east, and
 * the target's main action is north. A slot a target does not use stays empty.
 */

export type TargetKind = "canvas" | "step" | "ask" | "wire" | "askwire" | "notelink" | "note" | "container" | "stack" | "dot";

export const TARGET_LABEL: Record<TargetKind, string> = {
  canvas: "Canvas",
  step: "Step",
  ask: "Question",
  wire: "Wire",
  askwire: "Question wire",
  notelink: "Dotted line",
  note: "Note",
  container: "Container",
  stack: "Notes",
  dot: "History point",
};

export interface Command {
  id: string;
  name: string;
  /** A shorter name for the ring, where the room is small. */
  short?: string;
  run: () => void;
  /** What it acts on. A command with no target is global. */
  target?: TargetKind;
  /** Its place in that target's ring (a key of RING_LAYOUT[target]). */
  slot?: string;
  /** Its keyboard shortcut, as shown. */
  keys?: string;
  danger?: boolean;
  /** Extra words the search also matches. */
  keywords?: string;
  /** A small tag on the right of the row, such as the name of the step it is about. */
  tag?: string;
}

/** Where each slot sits in each target's ring. */
export const RING_LAYOUT: Record<TargetKind, Record<string, Dir>> = {
  canvas: {},
  step: { open: N, critic: NE, reopen: NE, duplicate: E, askfirst: SE, delete: S, always: SW, copy: W, more: NW },
  ask: { main: N, delete: S, more: NW },
  wire: { main: N, delete: S, more: NW },
  askwire: { delete: S, more: NW },
  notelink: { delete: S, more: NW },
  note: { main: N, delete: S, more: NW },
  container: { main: N, preset: NE, copy: W, delete: S, more: NW },
  stack: { main: N, inside: NE, delete: S, more: NW },
  dot: { main: N, merge: NE, copy: W, more: NW },
};

/** The short wedge name and icon for a slot, where the command has no short name of its own. */
export const SLOT_LOOK: Record<string, { short: string; icon: string }> = {
  more: { short: "More", icon: "more" },
  open: { short: "Open", icon: "open" },
  critic: { short: "Critic", icon: "eye" },
  reopen: { short: "Reopen", icon: "undo" },
  duplicate: { short: "Duplicate", icon: "branch" },
  askfirst: { short: "Ask first", icon: "chat" },
  delete: { short: "Delete", icon: "delete" },
  always: { short: "Always", icon: "repeat" },
  copy: { short: "Copy", icon: "copy" },
  preset: { short: "Save piece", icon: "store" },
  inside: { short: "Inside", icon: "open" },
  merge: { short: "Merge", icon: "branch" },
};

/** The most a wedge name may hold. */
export const SHORT_MAX = 10;

/** A name cut to fit a wedge. */
export function clipShort(text: string): string {
  return text.length > SHORT_MAX ? `${text.slice(0, SHORT_MAX - 1)}…` : text;
}

/**
 * How well a query matches a text: null when its letters do not appear in order, otherwise a score where higher is
 * better. Letters that touch, and letters that start a word, score more; a long gap scores less.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    if (ch === " ") {
      // A space asks for a word start.
      const at = t.indexOf(" ", from);
      if (at < 0) return null;
      from = at + 1;
      last = at;
      continue;
    }
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    const start = at === 0 || /[\s:/\-.(]/.test(t[at - 1]);
    score += 1 + (at === last + 1 ? 3 : 0) + (start ? 2 : 0) - Math.min(2, (at - from) * 0.1);
    last = at;
    from = at + 1;
  }
  // Shorter texts that contain the whole query are the closer match.
  if (t.includes(q)) score += 6;
  if (t.startsWith(q)) score += 4;
  return score - t.length * 0.01;
}

/** The commands that match a query, best first. An empty query keeps the order given. */
export function searchCommands(cmds: Command[], query: string): Command[] {
  if (!query.trim()) return cmds;
  const scored: Array<{ cmd: Command; score: number; index: number }> = [];
  cmds.forEach((cmd, index) => {
    const byName = fuzzyScore(query, cmd.name);
    const byWords = cmd.keywords || cmd.tag ? fuzzyScore(query, `${cmd.keywords ?? ""} ${cmd.tag ?? ""}`) : null;
    const best = Math.max(byName ?? -Infinity, byWords === null ? -Infinity : byWords - 3);
    if (best > -Infinity) scored.push({ cmd, score: best, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.cmd);
}
