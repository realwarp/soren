import { autoModel, markDone, type Critic, type Flow, type FlowNode, type ModelEntry } from "./flowModel";

/**
 * The critic loop on one step. A maker (the step's own tool) does the work, a critic (a second prompt, often a
 * cheaper model) reviews it, and the maker revises until the critic approves or the rounds run out. Soren does
 * not call either: the person copies each prompt and pastes back each reply, as with any step.
 */

export const DEFAULT_ROUNDS = 3;

export function newCritic(): Critic {
  return { criteria: "", maxRounds: DEFAULT_ROUNDS, rounds: [] };
}

/**
 * Where the loop stands: the maker's turn, the critic's turn, out of rounds (the person decides), or finished.
 * "make" covers both the first attempt and a revision.
 */
export function criticPhase(node: FlowNode): "make" | "review" | "limit" | "done" {
  const critic = node.critic;
  if (!critic || node.done) return "done";
  const last = critic.rounds[critic.rounds.length - 1];
  if (!last) return "make";
  if (!last.verdict) return "review";
  if (last.verdict === "approve") return "done";
  return critic.rounds.length >= critic.maxRounds ? "limit" : "make";
}

/** The model the critic would use: two ratings below the step's unless set, on its own tool or the step's. */
export function criticModel(flow: Flow, node: FlowNode): ModelEntry | undefined {
  const critic = node.critic;
  if (!critic) return undefined;
  const tool = flow.tools.find((t) => t.id === (critic.toolId ?? node.toolId));
  const need = critic.need ?? Math.max(1, (node.need ?? 5) - 2);
  return autoModel(tool, need);
}

function withCriticOn(flow: Flow, nodeId: string, change: (c: Critic) => Critic, now: number): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === nodeId && n.critic ? { ...n, critic: change(n.critic) } : n)),
    updatedAt: now,
  };
}

/** The maker's attempt came back: it goes to the critic as a new round. */
export function submitMade(flow: Flow, nodeId: string, made: string, now = Date.now()): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node || criticPhase(node) !== "make") return flow;
  return withCriticOn(flow, nodeId, (c) => ({ ...c, rounds: [...c.rounds, { at: now, made: made.trim() }] }), now);
}

/**
 * The critic's verdict on the latest round. Approve finishes the step with that attempt as its result. Revise
 * sends it back, with the reasons, unless that was the last round, when the person decides.
 */
export function submitVerdict(
  flow: Flow,
  nodeId: string,
  verdict: "approve" | "revise",
  reasons = "",
  now = Date.now(),
): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node || criticPhase(node) !== "review") return flow;
  const next = withCriticOn(
    flow,
    nodeId,
    (c) => ({
      ...c,
      rounds: c.rounds.map((r, i) => (i === c.rounds.length - 1 ? { ...r, verdict, reasons: reasons.trim() || undefined } : r)),
    }),
    now,
  );
  if (verdict !== "approve") return next;
  const rounds = next.nodes.find((n) => n.id === nodeId)?.critic?.rounds ?? [];
  const made = rounds[rounds.length - 1]?.made ?? "";
  return markDone(next, nodeId, made, now);
}

/** Out of rounds and still not approved: accept the last attempt anyway. */
export function approveAnyway(flow: Flow, nodeId: string, now = Date.now()): Flow {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node || criticPhase(node) !== "limit") return flow;
  const rounds = node.critic?.rounds ?? [];
  return markDone(flow, nodeId, rounds[rounds.length - 1]?.made ?? "", now);
}

/**
 * Read a verdict from the critic's reply: APPROVE or REVISE on its first line, and the rest as reasons.
 * Returns null when the reply says neither, so the person chooses.
 */
export function readVerdict(reply: string): { verdict: "approve" | "revise"; reasons: string } | null {
  const [first = "", ...rest] = reply.trim().split("\n");
  const word = first.trim().toLowerCase().replace(/[^a-z]/g, " ").trim().split(/\s+/)[0];
  if (word === "approve" || word === "approved") return { verdict: "approve", reasons: rest.join("\n").trim() };
  if (word === "revise" || word === "revision") return { verdict: "revise", reasons: rest.join("\n").trim() };
  return null;
}
