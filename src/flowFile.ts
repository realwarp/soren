import type { Flow, FlowKind, FlowNode } from "./flowModel";

/** What a workflow file says it is, so a stray JSON file is not mistaken for one. */
const FILE_TYPE = "soren-workflow";
const FILE_VERSION = 1;

const KINDS: FlowKind[] = ["agent", "verifier", "approval", "wait", "start", "end"];

/** A workflow as text for a file or the clipboard. Progress (done marks and pasted output) travels with it. */
export function exportFlow(flow: Flow): string {
  return JSON.stringify({ type: FILE_TYPE, version: FILE_VERSION, flow }, null, 2);
}

/** A file name for the workflow, safe on every system. */
export function exportName(flow: Flow): string {
  const slug = (flow.title || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "workflow"}.soren.json`;
}

function fail(message: string): never {
  throw new Error(message);
}

function checkNode(raw: unknown, index: number): FlowNode {
  if (typeof raw !== "object" || raw === null) fail(`Step ${index + 1} is not an object.`);
  const n = raw as Partial<FlowNode>;
  if (typeof n.id !== "string" || !n.id) fail(`Step ${index + 1} has no id.`);
  if (!KINDS.includes(n.kind as FlowKind)) fail(`Step ${n.id} has an unknown kind.`);
  return {
    ...(n as FlowNode),
    text: typeof n.text === "string" ? n.text : "",
    cost: typeof n.cost === "number" ? n.cost : 1,
    inputs: Array.isArray(n.inputs) ? n.inputs : [],
    outputs: Array.isArray(n.outputs) ? n.outputs : [],
  };
}

/**
 * Read a workflow back from text. It becomes a new workflow with its own id, so importing a copy never
 * overwrites the one it came from. Throws an Error whose message can be shown as it is.
 */
export function parseFlowFile(text: string, now = Date.now()): Flow {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    fail("That is not a workflow file: it is not valid JSON.");
  }
  const root = data as { type?: string; flow?: Partial<Flow> };
  if (!root || root.type !== FILE_TYPE || !root.flow) fail("That file is not a Soren workflow.");
  const f = root.flow as Partial<Flow>;
  if (!Array.isArray(f.nodes)) fail("The workflow has no steps list.");
  const nodes = f.nodes.map(checkNode);
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) fail("Two steps share one id.");
  return {
    ...(f as Flow),
    id: `flow_${now.toString(36)}`,
    title: typeof f.title === "string" ? f.title : "",
    tools: Array.isArray(f.tools) ? f.tools : [],
    nodes,
    containers: Array.isArray(f.containers) ? f.containers : undefined,
    notes: Array.isArray(f.notes) ? f.notes : undefined,
    noteLinks: Array.isArray(f.noteLinks) ? f.noteLinks : undefined,
    noteStacks: Array.isArray(f.noteStacks) ? f.noteStacks : undefined,
    asks: Array.isArray(f.asks) ? f.asks : undefined,
    locked: Boolean(f.locked),
    revision: typeof f.revision === "number" ? f.revision : 0,
    createdAt: now,
    updatedAt: now,
  };
}
