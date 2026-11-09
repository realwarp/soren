import { useSyncExternalStore } from "react";
import { answerLine, emptyAnswer, SKIPPED_ANSWER, type DecisionAnswer, type DecisionQuestion } from "./flowDecisions";
import type { Flow } from "./flowModel";
import { addPoint, dropPending, EMPTY_TIMELINE, type PointSpec, type Timeline } from "./flowTimeline";

/**
 * The history of a workflow: every turn you had with the agent from the canvas, newest first. A turn is what you asked
 * (the text typed where you double-clicked), the questions the Asker put to you and your answers, the one line the
 * agent left as its note, and what became of its change: kept, turned down, or none was asked for.
 *
 * It is kept in this device's local storage next to the workflows, one list per workflow id, so it follows the workflow
 * without being part of the graph (and so is never read by the agent as a note).
 */

/** "asking" is a turn whose questions are on the canvas and not all answered yet. */
export type TurnOutcome = "answered" | "applied" | "rejected" | "asking";

export interface HistoryDecision {
  question: string;
  answer: string;
}

export interface HistoryTurn {
  id: string;
  at: number;
  /** What was typed in the box. */
  ask: string;
  /** The agent's one-line note. */
  reply: string;
  /** The Asker's questions and the answers given. Empty when none were asked. */
  decisions: HistoryDecision[];
  outcome: TurnOutcome;
  /** For a change: the editor's summary line, and the list of things it did (or would have done). */
  summary?: string;
  changes: string[];
}

const KEY = "soren.flowHistory.v1";
/** The most turns kept for one workflow; the oldest go first. */
export const MAX_TURNS = 200;

type Store = Record<string, HistoryTurn[]>;

let cache: Store | null = null;
const listeners = new Set<() => void>();
const EMPTY: HistoryTurn[] = [];

function looksLikeTurn(value: unknown): value is HistoryTurn {
  const turn = value as Partial<HistoryTurn> | null;
  return Boolean(turn && typeof turn.id === "string" && typeof turn.ask === "string" && typeof turn.at === "number");
}

function read(): Store {
  if (cache) return cache;
  const store: Store = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, turns] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(turns)) store[id] = turns.filter(looksLikeTurn).map((t) => ({ ...t, decisions: t.decisions ?? [], changes: t.changes ?? [] }));
      }
    }
  } catch {
    // Unreadable or blocked storage: start empty; the session still works in memory.
  }
  cache = store;
  return store;
}

function write(next: Store): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage can be blocked or full; the history then lasts until reload.
  }
  listeners.forEach((listener) => listener());
}

/** The turns of one workflow, newest first. The same array is returned until it changes. */
export function loadHistory(flowId: string): HistoryTurn[] {
  return read()[flowId] ?? EMPTY;
}

/** Add a turn at the top of a workflow's history. */
export function recordTurn(flowId: string, turn: Omit<HistoryTurn, "id" | "at"> & { at?: number }, now = Date.now()): HistoryTurn {
  const full: HistoryTurn = { ...turn, id: `h${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: turn.at ?? now };
  write({ ...read(), [flowId]: [full, ...loadHistory(flowId)].slice(0, MAX_TURNS) });
  return full;
}

/** Change a turn that is already recorded, as when its questions are answered or its change is kept. */
export function updateTurn(flowId: string, id: string, patch: Partial<Omit<HistoryTurn, "id">>): void {
  const turns = loadHistory(flowId);
  if (!turns.some((t) => t.id === id)) return;
  write({ ...read(), [flowId]: turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

/** The questions of one batch on the canvas with the answers so far, as lines for the history. */
export function batchDecisions(flow: Flow, turn: string): HistoryDecision[] {
  return (flow.asks ?? [])
    .filter((a) => a.turn === turn)
    .map((a) => ({
      question: a.fields[0]?.label || a.title,
      answer: a.skipped ? SKIPPED_ANSWER : (a.fields[0]?.value ?? "").trim(),
    }));
}

/** Forget a workflow's history, as when the workflow is deleted. */
export function forgetHistory(flowId: string): void {
  forgetTimeline(flowId);
  const store = read();
  if (!(flowId in store)) return;
  const { [flowId]: _gone, ...rest } = store;
  write(rest);
}

// ---- The timeline: the points of a workflow's plan, each with a snapshot (see flowTimeline.ts) ----

const TIMELINE_KEY = "soren.flowTimeline.v1";

let timelines: Record<string, Timeline> | null = null;
const timelineListeners = new Set<() => void>();

function looksLikeTimeline(value: unknown): value is Timeline {
  const tl = value as Partial<Timeline> | null;
  return Boolean(tl && Array.isArray(tl.points) && tl.points.every((p) => p && typeof p.id === "string" && p.snapshot && Array.isArray(p.snapshot.nodes)));
}

function readTimelines(): Record<string, Timeline> {
  if (timelines) return timelines;
  const out: Record<string, Timeline> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TIMELINE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, tl] of Object.entries(parsed as Record<string, unknown>)) if (looksLikeTimeline(tl)) out[id] = tl;
    }
  } catch {
    // Unreadable or blocked storage: start empty.
  }
  timelines = out;
  return out;
}

function writeTimelines(next: Record<string, Timeline>): void {
  timelines = next;
  try {
    localStorage.setItem(TIMELINE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be blocked or full; the timeline then lasts until reload.
  }
  timelineListeners.forEach((listener) => listener());
}

/** A workflow's timeline. The same object is returned until it changes. */
export function loadTimeline(flowId: string): Timeline {
  return readTimelines()[flowId] ?? EMPTY_TIMELINE;
}

/** Change a workflow's timeline with a pure function from flowTimeline.ts. */
export function updateTimeline(flowId: string, change: (tl: Timeline) => Timeline): Timeline {
  const before = loadTimeline(flowId);
  const after = change(before);
  if (after !== before) writeTimelines({ ...readTimelines(), [flowId]: after });
  return after;
}

/** Add a point to a workflow's timeline; returns its id. */
export function recordPoint(flowId: string, spec: PointSpec, now = Date.now()): string {
  const id = `p${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  updateTimeline(flowId, (tl) => addPoint(tl, spec, id, now));
  return id;
}

/** Drop a merge left pending by a session that ended. */
export function clearPendingMerges(flowId: string): void {
  updateTimeline(flowId, dropPending);
}

function forgetTimeline(flowId: string): void {
  const all = readTimelines();
  if (!(flowId in all)) return;
  const { [flowId]: _gone, ...rest } = all;
  writeTimelines(rest);
}

function subscribeTimelines(listener: () => void): () => void {
  timelineListeners.add(listener);
  return () => timelineListeners.delete(listener);
}

/** A workflow's timeline, live: it redraws when a point is added or changed. */
export function useTimeline(flowId: string): Timeline {
  return useSyncExternalStore(subscribeTimelines, () => loadTimeline(flowId));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The history of a workflow, live: it redraws when a turn is added. */
export function useHistory(flowId: string): HistoryTurn[] {
  return useSyncExternalStore(subscribe, () => loadHistory(flowId));
}

/** The Asker's questions with the answers given, as plain lines for the history. */
export function recordDecisions(questions: DecisionQuestion[], answers: DecisionAnswer[]): HistoryDecision[] {
  return questions.map((q, i) => ({ question: q.question, answer: answerLine(answers[i] ?? emptyAnswer()) }));
}

export const OUTCOME_LABEL: Record<TurnOutcome, string> = {
  answered: "Answered",
  applied: "Applied",
  rejected: "Rejected",
  asking: "Asking",
};

/** For tests: drop the in-memory copy so the next read comes from storage. */
export function resetHistoryCache(): void {
  cache = null;
  timelines = null;
}
