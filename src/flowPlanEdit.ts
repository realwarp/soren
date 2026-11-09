import {
  addAgentNode,
  addOutput,
  artifactLabel,
  canRemove,
  isWork,
  planOrder,
  removeNode,
  unwire,
  updateNode,
  VERIFIER_PORT,
  wire,
  type Flow,
  type PortRef,
} from "./flowModel";
import { freeSlot } from "./flowLayout";

/**
 * Edits made in the Plan tab, mapped onto the graph by plain code. The tab reads the plan in order, so a step's heading is
 * its `text`, its body is the `readable` text (falling back to `text` when none is written), and moving a step means
 * changing what it waits for. Only simple chains are reordered; anything else is left to the canvas.
 */

/** The step a node waits on is read through this wire: its first output, made if it has none (a check uses its pass port). */
function outputRef(flow: Flow, id: string): { flow: Flow; ref: PortRef } {
  const node = flow.nodes.find((n) => n.id === id)!;
  if (node.kind === "verifier") return { flow, ref: { node: id, port: VERIFIER_PORT } };
  let next = flow;
  if (node.outputs.length === 0) next = addOutput(next, id, artifactLabel(node));
  return { flow: next, ref: { node: id, port: next.nodes.find((n) => n.id === id)!.outputs[0].id } };
}

const sameRef = (a: PortRef, b: PortRef) => a.node === b.node && a.port === b.port;
const dedupe = (refs: PortRef[]) => refs.filter((r, i) => refs.findIndex((o) => sameRef(o, r)) === i);

/** Nodes (of any kind) that wait on this one. */
const consumers = (flow: Flow, id: string) => flow.nodes.filter((n) => n.inputs.some((r) => r.node === id));

/** The heading is the step's own text. A check shows its check label instead, so its heading is set on the canvas. */
export function renameStep(flow: Flow, id: string, text: string): Flow {
  const node = flow.nodes.find((n) => n.id === id);
  const clean = text.replace(/\s+/g, " ").trim();
  if (!node || !isWork(node) || !clean || clean === node.text) return flow;
  return updateNode(flow, id, { text: clean });
}

/** Whether a step's heading can be edited here: a check's heading is its check label, which the canvas owns. */
export const headingEditable = (flow: Flow, id: string) => {
  const node = flow.nodes.find((n) => n.id === id);
  return Boolean(node && isWork(node) && !(node.kind === "verifier" && node.check));
};

/** The body is the written description. Emptying it goes back to showing the step's text. */
export function setStepBody(flow: Flow, id: string, body: string): Flow {
  const node = flow.nodes.find((n) => n.id === id);
  if (!node || !isWork(node)) return flow;
  const clean = body.trim();
  if (clean === (node.readable?.trim() || node.text)) return flow;
  return updateNode(flow, id, { readable: clean || undefined });
}

/** Take a step out. What waited for it waits for whatever it waited for, so the chain stays joined. */
export function removeStep(flow: Flow, id: string): Flow {
  const node = flow.nodes.find((n) => n.id === id);
  if (!node || !isWork(node) || !canRemove(flow, id)) return flow;
  const next = {
    ...flow,
    nodes: flow.nodes.map((n) => {
      if (!n.inputs.some((r) => r.node === id)) return n;
      const inputs = dedupe(n.inputs.flatMap((r) => (r.node === id ? node.inputs.map(({ node: from, port }) => ({ node: from, port })) : [r])));
      return { ...n, inputs: n.kind === "start" ? [] : inputs };
    }),
  };
  return removeNode(next, id);
}

/**
 * A new step at the end of the plan. It waits for the steps nothing else waits for, and whatever finished the workflow
 * (an End) now waits for it instead.
 */
export function addStepAtEnd(flow: Flow, text: string): Flow {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return flow;
  const steps = planOrder(flow).map((s) => s.node);
  const leaves = steps.filter((s) => !consumers(flow, s.id).some(isWork));
  const before = new Set(flow.nodes.map((n) => n.id));
  const toolId = [...steps].reverse().find((s) => s.toolId)?.toolId ?? flow.tools[0]?.id;
  let next = addAgentNode(flow, clean, toolId);
  const made = next.nodes.find((n) => !before.has(n.id))!;
  const parents = leaves.length > 0 ? leaves.map((l) => l.id) : flow.nodes.filter((n) => n.kind === "start").map((n) => n.id);
  for (const parent of parents) {
    const out = outputRef(next, parent);
    next = wire(out.flow, made.id, out.ref);
  }
  // Whatever closed the workflow follows the new step now.
  const mine = outputRef(next, made.id);
  next = mine.flow;
  for (const end of flow.nodes.filter((n) => n.kind === "end" && n.inputs.some((r) => parents.includes(r.node)))) {
    for (const r of end.inputs.filter((r) => parents.includes(r.node))) next = unwire(next, end.id, r);
    next = wire(next, end.id, mine.ref);
  }
  const taken = next.nodes.filter((n) => n.id !== made.id && n.pos).map((n) => n.pos!);
  const lowest = parents.map((p) => next.nodes.find((n) => n.id === p)?.pos).filter((p): p is { x: number; y: number } => Boolean(p));
  const anchor = lowest.sort((a, b) => b.y - a.y)[0];
  const pos = anchor ? { x: anchor.x, y: anchor.y + 160 } : freeSlot(taken);
  return { ...next, nodes: next.nodes.map((n) => (n.id === made.id ? { ...n, pos: taken.some((t) => Math.abs(t.x - pos.x) < 200 && Math.abs(t.y - pos.y) < 120) ? freeSlot(taken) : pos } : n)) };
}

export type MoveResult = { flow: Flow; note: string | null };

const NEEDS_CANVAS = "That move needs the canvas: these steps are not in a simple chain.";

/**
 * Move a step one place up or down the plan. Only swaps two neighbours in a plain chain (the earlier one is waited on by the
 * later one alone, and the later one waits on no other step): the later takes the earlier's place, so what the earlier
 * waited for it now waits for, and what waited for the later now waits for the earlier. Anything else is not guessed at.
 */
export function moveStep(flow: Flow, id: string, dir: -1 | 1): MoveResult {
  const order = planOrder(flow).map((s) => s.node);
  const at = order.findIndex((n) => n.id === id);
  const other = order[at + dir];
  if (at < 0 || !other) return { flow, note: null };
  const [a, b] = dir === -1 ? [other, order[at]] : [order[at], other];
  const workIds = new Set(order.map((n) => n.id));
  const chain =
    consumers(flow, a.id).length === 1 &&
    consumers(flow, a.id)[0].id === b.id &&
    b.inputs.filter((r) => workIds.has(r.node)).every((r) => r.node === a.id) &&
    a.inputs.every((r) => !consumers(flow, b.id).some((c) => c.id === r.node));
  if (!chain) return { flow, note: NEEDS_CANVAS };

  const refB = outputRef(flow, b.id);
  const refA = outputRef(refB.flow, a.id);
  let next = refA.flow;
  const aIn = a.inputs.map(({ node, port }) => ({ node, port }));
  const bOther = b.inputs.filter((r) => r.node !== a.id).map(({ node, port }) => ({ node, port }));
  next = {
    ...next,
    revision: next.revision + 1,
    locked: false,
    updatedAt: Date.now(),
    nodes: next.nodes.map((n) => {
      if (n.id === b.id) return { ...n, inputs: dedupe([...aIn, ...bOther]), pos: a.pos };
      if (n.id === a.id) return { ...n, inputs: [refB.ref], pos: b.pos };
      if (n.inputs.some((r) => r.node === b.id)) return { ...n, inputs: dedupe(n.inputs.map((r) => (r.node === b.id ? { node: a.id, port: refA.ref.port } : r))) };
      return n;
    }),
  };
  return { flow: next, note: null };
}
