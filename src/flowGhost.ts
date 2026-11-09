import type { Flow, FlowNode, PortRef } from "./flowModel";

/**
 * What the agent proposes, drawn over the workflow as it stands. The canvas shows one merged flow: everything the
 * proposal keeps or adds, plus what it would take away, each marked so it can be drawn dashed or faded. Nothing here
 * is saved; the person applies the proposal (the proposed flow replaces the real one) or rejects it (this is dropped).
 */
export interface Ghost {
  /** The merged flow to draw. Never saved. */
  flow: Flow;
  /** Steps the proposal would add, reword, and remove. */
  addNodes: Set<string>;
  editNodes: Set<string>;
  removeNodes: Set<string>;
  /** Wires, by their canvas id, the proposal would add and take away. */
  addEdges: Set<string>;
  removeEdges: Set<string>;
}

/** The id the canvas gives a wire into `to`, so a marked wire can be found when it is drawn. */
export function edgeId(ref: PortRef, to: string): string {
  return `${ref.node}.${ref.port}->${to}`;
}

export function ghostView(base: Flow, proposed: Flow): Ghost {
  const had = new Map(base.nodes.map((n) => [n.id, n] as const));
  const has = new Map(proposed.nodes.map((n) => [n.id, n] as const));
  const addNodes = new Set<string>();
  const editNodes = new Set<string>();
  const removeNodes = new Set<string>();
  for (const n of proposed.nodes) {
    const was = had.get(n.id);
    if (!was) addNodes.add(n.id);
    else if (was.text !== n.text) editNodes.add(n.id);
  }
  for (const n of base.nodes) if (!has.has(n.id)) removeNodes.add(n.id);

  const addEdges = new Set<string>();
  const removeEdges = new Set<string>();
  const keep = (n: FlowNode): FlowNode => {
    const was = had.get(n.id);
    const mine = new Set(n.inputs.map((r) => edgeId(r, n.id)));
    for (const r of n.inputs) if (!was?.inputs.some((w) => edgeId(w, n.id) === edgeId(r, n.id))) addEdges.add(edgeId(r, n.id));
    // A wire the proposal drops stays drawn, faded, so the person sees what would go.
    const dropped = (was?.inputs ?? []).filter((w) => !mine.has(edgeId(w, n.id)));
    for (const w of dropped) removeEdges.add(edgeId(w, n.id));
    return dropped.length ? { ...n, inputs: [...n.inputs, ...dropped] } : n;
  };
  const merged = proposed.nodes.map(keep);
  for (const id of removeNodes) {
    const gone = had.get(id)!;
    // Its own inputs go with it, and a wire into it from another removed step is not drawn twice.
    for (const r of gone.inputs) removeEdges.add(edgeId(r, id));
    merged.push(gone);
  }
  return { flow: { ...proposed, nodes: merged }, addNodes, editNodes, removeNodes, addEdges, removeEdges };
}
