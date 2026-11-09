import {
  addAgentNode,
  addApprovalNode,
  addEndNode,
  addOutput,
  addStartNode,
  addTool,
  addVerifierNode,
  artifactLabel,
  availableModels,
  canWire,
  dependencies,
  newFlow,
  renameFlow,
  updateNode,
  updateOutput,
  VERIFIER_PORT,
  wire,
  type CheckKind,
  type Flow,
  type FlowKind,
  type FlowNode,
  type FlowTool,
} from "./flowModel";
import { CAPABILITY_ANCHORS, presetToTool, TOOL_PRESETS } from "./flowTools";

/**
 * The cloud writer for workflows.
 *
 * Drawing the graph takes a planner call and then one call per section, all sections at once, so a
 * workflow of 140 steps is never one reply that can be cut off. Prompts are filled in by a template with no model
 * (flowPromptDoc.ts); the cloud model polishes them later, in batches, only when asked. The quotas shape every number here (Gemini 3.5 Flash Lite: 250k input
 * tokens a minute, 15 requests a minute, 500 a day). Requests are the scarce thing, tokens are
 * not: 250k a minute over 15 requests is about 16k per request, so a request is worth sending
 * only when it is that full. Each batch therefore carries the whole graph (about 3k tokens, so
 * every prompt can name its neighbours' artifacts) and writes as many nodes as fit in
 * `BATCH_OUTPUT_TOKENS`, instead of one node per request.
 *
 * Pacing is not done here. The Rust side makes each request wait for its place, so this module
 * can send every batch at once.
 */

/** Sends one request to the cloud model and returns the text it wrote. */
export type Complete = (system: string, prompt: string, maxTokens: number) => Promise<string>;

/** Output tokens one batch aims to write. With the graph and brief as input, a request lands near 16k. */
export const BATCH_OUTPUT_TOKENS = 10_000;
/** Most nodes in one request, so a batch stays a region a writer can hold in mind. */
const MAX_PER_BATCH = 15;
/** The planner writes a short brief per section, so even a 140-step workflow fits well inside this. */
const OUTLINE_MAX_TOKENS = 12_000;
/** A step is about 130 tokens of JSON, so 60 steps is about 8k; this is headroom so a long section is not cut off. */
const SECTION_MAX_TOKENS = 16_000;
/** Steps a section aims for, and the most the planner may give one, so each writer holds its part in mind. */
const SECTION_NODES = 40;
const MAX_SECTION_NODES = 60;
/** More than this is a planner gone wrong; a 140-step workflow is 3 to 5 sections. */
const MAX_SECTIONS = 14;
/** Headroom over the aim, so a long node does not cut the reply off mid-JSON. */
const BATCH_MAX_TOKENS = 16_000;
/** Characters of conversation and brief sent with every request. About 3k tokens. */
const CONTEXT_CHARS = 9_000;

/** A reply that came back but could not be used; the request itself worked. */
export class ReplyError extends Error {}

export interface PlanRequest {
  /** What the person typed into the box when they asked for a workflow; may be empty. */
  ask: string;
  messages: Array<{ role: "user" | "soren"; text: string }>;
  items: Array<{ type: string; text: string; status: string }>;
  /** The tools the person has, as the flow will carry them. */
  tools: Array<Omit<FlowTool, "id">>;
}

export interface Progress {
  stage: "graph" | "plans";
  batches: number;
  batchesDone: number;
  nodes: number;
  nodesDone: number;
}

export interface Generated {
  flow: Flow;
  /** Things the person should know: a node skipped, a batch that failed, a flow left unlocked. */
  notes: string[];
  /** Requests spent, against the day's allowance. */
  requests: number;
}

/** One line for the status under the composer while the workflow is being written. */
export function describeProgress(p: Progress): string {
  if (p.stage === "graph") {
    if (p.batches === 0) return "Planning the workflow…";
    return `Drawing the workflow: ${p.batchesDone} of ${p.batches} sections done, about ${p.nodes} steps in all…`;
  }
  if (p.nodes === 0) return "Polishing prompts…";
  const requests = `${p.batches} request${p.batches === 1 ? "" : "s"}`;
  return `Polishing prompts: ${p.nodesDone} of ${p.nodes} steps done, in ${requests}…`;
}

/** One line for when it is finished: what was made, what it cost, and the first thing to know. */
export function describeResult(result: Generated): string {
  const steps = result.flow.nodes.filter((n) => n.kind === "agent" || n.kind === "verifier" || n.kind === "approval").length;
  const spent = `${result.requests} request${result.requests === 1 ? "" : "s"}`;
  return `“${result.flow.title}” is drawn: ${steps} step${steps === 1 ? "" : "s"}, ${spent} used. Each step's prompt is already filled in from its fields; review the graph, and polish the prompts when you want.${result.notes[0] ? ` ${result.notes[0]}` : ""}`;
}

/** The tools of the most recent workflow that had any, else the owner's usual three at their usual plans. */
export function defaultTools(flows: Flow[], now = Date.now()): Array<Omit<FlowTool, "id">> {
  const last = [...flows].sort((a, b) => b.updatedAt - a.updatedAt).find((f) => f.tools.length > 0);
  if (last) return last.tools.map(({ id: _id, ...tool }) => tool);
  return ["Claude Code", "Codex", "Antigravity"].flatMap((name) => {
    const preset = TOOL_PRESETS.find((p) => p.name === name);
    return preset ? [presetToTool(preset, now)] : [];
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function whole(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
}

/** The first JSON object in a reply, fences and chatter around it ignored. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ReplyError("The reply has no JSON in it.");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (cause) {
    // A reply cut off at the token limit lands here too.
    throw new ReplyError(`The reply is not complete JSON (${cause instanceof Error ? cause.message : "unreadable"}).`);
  }
}

/** The conversation and brief as plain text, newest last, kept under `CONTEXT_CHARS`. */
export function contextText(request: PlanRequest): string {
  const brief = request.items.map((item) => `- [${item.type}, ${item.status}] ${item.text}`).join("\n");
  const head = [
    request.ask.trim() && `What the person just asked for:\n${request.ask.trim()}`,
    brief && `The brief so far:\n${brief}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // The newest messages matter most, so they are added from the end until the room is gone.
  const lines: string[] = [];
  let room = Math.max(1_500, CONTEXT_CHARS - head.length);
  for (const message of [...request.messages].reverse()) {
    const line = `${message.role === "user" ? "Person" : "Soren"}: ${clip(message.text.trim().replace(/\s+/g, " "), 1_500)}`;
    if (line.length > room) break;
    lines.unshift(line);
    room -= line.length;
  }
  return [head, lines.length ? `The conversation:\n${lines.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/** A flow with the person's tools and nothing else, which the graph is then built onto. */
export function skeletonFlow(tools: Array<Omit<FlowTool, "id">>, now = Date.now()): Flow {
  return tools.reduce((flow, tool) => addTool(flow, tool), newFlow("", now));
}

function describeTools(flow: Flow): string {
  return flow.tools
    .map((tool) => {
      const models = availableModels(tool)
        .map((m) => `${m.name} (${m.capability})`)
        .join(", ");
      const limits = tool.windows.map((w) => w.label).join(", ");
      const sessions = tool.sessions === null ? "several sessions at once" : `${tool.sessions} session at a time`;
      return `- ${tool.name}, ${tool.tier} plan: ${sessions}; limits: ${limits || "none known"}; models: ${models || "unknown"}`;
    })
    .join("\n");
}

/** Rules for drawing nodes, shared by every section writer. */
const NODE_RULES = `- Kinds: agent (a coding tool does it), verifier (check is lint, tests, build or custom), approval (the person looks and says it is fine). There is no start or end: those are added for you.
- List a node only after everything it needs, so there are no cycles.
- "needs" lists node ids. To take one named artifact of a node that makes several, write "2:DB schema". A verifier's pass is wired automatically, so name just its id.
- Steps that do not depend on each other must not be wired together, so the person can run them in parallel in different tools. Do not chain steps for the sake of order.
- Every agent makes at least one artifact: a label and a one-line note. Labels are unique across the whole workflow, so make them specific.
- Put a verifier after work worth checking and have the next step need it. A verifier always has text saying what it checks ("API tests pass", not "Check passes").
- tool is the exact name of one of the person's tools. Spread work across tools to use each one's free time and limits, and keep the strongest tool's limited prompts for the hardest steps. need is how capable a model the step needs, 1 to 10:
${CAPABILITY_ANCHORS.map((a) => `  ${a.at}: ${a.label}`).join("\n")}
- cost is the prompts the step is expected to use, usually 1. Set delegates to true only when the step is big enough that its tool should hand parts to subagents.`;

const OUTLINE_SYSTEM = `You plan how a large workflow gets drawn. A workflow is a graph of steps that a person runs by pasting one prompt per step into their own AI coding tools. Other agents will each draw one section of the graph from a brief you write, all at the same time, so you decide how big the workflow is, split it into sections, and write each section's brief. You do not draw steps yourself.

Reply with one JSON object and nothing else:
{"title":"short name","start":"what the person brings","sections":[{"id":"a","name":"Database and models","nodes":20,"takes":["Starting point"],"gives":["DB schema","Seed data"],"brief":"..."},{"id":"b","name":"API","nodes":24,"takes":["DB schema"],"gives":["API routes"],"brief":"..."}]}

Rules:
- First decide how many steps the whole workflow needs, then split it so no section has more than ${MAX_SECTION_NODES} steps, usually 30 to 45. A small job is one section. A whole product can need 100 to 150 steps in 3 to 5 sections.
- ids are single lowercase letters: a, b, c.
- The writers cannot see each other, so the artifacts are the contract. "gives" lists what a section leaves behind that another section relies on. "takes" lists what it relies on from other sections, or "Starting point", which is what the person brings. Use the exact same label in both places. Every taken label is given by an earlier section.
- Sections that do not depend on each other must not take from each other, so the person can run them in parallel.
- "nodes" is your estimate of the steps in that section.
- "brief" is everything its writer is told, 120 to 250 words: what the section builds and where it stops, the kinds of steps and checks it needs (a verifier after work worth checking, an approval where the person must look), which of the person's tools suit the work, and which artifacts it takes and must give, by label. It must make sense with only the conversation beside it.`;

const SECTION_SYSTEM = `You draw one section of a workflow: a graph of steps that a person runs by pasting one prompt per step into their own AI coding tools. You draw steps only. Prompts come later. Other writers draw the other sections at the same time, so stay inside your brief.

Reply with one JSON object and nothing else:
{"nodes":[{"id":"1","kind":"agent","text":"one or two lines: what this step does","tool":"exact tool name","need":6,"cost":1,"needs":["in:Starting point"],"makes":[{"label":"DB schema","note":"tables, keys and indexes"}],"delegates":false},{"id":"2","kind":"verifier","check":"tests","text":"Schema migrates cleanly","needs":["1"]},{"id":"3","kind":"approval","text":"what the person looks at","needs":["2"]}]}

Rules:
- Ids are short and local to your section: "1", "2", "3". Other sections cannot refer to them.
- To rely on an artifact from another section, write "in:" and its exact label in "needs", for example "in:DB schema". Only take what your section is told it takes.
- Every artifact your section is told it gives must be made by one of your steps, with exactly that label.
${NODE_RULES}
- Use as many steps as the brief needs, up to ${MAX_SECTION_NODES}. A step is one prompt's worth of work.`;

function describeSections(outline: Outline): string {
  return outline.sections
    .map((s) => `${s.id} ${s.name} (about ${s.nodes} steps) takes: ${s.takes.join("; ") || "nothing"} | gives: ${s.gives.join("; ") || "nothing"}`)
    .join("\n");
}

export function buildOutlinePrompt(request: PlanRequest, flow: Flow): { system: string; prompt: string } {
  return {
    system: OUTLINE_SYSTEM,
    prompt: `The person's tools:\n${describeTools(flow)}\n\n${contextText(request)}\n\nPlan the workflow and write the section briefs as JSON now.`,
  };
}

export function buildSectionPrompt(request: PlanRequest, flow: Flow, outline: Outline, section: Section): { system: string; prompt: string } {
  return {
    system: SECTION_SYSTEM,
    prompt: `The person's tools:\n${describeTools(flow)}\n\n${contextText(request)}\n\nThe workflow "${outline.title}" is split into these sections, drawn at the same time:\n${describeSections(outline)}\n\nYour section: ${section.id}, ${section.name}.\nIt takes: ${section.takes.join("; ") || "nothing"}\nIt must give: ${section.gives.join("; ") || "nothing"}\n\nYour brief:\n${section.brief}\n\nDraw this section's steps as JSON now.`,
  };
}

export interface Section {
  id: string;
  name: string;
  /** The outline's estimate of how many steps the section needs. */
  nodes: number;
  /** Artifacts it relies on from earlier sections, by label; "Starting point" is what the person brings. */
  takes: string[];
  /** Artifacts it must leave behind for later sections, by label. */
  gives: string[];
  /** Everything its writer is told. */
  brief: string;
}

export interface Outline {
  title: string;
  start: string;
  sections: Section[];
  notes: string[];
}

interface RawSection {
  id?: unknown;
  name?: unknown;
  nodes?: unknown;
  takes?: unknown;
  gives?: unknown;
  brief?: unknown;
}

function labelList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(Boolean).map((label) => clip(label, 60)) : [];
}

/** The outline from the planner's reply: how the work is split, and what each section's writer is told. */
export function parseOutline(raw: string): Outline {
  const data = extractJson(raw) as { title?: unknown; start?: unknown; sections?: unknown };
  if (!Array.isArray(data.sections) || data.sections.length === 0) throw new ReplyError("The reply has no sections in it.");
  const notes: string[] = [];
  const seen = new Set<string>();
  const sections: Section[] = [];
  for (const item of data.sections as RawSection[]) {
    const id = str(item?.id).toLowerCase().replace(/[^a-z0-9]/g, "");
    const brief = str(item?.brief);
    if (!id || seen.has(id) || !brief) {
      notes.push(`Left out a section the planner did not describe properly${id ? ` (${id})` : ""}.`);
      continue;
    }
    if (sections.length >= MAX_SECTIONS) {
      notes.push(`The planner asked for more than ${MAX_SECTIONS} sections, so the rest were left out.`);
      break;
    }
    seen.add(id);
    sections.push({
      id,
      name: clip(str(item.name), 60) || `Part ${sections.length + 1}`,
      nodes: whole(item.nodes, 1, MAX_SECTION_NODES * 2) ?? SECTION_NODES,
      takes: labelList(item.takes),
      gives: labelList(item.gives),
      brief: clip(brief, 2_500),
    });
  }
  if (sections.length === 0) throw new ReplyError("The reply has no usable sections in it.");
  return { title: clip(str(data.title), 80) || "Workflow", start: clip(str(data.start), 220), sections, notes };
}

interface RawNode {
  id?: unknown;
  kind?: unknown;
  text?: unknown;
  tool?: unknown;
  need?: unknown;
  cost?: unknown;
  check?: unknown;
  needs?: unknown;
  makes?: unknown;
  delegates?: unknown;
}

const KINDS = new Set<string>(["start", "agent", "verifier", "approval", "end"]);
const CHECKS = new Set<string>(["lint", "tests", "build", "custom"]);

function toolFor(flow: Flow, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const exact = flow.tools.find((t) => t.name.toLowerCase() === wanted);
  const near = flow.tools.find((t) => wanted && (t.name.toLowerCase().includes(wanted) || wanted.includes(t.name.toLowerCase())));
  return (exact ?? near ?? flow.tools[0])?.id;
}

/** The port to wire from: a verifier's pass, the artifact whose label matches, else the first one, made if there is none. */
function portFor(flow: Flow, fromId: string, label: string): { flow: Flow; port: string } {
  const source = flow.nodes.find((n) => n.id === fromId)!;
  if (source.kind === "verifier") return { flow, port: VERIFIER_PORT };
  const hit = label ? source.outputs.find((p) => p.label.toLowerCase() === label) : undefined;
  const found = hit ?? source.outputs[0];
  if (found) return { flow, port: found.id };
  const next = addOutput(flow, fromId, artifactLabel(source));
  return { flow: next, port: next.nodes.find((n) => n.id === fromId)!.outputs[0].id };
}

function isLeaf(flow: Flow, node: FlowNode): boolean {
  return node.kind !== "start" && node.kind !== "end" && !flow.nodes.some((other) => other.inputs.some((ref) => ref.node === node.id));
}

/**
 * Build a real flow from the model's reply, through the same functions the canvas uses, so
 * nothing the model got wrong can produce a state the editor cannot hold. What cannot be kept is
 * dropped with a note; what is missing (a Start, an End, a wire into the Start) is added.
 */
export function parseGraph(raw: string, skeleton: Flow): { flow: Flow; notes: string[] } {
  const data = extractJson(raw) as { title?: unknown; nodes?: unknown };
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) throw new ReplyError("The reply has no nodes in it.");
  const notes: string[] = [];
  let flow = renameFlow(skeleton, clip(str(data.title), 80) || "Workflow");

  const realId = new Map<string, string>();
  const wiring: Array<{ to: string; needs: string[] }> = [];
  const labels = new Set<string>();
  let firstStart: string | undefined;

  for (const item of data.nodes as RawNode[]) {
    const key = str(item?.id);
    const kind = str(item?.kind);
    if (!key || realId.has(key) || !KINDS.has(kind)) {
      notes.push(`Left out a node the writer did not describe properly${key ? ` (${key})` : ""}.`);
      continue;
    }
    if (kind === "start" && firstStart) {
      // One Start only; anything that waited for the extra one waits for the first.
      realId.set(key, firstStart);
      continue;
    }
    const text = clip(str(item.text), 220);
    if (kind === "start") flow = addStartNode(flow, text || undefined);
    else if (kind === "agent") flow = addAgentNode(flow, text, toolFor(flow, str(item.tool)));
    else if (kind === "verifier") flow = addVerifierNode(flow, CHECKS.has(str(item.check)) ? (str(item.check) as CheckKind) : "custom", text || undefined);
    else if (kind === "approval") flow = addApprovalNode(flow, text || undefined);
    else flow = addEndNode(flow, text || undefined);
    const node = flow.nodes[flow.nodes.length - 1];
    realId.set(key, node.id);
    if (kind === "start") firstStart = node.id;

    if (kind === "agent") {
      flow = updateNode(flow, node.id, {
        need: whole(item.need, 1, 10),
        cost: whole(item.cost, 1, 5) ?? 1,
        delegation: item.delegates === true ? true : undefined,
      });
    }
    if (kind === "start" || kind === "agent") {
      const makes = (Array.isArray(item.makes) ? item.makes : []) as Array<{ label?: unknown; note?: unknown }>;
      let first = true;
      for (const make of makes) {
        let label = clip(str(make?.label), 60);
        if (!label) continue;
        if (labels.has(label.toLowerCase())) label = `${label} (${node.id})`;
        labels.add(label.toLowerCase());
        const port = { label, note: clip(str(make?.note), 140) };
        // A Start is born with one output; the first artifact renames it rather than adding a second.
        flow = kind === "start" && first ? updateOutput(flow, node.id, "o1", port) : addOutput(flow, node.id, port.label, port.note);
        first = false;
      }
    }
    const needs = (Array.isArray(item.needs) ? item.needs : []).map(str).filter(Boolean);
    if (needs.length) wiring.push({ to: node.id, needs });
  }

  for (const { to, needs } of wiring) {
    for (const entry of needs) {
      const [id, ...rest] = entry.split(":");
      const from = realId.get(id.trim());
      if (!from || from === to || !canWire(flow, from, to)) {
        notes.push(`Dropped a link into ${to} that did not make sense (${entry}).`);
        continue;
      }
      const placed = portFor(flow, from, rest.join(":").trim().toLowerCase());
      flow = wire(placed.flow, to, { node: from, port: placed.port });
    }
  }

  if (!firstStart) {
    flow = addStartNode(flow);
    firstStart = flow.nodes[flow.nodes.length - 1].id;
  }
  // Everything has to begin somewhere: a step that waits for nothing waits for the Start.
  for (const node of flow.nodes) {
    // An End is left for the pass below, which connects it to the steps that finish the work.
    if (node.kind === "start" || node.kind === "end" || node.inputs.length > 0 || !canWire(flow, firstStart, node.id)) continue;
    const placed = portFor(flow, firstStart, "");
    flow = wire(placed.flow, node.id, { node: firstStart, port: placed.port });
  }
  if (!flow.nodes.some((n) => n.kind === "end")) flow = addEndNode(flow, "Done");
  for (const end of flow.nodes.filter((n) => n.kind === "end" && n.inputs.length === 0)) {
    for (const leaf of flow.nodes.filter((n) => isLeaf(flow, n))) {
      if (!canWire(flow, leaf.id, end.id)) continue;
      const placed = portFor(flow, leaf.id, "");
      flow = wire(placed.flow, end.id, { node: leaf.id, port: placed.port });
    }
  }
  return { flow: { ...flow, revision: 0, locked: false }, notes };
}

/** Output tokens a node's prompt and readable version are expected to take. */
const WEIGHT: Partial<Record<FlowKind, number>> = { agent: 600, verifier: 240, approval: 150 };

export interface BatchItem {
  id: string;
  kind: FlowKind;
  /** Expected output tokens. */
  weight: number;
  /** Ids of the nodes in this same list that this one waits for. */
  after: string[];
}

/** Whether a step has a prompt to polish: agents and checks do, approvals are done by a person. */
const hasPrompt = (node: FlowNode) => WEIGHT[node.kind] !== undefined && node.kind !== "approval";

/**
 * The steps whose prompts can be polished, each after everything it depends on, so neighbours land in the same
 * request. `only` limits it to some steps (one step's Polish button), otherwise it is every step with a prompt.
 */
export function polishItems(flow: Flow, only?: string[]): BatchItem[] {
  const placed = new Set<string>();
  const order: FlowNode[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of flow.nodes) {
      if (placed.has(node.id) || !dependencies(node).every((id) => placed.has(id))) continue;
      placed.add(node.id);
      order.push(node);
      grew = true;
    }
  }
  const wanted = only ? new Set(only) : null;
  const polishing = order.filter((n) => hasPrompt(n) && (!wanted || wanted.has(n.id)));
  const ids = new Set(polishing.map((n) => n.id));
  return polishing.map((n) => ({
    id: n.id,
    kind: n.kind,
    weight: WEIGHT[n.kind] ?? 0,
    after: dependencies(n).filter((id) => ids.has(id)),
  }));
}

/**
 * Split the nodes into requests. Fewer is better: a request costs one of the day's 500 however
 * little is in it, while its tokens are nearly free. Each group must fit `budget` output tokens
 * or the reply is cut off mid-JSON, and a group that shares a region of the graph (steps that
 * lean on the same artifacts) lets the writer keep their prompts consistent.
 *
 * `items` arrive in an order where every node comes after what it needs.
 */
export function planBatches(items: BatchItem[], budget = BATCH_OUTPUT_TOKENS): string[][] {
  // The fewest requests that respect both limits, then the work split evenly across them: 17
  // nodes become 9 and 8, not 16 and a request for one. Even requests also each stay well under
  // the budget, so none is the one that gets cut off. Items come in dependency order, so
  // neighbours in the list are steps that sit side by side or one after another in the graph, and
  // cutting the list in order keeps those regions together.
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const count = Math.max(1, Math.ceil(total / budget), Math.ceil(items.length / MAX_PER_BATCH));
  const target = total / count;

  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const item of items) {
    const over = used + item.weight > budget || current.length >= MAX_PER_BATCH;
    // Close once taking this item would put the batch more than half an item past its even share,
    // except in the last batch, which takes whatever is left.
    const evenShare = batches.length < count - 1 && used + item.weight / 2 > target;
    if (current.length > 0 && (over || evenShare)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item.id);
    used += item.weight;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The graph as one line per node, with what each needs and makes, for every batch to read. */
export function describeGraph(flow: Flow): string {
  const toolName = new Map(flow.tools.map((t) => [t.id, t.name]));
  return flow.nodes
    .map((node) => {
      const tool = node.toolId ? toolName.get(node.toolId) : undefined;
      const model = tool && node.need !== undefined ? ` need ${node.need}` : "";
      const needs = node.inputs.map((ref) => {
        const port = flow.nodes.find((n) => n.id === ref.node)?.outputs.find((p) => p.id === ref.port);
        return `${ref.node}:${port?.label ?? ref.port}`;
      });
      const makes = node.outputs.map((p) => (p.note ? `${p.label} (${p.note})` : p.label));
      return `${node.id} [${node.kind}${tool ? ` · ${tool}` : ""}${model}${node.delegation ? " · delegates to subagents" : ""}] ${node.text}${
        needs.length ? ` | needs: ${needs.join(", ")}` : ""
      }${makes.length ? ` | makes: ${makes.join("; ")}` : ""}`;
    })
    .join("\n");
}

const POLISH_SYSTEM = `You polish two texts for each requested step of a workflow: its prompt and its readable text. A person will paste each prompt, unchanged, into the coding tool named on its node. Each prompt was filled in from a template and may have been edited by the person; you are given its current text. You also get the whole graph, so a prompt can name the artifacts it relies on and the ones it must leave behind.

The readable text is the plain-language description of the step that a person reads in the written plan. Reword it to be short and clear: one to three sentences, at most 80 words, no markdown headings, no lists unless it already has them. Keep every fact, name and artifact label, add nothing new, and never mention Soren. If it is already clear, return it unchanged. If a step shows no readable text, return an empty string for it.

For every requested node return the same prompt, better written:
- Keep every fact, artifact label, check, name and {placeholder} (a word in curly braces) exactly as it is. Do not invent requirements, steps or files, and do not do a neighbour's job.
- Make it work with nothing else in front of it: the goal in a line, what already exists, the work in concrete steps, what must exist when it is done, and how to tell it worked. Where the current text already says these, tighten the wording instead of adding.
- Write for the node's model: more explicit, smaller steps when its "need" is high relative to the model, less hand-holding when it is low.
- Keep paragraphs separated by a blank line, and keep the order of the paragraphs. Never mention Soren. At most 300 words.
- If a prompt is already good, return it unchanged.

Reply with one JSON object and nothing else, covering exactly the requested ids:
{"nodes":[{"id":"n3","prompt":"...","readable":"..."}]}`;

/** What a step has to be polished: its prompt text, and the plain-language text the written plan shows for it. */
export interface PolishSource {
  prompt: string;
  readable: string;
}

/** What the model returned for a step. An empty field means it offered nothing for that text. */
export interface PolishedText {
  prompt: string;
  readable: string;
}

export function buildPolishPrompt(flow: Flow, ids: string[], context: string, current: Map<string, PolishSource>): { system: string; prompt: string } {
  const texts = ids
    .map((id) => `--- ${id}\nPROMPT:\n${current.get(id)?.prompt ?? ""}\n\nREADABLE TEXT:\n${current.get(id)?.readable ?? ""}`)
    .join("\n\n");
  return {
    system: POLISH_SYSTEM,
    prompt: `The person's tools and their limits:\n${describeTools(flow)}\n\n${context}\n\nThe whole workflow "${flow.title}":\n${describeGraph(flow)}\n\nThe current texts to polish:\n\n${texts}\n\nPolish the prompts for these nodes only: ${ids.join(", ")}`,
  };
}

/** The polished prompt and readable text of each requested node the reply covered. */
export function parsePolish(raw: string, ids: string[]): Map<string, PolishedText> {
  const data = extractJson(raw) as { nodes?: unknown };
  if (!Array.isArray(data.nodes)) throw new ReplyError("The reply has no nodes list.");
  const wanted = new Set(ids);
  const out = new Map<string, PolishedText>();
  for (const entry of data.nodes as Array<{ id?: unknown; prompt?: unknown; readable?: unknown }>) {
    const id = str(entry?.id);
    if (!wanted.has(id) || out.has(id)) continue;
    const prompt = clip(str(entry.prompt), 8_000);
    const readable = clip(str(entry.readable), 1_500);
    if (prompt || readable) out.set(id, { prompt, readable });
  }
  return out;
}

/**
 * Polish one batch. A reply that could not be read is tried again as two halves, and nodes the reply left out are asked
 * for once more, each at most once, so a bad batch costs a bounded number of requests and cannot spend the day.
 */
async function polishBatch(
  flow: Flow,
  ids: string[],
  context: string,
  current: Map<string, PolishSource>,
  complete: Complete,
  count: { requests: number },
  retried = false,
): Promise<{ polished: Map<string, PolishedText>; notes: string[] }> {
  const { system, prompt } = buildPolishPrompt(flow, ids, context, current);
  count.requests += 1;
  let polished: Map<string, PolishedText>;
  try {
    polished = parsePolish(await complete(system, prompt, BATCH_MAX_TOKENS), ids);
  } catch (cause) {
    if (cause instanceof ReplyError && ids.length > 1 && !retried) {
      const half = Math.ceil(ids.length / 2);
      const parts = await Promise.all([
        polishBatch(flow, ids.slice(0, half), context, current, complete, count, true),
        polishBatch(flow, ids.slice(half), context, current, complete, count, true),
      ]);
      return { polished: new Map(parts.flatMap((p) => [...p.polished])), notes: parts.flatMap((p) => p.notes) };
    }
    return { polished: new Map(), notes: [`Could not polish ${ids.length} step${ids.length === 1 ? "" : "s"} (${cause instanceof Error ? cause.message : "unknown error"}).`] };
  }
  const missing = ids.filter((id) => !polished.has(id));
  if (missing.length > 0 && !retried) {
    const more = await polishBatch(flow, missing, context, current, complete, count, true);
    for (const [id, texts] of more.polished) polished.set(id, texts);
    return { polished, notes: more.notes };
  }
  return { polished, notes: [] };
}

/** The complete node objects in a reply that was cut off before its JSON closed. */
function salvageNodes(raw: string): unknown[] {
  const at = raw.search(/"nodes"\s*:\s*\[/);
  if (at < 0) return [];
  const out: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let from = -1;
  for (let i = raw.indexOf("[", at); i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      if (ch === "{" && depth === 1) from = i;
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (ch === "}" && depth === 1 && from >= 0) {
        try {
          out.push(JSON.parse(raw.slice(from, i + 1)));
        } catch {
          // A malformed node is skipped; the ones around it are still good.
        }
        from = -1;
      }
      if (depth === 0) break;
    }
  }
  return out;
}

/** A section's nodes from its reply. A reply cut off at the token limit keeps the nodes it finished. */
function readSection(raw: string): { nodes: RawNode[]; cut: boolean } {
  try {
    const data = extractJson(raw) as { nodes?: unknown };
    if (Array.isArray(data.nodes)) return { nodes: data.nodes as RawNode[], cut: false };
  } catch (cause) {
    const nodes = salvageNodes(raw) as RawNode[];
    if (nodes.length > 0) return { nodes, cut: true };
    throw cause;
  }
  throw new ReplyError("The reply has no nodes in it.");
}

/** The first call: how big the workflow is, split into sections, each with the brief its writer is given. A reply that cannot be read is asked for once more. */
async function askOutline(request: PlanRequest, skeleton: Flow, complete: Complete, count: { requests: number }): Promise<Outline> {
  const { system, prompt } = buildOutlinePrompt(request, skeleton);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    count.requests += 1;
    try {
      return parseOutline(await complete(system, attempt === 0 ? prompt : `${prompt}\n\nYour last reply could not be used: ${lastError}`, OUTLINE_MAX_TOKENS));
    } catch (cause) {
      if (!(cause instanceof ReplyError) || attempt === 1) throw cause;
      lastError = cause.message;
    }
  }
  throw new ReplyError("The workflow could not be planned.");
}

/** One section's nodes. Tried once more if nothing usable came back; a section that still fails is left out with a note rather than sinking the rest. */
async function writeSection(
  request: PlanRequest,
  skeleton: Flow,
  outline: Outline,
  section: Section,
  complete: Complete,
  count: { requests: number },
): Promise<{ section: Section; nodes: RawNode[]; notes: string[] }> {
  const { system, prompt } = buildSectionPrompt(request, skeleton, outline, section);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    count.requests += 1;
    try {
      const { nodes, cut } = readSection(
        await complete(system, attempt === 0 ? prompt : `${prompt}\n\nYour last reply could not be used: ${lastError} Keep the steps shorter.`, SECTION_MAX_TOKENS),
      );
      return { section, nodes, notes: cut ? [`${section.name} was cut off, so it stops after ${nodes.length} steps.`] : [] };
    } catch (cause) {
      if (!(cause instanceof ReplyError)) {
        // A failed request (the day's allowance, the network) is not a bad reply, and asking again would only spend more.
        return { section, nodes: [], notes: [`${section.name} could not be written (${cause instanceof Error ? cause.message : "unknown error"}).`] };
      }
      lastError = cause.message;
    }
  }
  return { section, nodes: [], notes: [`${section.name} could not be written (${lastError}).`] };
}

const START_LABEL = "Starting point";

/**
 * The sections as one list of nodes for `parseGraph`. Ids are scoped by section so the writers
 * cannot collide, and an `in:Label` need is pointed at whichever node makes that artifact. The
 * Start is added here, since no section draws it.
 */
export function mergeSections(outline: Outline, results: Array<{ section: Section; nodes: RawNode[] }>): { nodes: RawNode[]; notes: string[] } {
  const notes: string[] = [];
  const nodes: RawNode[] = [{ id: "start", kind: "start", text: outline.start, makes: [{ label: START_LABEL, note: "" }] }];
  const scoped = results.map(({ section, nodes: raw }) => ({
    section,
    raw: raw.filter((n) => str(n?.id) && str(n?.kind) !== "start" && str(n?.kind) !== "end"),
  }));

  const owner = new Map<string, string>([[START_LABEL.toLowerCase(), "start"]]);
  for (const { section, raw } of scoped) {
    for (const node of raw) {
      for (const make of (Array.isArray(node.makes) ? node.makes : []) as Array<{ label?: unknown }>) {
        const label = str(make?.label).toLowerCase();
        if (label && !owner.has(label)) owner.set(label, `${section.id}_${str(node.id)}`);
      }
    }
  }

  for (const { section, raw } of scoped) {
    for (const node of raw) {
      const needs: string[] = [];
      for (const entry of (Array.isArray(node.needs) ? node.needs : []).map(str).filter(Boolean)) {
        if (!/^in:/i.test(entry)) {
          needs.push(`${section.id}_${entry}`);
          continue;
        }
        const label = entry.slice(3).trim();
        const from = owner.get(label.toLowerCase());
        if (from) needs.push(`${from}:${label}`);
        else notes.push(`A step in ${section.name} relied on “${label}”, which no section makes.`);
      }
      nodes.push({ ...node, id: `${section.id}_${str(node.id)}`, needs });
    }
  }
  return { nodes, notes };
}

/**
 * The first half of the job, and all that the Workflow button does. Two kinds of request: one
 * planner call decides how many steps the work needs and, in the same reply, writes the brief
 * for each section; then one call per section, all at once, draws that section's steps from its
 * brief. The sections are merged into one graph. The flow comes back unlocked, with no written prompts
 * (each step's prompt is filled in by the template), and carries the conversation it was drawn from as
 * background for the prompts and for polishing them later.
 */
export async function generateGraph(
  request: PlanRequest,
  complete: Complete,
  now = Date.now(),
  onProgress: (progress: Progress) => void = () => {},
): Promise<Generated> {
  const skeleton = skeletonFlow(request.tools, now);
  const count = { requests: 0 };
  onProgress({ stage: "graph", batches: 0, batchesDone: 0, nodes: 0, nodesDone: 0 });
  const outline = await askOutline(request, skeleton, complete, count);

  const expected = outline.sections.reduce((sum, s) => sum + s.nodes, 0);
  let done = 0;
  onProgress({ stage: "graph", batches: outline.sections.length, batchesDone: done, nodes: expected, nodesDone: 0 });
  const results = await Promise.all(
    outline.sections.map(async (section) => {
      const result = await writeSection(request, skeleton, outline, section, complete, count);
      done += 1;
      onProgress({ stage: "graph", batches: outline.sections.length, batchesDone: done, nodes: expected, nodesDone: 0 });
      return result;
    }),
  );
  const written = results.filter((r) => r.nodes.length > 0);
  if (written.length === 0) throw new ReplyError(results[0]?.notes[0] ?? "None of the sections could be written.");

  const merged = mergeSections(outline, written);
  const parsed = parseGraph(JSON.stringify({ title: outline.title, nodes: merged.nodes }), skeleton);
  return {
    flow: { ...parsed.flow, brief: contextText(request) },
    notes: [...outline.notes, ...results.flatMap((r) => r.notes), ...merged.notes, ...parsed.notes],
    requests: count.requests,
  };
}

/** One text the model offers to reword: what it was when asked, and the polished version. */
export interface TextRewrite {
  base: string;
  text: string;
}

/**
 * What the model offers for one step: a new prompt, a new readable text, or both. A field the model left as it was is
 * absent, so a step is only here when at least one text has something to look over. Nothing is applied.
 */
export interface Rewrite {
  prompt?: TextRewrite;
  readable?: TextRewrite;
}

export interface Polished {
  rewrites: Map<string, Rewrite>;
  notes: string[];
  requests: number;
  /** Steps the model did not answer for, for a second try. */
  missing: string[];
}

/**
 * Ask the cloud model to polish prompts the template wrote (and the person may have edited) and the readable text of
 * the same steps. `texts` holds each step's current prompt and readable text; only those steps are sent, in as few large
 * requests as fit, all at once, and each request covers both texts. What comes back is a list of rewrites to look over,
 * never a change: a text identical to what it was is dropped, field by field.
 */
export async function polishPlans(
  flow: Flow,
  texts: Map<string, PolishSource>,
  complete: Complete,
  onProgress: (progress: Progress) => void = () => {},
): Promise<Polished> {
  const context = flow.brief ?? "";
  const count = { requests: 0 };
  const batches = planBatches(polishItems(flow, [...texts.keys()]));
  const total = batches.reduce((sum, ids) => sum + ids.length, 0);
  let batchesDone = 0;
  let nodesDone = 0;
  onProgress({ stage: "plans", batches: batches.length, batchesDone, nodes: total, nodesDone });

  const results = await Promise.all(
    batches.map(async (ids) => {
      const result = await polishBatch(flow, ids, context, texts, complete, count);
      batchesDone += 1;
      nodesDone += ids.length;
      onProgress({ stage: "plans", batches: batches.length, batchesDone, nodes: total, nodesDone });
      return result;
    }),
  );
  const rewrites = new Map<string, Rewrite>();
  const notes: string[] = [];
  const answered = new Set<string>();
  for (const result of results) {
    for (const [id, polished] of result.polished) {
      answered.add(id);
      const source = texts.get(id);
      const rewrite: Rewrite = {};
      if (polished.prompt.trim() && polished.prompt.trim() !== (source?.prompt ?? "").trim()) rewrite.prompt = { base: source?.prompt ?? "", text: polished.prompt };
      // With no readable text to start from there is nothing to reword.
      if (source?.readable.trim() && polished.readable.trim() && polished.readable.trim() !== source.readable.trim()) {
        rewrite.readable = { base: source.readable, text: polished.readable };
      }
      if (rewrite.prompt || rewrite.readable) rewrites.set(id, rewrite);
    }
    notes.push(...result.notes);
  }
  const missing = batches.flat().filter((id) => !answered.has(id));
  return { rewrites, notes, requests: count.requests, missing };
}

/** One line for when the polish is in: how many rewrites to look over, what it cost, and what is left over. */
export function describePolish(result: Polished, asked: number): string {
  const spent = `${result.requests} request${result.requests === 1 ? "" : "s"}`;
  const n = result.rewrites.size;
  const unchanged = asked - result.missing.length - n;
  const head =
    n === 0
      ? `Nothing to change: the model left ${asked === 1 ? "the step" : "every step"} as it was (${spent} used).`
      : `${n} polished step${n === 1 ? "" : "s"} to look over${unchanged > 0 ? `, ${unchanged} left as they were` : ""} (${spent} used).`;
  return result.missing.length > 0 ? `${head} ${result.missing.length} did not come back. ${result.notes[0] ?? ""}`.trim() : head;
}
