import {
  addAgentNode,
  addEndNode,
  addStartNode,
  addOutput,
  addTool,
  addVerifierNode,
  newFlow,
  updateNode,
  VERIFIER_PORT,
  wire,
  type Flow,
} from "./flowModel";
import { presetToTool, TOOL_PRESETS } from "./flowTools";

/**
 * Flows live in the webview's local storage for now. Everything goes through
 * these two functions so that moving them into the Rust side later is a change
 * to this file only.
 */
const KEY = "soren.flows.v1";

function looksLikeFlow(value: unknown): value is Flow {
  const flow = value as Partial<Flow> | null;
  return Boolean(
    flow &&
      typeof flow.id === "string" &&
      Array.isArray(flow.nodes) &&
      Array.isArray(flow.tools),
  );
}

export function loadFlows(): Flow[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(looksLikeFlow).map((flow) => ({
          ...flow,
          // Tools saved before models existed get an empty list.
          tools: flow.tools.map((tool) => ({ ...tool, models: tool.models ?? [], plans: tool.plans ?? [] })),
        }))
      : [];
  } catch {
    return [];
  }
}

export function saveFlows(flows: Flow[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(flows));
  } catch {
    // Storage can be blocked or full; the session still works in memory.
  }
}

/** Sent on `window` with the flow as `detail`, for a Studio that is open when a flow is added from outside it. */
export const FLOW_ADDED = "soren:flow-added";

/**
 * Add a flow written outside the Studio. It goes into storage for a Studio that opens later, and
 * is announced for one that is open now, which would otherwise save over it with its own list.
 */
export function addFlow(flow: Flow): void {
  saveFlows([...loadFlows().filter((f) => f.id !== flow.id), flow]);
  window.dispatchEvent(new CustomEvent<Flow>(FLOW_ADDED, { detail: flow }));
}

/** Sent on `window` with the new version of a flow the Studio has open, as an undoable edit. */
export const FLOW_REPLACED = "soren:flow-replaced";

/** Put an edited version of a flow in place: the open Studio records it for undo, storage gets it either way. */
export function replaceFlow(flow: Flow): void {
  // The canvas holds an agent proposal for this workflow: an edit now would be written over when it is applied.
  if (proposalWaitingFor(flow.id)) return;
  saveFlows(loadFlows().map((f) => (f.id === flow.id ? flow : f)));
  window.dispatchEvent(new CustomEvent<Flow>(FLOW_REPLACED, { detail: flow }));
}

/** A small worked example so the canvas is not empty on first open. */
export function exampleFlow(now = Date.now()): Flow {
  const preset = (name: string) => TOOL_PRESETS.find((p) => p.name === name)!;
  let flow = newFlow("Todo app with accounts", now);
  flow = addTool(flow, presetToTool(preset("Claude Code"), now));
  flow = addTool(flow, presetToTool(preset("Codex"), now));
  flow = addAgentNode(flow, "Design the database schema for users and todos", "tool1");
  flow = addOutput(flow, "n1", "DB schema", "tables, keys and indexes");
  flow = addAgentNode(flow, "Build the REST API on that schema", "tool1");
  flow = addOutput(flow, "n2", "API contract", "routes and request shapes");
  flow = addAgentNode(flow, "Build the sign-in screen", "tool2");
  flow = addOutput(flow, "n3", "Sign-in UI", "form, validation and error states");
  flow = addVerifierNode(flow, "tests", "API tests pass");
  flow = addAgentNode(flow, "Connect the screens to the API", "tool1");
  flow = addOutput(flow, "n5", "Working app", "sign in and manage todos end to end");
  flow = addVerifierNode(flow, "build");
  flow = addAgentNode(flow, "Write the release notes", "tool1");
  flow = wire(flow, "n2", { node: "n1", port: "o1" });
  flow = wire(flow, "n4", { node: "n2", port: "o1" });
  flow = wire(flow, "n5", { node: "n2", port: "o1" });
  flow = wire(flow, "n5", { node: "n3", port: "o1" });
  flow = wire(flow, "n5", { node: "n4", port: VERIFIER_PORT });
  flow = wire(flow, "n6", { node: "n5", port: "o1" });
  flow = wire(flow, "n7", { node: "n6", port: VERIFIER_PORT });
  flow = updateNode(flow, "n5", { cost: 3 });
  // Every workflow begins at a Start, and this one finishes at an End.
  flow = addStartNode(flow, "The idea and any starting code");
  flow = wire(flow, "n1", { node: "n8", port: "o1" });
  flow = wire(flow, "n3", { node: "n8", port: "o1" });
  flow = addOutput(flow, "n7", "Release notes", "what changed and why");
  flow = addEndNode(flow, "Shipped");
  flow = wire(flow, "n9", { node: "n7", port: "o1" });
  for (const [id, need] of [["n1", 6], ["n2", 6], ["n3", 4], ["n5", 7], ["n7", 2]] as const) {
    flow = updateNode(flow, id, { need });
  }
  return { ...flow, revision: 0, locked: false };
}

/**
 * The workflows that have an agent proposal waiting on their canvas. While one waits, the canvas refuses edits, and the
 * Plan pane (which lives outside the canvas) must refuse them too, or Apply would write over them.
 */
const waiting = new Set<string>();
const gateListeners = new Set<() => void>();

export function setProposalWaiting(flowId: string, on: boolean): void {
  if (waiting.has(flowId) === on) return;
  if (on) waiting.add(flowId);
  else waiting.delete(flowId);
  gateListeners.forEach((listener) => listener());
}

export function proposalWaitingFor(flowId: string): boolean {
  return waiting.has(flowId);
}

export function subscribeProposalGate(listener: () => void): () => void {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
}
