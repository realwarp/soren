import type { AnswerType, AskField, AskKind, AskRef, Flow, FlowAsk, FlowNode } from "./flowModel";

/**
 * The square family: questions put to the person at run time. They live beside the workflow's steps, not
 * in its graph, and never connect to a step by a wire. An answer is published as a named variable
 * instead, and a step reaches it by name:
 *
 * - in its text or prompt, as {name};
 * - as something it needs before it can start (required, or optional);
 * - as a condition ("run only if {db} is postgres"), which makes the step skipped when it fails.
 *
 * Everything here is plain data and pure functions. It imports only types from the model, so the model
 * can use it without a cycle.
 */

/** Width and height of a square on the canvas. */
export const ASK_SIZE = 160;
/** An answered question the agent asked while planning is folded to this height. */
export const FOLDED_H = 64;

export const ASK_KIND_INFO: Record<AskKind, { label: string; hint: string }> = {
  input: { label: "Input", hint: "Asks you one thing when the run reaches it." },
  decision: { label: "Decision", hint: "A choice or yes/no that steps can branch on." },
  form: { label: "Form", hint: "Several questions answered together." },
  constant: { label: "Constant", hint: "A value you set once, now. It is never asked." },
};

const NAME = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const WORK = new Set(["agent", "verifier", "approval"]);

/** A variable name made from a question: lower case, underscores, starting with a letter. */
export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return "";
  return /^[a-z]/.test(s) ? s.slice(0, 32) : `a_${s}`.slice(0, 32);
}

/** Answered, or skipped (only an optional square can be). A square with no questions is not answered. */
export function isAnswered(ask: FlowAsk): boolean {
  if (ask.skipped) return true;
  return ask.fields.length > 0 && ask.fields.every((f) => (f.value ?? "").trim() !== "");
}

/** How tall a square is drawn: the agent's answered planning questions are folded small, everything else is square. */
export function askHeight(ask: FlowAsk): number {
  return ask.origin === "agent" && isAnswered(ask) ? FOLDED_H : ASK_SIZE;
}

/** Every variable a workflow's squares publish, by name. The first square to use a name keeps it. */
export function askVariables(flow: Flow): Map<string, { ask: FlowAsk; field: AskField }> {
  const out = new Map<string, { ask: FlowAsk; field: AskField }>();
  for (const ask of flow.asks ?? []) {
    for (const field of ask.fields) if (field.name && !out.has(field.name)) out.set(field.name, { ask, field });
  }
  return out;
}

/** The answer to a variable, or undefined when it is unknown, not answered, or its square was skipped. */
export function variableValue(flow: Flow, name: string): string | undefined {
  const found = askVariables(flow).get(name);
  if (!found || found.ask.skipped || askState(flow, found.ask) === "skipped") return undefined;
  return (found.field.value ?? "").trim() || undefined;
}

export function referencedNames(text: string): string[] {
  return [...text.matchAll(NAME)].map((m) => m[1]);
}

/**
 * Put the answers into a text. A name that is not a variable is left as typed, so braces in code are safe.
 * A line that uses a variable with no answer (an optional one, skipped) is dropped whole, rather than
 * left with a hole in it.
 */
export function fillVariables(flow: Flow, text: string): string {
  if (!flow.asks?.length) return text;
  const known = askVariables(flow);
  return text
    .split("\n")
    .flatMap((line) => {
      let drop = false;
      const filled = line.replace(NAME, (whole, name: string) => {
        if (!known.has(name)) return whole;
        const value = variableValue(flow, name);
        if (value === undefined) {
          drop = true;
          return "";
        }
        return value;
      });
      return drop ? [] : [filled];
    })
    .join("\n");
}

/** The squares a step uses: what it needs, what it is conditioned on, and what its text mentions. */
export function asksOf(flow: Flow, node: FlowNode): FlowAsk[] {
  const byId = new Map((flow.asks ?? []).map((a) => [a.id, a]));
  const vars = askVariables(flow);
  const found = new Map<string, FlowAsk>();
  for (const need of node.asks ?? []) {
    const ask = byId.get(need.ask);
    if (ask) found.set(ask.id, ask);
  }
  if (node.when) {
    const v = vars.get(node.when.name);
    if (v) found.set(v.ask.id, v.ask);
  }
  for (const name of referencedNames([node.text, node.prompt ?? "", ...(node.segments ?? []).map((seg) => seg.text), node.readable ?? ""].join("\n"))) {
    const v = vars.get(name);
    if (v) found.set(v.ask.id, v.ask);
  }
  return [...found.values()];
}

/**
 * Where a step's condition stands. "pending" means the answer it depends on is not in yet, so the step has to
 * wait; "fails" means it does not apply and the step is skipped. A condition on a name nothing publishes is
 * ignored here (the editor flags it).
 */
export function conditionState(flow: Flow, node: FlowNode): "none" | "pending" | "holds" | "fails" {
  if (!node.when) return "none";
  const found = askVariables(flow).get(node.when.name);
  if (!found) return "none";
  if (found.ask.skipped || askState(flow, found.ask) === "skipped") return "fails";
  const value = (found.field.value ?? "").trim().toLowerCase();
  if (!value) return "pending";
  return value === node.when.equals.trim().toLowerCase() ? "holds" : "fails";
}

/**
 * A step is skipped when its own condition fails, or when everything it waits for was skipped (a branch that
 * does not apply takes its follow-ups with it). A skipped step counts as done for whatever comes after.
 */
export function isSkipped(flow: Flow, node: FlowNode, path: ReadonlySet<string> = new Set()): boolean {
  if (!flow.asks?.length || path.has(node.id)) return false;
  // A translator is skipped when every square wired into it sits on a branch that was not taken, which
  // takes the steps that only wait for it along too.
  if (node.kind === "translator") return translatorState(flow, node) === "skipped";
  if (!WORK.has(node.kind)) return false;
  if (conditionState(flow, node) === "fails") return true;
  const sources = node.inputs.flatMap((ref) => flow.nodes.filter((n) => n.id === ref.node));
  if (sources.length === 0) return false;
  const next = new Set(path).add(node.id);
  return sources.every((source) => isSkipped(flow, source, next));
}

/** Waiting on you: a required square is not answered, or a condition's answer is not in yet. */
export function blockedByAsks(flow: Flow, node: FlowNode): boolean {
  if (!flow.asks?.length) return false;
  const byId = new Map(flow.asks.map((a) => [a.id, a]));
  for (const need of node.asks ?? []) {
    if (need.optional) continue;
    const ask = byId.get(need.ask);
    if (ask && !isSatisfied(flow, ask)) return true;
  }
  return conditionState(flow, node) === "pending";
}

/** The squares still waiting on you, in the order they were made. A constant is never waiting. */
export function pendingAsks(flow: Flow): FlowAsk[] {
  return (flow.asks ?? []).filter((a) => a.kind !== "constant" && !isAnswered(a) && askState(flow, a) === "open");
}

// ---- Editing. Squares are a drawing and data, like notes: they never unlock a locked workflow. ----

function stamp(flow: Flow, asks: FlowAsk[]): Flow {
  return { ...flow, asks, updatedAt: Date.now() };
}

function nextId(prefix: string, used: Set<string>): string {
  let n = used.size + 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** A variable name no other question uses: the base, then base_2, base_3 and so on. */
export function uniqueName(flow: Flow, base: string, except?: { ask: string; field: string }): string {
  const taken = new Set(
    (flow.asks ?? []).flatMap((a) =>
      a.fields.filter((f) => !(except && a.id === except.ask && f.id === except.field)).map((f) => f.name),
    ),
  );
  const root = slug(base) || "answer";
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}_${n}`)) n += 1;
  return `${root}_${n}`;
}

export function addAsk(flow: Flow, kind: AskKind, at: { x: number; y: number }): Flow {
  const asks = flow.asks ?? [];
  const id = nextId("ask", new Set(asks.map((a) => a.id)));
  const type: AnswerType = kind === "decision" ? "yesno" : "text";
  const field: AskField = { id: "f1", name: uniqueName(flow, "answer"), label: "", type };
  return stamp(flow, [...asks, { id, kind, title: "", fields: [field], pos: at }]);
}

export function updateAsk(flow: Flow, id: string, patch: Partial<Pick<FlowAsk, "title" | "kind" | "optional" | "pos">>): Flow {
  return stamp(flow, (flow.asks ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a)));
}

/**
 * Change one question. Its variable name follows the question's words until the person sets a name of their
 * own, and a single question's heading on the square is the question itself.
 */
export function updateAskField(flow: Flow, askId: string, fieldId: string, patch: Partial<Omit<AskField, "id">>): Flow {
  return stamp(
    flow,
    (flow.asks ?? []).map((ask) => {
      if (ask.id !== askId) return ask;
      const fields = ask.fields.map((field) => {
        if (field.id !== fieldId) return field;
        const next = { ...field, ...patch };
        // The name follows the question while it is still the default ("answer", "answer_2") or the question's own words.
        const following = field.name === slug(field.label) || (!field.label && /^answer(_\d+)?$/.test(field.name));
        if (patch.label !== undefined && patch.name === undefined && following) {
          next.name = uniqueName(flow, patch.label, { ask: askId, field: fieldId });
        }
        if (patch.name !== undefined) next.name = uniqueName(flow, patch.name, { ask: askId, field: fieldId });
        return next;
      });
      return { ...ask, fields, title: ask.kind === "form" ? ask.title : fields[0]?.label ?? ask.title };
    }),
  );
}

export function addAskField(flow: Flow, askId: string): Flow {
  return stamp(
    flow,
    (flow.asks ?? []).map((ask) => {
      if (ask.id !== askId) return ask;
      const id = nextId("f", new Set(ask.fields.map((f) => f.id)));
      return { ...ask, fields: [...ask.fields, { id, name: uniqueName(flow, "answer"), label: "", type: "text" as const }] };
    }),
  );
}

export function removeAskField(flow: Flow, askId: string, fieldId: string): Flow {
  return stamp(
    flow,
    (flow.asks ?? []).map((ask) => (ask.id === askId && ask.fields.length > 1 ? { ...ask, fields: ask.fields.filter((f) => f.id !== fieldId) } : ask)),
  );
}

/** Take a square out, and the steps' needs that pointed at it. Conditions naming its variables are flagged by the editor. */
export function removeAsk(flow: Flow, id: string): Flow {
  return {
    ...stamp(flow, (flow.asks ?? []).filter((a) => a.id !== id)),
    // A dotted note line ends at the square, so it goes with it. (Inline: this file imports only types from the model.)
    noteLinks: flow.noteLinks?.filter((l) => !(l.from.kind === "ask" && l.from.id === id) && !(l.to.kind === "ask" && l.to.id === id)),
    asks: (flow.asks ?? [])
      .filter((a) => a.id !== id)
      .map((a) => (a.inputs?.some((ref) => ref.ask === id) ? { ...a, inputs: a.inputs.filter((ref) => ref.ask !== id) } : a)),
    nodes: flow.nodes.map((n) => {
      const asks = n.asks?.some((need) => need.ask === id) ? n.asks.filter((need) => need.ask !== id) : n.asks;
      const askInputs = n.askInputs?.some((ref) => ref.ask === id) ? n.askInputs.filter((ref) => ref.ask !== id) : n.askInputs;
      return asks === n.asks && askInputs === n.askInputs ? n : { ...n, asks, askInputs };
    }),
  };
}

/** Record the answers, one value per question. Clears a skip. */
export function answerAsk(flow: Flow, id: string, values: Record<string, string>): Flow {
  return stamp(
    flow,
    (flow.asks ?? []).map((ask) =>
      ask.id === id
        ? { ...ask, skipped: false, fields: ask.fields.map((f) => (f.id in values ? { ...f, value: values[f.id] } : f)) }
        : ask,
    ),
  );
}

/** Leave an optional square unanswered. Anything else cannot be skipped. */
export function skipAsk(flow: Flow, id: string): Flow {
  return stamp(flow, (flow.asks ?? []).map((a) => (a.id === id && a.optional ? { ...a, skipped: true } : a)));
}

/** Take the answers back. A constant keeps its value, since it is set while planning, not at run time. */
export function clearAnswer(flow: Flow, id: string): Flow {
  return stamp(
    flow,
    (flow.asks ?? []).map((a) =>
      a.id === id && a.kind !== "constant" ? { ...a, skipped: false, fields: a.fields.map((f) => ({ ...f, value: undefined })) } : a,
    ),
  );
}

/** The steps that depend on a variable, by the value they wait for: for a Decision's "if yes, these steps" list. */
export function branchesOf(flow: Flow, name: string): Array<{ equals: string; nodes: FlowNode[] }> {
  const groups = new Map<string, FlowNode[]>();
  for (const node of flow.nodes) {
    if (node.when?.name !== name) continue;
    const key = node.when.equals;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  return [...groups.entries()].map(([equals, nodes]) => ({ equals, nodes }));
}

// ---- Wires between squares. A wire means "ask this after that", and lets this one read that answer. ----

/** The outputs a square offers. A Decision has one per choice, so a branch is a wire from a choice; anything else has one. */
export function askPorts(ask: FlowAsk): Array<{ port?: string; label: string }> {
  const field = ask.fields[0];
  if (ask.kind === "decision" && ask.fields.length === 1 && field) {
    const options = field.type === "yesno" ? ["yes", "no"] : field.type === "choice" ? field.options ?? [] : [];
    if (options.length > 0) return options.map((o) => ({ port: o, label: field.type === "yesno" ? (o === "yes" ? "Yes" : "No") : o }));
  }
  return [{ port: undefined, label: "" }];
}

type RefState = "live" | "dead" | "pending";
type AskState = "open" | "locked" | "skipped";

function refStateIn(flow: Flow, ref: AskRef, path: ReadonlySet<string>): RefState {
  const source = (flow.asks ?? []).find((a) => a.id === ref.ask);
  if (!source) return "dead";
  const state = askStateIn(flow, source, path);
  if (state === "skipped") return "dead";
  if (!isAnswered(source)) return "pending";
  if (ref.port === undefined) return "live";
  if (source.skipped) return "dead";
  const value = (source.fields[0]?.value ?? "").trim().toLowerCase();
  return value === ref.port.trim().toLowerCase() ? "live" : "dead";
}

function askStateIn(flow: Flow, ask: FlowAsk, path: ReadonlySet<string>): AskState {
  const inputs = ask.inputs ?? [];
  if (inputs.length === 0 || path.has(ask.id)) return "open";
  const next = new Set(path).add(ask.id);
  const states = inputs.map((ref) => refStateIn(flow, ref, next));
  if (states.every((st) => st === "dead")) return "skipped";
  if (states.some((st) => st === "pending")) return "locked";
  return "open";
}

/**
 * Where a square stands: "open" (nothing holds it back, so it can be answered), "locked" (waiting for a square
 * wired into it), or "skipped" (every wire into it is on a branch that was not taken).
 */
export function askState(flow: Flow, ask: FlowAsk): AskState {
  return askStateIn(flow, ask, new Set());
}

/** What one wire says right now: its answer is in and its branch (if any) was taken, or not taken, or not known yet. */
export function refState(flow: Flow, ref: AskRef): RefState {
  return refStateIn(flow, ref, new Set());
}

/** Nothing is owed on it: answered, or skipped because its branch was not taken. */
export function isSatisfied(flow: Flow, ask: FlowAsk): boolean {
  return askState(flow, ask) === "skipped" || isAnswered(ask);
}

/** The squares that, directly or not, are wired into this one. */
export function ancestorsOf(flow: Flow, askId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const ref of (flow.asks ?? []).find((a) => a.id === id)?.inputs ?? []) {
      if (out.has(ref.ask)) continue;
      out.add(ref.ask);
      walk(ref.ask);
    }
  };
  walk(askId);
  return out;
}

/** Data along the wires: a square's text may use the answers of the squares wired into it, as {name}. */
export function fillForAsk(flow: Flow, ask: FlowAsk, text: string): string {
  const allowed = ancestorsOf(flow, ask.id);
  if (allowed.size === 0) return text;
  const vars = askVariables(flow);
  return text.replace(NAME, (whole, name: string) => {
    const found = vars.get(name);
    if (!found || !allowed.has(found.ask.id)) return whole;
    return variableValue(flow, name) ?? whole;
  });
}

/** Could `to` wait for `from`? Not for itself, and never in a loop. */
export function canWireAsk(flow: Flow, from: string, to: string): boolean {
  const asks = flow.asks ?? [];
  if (from === to || !asks.some((a) => a.id === from) || !asks.some((a) => a.id === to)) return false;
  return !ancestorsOf(flow, from).has(to);
}

const sameRef = (a: AskRef, b: AskRef) => a.ask === b.ask && (a.port ?? "") === (b.port ?? "");

/** Make square `to` wait for `ref`. Does nothing if that would loop, or the wire is already there. */
export function wireAsk(flow: Flow, to: string, ref: AskRef): Flow {
  if (!canWireAsk(flow, ref.ask, to)) return flow;
  return stamp(
    flow,
    (flow.asks ?? []).map((a) => (a.id === to && !(a.inputs ?? []).some((r) => sameRef(r, ref)) ? { ...a, inputs: [...(a.inputs ?? []), ref] } : a)),
  );
}

export function unwireAsk(flow: Flow, to: string, ref: AskRef): Flow {
  return stamp(flow, (flow.asks ?? []).map((a) => (a.id === to ? { ...a, inputs: (a.inputs ?? []).filter((r) => !sameRef(r, ref)) } : a)));
}

/** Feed a square's answer to a translator. Wiring changes what the workflow says, so it unlocks it. */
export function wireTranslator(flow: Flow, nodeId: string, ref: AskRef): Flow {
  return {
    ...flow,
    locked: false,
    updatedAt: Date.now(),
    nodes: flow.nodes.map((n) =>
      n.id === nodeId && n.kind === "translator" && !(n.askInputs ?? []).some((r) => sameRef(r, ref))
        ? { ...n, askInputs: [...(n.askInputs ?? []), ref] }
        : n,
    ),
  };
}

export function unwireTranslator(flow: Flow, nodeId: string, ref: AskRef): Flow {
  return {
    ...flow,
    locked: false,
    updatedAt: Date.now(),
    nodes: flow.nodes.map((n) => (n.id === nodeId ? { ...n, askInputs: (n.askInputs ?? []).filter((r) => !sameRef(r, ref)) } : n)),
  };
}

/**
 * Where a translator stands: "waiting" for an answer it needs, "skipped" when every square wired into it is on a branch
 * not taken, otherwise "live" and done.
 */
export function translatorState(flow: Flow, node: FlowNode): "waiting" | "live" | "skipped" {
  const refs = node.askInputs ?? [];
  if (refs.length === 0) return "live";
  const states = refs.map((ref) => refStateIn(flow, ref, new Set()));
  if (states.every((st) => st === "dead")) return "skipped";
  if (states.some((st) => st === "pending")) return "waiting";
  return "live";
}

/**
 * What a translator hands the steps after it. Its own text with the answers written in, or, when it has none,
 * one "question: answer" line for each live square wired into it.
 */
export function translatedText(flow: Flow, node: FlowNode): string {
  if (node.text.trim()) return fillVariables(flow, node.text);
  const lines: string[] = [];
  for (const ref of node.askInputs ?? []) {
    const ask = (flow.asks ?? []).find((a) => a.id === ref.ask);
    if (!ask || refStateIn(flow, ref, new Set()) !== "live") continue;
    for (const field of ask.fields) {
      const value = (field.value ?? "").trim();
      if (value) lines.push(`- ${field.label || field.name}: ${value}`);
    }
  }
  return lines.join("\n");
}

// ---- A questionnaire an AI proposes, as plain data: validated here, drawn here, written by nobody's hand. ----

export interface DraftQuestion {
  id: string;
  question: string;
  /** "decision" is a question whose answer branches; anything else is a plain input. */
  kind: "input" | "decision";
  type: AnswerType;
  options: string[];
  optional: boolean;
  after: Array<{ from: string; port?: string }>;
}

export interface Questionnaire {
  questions: DraftQuestion[];
}

const MAX_QUESTIONS = 14;

/**
 * Read a questionnaire from a model's reply. It must be JSON with a "questions" list; each question has an id, the
 * question itself, and may say which earlier question (and which choice of it) it comes after. Anything that
 * does not hold together (a loop, an unknown id, a choice that does not exist) is an error, not a guess.
 */
export function parseQuestionnaire(reply: string): Questionnaire {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The model did not send a questionnaire.");
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    throw new Error("The model's questionnaire could not be read.");
  }
  const list = (raw as { questions?: unknown }).questions;
  if (!Array.isArray(list) || list.length === 0) throw new Error("The questionnaire has no questions.");
  if (list.length > MAX_QUESTIONS) throw new Error(`The questionnaire has more than ${MAX_QUESTIONS} questions.`);

  const questions: DraftQuestion[] = [];
  const seen = new Map<string, DraftQuestion>();
  for (const item of list as Array<Record<string, unknown>>) {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const question = typeof item.question === "string" ? item.question.trim() : "";
    if (!id || !question) throw new Error("A question is missing its id or its text.");
    if (seen.has(id)) throw new Error(`Two questions share the id ${id}.`);
    const type: AnswerType = item.type === "choice" || item.type === "yesno" ? item.type : "text";
    const options = Array.isArray(item.options) ? item.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim()) : [];
    if (type === "choice" && options.length < 2) throw new Error(`The choice "${question}" needs at least two options.`);
    const after: DraftQuestion["after"] = [];
    for (const link of Array.isArray(item.after) ? (item.after as Array<Record<string, unknown>>) : []) {
      const from = typeof link.from === "string" ? link.from : "";
      const source = seen.get(from);
      // Only earlier questions, so the questionnaire cannot loop.
      if (!source) throw new Error(`"${question}" comes after ${from || "nothing"}, which is not an earlier question.`);
      const port = typeof link.port === "string" && link.port.trim() ? link.port.trim() : undefined;
      if (port) {
        const choices = source.type === "yesno" ? ["yes", "no"] : source.options;
        if (source.kind !== "decision" || !choices.some((c) => c.toLowerCase() === port.toLowerCase())) {
          throw new Error(`"${question}" follows a choice "${port}" that does not exist.`);
        }
      }
      after.push({ from, port });
    }
    const draft: DraftQuestion = {
      id,
      question,
      kind: item.kind === "decision" && (type === "yesno" || type === "choice") ? "decision" : "input",
      type,
      options,
      optional: item.optional === true,
      after,
    };
    questions.push(draft);
    seen.set(id, draft);
  }
  return { questions };
}

/** Draw a questionnaire as squares and wires, left to right by how far each is from the first question. */
export function applyQuestionnaire(flow: Flow, plan: Questionnaire, at: { x: number; y: number }): Flow {
  const depth = new Map<string, number>();
  for (const q of plan.questions) depth.set(q.id, 1 + Math.max(-1, ...q.after.map((a) => depth.get(a.from) ?? -1)));
  const rows = new Map<number, number>();
  const made = new Map<string, string>();
  let next = flow;
  for (const q of plan.questions) {
    const col = depth.get(q.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    next = addAsk(next, q.kind, { x: at.x + col * (ASK_SIZE + 96), y: at.y + row * (ASK_SIZE + 40) });
    const ask = (next.asks ?? [])[(next.asks ?? []).length - 1];
    made.set(q.id, ask.id);
    next = updateAskField(next, ask.id, "f1", { label: q.question, type: q.type, options: q.type === "choice" ? q.options : undefined });
    if (q.optional) next = updateAsk(next, ask.id, { optional: true });
  }
  for (const q of plan.questions) {
    for (const link of q.after) {
      const from = made.get(link.from);
      const to = made.get(q.id);
      if (from && to) next = wireAsk(next, to, { ask: from, port: link.port });
    }
  }
  return next;
}
