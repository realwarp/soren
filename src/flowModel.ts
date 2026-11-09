import { blockedByAsks, isSkipped, translatorState } from "./flowAsk";

/**
 * The workflow model: a graph of nodes that carry named artifacts and checks.
 *
 * Soren does not talk to the coding tools. The person copies each node's prompt
 * into their own tool, then marks the node done and pastes back what came out.
 * Everything here is plain data and pure functions, so the local planner, the
 * canvas and the cloud prompt writer can all work on the same shape.
 */

/**
 * What a node is. A step is done by a coding tool (agent) or must pass (verifier). An approval
 * is done when the person says so. A wait is done by the clock, when a tool's limit resets.
 * Every workflow begins at a Start, which holds what the person brings, and may finish
 * at one or more Ends.
 */
export type FlowKind = "agent" | "verifier" | "approval" | "wait" | "start" | "end" | "translator";
export type CheckKind = "lint" | "tests" | "build" | "custom";

/** A wire out of a square. `port` is the choice it carries, for a Decision's branches; unset is the square's one output. */
export interface AskRef {
  ask: string;
  port?: string;
}

export type AskKind = "input" | "form" | "constant" | "decision";
export type AnswerType = "text" | "choice" | "yesno";

/** One question inside a square. Its answer is published as the variable `name`. */
export interface AskField {
  id: string;
  /** What a step writes, as {name}, to use the answer. */
  name: string;
  /** The question, as the person reads it. */
  label: string;
  type: AnswerType;
  /** The choices, when `type` is "choice". */
  options?: string[];
  /** The answer; for yes/no it is "yes" or "no". Empty until answered. A constant's is set while planning. */
  value?: string;
}

/**
 * A square: something the person is asked, at run time. Squares sit beside the graph and never connect to a
 * step by a wire; their answers reach steps as named variables (see flowAsk.ts).
 */
export interface FlowAsk {
  id: string;
  kind: AskKind;
  /** The heading on the square; for a single question it is the question. */
  title: string;
  fields: AskField[];
  /** May be left unanswered, with Skip. */
  optional?: boolean;
  skipped?: boolean;
  /** The squares this one waits for. A wire means: ask this after those, and let it read their answers. */
  inputs?: AskRef[];
  pos: { x: number; y: number };
  /** Put here by the agent while planning, to be answered early. Those answered stay on the canvas, folded, as a record. */
  origin?: "agent";
  /** For an agent's square: the history turn it was asked in, which is also its batch. */
  turn?: string;
}

/** The round a critic and a maker are on, and what each said. */
export interface CriticRound {
  at: number;
  made: string;
  verdict?: "approve" | "revise";
  reasons?: string;
}

/** A second tool that reviews what the step made, and sends it back for changes until it is satisfied. */
export interface Critic {
  /** What the critic checks for; empty means "does it do what the step says". */
  criteria: string;
  /** The most rounds before the person has to decide. */
  maxRounds: number;
  /** The critic's own tool; the step's tool when unset. */
  toolId?: string;
  /** How capable a model the critic needs; two below the step's by default. */
  need?: number;
  rounds: CriticRound[];
}

/** A named artifact: a short label and one line saying what must be in it. */
export interface FlowPort {
  id: string;
  label: string;
  note: string;
}

/** An input is a reference to another node's output. */
export interface PortRef {
  node: string;
  port: string;
  /** How far the person dragged the wire's middle segment from its default place, in pixels. */
  bend?: number;
}

/** How a tool is paid for; subscriptions are spent first, pay as you go last. */
export type Billing = "subscription" | "free" | "payg";

/**
 * One limit a tool has. Claude Code has a 5 hour window and a weekly one, Codex
 * free resets monthly, so a tool carries a list of these.
 */
export interface QuotaWindow {
  label: string;
  /** What `left` counts. Hours tools (Freebuff) spend hours, most others prompts. */
  unit?: "prompts" | "hours";
  /**
   * A limit must hold enough on its own (Claude's 5 hour and weekly limits).
   * Supplies add together (Freebuff's daily hours plus its wallet).
   */
  role?: "limit" | "supply";
  /** When it resets, as epoch milliseconds; null when the person has not said. */
  resetsAt: number | null;
  /** Prompts left in this window; null when unknown, which counts as enough. */
  left: number | null;
  /** When the person last set these numbers, so stale ones can be flagged. */
  updatedAt?: number;
}

/** A model a tool offers, rated 1 to 10 for how hard a job it can take. */
export interface ModelEntry {
  id: string;
  name: string;
  capability: number;
  /** The lowest plan that includes it; empty means every plan. */
  plan?: string;
  /** How fast it spends the tool's hours: 1 is normal, 20 is twenty times, 0 is free. */
  usage?: number;
  /**
   * A model that only exists inside a free allowance: this many hours a day,
   * and nothing past it, not even at a price. A step longer than that cannot run on it.
   */
  freeHours?: number;
  note?: string;
}

/** One plan of a tool, listed lowest first; a higher plan includes everything below it. */
export interface PlanTier {
  name: string;
  price?: string;
  /** Hours a day that plan gives, for tools sold in hours. */
  perDay?: number;
  /** Hours added to the wallet each month, or on login for a free plan. */
  wallet?: number;
}

/** A coding tool the person picked, at the tier they have. */
export interface FlowTool {
  id: string;
  name: string;
  /** The plan the person is on. */
  tier: string;
  /** The tool's plans, lowest first. Empty when the person typed their own. */
  plans: PlanTier[];
  billing: Billing;
  /** Parallel sessions the tool can run; null means ask at run time. */
  sessions: number | null;
  /** "Use this one first": spend its quota before the others. */
  prefer: boolean;
  windows: QuotaWindow[];
  /** The models this tool offers; the table the auto-pick works from. */
  models: ModelEntry[];
}

export interface FlowCheck {
  kind: CheckKind;
  label: string;
}

/** Who wrote a stretch of a prompt: the template (code), the model (an accepted polish) or the person. */
export type PromptAuthor = "template" | "ai" | "you";

/** A stretch of a step's prompt and its author. A template segment has the `key` of the field it is filled from. */
export interface PromptSegment {
  id: string;
  author: PromptAuthor;
  text: string;
  key?: string;
}

export interface FlowNode {
  id: string;
  kind: FlowKind;
  /** The one or two line description the local planner writes. */
  text: string;
  /** Agent nodes: which picked tool runs it. */
  toolId?: string;
  /** Prompts this node is expected to cost; the planner can raise it. */
  cost: number;
  /** How capable a model the job needs, 1 to 10; unset until rated. */
  need?: number;
  /** A model the person chose by hand; otherwise one is picked from `need`. */
  modelId?: string;
  /** Verifier nodes: what is being verified. */
  check?: FlowCheck;
  inputs: PortRef[];
  outputs: FlowPort[];
  /**
   * A prompt the cloud writer produced before prompts were built from a template. Read as one model-written segment;
   * a step that is edited moves its words into `segments`.
   */
  prompt?: string;
  /**
   * The step's prompt as written by its authors (see flowPromptDoc.ts). Absent until the person or an accepted
   * rewrite changes the template's wording; until then the prompt is the template, filled from the step's fields.
   */
  segments?: PromptSegment[];
  /** What the template said for each field when the person last settled it, to tell a field that has changed since. */
  basis?: Record<string, string>;
  readable?: string;
  /**
   * Set when the cloud writer marks the step as delegating inside the tool
   * (a main model handing work to subagents). The local planner then lays out
   * `sub`: descriptions and wiring only, no prompts of their own.
   */
  delegation?: boolean;
  sub?: FlowNode[];
  /** A wait node: which tool's limit it holds the workflow for. */
  wait?: { toolId: string; window: string };
  /** Where the node sits on the canvas, in pixels from its top-left corner. */
  pos?: { x: number; y: number };
  /** Set when the person marks the node done. */
  done?: { at: number; pasted: string };
  /**
   * Set when the person reports that the tool's attempt failed. The node is still not done, so it
   * stays ready and everything after it keeps waiting; its prompt gains a retry section with the error.
   * Marking the node done clears it.
   */
  failed?: { at: number; error: string; attempts: number; retry?: string };
  /** Squares this step needs answered before it starts; an optional one does not hold it. */
  asks?: Array<{ ask: string; optional?: boolean }>;
  /** Run only when this variable has this answer; otherwise the step is skipped. */
  when?: { name: string; equals: string };
  /** A translator only: the squares whose answers it turns into the artifact it makes. */
  askInputs?: AskRef[];
  /** A reviewer that sends the step's work back until it is satisfied. */
  critic?: Critic;
}

/**
 * A labelled box drawn on the canvas to set one part of a workflow apart from another.
 * It is only a drawing: it has no inputs, no outputs and nothing is ever done in it.
 */
export interface FlowContainer {
  id: string;
  name: string;
  /** One of the named colours the canvas knows. */
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Folded into one small card; the steps inside it are hidden and its wires meet at the card. */
  collapsed?: boolean;
}

/** A sticky note on the canvas. Only a drawing, like a container: nothing waits for it. */
export interface FlowNote {
  id: string;
  text: string;
  /** One of the named colours the notes know. */
  color: string;
  x: number;
  y: number;
  /** Set once the person drags the corner; until then the note is the default size. */
  w?: number;
  h?: number;
  /** The notes container this note belongs to, when an agent turn left it there. */
  stack?: string;
  /**
   * Set on a diff note: what Polish offers for one step, waiting on an Accept or a Reject. Each field holds the text
   * as it was when the model saw it and the polished text; a field the model left alone is absent. The note is drawn as
   * a word diff, not as editable text, and it never reaches the plan, the run order or the prompts until accepted.
   */
  diff?: NoteDiff;
}

/** What a diff note offers for one step: its human-readable text and its prompt, each as it was and as polished. */
export interface NoteDiff {
  /** The id of the step the note is about. */
  node: string;
  prompt?: { base: string; text: string };
  readable?: { base: string; text: string };
}

/**
 * A notes container: one card on the canvas that holds the notes one agent turn left. Like a note it is only a
 * drawing, so it never appears in the plan, the run order or the prompts. It can be shrunk to its card, opened
 * on a canvas of its own (like the inside of a step) or expanded so its notes sit in the workflow itself.
 */
export interface NoteStack {
  id: string;
  /** What was asked, so the next agent can read why these notes exist. */
  title: string;
  x: number;
  y: number;
  /** True (the default) when its notes are drawn on the workflow; false when they are folded into the card. */
  expanded?: boolean;
}

/** What one end of a note link can be: anything on the canvas. */
export interface NoteLinkEnd {
  kind: "note" | "ask" | "node" | "container" | "stack";
  id: string;
}

/**
 * A dotted line between a note and anything else on the canvas (a square, a step, a container, another note).
 * It is an annotation, like the note itself: it lives apart from the steps' `inputs`, so it never appears in the
 * plan, the run order, the issue checks or the prompts that get written. Read it as undirected; `from` is only
 * the end it was drawn from.
 */
export interface NoteLink {
  id: string;
  from: NoteLinkEnd;
  to: NoteLinkEnd;
}

export interface Flow {
  id: string;
  title: string;
  tools: FlowTool[];
  nodes: FlowNode[];
  /** Boxes that mark parts of the canvas; they do not change what the workflow says. */
  containers?: FlowContainer[];
  /** Sticky notes the person put on the canvas; they do not change what the workflow says. */
  notes?: FlowNote[];
  /** Dotted lines from notes to anything else. Not part of the graph: see `NoteLink`. */
  noteLinks?: NoteLink[];
  /** Notes containers: the cards that hold the notes an agent turn left. Drawings, like notes. */
  noteStacks?: NoteStack[];
  /** Squares: what the person is asked at run time. They are separate from the graph. */
  asks?: FlowAsk[];
  /** What the workflow was planned from; it goes into every step's prompt as background and into polish requests. */
  brief?: string;
  /** Locked flows are the ones sent to the cloud writer. */
  locked: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export const VERIFIER_PORT = "passes";

export type IssueKind =
  | "missing-node"
  | "missing-port"
  | "self-input"
  | "duplicate-output"
  | "cycle"
  | "empty-text"
  | "no-tool"
  | "weak-model"
  | "unknown-tool"
  | "ungated-verifier"
  | "extra-start"
  | "unreachable"
  | "end-empty"
  | "no-wait-target"
  | "duplicate-variable"
  | "missing-ask"
  | "unknown-variable"
  | "translator-empty";

export interface FlowIssue {
  kind: IssueKind;
  node: string;
  message: string;
}

const TOOL_NAMES: Record<CheckKind, string> = {
  lint: "Lint passes",
  tests: "Tests pass",
  build: "Build passes",
  custom: "Check passes",
};

export function newFlow(title = "", now = Date.now()): Flow {
  return {
    id: `flow_${now.toString(36)}`,
    title,
    tools: [],
    nodes: [],
    locked: false,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function nextId(prefix: string, used: Set<string>): string {
  let index = used.size + 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

/** Any edit unlocks the flow: a locked flow is a promise about what was sent. */
function touch(flow: Flow, patch: Partial<Flow>): Flow {
  return {
    ...flow,
    ...patch,
    locked: false,
    revision: flow.revision + 1,
    updatedAt: Date.now(),
  };
}

export function addTool(flow: Flow, tool: Omit<FlowTool, "id">): Flow {
  const id = nextId("tool", new Set(flow.tools.map((t) => t.id)));
  return touch(flow, { tools: [...flow.tools, { ...tool, id }] });
}

export function updateTool(
  flow: Flow,
  toolId: string,
  patch: Partial<Omit<FlowTool, "id">>,
): Flow {
  return touch(flow, {
    tools: flow.tools.map((tool) =>
      tool.id === toolId ? { ...tool, ...patch } : tool,
    ),
  });
}

export function renameFlow(flow: Flow, title: string): Flow {
  return { ...flow, title, updatedAt: Date.now() };
}

export function updateOutput(
  flow: Flow,
  nodeId: string,
  portId: string,
  patch: Partial<Pick<FlowPort, "label" | "note">>,
): Flow {
  return touch(flow, {
    nodes: flow.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            outputs: node.outputs.map((port) =>
              port.id === portId ? { ...port, ...patch } : port,
            ),
          }
        : node,
    ),
  });
}

export function removeTool(flow: Flow, toolId: string): Flow {
  return touch(flow, {
    tools: flow.tools.filter((tool) => tool.id !== toolId),
    nodes: flow.nodes.map((node) =>
      node.toolId === toolId ? { ...node, toolId: undefined } : node,
    ),
  });
}

export function addAgentNode(flow: Flow, text = "", toolId?: string): Flow {
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const node: FlowNode = {
    id,
    kind: "agent",
    text,
    toolId,
    cost: 1,
    inputs: [],
    outputs: [],
  };
  return touch(flow, { nodes: [...flow.nodes, node] });
}

export function addVerifierNode(
  flow: Flow,
  kind: CheckKind,
  label = TOOL_NAMES[kind],
): Flow {
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const node: FlowNode = {
    id,
    kind: "verifier",
    text: label,
    check: { kind, label },
    cost: 0,
    inputs: [],
    outputs: [{ id: VERIFIER_PORT, label, note: "" }],
  };
  return touch(flow, { nodes: [...flow.nodes, node] });
}

/** The one place a workflow begins. Its outputs are what the person brings to it. */
export function addStartNode(flow: Flow, text = "What you bring"): Flow {
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const node: FlowNode = {
    id,
    kind: "start",
    text,
    cost: 0,
    inputs: [],
    outputs: [{ id: "o1", label: "Starting point", note: "" }],
  };
  return touch(flow, { nodes: [...flow.nodes, node] });
}

/** A pause for the person: it is done when they say they have looked and it is fine. */
export function addApprovalNode(flow: Flow, text = "Check this before going on"): Flow {
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const node: FlowNode = {
    id,
    kind: "approval",
    text,
    cost: 0,
    inputs: [],
    outputs: [{ id: "o1", label: "Approved", note: "" }],
  };
  return touch(flow, { nodes: [...flow.nodes, node] });
}

/** A pause for the clock: it is done once the chosen limit of a tool has reset. */
export function addWaitNode(flow: Flow, toolId = "", window = "", text = "Wait for the limit to reset"): Flow {
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const node: FlowNode = {
    id,
    kind: "wait",
    text,
    cost: 0,
    wait: { toolId, window },
    inputs: [],
    outputs: [{ id: "o1", label: "Limit reset", note: "" }],
  };
  return touch(flow, { nodes: [...flow.nodes, node] });
}

/** A place a workflow can finish. A workflow may have several, or none. */
export function addEndNode(flow: Flow, text = "Done"): Flow {
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const node: FlowNode = { id, kind: "end", text, cost: 0, inputs: [], outputs: [] };
  return touch(flow, { nodes: [...flow.nodes, node] });
}

/**
 * A translator turns what people answered in squares into words a step can take: an artifact the steps
 * after it wait for. It is done by itself once the squares wired into it are answered, and skipped when
 * every one of them sits on a branch that was not taken.
 */
export function addTranslatorNode(flow: Flow, text = ""): Flow {
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const node: FlowNode = {
    id,
    kind: "translator",
    text,
    cost: 0,
    inputs: [],
    outputs: [{ id: "o1", label: "Answers", note: "what you answered, in words" }],
    askInputs: [],
  };
  return touch(flow, { nodes: [...flow.nodes, node] });
}

/** Work a person or a tool actually does, as opposed to where a workflow starts and ends. */
export function isWork(node: FlowNode): boolean {
  return node.kind === "agent" || node.kind === "verifier" || node.kind === "approval";
}

/** When the limit a wait node holds for resets, in epoch milliseconds, or null when it points at nothing known. */
export function waitUntil(flow: Flow, node: FlowNode): number | null {
  if (node.kind !== "wait" || !node.wait) return null;
  const tool = flow.tools.find((t) => t.id === node.wait!.toolId);
  const window = tool?.windows.find((w) => w.label === node.wait!.window);
  return window?.resetsAt ?? null;
}

/** Whether a node can be taken out: the only Start cannot, since a workflow always has one. */
export function canRemove(flow: Flow, nodeId: string): boolean {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  return node.kind !== "start" || flow.nodes.filter((n) => n.kind === "start").length > 1;
}

export function updateNode(
  flow: Flow,
  nodeId: string,
  patch: Partial<
    Pick<
      FlowNode,
      "text" | "toolId" | "check" | "cost" | "prompt" | "segments" | "basis" | "readable" | "delegation" | "need" | "modelId" | "wait" | "asks" | "when" | "critic" | "askInputs"
    >
  >,
  /** `keepLock` is for accepting a polished prompt: polishing finishes a locked plan, it does not break it. */
  options: { keepLock?: boolean } = {},
): Flow {
  const next = touch(flow, {
    nodes: flow.nodes.map((node) =>
      node.id === nodeId ? { ...node, ...patch } : node,
    ),
  });
  return options.keepLock ? { ...next, locked: flow.locked } : next;
}

/** The notes tied to a step by a dotted line: the ones that say something about it. */
export function notesOfNode(flow: Flow, nodeId: string): FlowNote[] {
  const linked = new Set<string>();
  for (const l of flow.noteLinks ?? []) {
    if (l.from.kind === "note" && l.to.kind === "node" && l.to.id === nodeId) linked.add(l.from.id);
    if (l.to.kind === "note" && l.from.kind === "node" && l.from.id === nodeId) linked.add(l.to.id);
  }
  return (flow.notes ?? []).filter((n) => linked.has(n.id));
}

/** A node's inside as a flow of its own, so every graph operation works on it. It shows the notes that touch the step. */
export function subFlow(flow: Flow, nodeId: string): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId);
  return {
    ...flow,
    id: `${flow.id}.${nodeId}`,
    tools: [],
    nodes: node?.sub ?? [],
    // A diff note belongs to the step's own canvas, not to what is inside it: accepting it acts on the step.
    notes: gridNotes(notesOfNode(flow, nodeId).filter((n) => !n.diff)),
    noteStacks: [],
    noteLinks: [],
    locked: false,
  };
}

/**
 * Write an edited inside back into its node. Notes written inside are kept on the workflow, tied to the step; edits
 * to the notes that were shown (words, colour, size) and their deletion come back too, but where they sit on the
 * inside canvas does not move them. Changing only notes does not unlock a locked workflow, as notes are a drawing.
 */
export function setSub(flow: Flow, nodeId: string, inside: Flow): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId);
  const stepsChanged = !node || node.sub !== inside.nodes;
  let next: Flow = stepsChanged
    ? touch(flow, {
        nodes: flow.nodes.map((n) =>
          n.id === nodeId ? { ...n, sub: inside.nodes, delegation: inside.nodes.length > 0 ? true : n.delegation } : n,
        ),
      })
    : flow;
  const shown = new Set(notesOfNode(flow, nodeId).filter((n) => !n.diff).map((n) => n.id));
  const edited = new Map((inside.notes ?? []).map((n) => [n.id, n] as const));
  for (const id of shown) {
    const e = edited.get(id);
    if (!e) next = removeNote(next, id);
    else next = updateNote(next, id, { text: e.text, color: e.color, w: e.w, h: e.h });
  }
  // A note made inside is new to the workflow: give it a fresh id here and tie it to the step.
  for (const e of inside.notes ?? []) {
    if (shown.has(e.id)) continue;
    next = addNote(next, { x: e.x, y: e.y }, e.text, e.color, { w: e.w, h: e.h });
    next = addNoteLink(next, { kind: "note", id: next.notes![next.notes!.length - 1].id }, { kind: "node", id: nodeId });
  }
  return next;
}

/** Containers are drawing, like moving a step: they never unlock a locked workflow. */
export function addContainer(flow: Flow, at: { x: number; y: number }, size = { w: 576, h: 384 }): Flow {
  const used = new Set((flow.containers ?? []).map((c) => c.id));
  let n = used.size + 1;
  while (used.has(`c${n}`)) n += 1;
  const box: FlowContainer = { id: `c${n}`, name: "", color: "teal", x: at.x, y: at.y, w: size.w, h: size.h };
  return { ...flow, containers: [...(flow.containers ?? []), box], updatedAt: Date.now() };
}

export function updateContainer(flow: Flow, id: string, patch: Partial<Omit<FlowContainer, "id">>): Flow {
  return {
    ...flow,
    containers: (flow.containers ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)),
    updatedAt: Date.now(),
  };
}

export function removeContainer(flow: Flow, id: string): Flow {
  return dropNoteLinks({ ...flow, containers: (flow.containers ?? []).filter((c) => c.id !== id), updatedAt: Date.now() }, "container", id);
}

/** The width and height a collapsed container is drawn at. */
export const COLLAPSED_SIZE = { w: 256, h: 48 };

/**
 * Steps hidden by a collapsed container, with the container that hides each. A step is inside a container
 * when the middle of the step sits within the container's box; containers are a drawing, not an owner.
 */
export function hiddenByContainers(
  flow: Flow,
  size: { w: number; h: number } = { w: 256, h: 96 },
): Map<string, string> {
  const hidden = new Map<string, string>();
  for (const c of flow.containers ?? []) {
    if (!c.collapsed) continue;
    for (const n of flow.nodes) {
      const cx = (n.pos?.x ?? 0) + size.w / 2;
      const cy = (n.pos?.y ?? 0) + size.h / 2;
      if (cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h && !hidden.has(n.id)) hidden.set(n.id, c.id);
    }
  }
  return hidden;
}

/** A note's default size, and the smallest a drag can make it. */
export const NOTE_DEFAULT = { w: 192, h: 128 } as const;
export const NOTE_MIN = { w: 120, h: 72 } as const;

/** The size a note is drawn at: what was dragged, else the default. */
export function noteSize(n: Pick<FlowNote, "w" | "h">): { w: number; h: number } {
  return { w: Math.max(NOTE_MIN.w, n.w ?? NOTE_DEFAULT.w), h: Math.max(NOTE_MIN.h, n.h ?? NOTE_DEFAULT.h) };
}

export const NOTE_COLORS = ["yellow", "pink", "blue", "green"] as const;

/** The colour of a diff note, kept out of NOTE_COLORS so the colour button never offers it or lands on it. */
export const DIFF_NOTE_COLOR = "teal";

/** The notes that offer a polished version of a step, each waiting on an Accept or a Reject. */
export function diffNotes(flow: Flow): FlowNote[] {
  return (flow.notes ?? []).filter((n) => n.diff !== undefined);
}

/** A notes container is drawn as a card the size of a step. */
export const STACK_SIZE = { w: 192, h: 96 } as const;

/** Notes are a drawing, so they never unlock a locked workflow. */
export function addNote(
  flow: Flow,
  at: { x: number; y: number },
  text = "",
  color: string = NOTE_COLORS[0],
  extra: Partial<Pick<FlowNote, "stack" | "w" | "h" | "diff">> = {},
): Flow {
  const used = new Set((flow.notes ?? []).map((n) => n.id));
  let n = used.size + 1;
  while (used.has(`note${n}`)) n += 1;
  return { ...flow, notes: [...(flow.notes ?? []), { id: `note${n}`, text, color, x: at.x, y: at.y, ...extra }], updatedAt: Date.now() };
}

export function updateNote(flow: Flow, id: string, patch: Partial<Omit<FlowNote, "id">>): Flow {
  return { ...flow, notes: (flow.notes ?? []).map((n) => (n.id === id ? { ...n, ...patch } : n)), updatedAt: Date.now() };
}

/** Take a note away. A notes container whose last note goes goes with it, since an empty card says nothing. */
export function removeNote(flow: Flow, id: string): Flow {
  const gone = (flow.notes ?? []).find((n) => n.id === id);
  let next = dropNoteLinks({ ...flow, notes: (flow.notes ?? []).filter((n) => n.id !== id), updatedAt: Date.now() }, "note", id);
  if (gone?.stack && !(next.notes ?? []).some((n) => n.stack === gone.stack)) next = removeNoteStack(next, gone.stack);
  return next;
}

/** Make an empty notes container. Expanded unless said otherwise. */
export function addNoteStack(flow: Flow, at: { x: number; y: number }, title: string, expanded = true): Flow {
  const used = new Set((flow.noteStacks ?? []).map((s) => s.id));
  let n = used.size + 1;
  while (used.has(`ns${n}`)) n += 1;
  return { ...flow, noteStacks: [...(flow.noteStacks ?? []), { id: `ns${n}`, title, x: at.x, y: at.y, expanded }], updatedAt: Date.now() };
}

export function updateNoteStack(flow: Flow, id: string, patch: Partial<Omit<NoteStack, "id">>): Flow {
  return { ...flow, noteStacks: (flow.noteStacks ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)), updatedAt: Date.now() };
}

/** Delete a notes container and every note inside it, with the dotted lines that touched any of them. */
export function removeNoteStack(flow: Flow, id: string): Flow {
  let next: Flow = { ...flow, noteStacks: (flow.noteStacks ?? []).filter((s) => s.id !== id), updatedAt: Date.now() };
  const inside = (next.notes ?? []).filter((n) => n.stack === id).map((n) => n.id);
  next = { ...next, notes: (next.notes ?? []).filter((n) => n.stack !== id) };
  for (const note of inside) next = dropNoteLinks(next, "note", note);
  return dropNoteLinks(next, "stack", id);
}

export function stackNotes(flow: Flow, id: string): FlowNote[] {
  return (flow.notes ?? []).filter((n) => n.stack === id);
}

/** The ids of notes folded into a shrunk card: they exist, but are not drawn. */
export function hiddenNotes(flow: Flow): Map<string, string> {
  const folded = new Set((flow.noteStacks ?? []).filter((s) => s.expanded === false).map((s) => s.id));
  return new Map((flow.notes ?? []).flatMap((n) => (n.stack && folded.has(n.stack) ? [[n.id, n.stack] as const] : [])));
}

/** How far apart the notes sit on a container's own canvas, and how many to a row. */
const INSIDE_GAP = 24;
const INSIDE_COLUMNS = 3;

/**
 * The inside of a notes container as a flow of its own, so the same canvas can show it: just its notes, laid out in
 * rows that never touch, whatever they were doing on the workflow. Like `subFlow` for a step.
 */
export function notesInside(flow: Flow, stackId: string): Flow {
  const notes = gridNotes(stackNotes(flow, stackId));
  return { ...flow, id: `${flow.id}.${stackId}`, tools: [], nodes: [], containers: [], asks: [], noteStacks: [], noteLinks: [], notes, locked: false };
}

/** Notes set down in rows that never touch, whatever they were doing on the workflow, cut loose from any container. */
function gridNotes(members: FlowNote[]): FlowNote[] {
  let x = INSIDE_GAP;
  let y = INSIDE_GAP;
  let row = 0;
  return members.map((n, i) => {
    const size = noteSize(n);
    if (i > 0 && i % INSIDE_COLUMNS === 0) {
      x = INSIDE_GAP;
      y += row + INSIDE_GAP;
      row = 0;
    }
    const placed: FlowNote = { ...n, stack: undefined, x, y, w: size.w, h: size.h };
    x += size.w + INSIDE_GAP;
    row = Math.max(row, size.h);
    return placed;
  });
}

/**
 * Write an edited inside back: the words, colours and sizes of the notes that are still there, and the removal of
 * the ones deleted. Where a note sits on the inside canvas is only a tidy grid, so it does not move the note on the workflow.
 */
export function setNotesInside(flow: Flow, stackId: string, inside: Flow): Flow {
  const edited = new Map((inside.notes ?? []).map((n) => [n.id, n] as const));
  let next: Flow = {
    ...flow,
    notes: (flow.notes ?? []).flatMap((n) => {
      if (n.stack !== stackId) return [n];
      const e = edited.get(n.id);
      return e ? [{ ...n, text: e.text, color: e.color, w: e.w, h: e.h }] : [];
    }),
    updatedAt: Date.now(),
  };
  for (const n of stackNotes(flow, stackId)) if (!edited.has(n.id)) next = dropNoteLinks(next, "note", n.id);
  return stackNotes(next, stackId).length === 0 ? removeNoteStack(next, stackId) : next;
}

/** Forget every dotted line that touches this thing. Ids are reused after a delete, so a line must not outlive its end. */
export function dropNoteLinks(flow: Flow, kind: NoteLinkEnd["kind"], id: string): Flow {
  if (!flow.noteLinks?.length) return flow;
  const gone = (e: NoteLinkEnd) => e.kind === kind && e.id === id;
  const left = flow.noteLinks.filter((l) => !gone(l.from) && !gone(l.to));
  return left.length === flow.noteLinks.length ? flow : { ...flow, noteLinks: left };
}

/**
 * Draw a dotted line from one thing to another. One end must be a note, both must exist, a thing is not
 * linked to itself, and the same two things are not linked twice (either way round). Returns the flow unchanged
 * when the line is not allowed. Like notes, links never unlock a locked workflow.
 */
export function addNoteLink(flow: Flow, from: NoteLinkEnd, to: NoteLinkEnd): Flow {
  if (from.kind !== "note" && to.kind !== "note") return flow;
  if (from.kind === to.kind && from.id === to.id) return flow;
  const exists = (e: NoteLinkEnd) =>
    e.kind === "note"
      ? (flow.notes ?? []).some((n) => n.id === e.id)
      : e.kind === "ask"
        ? (flow.asks ?? []).some((a) => a.id === e.id)
        : e.kind === "node"
          ? flow.nodes.some((n) => n.id === e.id)
          : e.kind === "stack"
            ? (flow.noteStacks ?? []).some((s) => s.id === e.id)
            : (flow.containers ?? []).some((c) => c.id === e.id);
  if (!exists(from) || !exists(to)) return flow;
  const same = (a: NoteLinkEnd, b: NoteLinkEnd) => a.kind === b.kind && a.id === b.id;
  const links = flow.noteLinks ?? [];
  if (links.some((l) => (same(l.from, from) && same(l.to, to)) || (same(l.from, to) && same(l.to, from)))) return flow;
  const used = new Set(links.map((l) => l.id));
  let n = used.size + 1;
  while (used.has(`nl${n}`)) n += 1;
  return { ...flow, noteLinks: [...links, { id: `nl${n}`, from, to }], updatedAt: Date.now() };
}

export function removeNoteLink(flow: Flow, id: string): Flow {
  return { ...flow, noteLinks: (flow.noteLinks ?? []).filter((l) => l.id !== id), updatedAt: Date.now() };
}

/**
 * Put a copy of `source` (from this flow or another) at `at`. The copy waits for nothing and is not done.
 * A Start is never copied, since a workflow has one. A tool the flow does not have is dropped, and an
 * artifact name another step already makes gets " (copy)" so the two can be told apart.
 */
export function insertCopy(flow: Flow, source: FlowNode, at: { x: number; y: number }): Flow {
  if (source.kind === "start") return flow;
  const id = nextId("n", new Set(flow.nodes.map((n) => n.id)));
  const clone: FlowNode = JSON.parse(JSON.stringify(source));
  const hasTool = Boolean(clone.toolId && flow.tools.some((t) => t.id === clone.toolId));
  const taken = new Set(
    flow.nodes.filter((n) => n.kind !== "verifier" && n.kind !== "approval").flatMap((n) => n.outputs.map((p) => p.label.trim().toLowerCase())),
  );
  const copy: FlowNode = {
    ...clone,
    id,
    inputs: [],
    done: undefined,
    failed: undefined,
    critic: clone.critic ? { ...clone.critic, rounds: [], toolId: flow.tools.some((t) => t.id === clone.critic?.toolId) ? clone.critic.toolId : undefined } : undefined,
    asks: clone.asks?.filter((need) => (flow.asks ?? []).some((a) => a.id === need.ask)),
    askInputs: clone.askInputs?.filter((ref) => (flow.asks ?? []).some((a) => a.id === ref.ask)),
    when: clone.when && (flow.asks ?? []).some((a) => a.fields.some((f) => f.name === clone.when!.name)) ? clone.when : undefined,
    toolId: hasTool ? clone.toolId : undefined,
    modelId: hasTool ? clone.modelId : undefined,
    outputs:
      source.kind === "verifier" || source.kind === "approval"
        ? clone.outputs
        : clone.outputs.map((p) => (taken.has(p.label.trim().toLowerCase()) ? { ...p, label: `${p.label} (copy)` } : p)),
    pos: at,
  };
  return touch(flow, { nodes: [...flow.nodes, copy] });
}

/** Keep the AI-written retry prompt on a failed step, or drop it with undefined. */
export function setRetry(flow: Flow, nodeId: string, retry: string | undefined): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) =>
      n.id === nodeId && n.failed ? { ...n, failed: { ...n.failed, retry: retry?.trim() || undefined } } : n,
    ),
    updatedAt: Date.now(),
  };
}

/** Replace the sub-steps of a step with plain descriptions, as parallel steps the main model hands out. */
export function setSubSteps(flow: Flow, nodeId: string, texts: string[]): Flow {
  const clean = texts.map((t) => t.trim()).filter(Boolean);
  let inside = subFlow(flow, nodeId);
  inside = { ...inside, nodes: [] };
  clean.forEach((text) => {
    inside = addAgentNode(inside, text);
  });
  inside = {
    ...inside,
    nodes: inside.nodes.map((n, i) => ({ ...n, pos: { x: 48 + (i % 3) * 320, y: 48 + Math.floor(i / 3) * 144 } })),
  };
  return setSub(flow, nodeId, inside);
}

/** Bending a wire changes how it looks, not what it says, so the flow stays locked. */
export function setBend(flow: Flow, to: string, ref: { node: string; port: string }, bend: number): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.id === to
        ? {
            ...node,
            inputs: node.inputs.map((r) =>
              r.node === ref.node && r.port === ref.port ? { ...r, bend: Math.round(bend) } : r,
            ),
          }
        : node,
    ),
    updatedAt: Date.now(),
  };
}

/** Moving a node changes how it looks, not what it says, so the flow stays locked. */
export function moveNode(flow: Flow, nodeId: string, pos: { x: number; y: number }): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => (node.id === nodeId ? { ...node, pos } : node)),
    updatedAt: Date.now(),
  };
}

export function removeNode(flow: Flow, nodeId: string): Flow {
  return dropNoteLinks(
    touch(flow, {
      nodes: flow.nodes
        .filter((node) => node.id !== nodeId)
        .map((node) => ({
          ...node,
          inputs: node.inputs.filter((ref) => ref.node !== nodeId),
        })),
    }),
    "node",
    nodeId,
  );
}

export function addOutput(
  flow: Flow,
  nodeId: string,
  label: string,
  note = "",
): Flow {
  return touch(flow, {
    nodes: flow.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const id = nextId("o", new Set(node.outputs.map((p) => p.id)));
      return { ...node, outputs: [...node.outputs, { id, label, note }] };
    }),
  });
}

export function removeOutput(
  flow: Flow,
  nodeId: string,
  portId: string,
): Flow {
  return touch(flow, {
    nodes: flow.nodes.map((node) => {
      const inputs = node.inputs.filter(
        (ref) => !(ref.node === nodeId && ref.port === portId),
      );
      return node.id === nodeId
        ? { ...node, inputs, outputs: node.outputs.filter((p) => p.id !== portId) }
        : { ...node, inputs };
    }),
  });
}

/** Wire one node's output into another node's inputs. */
export function wire(flow: Flow, to: string, ref: PortRef): Flow {
  return touch(flow, {
    nodes: flow.nodes.map((node) =>
      node.id === to &&
      !node.inputs.some((r) => r.node === ref.node && r.port === ref.port)
        ? { ...node, inputs: [...node.inputs, ref] }
        : node,
    ),
  });
}

export function unwire(flow: Flow, to: string, ref: PortRef): Flow {
  return touch(flow, {
    nodes: flow.nodes.map((node) =>
      node.id === to
        ? {
            ...node,
            inputs: node.inputs.filter(
              (r) => !(r.node === ref.node && r.port === ref.port),
            ),
          }
        : node,
    ),
  });
}

/** Every node that waits, directly or through others, on this one. */
export function descendants(flow: Flow, nodeId: string): Set<string> {
  const found = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of flow.nodes) {
      if (found.has(node.id) || node.id === nodeId) continue;
      if (dependencies(node).some((id) => id === nodeId || found.has(id))) {
        found.add(node.id);
        grew = true;
      }
    }
  }
  return found;
}

/** Whether `to` may wait for `from`: a different node that does not already wait on `to`. */
export function canWire(flow: Flow, from: string, to: string): boolean {
  if (from === to) return false;
  const source = flow.nodes.find((n) => n.id === from);
  const target = flow.nodes.find((n) => n.id === to);
  if (!source || !target) return false;
  // A Start waits for nothing and an End makes nothing.
  if (target.kind === "start" || source.kind === "end") return false;
  return !descendants(flow, to).has(from);
}

/** A short artifact name taken from a node's own text, for when it makes none yet. */
export function artifactLabel(node: FlowNode): string {
  const words = node.text.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  return words ? `${words} output` : "Output";
}

/** The nodes a node waits for, derived from its wired inputs. */
export function dependencies(node: FlowNode): string[] {
  return [...new Set(node.inputs.map((ref) => ref.node))];
}

/** Adapter for the existing canvas layout and edge router. */
export function toTasks(flow: Flow) {
  return flow.nodes.map((node) => ({
    id: node.id,
    text: node.text,
    dependsOn: dependencies(node),
  }));
}

export function flowIssues(flow: Flow): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const toolIds = new Set(flow.tools.map((tool) => tool.id));
  const produced = new Map<string, string>();

  for (const node of flow.nodes) {
    if (isWork(node) && !node.text.trim()) {
      issues.push({ kind: "empty-text", node: node.id, message: "Needs a one-line description." });
    }
    if (node.kind === "agent") {
      if (!node.toolId) {
        issues.push({ kind: "no-tool", node: node.id, message: "Pick the tool that runs this node." });
      } else if (!toolIds.has(node.toolId)) {
        issues.push({ kind: "unknown-tool", node: node.id, message: "Its tool is not in your list." });
      }
    }
    if (node.kind === "agent" && node.need !== undefined && node.toolId && toolIds.has(node.toolId)) {
      const model = effectiveModel(flow, node);
      if (!model || model.capability < node.need) {
        issues.push({
          kind: "weak-model",
          node: node.id,
          message: `No model in this tool reaches capability ${node.need}.`,
        });
      }
    }
    // A verifier's pass is always taken from that verifier, so several checks may all be called "Check passes".
    // An approval is the same: every one makes "Approved", wired from its own step.
    // Only artifacts a person has to tell apart by name must be unique.
    for (const port of node.kind === "verifier" || node.kind === "approval" ? [] : node.outputs) {
      const key = port.label.trim().toLowerCase();
      const owner = produced.get(key);
      if (key && owner && owner !== node.id) {
        issues.push({
          kind: "duplicate-output",
          node: node.id,
          message: `"${port.label}" is also produced by ${owner}.`,
        });
      } else if (key) {
        produced.set(key, node.id);
      }
    }
    for (const ref of node.inputs) {
      const source = byId.get(ref.node);
      if (ref.node === node.id) {
        issues.push({ kind: "self-input", node: node.id, message: "A node cannot wait for itself." });
      } else if (!source) {
        issues.push({ kind: "missing-node", node: node.id, message: `Input comes from ${ref.node}, which is gone.` });
      } else if (!source.outputs.some((port) => port.id === ref.port)) {
        issues.push({ kind: "missing-port", node: node.id, message: `${source.id} no longer produces that artifact.` });
      }
    }
  }

  for (const node of flow.nodes) {
    if (node.kind === "wait" && waitUntil(flow, node) === null) {
      issues.push({
        kind: "no-wait-target",
        node: node.id,
        message: "Pick which tool and which limit this waits for, and set when it resets.",
      });
    }
  }

  const seenNames = new Map<string, string>();
  for (const ask of flow.asks ?? []) {
    for (const field of ask.fields) {
      const owner = seenNames.get(field.name);
      if (field.name && owner && owner !== ask.id) {
        issues.push({ kind: "duplicate-variable", node: ask.id, message: `{${field.name}} is also used by ${owner}.` });
      } else if (field.name) {
        seenNames.set(field.name, ask.id);
      }
    }
  }
  const askIds = new Set((flow.asks ?? []).map((a) => a.id));
  for (const node of flow.nodes) {
    for (const need of node.asks ?? []) {
      if (!askIds.has(need.ask)) issues.push({ kind: "missing-ask", node: node.id, message: "It needs a question that is gone." });
    }
    if (node.when && !seenNames.has(node.when.name)) {
      issues.push({ kind: "unknown-variable", node: node.id, message: `Its condition uses {${node.when.name}}, which no question makes.` });
    }
  }

  for (const node of flow.nodes) {
    if (node.kind !== "translator") continue;
    if ((node.askInputs ?? []).length === 0) {
      issues.push({ kind: "translator-empty", node: node.id, message: "Wire the questions it should turn into words." });
    }
    for (const ref of node.askInputs ?? []) {
      if (!askIds.has(ref.ask)) issues.push({ kind: "missing-ask", node: node.id, message: "A question wired into it is gone." });
    }
  }

  const starts = flow.nodes.filter((n) => n.kind === "start");
  for (const extra of starts.slice(1)) {
    issues.push({ kind: "extra-start", node: extra.id, message: "A workflow has one Start. Remove this one." });
  }
  for (const end of flow.nodes.filter((n) => n.kind === "end")) {
    if (end.inputs.length === 0) {
      issues.push({ kind: "end-empty", node: end.id, message: "Connect something to this End." });
    }
  }
  // Everything has to be reachable from the Start. Only checked once there is a Start, so
  // a flow built without one (inside a step, say) is not asked for one.
  if (starts.length > 0) {
    // A translator is a second way in: it waits for squares, not for another step.
    const reached = new Set([...starts, ...flow.nodes.filter((n) => n.kind === "translator")].map((n) => n.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of flow.nodes) {
        if (!reached.has(n.id) && dependencies(n).some((id) => reached.has(id))) {
          reached.add(n.id);
          grew = true;
        }
      }
    }
    for (const n of flow.nodes) {
      if (!reached.has(n.id) && n.kind !== "end") {
        issues.push({ kind: "unreachable", node: n.id, message: "Not connected to the Start." });
      }
    }
  }

  const gated = new Set(flow.nodes.flatMap((node) => node.inputs.map((ref) => ref.node)));
  for (const node of flow.nodes) {
    if (node.kind === "verifier" && !gated.has(node.id)) {
      issues.push({
        kind: "ungated-verifier",
        node: node.id,
        message: "Nothing waits for this check, so it gates nothing.",
      });
    }
  }

  if (hasCycle(flow)) {
    issues.push({ kind: "cycle", node: flow.nodes[0]?.id ?? "", message: "The graph contains a cycle." });
  }
  return issues;
}

export function hasCycle(flow: Flow): boolean {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "visited">();
  const visit = (id: string): boolean => {
    const seen = state.get(id);
    if (seen === "visiting") return true;
    if (seen === "visited") return false;
    const node = byId.get(id);
    if (!node) return false;
    state.set(id, "visiting");
    for (const dep of dependencies(node)) if (visit(dep)) return true;
    state.set(id, "visited");
    return false;
  };
  return flow.nodes.some((node) => visit(node.id));
}

/**
 * Whether a node counts as done. A Start always does, since what it holds is already
 * there. An End is reached the moment everything it waits for is done.
 */
export function doneOf(flow: Flow, node: FlowNode, now = Date.now()): boolean {
  if (node.kind === "start") return true;
  // A translator finishes by itself once the questions wired into it are answered (or on a branch not taken).
  if (node.kind === "translator") return translatorState(flow, node) !== "waiting";
  // A step whose condition fails (or whose whole branch does) has nothing to do, so what follows may go on.
  if (isSkipped(flow, node)) return true;
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const depsDone = () => {
    const deps = dependencies(node);
    return deps.every((id) => Boolean(byId.get(id) && doneOf(flow, byId.get(id)!, now)));
  };
  if (node.kind === "end") return dependencies(node).length > 0 && depsDone();
  // A wait is done by the clock, once what it waits for is done and the limit has reset, or when the
  // person says they know it has.
  if (node.kind === "wait") {
    if (node.done) return true;
    const until = waitUntil(flow, node);
    return until !== null && until <= now && depsDone();
  }
  return Boolean(node.done);
}

/** Ready to be worked on: a step that is not done whose inputs are. Starts and Ends are never ready. */
export function isReady(flow: Flow, node: FlowNode, now = Date.now()): boolean {
  if (!isWork(node) || node.done) return false;
  if (isSkipped(flow, node) || blockedByAsks(flow, node)) return false;
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  return dependencies(node).every((id) => {
    const source = byId.get(id);
    return Boolean(source && doneOf(flow, source, now));
  });
}

/** Nodes whose inputs all exist, best one to start first. */
export function readyNodes(flow: Flow, now = Date.now()): FlowNode[] {
  return rankReady(flow, flow.nodes.filter((node) => isReady(flow, node, now)), now);
}

const BILLING_RANK: Record<Billing, number> = { subscription: 0, free: 1, payg: 2 };

function toolOf(flow: Flow, node: FlowNode): FlowTool | undefined {
  return flow.tools.find((tool) => tool.id === node.toolId);
}

/**
 * Whether the node fits what its tool has left. An unknown amount counts as
 * enough, and so does a window whose reset time has already passed.
 *
 * Limits each have to hold the node's cost. Supplies (daily hours and a wallet)
 * are added together first. Hour windows are charged at the model's usage rate,
 * so a model that spends hours twenty times as fast needs twenty times as many.
 */
export function fitsQuota(flow: Flow, node: FlowNode, now = Date.now()): boolean {
  const tool = toolOf(flow, node);
  if (!tool) return true;
  const rate = effectiveModel(flow, node)?.usage ?? 1;
  const need = (w: QuotaWindow) => node.cost * (w.unit === "hours" ? rate : 1);
  const known = (w: QuotaWindow) =>
    w.left !== null && !(w.resetsAt !== null && w.resetsAt <= now);
  const limits = tool.windows.filter((w) => (w.role ?? "limit") === "limit");
  const supplies = tool.windows.filter((w) => w.role === "supply");
  const limitsOk = limits.every((w) => !known(w) || need(w) <= (w.left ?? 0));
  if (!limitsOk) return false;
  const model = effectiveModel(flow, node);
  if (model?.freeHours !== undefined) return node.cost <= model.freeHours;
  if (supplies.length === 0 || supplies.some((w) => !known(w))) return true;
  return need(supplies[0]) <= supplies.reduce((sum, w) => sum + (w.left ?? 0), 0);
}

/** Position of a plan in the tool's ladder, or -1 when it is not on it. */
export function planRank(tool: FlowTool | undefined, name: string | undefined): number {
  if (!tool || !name) return -1;
  return (tool.plans ?? []).findIndex((p) => p.name.toLowerCase() === name.trim().toLowerCase());
}

/** The models the person's plan includes. With no plan to go by, all of them. */
export function availableModels(tool: FlowTool | undefined): ModelEntry[] {
  if (!tool) return [];
  const have = planRank(tool, tool.tier);
  if (have < 0) return tool.models ?? [];
  return (tool.models ?? []).filter((m) => {
    const needs = planRank(tool, m.plan);
    return needs < 0 || needs <= have;
  });
}

/** What the tool's quota is counted in. */
export function costUnit(tool: FlowTool | undefined): "prompts" | "hours" {
  return tool?.windows.some((w) => w.unit === "hours") ? "hours" : "prompts";
}

export const MIN_NEED = 1;
export const MAX_NEED = 10;

/** One point above what the job needs, so there is headroom; 10 stays 10. */
export function targetCapability(need: number): number {
  return Math.min(MAX_NEED, Math.round(need) + 1);
}

/** Models on the person's plan that are strong enough for the job, weakest first. */
export function eligibleModels(tool: FlowTool | undefined, need: number): ModelEntry[] {
  return [...availableModels(tool)]
    .filter((m) => m.capability >= need)
    .sort((a, b) => a.capability - b.capability);
}

/**
 * The model picked for a job: the weakest one at the target (need plus one),
 * which keeps the stronger ones for harder work. If none reaches the target,
 * the strongest one the plan includes.
 */
export function autoModel(tool: FlowTool | undefined, need: number): ModelEntry | undefined {
  const models = [...availableModels(tool)].sort((a, b) => a.capability - b.capability);
  const target = targetCapability(need);
  return models.find((m) => m.capability >= target) ?? models[models.length - 1];
}

/** The model a node will use: the person's choice if the plan still has it, else the auto-pick. */
export function effectiveModel(flow: Flow, node: FlowNode): ModelEntry | undefined {
  const tool = flow.tools.find((t) => t.id === node.toolId);
  if (!tool || node.kind !== "agent") return undefined;
  const chosen = availableModels(tool).find((m) => m.id === node.modelId);
  if (chosen) return chosen;
  return node.need === undefined ? undefined : autoModel(tool, node.need);
}

/** Nodes that become ready the moment this one is done. */
export function unlocks(flow: Flow, node: FlowNode): number {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  return flow.nodes.filter((other) => {
    if (other.done || other.id === node.id || !isWork(other)) return false;
    const deps = dependencies(other);
    return (
      deps.includes(node.id) &&
      deps.every((id) => {
        const dep = byId.get(id);
        return id === node.id || Boolean(dep && doneOf(flow, dep));
      })
    );
  }).length;
}

/** Soonest reset among the windows still running; Infinity when none is known. */
function soonestReset(tool: FlowTool | undefined, now: number): number {
  const times = (tool?.windows ?? [])
    .map((w) => w.resetsAt)
    .filter((t): t is number => t !== null && t > now);
  return times.length > 0 ? Math.min(...times) : Infinity;
}

/**
 * Order the nodes that can start right now. The first is what to paste next,
 * and the ones after it can run beside it.
 *
 * Nodes that do not fit their tool's quota go last. The rest are grouped by
 * tool and the tools are ordered: the one marked "use first", then the soonest
 * reset (so what is left is not wasted), then subscriptions before free tiers
 * before pay as you go. Within a tool the node that unlocks the most comes
 * first. Finally the tools take turns, so different tools are on top and work
 * runs in parallel.
 */
export function rankReady(
  flow: Flow,
  ready: FlowNode[],
  now = Date.now(),
): FlowNode[] {
  const position = new Map(flow.nodes.map((node, index) => [node.id, index]));
  const gain = new Map(ready.map((node) => [node.id, unlocks(flow, node)]));
  const byGain = (a: FlowNode, b: FlowNode) =>
    (gain.get(b.id) ?? 0) - (gain.get(a.id) ?? 0) ||
    (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);

  const fits = ready.filter((node) => fitsQuota(flow, node, now));
  const rest = ready.filter((node) => !fitsQuota(flow, node, now)).sort(byGain);

  // Nodes without a tool (verifiers) share one lane that comes last.
  const lanes = new Map<string, FlowNode[]>();
  for (const node of fits) {
    const key = toolOf(flow, node)?.id ?? "";
    lanes.set(key, [...(lanes.get(key) ?? []), node]);
  }
  const laneRank = (key: string) => {
    const tool = flow.tools.find((t) => t.id === key);
    return [
      tool ? 0 : 1,
      tool?.prefer ? 0 : 1,
      soonestReset(tool, now),
      tool ? BILLING_RANK[tool.billing] : 3,
    ];
  };
  const ordered = [...lanes.entries()]
    .map(([key, nodes]) => ({ key, nodes: nodes.sort(byGain) }))
    .sort((a, b) => {
      const [ra, rb] = [laneRank(a.key), laneRank(b.key)];
      for (let i = 0; i < ra.length; i += 1) {
        if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
      }
      return (position.get(a.nodes[0].id) ?? 0) - (position.get(b.nodes[0].id) ?? 0);
    });

  const result: FlowNode[] = [];
  const turns = Math.max(0, ...ordered.map((lane) => lane.nodes.length));
  for (let turn = 0; turn < turns; turn += 1) {
    for (const lane of ordered) if (lane.nodes[turn]) result.push(lane.nodes[turn]);
  }
  return [...result, ...rest];
}

export function markDone(flow: Flow, nodeId: string, pasted = "", now = Date.now()): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.id === nodeId ? { ...node, done: { at: now, pasted }, failed: undefined } : node,
    ),
    updatedAt: now,
  };
}

/**
 * The tool's attempt did not work. The node goes back to not done (and so does anything built on it,
 * in case it had been marked done before), and keeps the error and how many attempts have failed, so
 * its prompt can ask for a retry that starts from what went wrong.
 */
export function markFailed(flow: Flow, nodeId: string, error = "", now = Date.now()): Flow {
  const reopened = reopen(flow, nodeId);
  return {
    ...reopened,
    nodes: reopened.nodes.map((node) =>
      node.id === nodeId
        ? { ...node, failed: { at: now, error: error.trim(), attempts: (node.failed?.attempts ?? 0) + 1 } }
        : node,
    ),
    updatedAt: now,
  };
}

/** Undoing a node also undoes everything built on top of it. */
export function reopen(flow: Flow, nodeId: string): Flow {
  const stale = new Set([nodeId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of flow.nodes) {
      if (!stale.has(node.id) && dependencies(node).some((id) => stale.has(id))) {
        stale.add(node.id);
        grew = true;
      }
    }
  }
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      stale.has(node.id)
        ? { ...node, done: undefined, critic: node.critic ? { ...node.critic, rounds: [] } : undefined }
        : node,
    ),
    updatedAt: Date.now(),
  };
}

export function lock(flow: Flow): Flow | null {
  if (flow.nodes.length === 0) return null;
  const blocking = flowIssues(flow).filter((i) => i.kind !== "ungated-verifier");
  if (blocking.length > 0) return null;
  return { ...flow, locked: true, updatedAt: Date.now() };
}

/** A, B, ... Z, then AA, AB, ... for the rare stage with more branches than letters. */
function branchLetters(i: number): string {
  const letter = (n: number) => String.fromCharCode(65 + n);
  return i < 26 ? letter(i) : `${branchLetters(Math.floor(i / 26) - 1)}${letter(i % 26)}`;
}

export interface PlanStep {
  node: FlowNode;
  /** "1", "2A", "3BA": the stage, then the branch within it. */
  label: string;
}

/**
 * The work steps in the order they are read, each with the name it goes by in the plan.
 *
 * A step's number is its stage: one more than the latest stage of anything it waits for, so steps
 * that can run side by side share a number. Its letters say which branch it is on. Steps in the
 * same stage that came out of the same branch split it, A then B then C, and a branch that splits
 * again keeps its letter and adds another (3BA and 3BB are two halves of branch B). A step that
 * waits for several branches rejoins their common branch, so a step that waits for everything has
 * no letters at all. Starts, ends and waits are not steps and are passed through.
 */
export function planOrder(flow: Flow): PlanStep[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const work = flow.nodes.filter(isWork);
  const index = new Map(work.map((n, i) => [n.id, i]));

  /** The steps a node waits for, looking through anything that is not a step. */
  const workParents = (node: FlowNode, seen = new Set<string>()): FlowNode[] =>
    dependencies(node).flatMap((id) => {
      const parent = byId.get(id);
      if (!parent || seen.has(id)) return [];
      seen.add(id);
      return isWork(parent) ? [parent] : workParents(parent, seen);
    });
  const parents = new Map(work.map((n) => [n.id, workParents(n)]));

  // A cycle is a mistake the editor reports separately; here it must only not hang.
  const stage = new Map<string, number>();
  const visiting = new Set<string>();
  const stageOf = (n: FlowNode): number => {
    const known = stage.get(n.id);
    if (known !== undefined) return known;
    if (visiting.has(n.id)) return 0;
    visiting.add(n.id);
    const value = 1 + Math.max(0, ...(parents.get(n.id) ?? []).map(stageOf));
    visiting.delete(n.id);
    stage.set(n.id, value);
    return value;
  };
  work.forEach(stageOf);

  const common = (lanes: string[]) =>
    lanes.reduce((prefix, lane) => {
      let i = 0;
      while (i < prefix.length && i < lane.length && prefix[i] === lane[i]) i += 1;
      return prefix.slice(0, i);
    });

  const lane = new Map<string, string>();
  const stages = [...new Set(work.map((n) => stage.get(n.id)!))].sort((a, b) => a - b);
  for (const at of stages) {
    // Where each step in this stage starts from: the branch of what it waits for.
    const groups = new Map<string, FlowNode[]>();
    for (const n of work.filter((w) => stage.get(w.id) === at)) {
      const ps = parents.get(n.id) ?? [];
      const from = ps.length ? common(ps.map((p) => lane.get(p.id) ?? "")) : "";
      groups.set(from, [...(groups.get(from) ?? []), n]);
    }
    for (const [from, members] of groups) {
      members.forEach((n, i) => lane.set(n.id, members.length > 1 ? `${from}${branchLetters(i)}` : from));
    }
  }

  const label = new Map(work.map((n) => [n.id, `${stage.get(n.id)}${lane.get(n.id) ?? ""}`]));
  // Two steps that rejoin and split in odd ways could land on one name; they are told apart, never shared.
  for (let round = 0; round < 4; round++) {
    const named = new Map<string, FlowNode[]>();
    for (const n of work) named.set(label.get(n.id)!, [...(named.get(label.get(n.id)!) ?? []), n]);
    const clashes = [...named.values()].filter((group) => group.length > 1);
    if (clashes.length === 0) break;
    for (const group of clashes) group.forEach((n, i) => label.set(n.id, `${label.get(n.id)}${branchLetters(i)}`));
  }

  return [...work]
    .sort((a, b) => {
      const byStage = stage.get(a.id)! - stage.get(b.id)!;
      if (byStage) return byStage;
      const la = lane.get(a.id) ?? "";
      const lb = lane.get(b.id) ?? "";
      return la === lb ? index.get(a.id)! - index.get(b.id)! : la < lb ? -1 : 1;
    })
    .map((node) => ({ node, label: label.get(node.id)! }));
}

/** The human-readable record: each step under its plan name, in reading order, joined by a horizontal rule. */
export function collatedDoc(flow: Flow): string {
  const toolName = new Map(flow.tools.map((tool) => [tool.id, tool.name]));
  const steps = planOrder(flow);
  const labelOf = new Map(steps.map((s) => [s.node.id, s.label]));
  /** A wait is not a step, so a step that follows one is read as following whatever the wait followed. */
  const origin = (id: string, seen = new Set<string>()): string => {
    const source = flow.nodes.find((n) => n.id === id);
    const label = labelOf.get(id);
    if (label) return label;
    if (source?.kind === "wait" && !seen.has(id)) {
      seen.add(id);
      const before = source.inputs[0];
      if (before) return origin(before.node, seen);
    }
    // A step is named by its plan label, the Start by what it is, anything else by what it says.
    return source?.kind === "start" || source?.kind === "wait" ? "the start" : source?.text || id;
  };
  const parts = steps.map(({ node, label }) => {
    const head =
      node.kind === "approval"
        ? `## ${label}. Approval: ${node.text}`
        : node.kind === "verifier"
        ? `## ${label}. Check: ${node.check?.label ?? node.text}`
        : `## ${label}. ${node.text}${node.toolId ? ` (${toolName.get(node.toolId) ?? node.toolId})` : ""}`;
    const needs = node.inputs.map((ref) => {
      const source = flow.nodes.find((n) => n.id === ref.node);
      const port = source?.outputs.find((p) => p.id === ref.port);
      return `- Needs: ${port?.label ?? ref.port} (from ${origin(ref.node)})`;
    });
    const makes = node.outputs.map(
      (port) => `- Makes: ${port.label}${port.note ? `, ${port.note}` : ""}`,
    );
    const inside = (node.sub ?? []).map((step) => `- Inside: ${step.text || step.id}`);
    return [head, "", node.readable?.trim() || node.text, "", ...needs, ...makes, ...inside]
      .join("\n")
      .trim();
  });
  return `# ${flow.title || "Workflow"}\n\n${parts.join("\n\n---\n\n")}\n`;
}
