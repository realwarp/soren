import { ASK_SIZE, addAsk, answerAsk, isAnswered, skipAsk, updateAsk, updateAskField } from "./flowAsk";
import { GRID, snap } from "./flowLayout";
import { nearestFree, occupied } from "./flowNotes";
import { addNoteLink, STACK_SIZE, type Flow } from "./flowModel";

/**
 * The Asker. Before the agent draws a change, it may put the major decisions in the request to the person, one at a
 * time. Each answer is kept on the canvas as a decision square, made here by code from the answers (the agent never
 * writes into the graph), and joined by a dotted line to the note the turn leaves, so the graph carries the reason it
 * looks the way it does.
 */

export interface DecisionQuestion {
  question: string;
  options: string[];
}

/** One answer: the options picked, the person's own words, or a skip (the agent then picks a default). */
export interface DecisionAnswer {
  picked: string[];
  text: string;
  skipped: boolean;
}

export const MAX_DECISIONS = 4;
export const SKIPPED_ANSWER = "Left to the agent";

/** Read the questions a model sent. Anything that is not a question with two or more options is dropped. */
export function readDecisions(raw: unknown): DecisionQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DecisionQuestion[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const question = typeof item?.question === "string" ? item.question.trim() : "";
    const options = Array.isArray(item?.options)
      ? [...new Set((item.options as unknown[]).filter((o): o is string => typeof o === "string").map((o) => o.trim()).filter(Boolean))].slice(0, 4)
      : [];
    if (question && options.length >= 2) out.push({ question, options });
    if (out.length >= MAX_DECISIONS) break;
  }
  return out;
}

export const emptyAnswer = (): DecisionAnswer => ({ picked: [], text: "", skipped: false });

/** Whether an answer says anything yet (an option or words), so Next can be offered. */
export const isFilled = (a: DecisionAnswer) => a.skipped || a.picked.length > 0 || a.text.trim() !== "";

/** The answer as one line: the picked options, then the person's own words. */
export function answerLine(a: DecisionAnswer): string {
  if (a.skipped) return SKIPPED_ANSWER;
  return [...a.picked, a.text.trim()].filter(Boolean).join(", ") || SKIPPED_ANSWER;
}

/** The instruction for the editor: the change, then what the person decided, with a default asked for where they skipped. */
export function withDecisions(change: string, qs: DecisionQuestion[], answers: DecisionAnswer[]): string {
  const lines = qs.map((q, i) => {
    const a = answers[i] ?? emptyAnswer();
    return a.skipped || !isFilled(a)
      ? `- ${q.question} Not answered: choose the most sensible default yourself, and start your summary with "Chose <that> for: ${q.question}".`
      : `- ${q.question} ${answerLine(a)}`;
  });
  return `${change}\n\nDecisions the person made (follow them):\n${lines.join("\n")}`;
}

/**
 * One decision square per question, answered, in a column to the right of `spot` on free ground. A single option picked
 * with no words is a choice among the question's options; anything else is kept as the person's text.
 */
export function addDecisionSquares(flow: Flow, spot: { x: number; y: number }, qs: DecisionQuestion[], answers: DecisionAnswer[]): { flow: Flow; ids: string[] } {
  const taken = occupied(flow);
  let next = flow;
  const ids: string[] = [];
  qs.forEach((q, i) => {
    const a = answers[i] ?? emptyAnswer();
    const at = nearestFree({ x: snap(spot.x + STACK_SIZE.w + GRID * 3), y: snap(spot.y) }, taken, { w: ASK_SIZE, h: ASK_SIZE });
    taken.push({ ...at, w: ASK_SIZE, h: ASK_SIZE });
    next = addAsk(next, "decision", at);
    const ask = next.asks![next.asks!.length - 1];
    const asChoice = !a.skipped && a.picked.length === 1 && a.text.trim() === "";
    next = updateAskField(next, ask.id, "f1", {
      label: q.question,
      type: asChoice ? "choice" : "text",
      options: asChoice ? q.options : undefined,
      value: answerLine(a),
    });
    ids.push(ask.id);
  });
  return { flow: next, ids };
}

/** Join each decision square to the first note the turn left (its ask note) by the dotted line. */
export function linkDecisions(flow: Flow, ids: string[]): Flow {
  const stack = (flow.noteStacks ?? [])[(flow.noteStacks ?? []).length - 1];
  const note = stack ? (flow.notes ?? []).find((n) => n.stack === stack.id) : undefined;
  if (!note) return flow;
  let next = flow;
  for (const id of ids) next = addNoteLink(next, { kind: "ask", id }, { kind: "note", id: note.id });
  return next;
}

/**
 * The agent's questions as squares on the canvas, unanswered, in a column to the right of `spot` on free ground. They are
 * the same decision squares as the ones asked at run time, marked as the agent's and tied to the turn that asked them. Each
 * can be skipped, which leaves the choice to the agent.
 */
export function addPlanningSquares(flow: Flow, spot: { x: number; y: number }, qs: DecisionQuestion[], turn: string): { flow: Flow; ids: string[] } {
  const taken = occupied(flow);
  let next = flow;
  const ids: string[] = [];
  let lastAt = { x: 0, y: 0 };
  for (const q of qs) {
    // A column, one under the next, so the answer box that opens beside the column never sits on top of a square.
    const want = ids.length === 0 ? { x: snap(spot.x + STACK_SIZE.w + GRID * 3), y: snap(spot.y) } : { x: lastAt.x, y: lastAt.y + ASK_SIZE + GRID * 2 };
    const at = nearestFree(want, taken, { w: ASK_SIZE, h: ASK_SIZE });
    lastAt = at;
    taken.push({ ...at, w: ASK_SIZE, h: ASK_SIZE });
    next = addAsk(next, "decision", at);
    const ask = next.asks![next.asks!.length - 1];
    next = updateAskField(next, ask.id, "f1", { label: q.question, type: "choice", options: q.options });
    next = updateAsk(next, ask.id, { optional: true });
    next = { ...next, asks: next.asks!.map((a) => (a.id === ask.id ? { ...a, origin: "agent" as const, turn } : a)) };
    ids.push(ask.id);
  }
  return { flow: next, ids };
}

/**
 * Put a person's answer on one planning square. One option picked with no words is a choice among the question's options;
 * anything else is kept as their text (the options stay on the square). A skip leaves the choice to the agent.
 */
export function answerPlanning(flow: Flow, askId: string, a: DecisionAnswer): Flow {
  const ask = (flow.asks ?? []).find((x) => x.id === askId);
  const field = ask?.fields[0];
  if (!ask || !field) return flow;
  if (a.skipped || !isFilled(a)) return skipAsk(flow, askId);
  const asChoice = a.picked.length === 1 && a.text.trim() === "";
  const typed = updateAskField(flow, askId, field.id, { type: asChoice ? "choice" : "text" });
  return answerAsk(typed, askId, { [field.id]: answerLine(a) });
}

/** One batch of the agent's questions, read back from the squares: the questions, the answers, and whether all are in. */
export function batchOf(flow: Flow, turn: string): { ids: string[]; questions: DecisionQuestion[]; answers: DecisionAnswer[]; done: boolean } {
  const asks = (flow.asks ?? []).filter((a) => a.turn === turn);
  return {
    ids: asks.map((a) => a.id),
    questions: asks.map((a) => ({ question: a.fields[0]?.label || a.title, options: a.fields[0]?.options ?? [] })),
    answers: asks.map((a) => (a.skipped ? { picked: [], text: "", skipped: true } : isAnswered(a) ? { picked: [], text: (a.fields[0]?.value ?? "").trim(), skipped: false } : emptyAnswer())),
    done: asks.length > 0 && asks.every(isAnswered),
  };
}
