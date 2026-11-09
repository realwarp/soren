import { ensurePositions, GRID, NODE_H, NODE_W, snap } from "./flowLayout";
import { ASK_SIZE } from "./flowAsk";
import { acceptRewrite, basePromptText } from "./flowPromptDoc";
import {
  addNote,
  addNoteLink,
  addNoteStack,
  DIFF_NOTE_COLOR,
  diffNotes,
  noteSize,
  NOTE_DEFAULT,
  NOTE_MIN,
  removeNote,
  stackNotes,
  STACK_SIZE,
  updateNode,
  updateNote,
  updateNoteStack,
  type Flow,
  type NoteDiff,
} from "./flowModel";

/**
 * Where an agent turn's notes go. Each turn leaves one notes container at the spot you double-clicked, and a note per
 * thing the agent did, each sized to show its whole text and placed where it touches nothing: no step, no square, no
 * card and no other note.
 */

/** One clean line, whatever the model sent: first line only, spaces collapsed, quotes and bullets trimmed, cut at 200. */
export function oneLine(raw: string): string {
  const first = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const line = first
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\\[nrt]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“](.*)["”]$/, "$1")
    .trim();
  return line.length > 200 ? `${line.slice(0, 197).trimEnd()}...` : line;
}

/** Text lines wrapped to `width` characters, breaking at spaces and splitting a word too long to fit. */
function wrappedLines(text: string, width: number): number {
  let lines = 0;
  for (const paragraph of text.split(/\r?\n/)) {
    let used = 0;
    let any = false;
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (used > 0) {
          lines += 1;
          used = 0;
        }
        lines += 1;
        word = word.slice(width);
      }
      if (used === 0) used = word.length;
      else if (used + 1 + word.length <= width) used += 1 + word.length;
      else {
        lines += 1;
        used = word.length;
      }
      any = true;
    }
    lines += any || paragraph === "" ? 1 : 0;
  }
  return Math.max(1, lines);
}

/** A note's grip strip, the text's padding, and its line height, as the stylesheet has them. */
const NOTE_CHROME = 22 + 8 + 10;
const NOTE_LINE = 12.5 * 1.45;
const NOTE_CHAR = 6.8;

/**
 * The size a note needs to show all of `text`: the default width, and as tall as the text wraps to, rounded up to the
 * grid, with a line to spare since a font can wrap a little earlier than the estimate says.
 */
export function noteFit(text: string, w: number = NOTE_DEFAULT.w): { w: number; h: number } {
  const chars = Math.max(8, Math.floor((w - 24) / NOTE_CHAR));
  const h = NOTE_CHROME + (wrappedLines(text, chars) + 1) * NOTE_LINE;
  return { w, h: Math.max(NOTE_MIN.h, Math.ceil(h / GRID) * GRID) };
}

/** Clear space kept around anything a note lands beside, so it never touches it. */
const MARGIN = GRID;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Everything a new note must not land on: steps, squares, notes containers and the notes that are drawn. A note
 * folded into a shrunk container is not drawn, so it holds no space; `except` leaves some notes out, for ones being placed again.
 */
export function occupied(flow: Flow, except: ReadonlySet<string> = new Set()): Rect[] {
  const placed = ensurePositions(flow);
  const folded = new Set((flow.noteStacks ?? []).filter((s) => s.expanded === false).map((s) => s.id));
  return [
    ...placed.nodes.flatMap((n) => (n.pos ? [{ x: n.pos.x, y: n.pos.y, w: NODE_W, h: NODE_H }] : [])),
    ...(flow.asks ?? []).map((a) => ({ x: a.pos.x, y: a.pos.y, w: ASK_SIZE, h: ASK_SIZE })),
    ...(flow.noteStacks ?? []).map((s) => ({ x: s.x, y: s.y, ...STACK_SIZE })),
    ...(flow.notes ?? []).filter((n) => !except.has(n.id) && !(n.stack && folded.has(n.stack))).map((n) => ({ x: n.x, y: n.y, ...noteSize(n) })),
  ];
}

const clear = (at: { x: number; y: number }, size: { w: number; h: number }, taken: Rect[]) =>
  !taken.some((r) => at.x < r.x + r.w + MARGIN && at.x + size.w + MARGIN > r.x && at.y < r.y + r.h + MARGIN && at.y + size.h + MARGIN > r.y);

/**
 * The spot nearest `want` where something of `size` fits without touching anything. It looks at `want` first, then at
 * rings of spots around it, one grid step further out each time, nearest first. Gives `want` back when the canvas is full.
 */
export function nearestFree(want: { x: number; y: number }, taken: Rect[], size: { w: number; h: number } = NOTE_DEFAULT): { x: number; y: number } {
  const start = { x: snap(want.x), y: snap(want.y) };
  if (clear(start, size, taken)) return start;
  for (let ring = 1; ring <= 120; ring += 1) {
    const ring_ = ring * GRID;
    let best: { x: number; y: number; d: number } | null = null;
    for (let i = -ring; i <= ring; i += 1) {
      const edge = i * GRID;
      for (const [dx, dy] of [[edge, -ring_], [edge, ring_], [-ring_, edge], [ring_, edge]]) {
        const at = { x: start.x + dx, y: start.y + dy };
        const d = Math.hypot(dx, dy);
        if ((!best || d < best.d) && clear(at, size, taken)) best = { ...at, d };
      }
    }
    if (best) return { x: best.x, y: best.y };
  }
  return start;
}

/** Where the next note goes: straight under the one above when that is free, otherwise the nearest free spot. */
function below(at: { x: number; y: number }, above: { h: number }, size: { w: number; h: number }, taken: Rect[]) {
  return nearestFree({ x: at.x, y: at.y + above.h + GRID }, taken, size);
}

/**
 * What a turn leaves on the canvas: one notes container at `spot` named for what you asked, and a yellow note for
 * everything the agent did, all of them held inside it (the card is shrunk, so the workflow shows one card, not a column
 * of notes; expand it to see them on the workflow). Every note is as tall as its text needs, so none is cut off, and they
 * are placed one under the next on free ground. Notes that touched a step are joined to it by a dotted line, and the
 * notes are chained to the card by short ones. Nothing is dropped, however many there are.
 */
export function leaveNotes(flow: Flow, spot: { x: number; y: number }, ask: string, lines: Array<{ text: string; touched?: string | null }>): Flow {
  const taken = occupied(flow);
  const card = nearestFree(spot, taken, STACK_SIZE);
  taken.push({ ...card, ...STACK_SIZE });
  let next = addNoteStack(flow, card, oneLine(ask) || "Asked the agent", false);
  const stack = next.noteStacks![next.noteStacks!.length - 1].id;
  let previous: { kind: "stack" | "note"; id: string } = { kind: "stack", id: stack };
  let at = card;
  let above: { h: number } = STACK_SIZE;
  for (const line of lines) {
    const text = oneLine(line.text);
    const size = noteFit(text);
    at = below(at, above, size, taken);
    taken.push({ ...at, ...size });
    next = addNote(next, at, text, "yellow", { stack, ...size });
    const made: { kind: "note"; id: string } = { kind: "note", id: next.notes![next.notes!.length - 1].id };
    // A chain, the card to the first note and each to the next, so the stack is joined by short dashes, not a fan of long lines.
    next = addNoteLink(next, previous, made);
    previous = made;
    above = size;
    if (line.touched && next.nodes.some((n) => n.id === line.touched)) next = addNoteLink(next, made, { kind: "node", id: line.touched });
  }
  return next;
}

/**
 * Show a container's notes on the workflow. Notes keep their place from when they were last shown, so any that still
 * sit on free ground stay where they are; the rest (something was put there meanwhile) are set down again, one under
 * the next from the card, on ground that is free.
 */
export function expandStack(flow: Flow, id: string): Flow {
  const stack = (flow.noteStacks ?? []).find((s) => s.id === id);
  if (!stack) return flow;
  const members = stackNotes(flow, id);
  const taken = occupied(flow, new Set(members.map((n) => n.id)));
  // Rects of cards belonging to this container itself would block its own notes; the card is there on purpose.
  let next = updateNoteStack(flow, id, { expanded: true });
  let at: { x: number; y: number } = { x: stack.x, y: stack.y };
  let above: { h: number } = STACK_SIZE;
  for (const n of members) {
    const size = noteFit(n.text, noteSize(n).w);
    const h = Math.max(size.h, noteSize(n).h);
    const fits = clear({ x: n.x, y: n.y }, { w: size.w, h }, taken);
    const spot = fits ? { x: n.x, y: n.y } : below(at, above, { w: size.w, h }, taken);
    taken.push({ ...spot, w: size.w, h });
    if (!fits || n.h !== h) next = updateNote(next, n.id, { x: spot.x, y: spot.y, w: size.w, h });
    at = spot;
    above = { h };
  }
  return next;
}

// ---- Diff notes: what Polish offers for a step, left beside it to be accepted or rejected. ----

/** A diff note's default width, and the tallest it starts at; a longer diff scrolls inside it (it can be resized). */
export const DIFF_NOTE_WIDTH = 320;
export const DIFF_NOTE_MAX_H = 260;

/** The height a diff note starts at: what its fields need (two sides of words each), up to the most it opens at. */
function diffFit(diff: NoteDiff): number {
  const chars = Math.floor((DIFF_NOTE_WIDTH - 24) / 6.4);
  let h = 22 + 24 + 34;
  for (const field of [diff.readable, diff.prompt]) {
    if (field) h += 16 + 2 * (14 + wrappedLines(field.base, chars) * 18) + 6;
  }
  return Math.ceil(Math.min(DIFF_NOTE_MAX_H, Math.max(120, h)) / GRID) * GRID;
}

/**
 * Leave one diff note per offer, just right of its step, joined to it by a dotted line. A note is set at the step's
 * height and moved down in steps until it touches nothing; if there is no room below, the nearest free spot is used.
 * An older diff note for the same step is replaced. Notes and links are a drawing: a locked plan stays locked.
 */
export function leaveDiffNotes(flow: Flow, offers: NoteDiff[]): Flow {
  const replaced = new Set(offers.map((o) => o.node));
  let next = flow;
  for (const old of diffNotes(flow)) if (replaced.has(old.diff!.node)) next = removeNote(next, old.id);
  const placed = ensurePositions(next);
  const taken = occupied(next);
  for (const offer of offers) {
    const node = placed.nodes.find((n) => n.id === offer.node);
    if (!node) continue;
    const size = { w: DIFF_NOTE_WIDTH, h: diffFit(offer) };
    const want = { x: snap((node.pos?.x ?? 0) + NODE_W + 2 * GRID), y: snap(node.pos?.y ?? 0) };
    let at = want;
    for (let i = 0; i < 40 && !clear(at, size, taken); i += 1) at = { x: want.x, y: want.y + (i + 1) * 2 * GRID };
    if (!clear(at, size, taken)) at = nearestFree(want, taken, size);
    taken.push({ ...at, ...size });
    const title = oneLine(node.text) || "Untitled step";
    next = addNote(next, at, title, DIFF_NOTE_COLOR, { ...size, diff: offer });
    next = addNoteLink(next, { kind: "note", id: next.notes![next.notes!.length - 1].id }, { kind: "node", id: node.id });
  }
  return next;
}

/**
 * Accept diff notes: each one's texts go onto its step, the prompt through the same path a polished prompt always took
 * and the readable text beside it, and the note and its dotted line are removed. A text that changed since the model saw
 * it is left as it is (`stale` counts those notes). The plan keeps its lock: polishing finishes a locked plan, it does not break it.
 */
export function takeDiffNotes(flow: Flow, ids: string[]): { flow: Flow; taken: number; stale: number } {
  let next = flow;
  let taken = 0;
  let stale = 0;
  for (const id of ids) {
    const diff = (next.notes ?? []).find((n) => n.id === id)?.diff;
    if (!diff) continue;
    const node = next.nodes.find((n) => n.id === diff.node);
    if (node) {
      let patch: Parameters<typeof updateNode>[2] = {};
      let old = false;
      if (diff.prompt) {
        if (basePromptText(next, node).trim() === diff.prompt.base.trim()) patch = { ...patch, ...acceptRewrite(next, node, diff.prompt.text) };
        else old = true;
      }
      if (diff.readable) {
        if ((node.readable?.trim() || node.text).trim() === diff.readable.base.trim()) patch = { ...patch, readable: diff.readable.text };
        else old = true;
      }
      if (Object.keys(patch).length > 0) {
        next = updateNode(next, node.id, patch, { keepLock: true });
        taken += 1;
      }
      if (old) stale += 1;
    }
    next = removeNote(next, id);
  }
  return { flow: next, taken, stale };
}

/** Reject diff notes: the notes and their dotted lines go, and nothing else changes. */
export function dropDiffNotes(flow: Flow, ids: string[]): Flow {
  let next = flow;
  for (const id of ids) if ((next.notes ?? []).some((n) => n.id === id && n.diff)) next = removeNote(next, id);
  return next;
}
