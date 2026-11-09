import { describeGraph, extractJson, type Complete } from "./flowCloud";
import { isAnswered } from "./flowAsk";
import type { Flow, FlowAsk } from "./flowModel";

/**
 * The timeline of a workflow: how its plan came about. Every point is one question (a square the agent put on the canvas,
 * or one answered at run time) or one agent turn that had no questions, with a snapshot of the flow after it. Points
 * form a tree: rewind to an earlier point and change anything, and a new line starts from there. The old line is kept.
 *
 * This file is plain data and pure functions; storage is in flowHistory.ts and the drawing in components/FlowStrip.tsx.
 */

export type PointKind = "question" | "turn" | "edit" | "merge";

export interface TimelinePoint {
  id: string;
  /** The point before this one on its line, or the one a new line started from. Null for the first point. */
  parent: string | null;
  /** For a merge: the tip of the branch it folded in. */
  merged?: string;
  /** 0 is the main line; each new branch takes the next number. */
  line: number;
  at: number;
  kind: PointKind;
  /** The questions asked together in one turn share this; a lone question has none. */
  group?: string;
  /** The question, or the agent's one-line note. */
  label: string;
  answer?: string;
  /** A merge waiting for its three suggestions to be picked and kept. */
  pending?: boolean;
  snapshot: Flow;
  /** The length of the snapshot as text, so storage can be kept under a size. */
  size: number;
}

export interface Timeline {
  points: TimelinePoint[];
  /** The point the work stands at: the end of the line new points are added to. */
  head: string | null;
}

export const EMPTY_TIMELINE: Timeline = { points: [], head: null };

/** The most points kept for one workflow, and the most text they may add up to. The oldest go first. */
export const MAX_POINTS = 200;
export const MAX_BYTES = 2_800_000;

/** What a new point is made from. */
export interface PointSpec {
  kind: PointKind;
  label: string;
  answer?: string;
  group?: string;
  snapshot: Flow;
  pending?: boolean;
  merged?: string;
  /** Start a new line from this point instead of continuing the head's line. */
  forkFrom?: string;
  /** Put it right after this point on that point's line (a merge goes on the main line). */
  after?: string;
}

const find = (tl: Timeline, id: string | null | undefined) => (id ? tl.points.find((p) => p.id === id) : undefined);

/** The last point of a line. */
export function tipOf(tl: Timeline, line: number): TimelinePoint | undefined {
  for (let i = tl.points.length - 1; i >= 0; i -= 1) if (tl.points[i].line === line) return tl.points[i];
  return undefined;
}

/** Whether nothing comes after a point on its own line. */
export function isTip(tl: Timeline, point: TimelinePoint): boolean {
  return !tl.points.some((p) => p.parent === point.id && p.line === point.line);
}

/** The branches that can be merged into the main line: their last point, not yet folded in by a merge. */
export function branchTips(tl: Timeline): TimelinePoint[] {
  const merged = new Set(tl.points.filter((p) => p.merged).map((p) => p.merged));
  return tl.points.filter((p) => p.line > 0 && isTip(tl, p) && !merged.has(p.id));
}

/** The column a line is drawn in: the main line in the first, branches in the second and third (a fourth reuses the third). */
export const columnOf = (line: number) => Math.min(line, 2);

function trimmed(points: TimelinePoint[]): TimelinePoint[] {
  let out = points;
  let bytes = out.reduce((n, p) => n + p.size, 0);
  while (out.length > 1 && (out.length > MAX_POINTS || bytes > MAX_BYTES)) {
    bytes -= out[0].size;
    out = out.slice(1);
  }
  return out;
}

/** The text length of a snapshot, for the size cap. */
export const sizeOf = (flow: Flow) => JSON.stringify(flow).length;

/** Add a point. It continues the head's line, or starts a new line when `forkFrom` is set. */
export function addPoint(tl: Timeline, spec: PointSpec, id: string, now = Date.now()): Timeline {
  const after = find(tl, spec.after);
  const from = find(tl, spec.forkFrom);
  const head = find(tl, tl.head);
  const line = from ? Math.max(0, ...tl.points.map((p) => p.line)) + 1 : (after ?? head)?.line ?? 0;
  const parent = from ? from.id : after ? after.id : head ? head.id : null;
  const point: TimelinePoint = {
    id,
    parent,
    merged: spec.merged,
    line,
    at: now,
    kind: spec.kind,
    group: spec.group,
    label: spec.label,
    answer: spec.answer,
    pending: spec.pending,
    snapshot: spec.snapshot,
    size: sizeOf(spec.snapshot),
  };
  return { points: trimmed([...tl.points, point]), head: id };
}

/** Change a point in place (a merge being finished). */
export function patchPoint(tl: Timeline, id: string, patch: Partial<Omit<TimelinePoint, "id" | "size">>): Timeline {
  if (!find(tl, id)) return tl;
  return {
    ...tl,
    points: tl.points.map((p) => {
      if (p.id !== id) return p;
      const next = { ...p, ...patch };
      return patch.snapshot ? { ...next, size: sizeOf(patch.snapshot) } : next;
    }),
  };
}

/** Take a point out (a merge that was called off). The head falls back to its parent. */
export function dropPoint(tl: Timeline, id: string): Timeline {
  const point = find(tl, id);
  if (!point) return tl;
  return { points: tl.points.filter((p) => p.id !== id), head: tl.head === id ? point.parent : tl.head };
}

/** A pending merge left over from a session that ended is not a real point: drop it. */
export function dropPending(tl: Timeline): Timeline {
  return tl.points.reduce((acc, p) => (p.pending ? dropPoint(acc, p.id) : acc), tl);
}

/** Whether a flow is the same as a point's snapshot (the work has moved on from the point if not). */
export function sameFlow(a: Flow, b: Flow): boolean {
  return a === b || (a.updatedAt === b.updatedAt && JSON.stringify(a) === JSON.stringify(b));
}

// ---- Reading answers out of changes ----

/** The answer on a square as one line. */
export function askAnswerLine(ask: FlowAsk): string {
  if (ask.skipped) return "Skipped";
  return ask.fields
    .map((f) => (f.value ?? "").trim())
    .filter(Boolean)
    .join("; ");
}

/** The squares a change answered (or skipped) that were not answered before. A constant is set while planning, not asked. */
export function newlyAnswered(prev: Flow, next: Flow): FlowAsk[] {
  const before = new Map((prev.asks ?? []).map((a) => [a.id, a] as const));
  return (next.asks ?? []).filter((a) => a.kind !== "constant" && isAnswered(a) && !(before.get(a.id) && isAnswered(before.get(a.id)!)));
}

/** The point a newly answered square makes. */
export function questionPoint(ask: FlowAsk, snapshot: Flow): PointSpec {
  return {
    kind: "question",
    label: ask.fields.length > 1 ? ask.title || ask.fields[0]?.label || "Questions" : ask.fields[0]?.label || ask.title || "A question",
    answer: askAnswerLine(ask),
    group: ask.origin === "agent" ? ask.turn : undefined,
    snapshot,
  };
}

// ---- Drawing: where each point, link and group goes ----

export const ROW_H = 18;
export const COL_W = 13;
export const COL_X0 = 10;

export interface StripDot {
  point: TimelinePoint;
  row: number;
  col: number;
}

export interface StripLink {
  from: { row: number; col: number };
  to: { row: number; col: number };
  kind: "line" | "fork" | "merge";
}

export interface StripGroup {
  from: number;
  to: number;
  col: number;
}

export interface StripLayout {
  dots: StripDot[];
  links: StripLink[];
  groups: StripGroup[];
  rows: number;
}

/** Rows run in the order points were made, oldest first. */
export function layoutStrip(tl: Timeline): StripLayout {
  const where = new Map<string, StripDot>();
  const dots = tl.points.map((point, row) => {
    const dot = { point, row, col: columnOf(point.line) };
    where.set(point.id, dot);
    return dot;
  });
  const links: StripLink[] = [];
  for (const dot of dots) {
    const parent = dot.point.parent ? where.get(dot.point.parent) : undefined;
    if (parent) links.push({ from: { row: parent.row, col: parent.col }, to: { row: dot.row, col: dot.col }, kind: parent.col === dot.col ? "line" : "fork" });
    const merged = dot.point.merged ? where.get(dot.point.merged) : undefined;
    if (merged) links.push({ from: { row: merged.row, col: merged.col }, to: { row: dot.row, col: dot.col }, kind: "merge" });
  }
  // A group is questions asked together: dots with the same group next to each other on one line. A lone question gets no box.
  const groups: StripGroup[] = [];
  let start = 0;
  for (let i = 1; i <= dots.length; i += 1) {
    const here = dots[i];
    const first = dots[start];
    if (here && first.point.group && here.point.group === first.point.group && here.col === first.col) continue;
    if (first.point.group && i - start > 1) groups.push({ from: first.row, to: dots[i - 1].row, col: first.col });
    start = i;
  }
  return { dots, links, groups, rows: dots.length };
}

/** The tooltip for a point: the question and its answer, or the agent's note. */
export function pointTip(p: TimelinePoint): string {
  if (p.kind === "question") return `${p.label}\n${p.answer || "No answer"}`;
  if (p.kind === "merge") return p.pending ? "Merging a branch into the main line…" : `Merged: ${p.label}`;
  if (p.kind === "edit") return p.label;
  return p.label;
}

// ---- Merging ----

/** One way to join a branch into the main line: said in a line, with what would exist after it and what would be left out. */
export interface MergeSuggestion {
  title: string;
  summary: string;
  /** What the main line would have after the merge. */
  exists: string[];
  /** What would be removed because the two lines disagree about it. */
  removed: string[];
  /** What to tell the editor to do to the main line's workflow. */
  instruction: string;
}

const MERGE_SYSTEM = `You join two versions of one workflow. They began as the same plan and went different ways: the MAIN version and a BRANCH. Each is shown as one line per step: id [kind · tool] text | needs | makes.
Suggest exactly three different ways to end up with one workflow, as edits to the MAIN version. For example: keep main and add the branch's best new steps; take the branch's approach where the two disagree and keep main's other steps; or blend by choosing step by step. Make the three really different from each other.
For each suggestion give:
- "title": two to four words
- "summary": one plain line saying what the merged workflow is like
- "exists": three to six short phrases naming what the merged workflow would contain that matters
- "removed": the steps or approaches that would be dropped because the two versions conflict, each with the reason in a few words (empty when nothing conflicts)
- "instruction": the concrete change to make to the MAIN workflow, written for an editor that adds, rewords, removes and rewires steps. Name steps by their text.
Reply with one JSON object and nothing else:
{"suggestions":[{"title":"","summary":"","exists":[""],"removed":[""],"instruction":""}]}`;

const lines = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max) : [];

/** Read the three suggestions a model sent. Anything without an instruction is dropped. */
export function parseMerges(raw: string): MergeSuggestion[] {
  const parsed = extractJson(raw) as { suggestions?: unknown };
  const list = Array.isArray(parsed.suggestions) ? (parsed.suggestions as Array<Record<string, unknown>>) : [];
  const out: MergeSuggestion[] = [];
  for (const item of list) {
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const instruction = text(item.instruction);
    if (!instruction) continue;
    out.push({
      title: text(item.title).slice(0, 40) || `Option ${out.length + 1}`,
      summary: text(item.summary).slice(0, 220),
      exists: lines(item.exists, 6),
      removed: lines(item.removed, 6),
      instruction,
    });
    if (out.length === 3) break;
  }
  if (out.length === 0) throw new Error("The cloud model sent back no ways to merge.");
  return out;
}

/** One cloud request: three ways to merge a branch into the main line. */
export async function suggestMerges(complete: Complete, main: Flow, branch: Flow): Promise<MergeSuggestion[]> {
  const prompt = [
    `Workflow: ${main.title || "untitled"}`,
    `MAIN version:\n${describeGraph(main) || "(empty)"}`,
    "",
    `BRANCH version:\n${describeGraph(branch) || "(empty)"}`,
  ].join("\n");
  return parseMerges(await complete(MERGE_SYSTEM, prompt, 3000));
}
