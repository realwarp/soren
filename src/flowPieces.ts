import { ASK_SIZE, uniqueName } from "./flowAsk";
import { ensurePositions, NODE_H, NODE_W } from "./flowLayout";
import {
  noteSize,
  type Flow,
  type FlowAsk,
  type FlowContainer,
  type FlowNode,
  type FlowNote,
  type NoteLink,
  type NoteLinkEnd,
} from "./flowModel";

/**
 * Reusable pieces: a container with everything inside it (steps, squares, notes, boxes inside boxes, and the wires among
 * them), kept as plain data so it can be dropped onto any workflow with fresh ids. A thing is inside a container when the
 * middle of it sits within the box, as everywhere else. Positions are kept relative to the container's corner.
 *
 * Pieces are used in three places: saved presets, the copy and paste of a container, and the nine numbered slots.
 */

export interface Piece {
  /** The outer container, at 0,0. */
  container: Omit<FlowContainer, "id">;
  nodes: FlowNode[];
  asks: FlowAsk[];
  notes: FlowNote[];
  /** Boxes inside the outer one, with their ids as they were. */
  inner: FlowContainer[];
  noteLinks: NoteLink[];
}

const within = (c: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h;

/** Copy a container and everything inside it. Null when the container is not there. */
export function capturePiece(flow: Flow, containerId: string): Piece | null {
  const placed = ensurePositions(flow);
  const box = (placed.containers ?? []).find((c) => c.id === containerId);
  if (!box) return null;
  const rel = (p: { x: number; y: number }) => ({ x: p.x - box.x, y: p.y - box.y });

  // A collapsed container hides its steps but they still sit under it, so they are in it.
  const nodes = placed.nodes.filter((n) => n.kind !== "start" && n.pos && within(box, n.pos.x + NODE_W / 2, n.pos.y + NODE_H / 2));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const asks = (placed.asks ?? []).filter((a) => within(box, a.pos.x + ASK_SIZE / 2, a.pos.y + ASK_SIZE / 2));
  const askIds = new Set(asks.map((a) => a.id));
  const notes = (placed.notes ?? []).filter((n) => !n.stack && !n.diff && within(box, n.x + noteSize(n).w / 2, n.y + noteSize(n).h / 2));
  const noteIds = new Set(notes.map((n) => n.id));
  const inner = (placed.containers ?? []).filter(
    (c) => c.id !== box.id && c.x >= box.x && c.y >= box.y && c.x + c.w <= box.x + box.w && c.y + c.h <= box.y + box.h,
  );
  const innerIds = new Set(inner.map((c) => c.id));
  const hasEnd = (e: NoteLinkEnd) =>
    e.kind === "node" ? nodeIds.has(e.id) : e.kind === "ask" ? askIds.has(e.id) : e.kind === "note" ? noteIds.has(e.id) : e.kind === "container" ? innerIds.has(e.id) : false;

  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const varsInside = new Set(asks.flatMap((a) => a.fields.map((f) => f.name)));
  return {
    container: { name: box.name, color: box.color, x: 0, y: 0, w: box.w, h: box.h, collapsed: box.collapsed },
    nodes: nodes.map((n) => {
      const copy = clone(n);
      return {
        ...copy,
        pos: rel(n.pos!),
        inputs: copy.inputs.filter((r) => nodeIds.has(r.node)),
        done: undefined,
        failed: undefined,
        critic: copy.critic ? { ...copy.critic, rounds: [] } : undefined,
        asks: copy.asks?.filter((need) => askIds.has(need.ask)),
        askInputs: copy.askInputs?.filter((r) => askIds.has(r.ask)),
        when: copy.when && varsInside.has(copy.when.name) ? copy.when : undefined,
      };
    }),
    asks: asks.map((a) => ({ ...clone(a), pos: rel(a.pos), inputs: a.inputs?.filter((r) => askIds.has(r.ask)) })),
    notes: notes.map((n) => ({ ...clone(n), ...rel(n) })),
    inner: inner.map((c) => ({ ...clone(c), ...rel(c) })),
    noteLinks: (placed.noteLinks ?? []).filter((l) => hasEnd(l.from) && hasEnd(l.to)).map(clone),
  };
}

/** The first id with this prefix that is not taken, counting up from how many there are. */
function fresh(prefix: string, used: Set<string>): string {
  let n = used.size + 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  const id = `${prefix}${n}`;
  used.add(id);
  return id;
}

/**
 * Draw a piece on `flow` with its corner at `at`, every id new. A tool this workflow does not have is dropped from the
 * step, a question name another square already uses gets a number (and the steps that mention it follow), and an artifact
 * another step already makes is told apart with " (copy)". Returns the new container's id.
 */
export function placePiece(flow: Flow, piece: Piece, at: { x: number; y: number }): { flow: Flow; containerId: string } {
  const nodeUsed = new Set(flow.nodes.map((n) => n.id));
  const askUsed = new Set((flow.asks ?? []).map((a) => a.id));
  const boxUsed = new Set((flow.containers ?? []).map((c) => c.id));
  const noteUsed = new Set((flow.notes ?? []).map((n) => n.id));
  const linkUsed = new Set((flow.noteLinks ?? []).map((l) => l.id));
  const nodeMap = new Map(piece.nodes.map((n) => [n.id, fresh("n", nodeUsed)] as const));
  const askMap = new Map(piece.asks.map((a) => [a.id, fresh("ask", askUsed)] as const));
  const noteMap = new Map(piece.notes.map((n) => [n.id, fresh("note", noteUsed)] as const));
  const boxMap = new Map(piece.inner.map((c) => [c.id, fresh("c", boxUsed)] as const));
  const containerId = fresh("c", boxUsed);
  const shift = (p: { x: number; y: number }) => ({ x: p.x + at.x, y: p.y + at.y });

  // Question names: keep them unless taken, and keep the steps that use {name} pointing at the right one.
  let working = flow;
  const renames = new Map<string, string>();
  const asks: FlowAsk[] = [];
  for (const a of piece.asks) {
    const fields = a.fields.map((f) => {
      const name = uniqueName({ ...working, asks: [...(working.asks ?? []), ...asks] }, f.name);
      if (name !== f.name) renames.set(f.name, name);
      // A name made unique above is only unique against what is already placed, so place as we go.
      // A copy asks again when it is run; only a constant keeps its value.
      return { ...f, name, value: a.kind === "constant" ? f.value : undefined };
    });
    asks.push({ ...a, id: askMap.get(a.id)!, fields, pos: shift(a.pos), inputs: a.inputs?.map((r) => ({ ...r, ask: askMap.get(r.ask)! })), skipped: false });
  }
  const rename = (text: string) => (renames.size === 0 ? text : text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, name: string) => (renames.has(name) ? `{${renames.get(name)}}` : whole)));
  const takenLabels = new Set(flow.nodes.filter((n) => n.kind !== "verifier" && n.kind !== "approval").flatMap((n) => n.outputs.map((p) => p.label.trim().toLowerCase())));
  const nodes: FlowNode[] = piece.nodes.map((n) => {
    const hasTool = Boolean(n.toolId && flow.tools.some((t) => t.id === n.toolId));
    return {
      ...n,
      id: nodeMap.get(n.id)!,
      pos: shift(n.pos!),
      text: rename(n.text),
      prompt: n.prompt ? rename(n.prompt) : n.prompt,
      segments: n.segments?.map((seg) => ({ ...seg, text: rename(seg.text) })),
      basis: n.basis ? Object.fromEntries(Object.entries(n.basis).map(([key, text]) => [key, rename(text)])) : n.basis,
      readable: n.readable ? rename(n.readable) : n.readable,
      toolId: hasTool ? n.toolId : undefined,
      modelId: hasTool ? n.modelId : undefined,
      inputs: n.inputs.filter((r) => nodeMap.has(r.node)).map((r) => ({ ...r, node: nodeMap.get(r.node)! })),
      asks: n.asks?.filter((need) => askMap.has(need.ask)).map((need) => ({ ...need, ask: askMap.get(need.ask)! })),
      askInputs: n.askInputs?.filter((r) => askMap.has(r.ask)).map((r) => ({ ...r, ask: askMap.get(r.ask)! })),
      when: n.when ? { ...n.when, name: renames.get(n.when.name) ?? n.when.name } : undefined,
      critic: n.critic ? { ...n.critic, toolId: flow.tools.some((t) => t.id === n.critic?.toolId) ? n.critic.toolId : undefined } : undefined,
      outputs:
        n.kind === "verifier" || n.kind === "approval"
          ? n.outputs
          : n.outputs.map((p) => (takenLabels.has(p.label.trim().toLowerCase()) ? { ...p, label: `${p.label} (copy)` } : p)),
    };
  });
  const notes: FlowNote[] = piece.notes.map((n) => ({ ...n, id: noteMap.get(n.id)!, ...shift(n) }));
  const inner: FlowContainer[] = piece.inner.map((c) => ({ ...c, id: boxMap.get(c.id)!, ...shift(c) }));
  const mapEnd = (e: NoteLinkEnd): NoteLinkEnd => ({
    kind: e.kind,
    id: (e.kind === "node" ? nodeMap : e.kind === "ask" ? askMap : e.kind === "note" ? noteMap : boxMap).get(e.id) ?? e.id,
  });
  const noteLinks: NoteLink[] = piece.noteLinks.map((l) => ({ id: fresh("nl", linkUsed), from: mapEnd(l.from), to: mapEnd(l.to) }));
  const outer: FlowContainer = { ...piece.container, id: containerId, ...shift(piece.container) };
  working = {
    ...flow,
    nodes: [...flow.nodes, ...nodes],
    asks: [...(flow.asks ?? []), ...asks],
    notes: [...(flow.notes ?? []), ...notes],
    // The outer box goes first so it is drawn under the boxes inside it.
    containers: [...(flow.containers ?? []), outer, ...inner],
    noteLinks: [...(flow.noteLinks ?? []), ...noteLinks],
    locked: nodes.length > 0 ? false : flow.locked,
    revision: nodes.length > 0 ? flow.revision + 1 : flow.revision,
    updatedAt: Date.now(),
  };
  return { flow: working, containerId };
}

// ---- Age colour for the numbered slots ----

export interface AgeLimits {
  /** Fully green up to here, in days. */
  freshDays: number;
  /** Fully yellow here. */
  yellowDays: number;
  /** Fully red here and after. */
  redDays: number;
}

export const DEFAULT_LIMITS: AgeLimits = { freshDays: 1, yellowDays: 7, redDays: 14 };

const HUE = { green: 135, yellow: 48, red: 2 } as const;

/**
 * The hue, in degrees, for something this old: green until `freshDays`, sliding to yellow at `yellowDays` and on to red at
 * `redDays`, with no jump anywhere. Limits that are out of order are pulled into order, never an error.
 */
export function ageHue(ageDays: number, limits: AgeLimits = DEFAULT_LIMITS): number {
  const fresh = Math.max(0, limits.freshDays);
  const yellow = Math.max(fresh, limits.yellowDays);
  const red = Math.max(yellow, limits.redDays);
  const mix = (from: number, to: number, start: number, end: number) => (end <= start ? to : from + ((to - from) * (ageDays - start)) / (end - start));
  if (ageDays <= fresh) return HUE.green;
  if (ageDays <= yellow) return mix(HUE.green, HUE.yellow, fresh, yellow);
  if (ageDays <= red) return mix(HUE.yellow, HUE.red, yellow, red);
  return HUE.red;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

// ---- What is kept: saved presets and the nine slots, in this device's local storage ----

export interface Preset {
  id: string;
  name: string;
  savedAt: number;
  piece: Piece;
}

export interface Slot {
  name: string;
  storedAt: number;
  piece: Piece;
}

interface Kept {
  presets: Preset[];
  slots: Record<string, Slot>;
}

const KEY = "soren.pieces.v1";
let kept: Kept | null = null;
const listeners = new Set<() => void>();

function load(): Kept {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Kept>) : {};
    return {
      presets: Array.isArray(parsed.presets) ? parsed.presets.filter((p) => p && typeof p.id === "string" && p.piece) : [],
      slots: parsed.slots && typeof parsed.slots === "object" ? parsed.slots : {},
    };
  } catch {
    return { presets: [], slots: {} };
  }
}

function state(): Kept {
  if (!kept) kept = load();
  return kept;
}

function save(next: Kept) {
  // A new object each time, so a subscriber can tell it changed.
  kept = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Lasts until the app closes when storage is blocked or full.
  }
  listeners.forEach((l) => l());
}

export const subscribePieces = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getPieces = (): Kept => state();

export function savePreset(name: string, piece: Piece): Preset {
  const now = Date.now();
  const preset: Preset = { id: `pre_${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, name: name.trim() || piece.container.name || "Piece", savedAt: now, piece };
  save({ ...state(), presets: [...state().presets, preset] });
  return preset;
}

export function deletePreset(id: string) {
  save({ ...state(), presets: state().presets.filter((p) => p.id !== id) });
}

export function storeSlot(n: number, name: string, piece: Piece, now = Date.now()) {
  save({ ...state(), slots: { ...state().slots, [String(n)]: { name: name.trim() || "Container", storedAt: now, piece } } });
}

export function clearSlot(n: number) {
  const slots = { ...state().slots };
  delete slots[String(n)];
  save({ ...state(), slots });
}

export const getSlot = (n: number): Slot | undefined => state().slots[String(n)];
