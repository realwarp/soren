import {
  addAgentNode,
  addApprovalNode,
  addEndNode,
  addOutput,
  addVerifierNode,
  artifactLabel,
  canRemove,
  canWire,
  removeNode,
  unwire,
  updateNode,
  wire,
  type Flow,
} from "./flowModel";
import { describeGraph, extractJson, type Complete } from "./flowCloud";
import { freeSlot, GRID, NODE_H, NODE_W, snap } from "./flowLayout";

const EDIT_SYSTEM = `You edit a workflow graph. Steps wait for the steps they need; the graph has no cycles.
You get the graph, one line per step (id [kind · tool] text | needs | makes), and one change to make.

Deleting or clearing the whole workflow means removing every step except the Start step, which cannot be removed. "Change everything" or "start over" means removing or rewording every existing step so nothing stays as it was, and adding the steps the new version needs. Always send at least one operation when asked to change something.

Small changes (reword a step, remove one, rewire two) are made as asked and nothing else.
A goal, such as "build a harness for X" or "make a productivity app", is NOT one step. Break it into the steps it really takes: concrete steps with one job each, usually 8 to 20 for a real piece of software, in the order they must happen. Steps that do not depend on each other wait for the same earlier step and so run side by side. A step with nothing before it waits for the Start step. Finish with a verifier step that checks the result and an end step. Never answer a goal with a single step.
Each step's text says what is done and what must exist afterwards, in one or two plain lines. Give each step a short "makes" label for what it leaves behind, so the next step can wait for it.

Reply with one JSON object and nothing else:
{"summary":"one short line saying what changed","ops":[...]}
Operations, applied in order:
{"op":"add","ref":"new1","kind":"agent","text":"what the step does, one or two lines","tool":"tool name or empty","after":["n2"],"makes":"what it leaves behind, a short label"}
  kind is agent, verifier, approval or end. "after" lists ids (or earlier refs) it waits for.
{"op":"edit","id":"n3","text":"new text"}
{"op":"remove","id":"n4"}
{"op":"connect","from":"n1","to":"n3"}   (n3 waits for n1)
{"op":"disconnect","from":"n1","to":"n3"}
When a step is inserted between two steps, connect it to both and disconnect the old link.`;

interface RawOp {
  op?: unknown;
  ref?: unknown;
  id?: unknown;
  kind?: unknown;
  text?: unknown;
  tool?: unknown;
  after?: unknown;
  makes?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface FlowEdit {
  flow: Flow;
  summary: string;
  /** One plain line per operation that was made, for the person to read before accepting. */
  changes: string[];
  /** Per change, the step it touched (a removed step has none), so a note can be joined to it. Same order as `changes`. */
  touched: Array<string | null>;
  /** Operations the editor sent that could not be made (a missing step, a cycle). */
  skipped: string[];
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Wire `to` to wait for `from`, giving `from` an output first when it makes nothing yet. */
function connect(flow: Flow, from: string, to: string): Flow | null {
  if (!canWire(flow, from, to)) return null;
  let next = flow;
  let source = next.nodes.find((n) => n.id === from)!;
  if (source.outputs.length === 0) {
    next = addOutput(next, from, artifactLabel(source));
    source = next.nodes.find((n) => n.id === from)!;
  }
  return wire(next, to, { node: from, port: source.outputs[0].id });
}

/** Apply the editor's operations to the flow. Bad operations are skipped and listed, not fatal. */
export function applyOps(flow: Flow, ops: RawOp[]): Omit<FlowEdit, "summary"> {
  let next = flow;
  const refs = new Map<string, string>();
  const changes: string[] = [];
  const touched: Array<string | null> = [];
  const skipped: string[] = [];
  const resolve = (value: unknown) => {
    const key = str(value);
    return refs.get(key) ?? key;
  };
  const name = (id: string) => `"${next.nodes.find((n) => n.id === id)?.text || id}"`;

  for (const op of ops) {
    const kind = str(op.op);
    if (kind === "add") {
      const text = str(op.text);
      if (!text) {
        skipped.push("a new step with no text");
        continue;
      }
      const toolName = str(op.tool).toLowerCase();
      const tool = toolName ? next.tools.find((t) => t.name.toLowerCase() === toolName) : undefined;
      const stepKind = str(op.kind);
      const before = new Set(next.nodes.map((n) => n.id));
      next =
        stepKind === "approval"
          ? addApprovalNode(next, text)
          : stepKind === "end"
            ? addEndNode(next, text)
            : stepKind === "verifier"
              ? addVerifierNode(next, "custom", text)
              : addAgentNode(next, text, tool?.id);
      const made = next.nodes.find((n) => !before.has(n.id))!;
      if (str(op.ref)) refs.set(str(op.ref), made.id);
      const makes = str(op.makes);
      if (makes && made.kind === "agent") next = addOutput(next, made.id, makes);
      const parents = (Array.isArray(op.after) ? op.after : []).map(resolve);
      for (const parent of parents) {
        const wired = connect(next, parent, made.id);
        if (wired) next = wired;
        else skipped.push(`waiting on ${parent} for ${JSON.stringify(text)}`);
      }
      // Beside its first parent when it has one, otherwise in the first free spot.
      const anchor = next.nodes.find((n) => n.id === parents[0])?.pos;
      const taken = next.nodes.filter((n) => n.pos && n.id !== made.id).map((n) => n.pos!);
      let pos = anchor ? { x: snap(anchor.x + NODE_W + GRID * 4), y: anchor.y } : freeSlot(taken);
      while (anchor && taken.some((t) => Math.abs(t.x - pos.x) < NODE_W && Math.abs(t.y - pos.y) < NODE_H)) {
        pos = { x: pos.x, y: snap(pos.y + NODE_H + GRID * 2) };
      }
      next = { ...next, nodes: next.nodes.map((n) => (n.id === made.id ? { ...n, pos } : n)) };
      changes.push(`Added ${JSON.stringify(text.replace(/\s+/g, " "))}`);
      touched.push(made.id);
    } else if (kind === "edit") {
      const id = resolve(op.id);
      const text = str(op.text);
      if (!next.nodes.some((n) => n.id === id) || !text) {
        skipped.push(`rewording ${id || "a step"}`);
        continue;
      }
      changes.push(`Reworded ${name(id)} to ${JSON.stringify(text.replace(/\s+/g, " "))}`);
      touched.push(id);
      next = updateNode(next, id, { text });
    } else if (kind === "remove") {
      const id = resolve(op.id);
      if (!canRemove(next, id)) {
        skipped.push(`removing ${id || "a step"}`);
        continue;
      }
      changes.push(`Removed ${name(id)}`);
      touched.push(null);
      next = removeNode(next, id);
    } else if (kind === "connect") {
      const from = resolve(op.from);
      const to = resolve(op.to);
      const wired = next.nodes.some((n) => n.id === to) ? connect(next, from, to) : null;
      if (!wired) {
        skipped.push(`connecting ${from} to ${to}`);
        continue;
      }
      changes.push(`${name(to)} now waits for ${name(from)}`);
      touched.push(to);
      next = wired;
    } else if (kind === "disconnect") {
      const from = resolve(op.from);
      const to = resolve(op.to);
      const target = next.nodes.find((n) => n.id === to);
      const refsFrom = target?.inputs.filter((r) => r.node === from) ?? [];
      if (refsFrom.length === 0) {
        skipped.push(`disconnecting ${from} from ${to}`);
        continue;
      }
      changes.push(`${name(to)} no longer waits for ${name(from)}`);
      touched.push(to);
      for (const ref of refsFrom) next = unwire(next, to, ref);
    } else {
      skipped.push(`an unknown operation "${kind}"`);
    }
  }
  return { flow: next, changes, touched, skipped };
}

/** Ask the cloud model to make one change to the flow. Throws when its reply cannot be read. */
export async function editFlow(complete: Complete, flow: Flow, instruction: string): Promise<FlowEdit> {
  const tools = flow.tools.map((t) => t.name).join(", ");
  const prompt = [
    `Workflow: ${flow.title || "untitled"}`,
    tools ? `Tools: ${tools}` : "",
    "Graph:",
    describeGraph(flow) || "(empty)",
    "",
    `The change: ${instruction}`,
  ]
    .filter((line, i) => line !== "" || i > 0)
    .join("\n");
  const raw = await complete(EDIT_SYSTEM, prompt, 12000);
  const parsed = extractJson(raw) as { summary?: unknown; ops?: unknown };
  const ops = Array.isArray(parsed.ops) ? (parsed.ops as RawOp[]) : [];
  if (ops.length === 0) throw new Error("The editor sent back no changes.");
  const result = applyOps(flow, ops);
  if (result.changes.length === 0) throw new Error("None of the editor's changes fit this workflow.");
  return { ...result, summary: str(parsed.summary) || instruction };
}
