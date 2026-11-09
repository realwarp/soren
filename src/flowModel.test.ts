import { describe, expect, it } from "vitest";
import {
  noteSize,
  addAgentNode,
  addApprovalNode,
  addWaitNode,
  waitUntil,
  addEndNode,
  addStartNode,
  canRemove,
  doneOf,
  isReady,
  addOutput,
  addTool,
  addVerifierNode,
  artifactLabel,
  autoModel,
  availableModels,
  costUnit,
  eligibleModels,
  fitsQuota,
  effectiveModel,
  targetCapability,
  canWire,
  collatedDoc,
  descendants,
  dependencies,
  flowIssues,
  lock,
  markDone,
  markFailed,
  newFlow,
  readyNodes,
  removeNode,
  setSub,
  subFlow,
  removeOutput,
  reopen,
  toTasks,
  unwire,
  updateNode,
  VERIFIER_PORT,
  rankReady,
  unlocks,
  wire,
  type Billing,
  type Flow,
  type FlowTool,
} from "./flowModel";
import { billingFor, presetToTool, TOOL_PRESETS } from "./flowTools";
import { nodePrompt } from "./flowPrompt";

function tool(name: string, billing: Billing, over: Partial<Omit<FlowTool, "id">> = {}): Omit<FlowTool, "id"> {
  return { name, tier: "", plans: [], billing, sessions: null, prefer: false, windows: [], models: [], ...over };
}

/** schema -> api -> tests pass, with the agent nodes on one tool. */
function sample(): Flow {
  let flow = newFlow("Todo app", 1_700_000_000_000);
  flow = addTool(flow, { ...tool("Claude Code", "subscription"), tier: "Pro" });
  flow = addAgentNode(flow, "Design the database schema", "tool1");
  flow = addOutput(flow, "n1", "DB schema", "tables and keys");
  flow = addAgentNode(flow, "Build the API on the schema", "tool1");
  flow = addOutput(flow, "n2", "API contract", "routes and shapes");
  flow = addVerifierNode(flow, "tests");
  flow = wire(flow, "n2", { node: "n1", port: "o1" });
  flow = wire(flow, "n3", { node: "n2", port: "o1" });
  flow = addAgentNode(flow, "Ship the release notes", "tool1");
  flow = wire(flow, "n4", { node: "n3", port: VERIFIER_PORT });
  return flow;
}

describe("graph editing", () => {
  it("derives dependencies from wired inputs", () => {
    const flow = sample();
    expect(dependencies(flow.nodes[1])).toEqual(["n1"]);
    expect(toTasks(flow).map((t) => t.dependsOn)).toEqual([[], ["n1"], ["n2"], ["n3"]]);
  });

  it("does not wire the same artifact twice", () => {
    const flow = wire(sample(), "n2", { node: "n1", port: "o1" });
    expect(flow.nodes[1].inputs).toHaveLength(1);
  });

  it("unwires an input", () => {
    const flow = unwire(sample(), "n2", { node: "n1", port: "o1" });
    expect(flow.nodes[1].inputs).toEqual([]);
  });

  it("removing a node removes the inputs that came from it", () => {
    const flow = removeNode(sample(), "n1");
    expect(flow.nodes.map((n) => n.id)).toEqual(["n2", "n3", "n4"]);
    expect(flow.nodes[0].inputs).toEqual([]);
  });

  it("removing an output removes the wires that used it", () => {
    const flow = removeOutput(sample(), "n1", "o1");
    expect(flow.nodes[1].inputs).toEqual([]);
  });

  it("any edit unlocks and bumps the revision", () => {
    const locked = lock(sample())!;
    expect(locked.locked).toBe(true);
    const edited = updateNode(locked, "n1", { text: "Design the schema" });
    expect(edited.locked).toBe(false);
    expect(edited.revision).toBeGreaterThan(locked.revision);
  });
});

describe("wiring rules", () => {
  it("finds everything that waits on a node, through others", () => {
    expect([...descendants(sample(), "n1")].sort()).toEqual(["n2", "n3", "n4"]);
  });

  it("allows a new dependency between unrelated nodes", () => {
    const flow = addAgentNode(sample(), "Write the landing page", "tool1");
    expect(canWire(flow, "n5", "n1")).toBe(true);
    expect(canWire(flow, "n1", "n5")).toBe(true);
  });

  it("refuses itself and anything that would make a cycle", () => {
    const flow = sample();
    expect(canWire(flow, "n1", "n1")).toBe(false);
    expect(canWire(flow, "n3", "n1")).toBe(false);
    expect(canWire(flow, "n1", "n9")).toBe(false);
  });

  it("names an unnamed artifact from the node's first words", () => {
    const flow = addAgentNode(newFlow("x"), "  Build the REST API on that schema  ");
    expect(artifactLabel(flow.nodes[0])).toBe("Build the REST API output");
    expect(artifactLabel(addAgentNode(newFlow("x"), "").nodes[0])).toBe("Output");
  });
});

describe("issues", () => {
  it("is clean for a wired flow", () => {
    expect(flowIssues(sample())).toEqual([]);
  });

  it("reports an empty description and a missing tool", () => {
    const flow = addAgentNode(newFlow("x"), "");
    expect(flowIssues(flow).map((i) => i.kind).sort()).toEqual(["empty-text", "no-tool"]);
  });

  it("reports a tool that was removed", () => {
    const flow = sample();
    flow.tools = [];
    expect(flowIssues(flow).some((i) => i.kind === "unknown-tool")).toBe(true);
  });

  it("reports two nodes producing the same artifact", () => {
    const flow = addOutput(sample(), "n2", "db schema");
    expect(flowIssues(flow).map((i) => i.kind)).toContain("duplicate-output");
  });

  it("lets several checks share the default name, since each is wired from its own step", () => {
    let flow = sample();
    flow = addVerifierNode(flow, "custom");
    flow = addVerifierNode(flow, "custom");
    expect(flowIssues(flow).map((i) => i.kind)).not.toContain("duplicate-output");
  });

  it("lets several approvals share the name Approved", () => {
    let flow = sample();
    flow = addApprovalNode(flow);
    flow = addApprovalNode(flow);
    expect(flowIssues(flow).map((i) => i.kind)).not.toContain("duplicate-output");
  });

  it("reports a verifier that gates nothing", () => {
    let flow = addAgentNode(newFlow("x"), "Write code", "t");
    flow.tools = [{ id: "t", ...tool("T", "free") }];
    flow = addVerifierNode(flow, "lint");
    expect(flowIssues(flow).map((i) => i.kind)).toEqual(["ungated-verifier"]);
  });

  it("detects a cycle and refuses to lock it", () => {
    let flow = sample();
    flow = wire(flow, "n1", { node: "n2", port: "o1" });
    expect(flowIssues(flow).some((i) => i.kind === "cycle")).toBe(true);
    expect(lock(flow)).toBeNull();
  });

  it("refuses to lock an empty flow", () => {
    expect(lock(newFlow("x"))).toBeNull();
  });
});

describe("running", () => {
  it("only the first node is ready at the start", () => {
    expect(readyNodes(sample()).map((n) => n.id)).toEqual(["n1"]);
  });

  it("a node becomes ready when what it waits for is done", () => {
    let flow = markDone(sample(), "n1", "schema.sql written");
    expect(readyNodes(flow).map((n) => n.id)).toEqual(["n2"]);
    flow = markDone(flow, "n2");
    flow = markDone(flow, "n3");
    expect(readyNodes(flow).map((n) => n.id)).toEqual(["n4"]);
  });

  it("two independent nodes are ready together", () => {
    let flow = addAgentNode(sample(), "Write the landing page", "tool1");
    expect(readyNodes(flow).map((n) => n.id).sort()).toEqual(["n1", "n5"]);
  });

  it("reopening a node also reopens what was built on it", () => {
    let flow = sample();
    for (const id of ["n1", "n2", "n3"]) flow = markDone(flow, id);
    flow = reopen(flow, "n2");
    expect(flow.nodes.map((n) => Boolean(n.done))).toEqual([true, false, false, false]);
  });

  it("a failed node stays ready, keeps what was built after it waiting, and counts attempts", () => {
    let flow = markDone(sample(), "n1");
    flow = markFailed(flow, "n2", "TypeError: db is undefined", 5);
    expect(readyNodes(flow).map((n) => n.id)).toContain("n2");
    expect(flow.nodes.find((n) => n.id === "n3")?.done).toBeUndefined();
    expect(flow.nodes.find((n) => n.id === "n2")?.failed).toEqual({ at: 5, error: "TypeError: db is undefined", attempts: 1 });
    flow = markFailed(flow, "n2", "still broken", 6);
    expect(flow.nodes.find((n) => n.id === "n2")?.failed?.attempts).toBe(2);
  });

  it("failing a node that was done reopens what was built on it, and marking it done clears the failure", () => {
    let flow = sample();
    for (const id of ["n1", "n2", "n3"]) flow = markDone(flow, id);
    flow = markFailed(flow, "n2", "tests broke");
    expect(flow.nodes.map((n) => Boolean(n.done))).toEqual([true, false, false, false]);
    flow = markDone(flow, "n2", "fixed");
    expect(flow.nodes.find((n) => n.id === "n2")?.failed).toBeUndefined();
  });

  it("the prompt of a failed node asks for a retry that starts from the error", () => {
    const flow = markFailed(sample(), "n1", "port 5432 refused");
    const prompt = nodePrompt(flow, flow.nodes[0]);
    expect(prompt).toContain("attempt 2");
    expect(prompt).toContain("port 5432 refused");
    const done = markDone(flow, "n1");
    expect(nodePrompt(done, done.nodes[0])).not.toContain("attempt 2");
  });
});

describe("ranking ready nodes", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;

  /** Three independent nodes on three tools, ids n1..n3 and tool1..tool3. */
  function lanes(tools: Array<Omit<FlowTool, "id">>): Flow {
    let flow = newFlow("x", NOW);
    for (const t of tools) flow = addTool(flow, t);
    tools.forEach((_, i) => {
      flow = addAgentNode(flow, `Task ${i + 1}`, `tool${i + 1}`);
    });
    return flow;
  }
  const ids = (nodes: Array<{ id: string }>) => nodes.map((n) => n.id);

  it("counts only what a node frees immediately", () => {
    const flow = sample();
    expect(unlocks(flow, flow.nodes[0])).toBe(1);
    expect(unlocks(flow, flow.nodes[1])).toBe(1);
  });

  it("a node with other unmet inputs does not count as unlocked", () => {
    let flow = addAgentNode(sample(), "Join", "tool1");
    flow = wire(flow, "n5", { node: "n1", port: "o1" });
    flow = wire(flow, "n5", { node: "n2", port: "o1" });
    expect(unlocks(flow, flow.nodes[0])).toBe(1);
  });

  it("puts the tool resetting soonest first", () => {
    const flow = lanes([
      tool("A", "subscription", { windows: [{ label: "weekly", resetsAt: NOW + 50 * HOUR, left: 10 }] }),
      tool("B", "subscription", { windows: [{ label: "5 hour", resetsAt: NOW + 2 * HOUR, left: 10 }] }),
    ]);
    expect(ids(rankReady(flow, flow.nodes, NOW))).toEqual(["n2", "n1"]);
  });

  it("uses the soonest of a tool's several windows", () => {
    const flow = lanes([
      tool("A", "subscription", {
        windows: [
          { label: "weekly", resetsAt: NOW + 90 * HOUR, left: 10 },
          { label: "5 hour", resetsAt: NOW + 1 * HOUR, left: 10 },
        ],
      }),
      tool("B", "subscription", { windows: [{ label: "5 hour", resetsAt: NOW + 3 * HOUR, left: 10 }] }),
    ]);
    expect(ids(rankReady(flow, flow.nodes, NOW))).toEqual(["n1", "n2"]);
  });

  it("a tool marked use-first beats a sooner reset", () => {
    const flow = lanes([
      tool("A", "free", { prefer: true, windows: [{ label: "month", resetsAt: NOW + 400 * HOUR, left: 10 }] }),
      tool("B", "subscription", { windows: [{ label: "5 hour", resetsAt: NOW + HOUR, left: 10 }] }),
    ]);
    expect(ids(rankReady(flow, flow.nodes, NOW))).toEqual(["n1", "n2"]);
  });

  it("with equal resets: subscription, then free, then pay as you go", () => {
    const flow = lanes([tool("P", "payg"), tool("F", "free"), tool("S", "subscription")]);
    expect(ids(rankReady(flow, flow.nodes, NOW))).toEqual(["n3", "n2", "n1"]);
  });

  it("a node that does not fit its quota goes last", () => {
    let flow = lanes([
      tool("A", "subscription", { windows: [{ label: "5 hour", resetsAt: NOW + HOUR, left: 1 }] }),
      tool("B", "payg"),
    ]);
    flow = updateNode(flow, "n1", { cost: 4 });
    expect(ids(rankReady(flow, flow.nodes, NOW))).toEqual(["n2", "n1"]);
  });

  it("a window that has already reset counts as enough", () => {
    let flow = lanes([tool("A", "subscription", { windows: [{ label: "5 hour", resetsAt: NOW - 1, left: 0 }] })]);
    flow = updateNode(flow, "n1", { cost: 3 });
    expect(ids(rankReady(flow, flow.nodes, NOW))).toEqual(["n1"]);
  });

  it("tools take turns, and inside a tool the node that frees more is first", () => {
    let flow = newFlow("x", NOW);
    flow = addTool(flow, tool("A", "subscription"));
    flow = addTool(flow, tool("B", "subscription"));
    for (const [text, toolId] of [["a-low", "tool1"], ["a-high", "tool1"], ["b-only", "tool2"], ["after", "tool2"]] as const) {
      flow = addAgentNode(flow, text, toolId);
    }
    flow = addOutput(flow, "n2", "thing");
    flow = wire(flow, "n4", { node: "n2", port: "o1" });
    const ranked = rankReady(flow, flow.nodes.filter((n) => n.id !== "n4"), NOW);
    expect(ids(ranked)).toEqual(["n2", "n3", "n1"]);
  });
});

describe("inside a node", () => {
  it("edits a node's inside with the same operations as the main graph", () => {
    let flow = sample();
    let inside = subFlow(flow, "n2");
    expect(inside.nodes).toEqual([]);
    inside = addAgentNode(inside, "Research the routes");
    inside = addAgentNode(inside, "Write the handlers");
    inside = wire(addOutput(inside, "n1", "Route list"), "n2", { node: "n1", port: "o1" });
    flow = setSub(flow, "n2", inside);
    expect(flow.nodes[1].sub?.map((n) => n.text)).toEqual(["Research the routes", "Write the handlers"]);
    expect(dependencies(flow.nodes[1].sub![1])).toEqual(["n1"]);
    expect(flow.nodes[0].sub).toBeUndefined();
  });

  it("the inside does not change what the outer graph needs", () => {
    const flow = setSub(sample(), "n2", addAgentNode(subFlow(sample(), "n2"), "x"));
    expect(toTasks(flow)).toEqual(toTasks(sample()));
  });

  it("shows sub-steps in the read-through", () => {
    const flow = setSub(sample(), "n2", addAgentNode(subFlow(sample(), "n2"), "Research the routes"));
    expect(collatedDoc(flow)).toContain("- Inside: Research the routes");
  });

  it("editing the readable plan and prompt unlocks the flow", () => {
    const locked = lock(sample())!;
    const edited = updateNode(locked, "n1", { readable: "Plain words", prompt: "Do the thing", delegation: true });
    expect(edited.locked).toBe(false);
    expect(edited.nodes[0]).toMatchObject({ readable: "Plain words", prompt: "Do the thing", delegation: true });
  });
});

describe("choosing a model from the capability need", () => {
  const claude = tool("Claude Code", "subscription", {
    models: [
      { id: "m1", name: "Fable", capability: 10 },
      { id: "m2", name: "Opus", capability: 9 },
      { id: "m3", name: "Sonnet", capability: 7 },
      { id: "m4", name: "Haiku", capability: 4 },
    ],
  });
  const withTool = (need?: number, modelId?: string) => {
    let flow = addTool(newFlow("x"), claude);
    flow = addAgentNode(flow, "Do it", "tool1");
    return updateNode(flow, "n1", { need, modelId });
  };

  it("aims one point above the need and stops at 10", () => {
    expect(targetCapability(6)).toBe(7);
    expect(targetCapability(10)).toBe(10);
  });

  it("picks the weakest model at the target", () => {
    expect(autoModel(withTool().tools[0], 6)?.name).toBe("Sonnet");
    expect(autoModel(withTool().tools[0], 3)?.name).toBe("Haiku");
    expect(autoModel(withTool().tools[0], 7)?.name).toBe("Opus");
  });

  it("takes the strongest the tool has when none reaches the target", () => {
    const flow = withTool(9);
    expect(autoModel(flow.tools[0], 10)?.name).toBe("Fable");
    const weak = tool("Small", "free", { models: [{ id: "m1", name: "Mini", capability: 5 }] });
    expect(autoModel({ id: "t", ...weak }, 8)?.name).toBe("Mini");
  });

  it("lists every model at or above the need, weakest first", () => {
    expect(eligibleModels(withTool().tools[0], 7).map((m) => m.name)).toEqual(["Sonnet", "Opus", "Fable"]);
  });

  it("uses the person's choice when it exists, else the auto pick, else nothing", () => {
    expect(effectiveModel(withTool(6), withTool(6).nodes[0])?.name).toBe("Sonnet");
    const pinned = withTool(6, "m4");
    expect(effectiveModel(pinned, pinned.nodes[0])?.name).toBe("Haiku");
    const unrated = withTool();
    expect(effectiveModel(unrated, unrated.nodes[0])).toBeUndefined();
  });

  it("flags a step whose tool has nothing strong enough", () => {
    let flow = addTool(newFlow("x"), tool("Small", "free", { models: [{ id: "m1", name: "Mini", capability: 5 }] }));
    flow = addAgentNode(flow, "Hard thing", "tool1");
    flow = updateNode(flow, "n1", { need: 8 });
    expect(flowIssues(flow).map((i) => i.kind)).toContain("weak-model");
    flow = updateNode(flow, "n1", { need: 5 });
    expect(flowIssues(flow).map((i) => i.kind)).not.toContain("weak-model");
  });
});

describe("plans and hours", () => {
  const ladder = [{ name: "Free" }, { name: "Plus" }];
  const models = [
    { id: "m1", name: "Luna", capability: 5, plan: "Free" },
    { id: "m2", name: "Sol", capability: 8, plan: "Plus", usage: 2 },
    { id: "m3", name: "Anywhere", capability: 3 },
  ];
  const on = (tier: string) => ({ id: "t", ...tool("Codex", "free", { tier, plans: ladder, models }) });

  it("lists only the models the plan includes", () => {
    expect(availableModels(on("Free")).map((m) => m.name)).toEqual(["Luna", "Anywhere"]);
    expect(availableModels(on("Plus")).map((m) => m.name)).toEqual(["Luna", "Sol", "Anywhere"]);
  });

  it("offers everything when the plan is not on the ladder", () => {
    expect(availableModels(on("Mystery"))).toHaveLength(3);
  });

  it("never picks a model the plan does not include", () => {
    expect(autoModel(on("Free"), 7)?.name).toBe("Luna");
    expect(autoModel(on("Plus"), 7)?.name).toBe("Sol");
    expect(eligibleModels(on("Free"), 5).map((m) => m.name)).toEqual(["Luna"]);
  });

  /** One hours tool: 2 daily hours and 3 in the wallet, one node on a model with a usage rate. */
  function hoursFlow(cost: number, usage: number, daily: number | null = 2, wallet: number | null = 3): Flow {
    let flow = addTool(newFlow("x"), tool("Freebuff", "free", {
      models: [{ id: "m1", name: "M", capability: 5, usage }],
      windows: [
        { label: "daily hours", unit: "hours", role: "supply", resetsAt: null, left: daily },
        { label: "wallet hours", unit: "hours", role: "supply", resetsAt: null, left: wallet },
      ],
    }));
    flow = addAgentNode(flow, "Do it", "tool1");
    return updateNode(flow, "n1", { need: 4, cost });
  }

  it("adds daily and wallet hours together and charges the model's rate", () => {
    const fits = (cost: number, usage: number) => fitsQuota(hoursFlow(cost, usage), hoursFlow(cost, usage).nodes[0]);
    expect(fits(2, 2)).toBe(true); // 4 hours needed, 5 there
    expect(fits(3, 2)).toBe(false); // 6 needed
    expect(fits(40, 0)).toBe(true); // a free model spends nothing
  });

  it("a free-hour model cannot run a step longer than its free hours, whatever else is left", () => {
    const build = (cost: number) => {
      let flow = addTool(newFlow("x"), tool("Freebuff", "subscription", {
        models: [{ id: "m1", name: "Sol", capability: 8, usage: 0, freeHours: 1 }],
        windows: [{ label: "daily hours", unit: "hours", role: "supply", resetsAt: null, left: 70 }],
      }));
      flow = addAgentNode(flow, "Do it", "tool1");
      return updateNode(flow, "n1", { need: 7, cost });
    };
    expect(fitsQuota(build(1), build(1).nodes[0])).toBe(true);
    expect(fitsQuota(build(2), build(2).nodes[0])).toBe(false);
  });

  it("counts an unknown hour supply as enough", () => {
    const flow = hoursFlow(30, 1, 2, null);
    expect(fitsQuota(flow, flow.nodes[0])).toBe(true);
  });

  it("counts a tool's quota in hours when any window is in hours", () => {
    expect(costUnit(hoursFlow(1, 1).tools[0])).toBe("hours");
    expect(costUnit(on("Free"))).toBe("prompts");
  });

  it("builds Freebuff from its plan: hours a day and wallet per plan", () => {
    const freebuff = TOOL_PRESETS.find((p) => p.name === "Freebuff")!;
    const free = presetToTool(freebuff, 1_000);
    expect(free.tier).toBe("Free");
    expect(free.billing).toBe("free");
    expect(free.windows.map((w) => w.left)).toEqual([5, 5]);
    const pro = presetToTool(freebuff, 1_000, "Pro");
    expect(pro.windows.map((w) => w.left)).toEqual([70, 160]);
    expect(pro.billing).toBe("subscription");
    expect(pro.windows[1].resetsAt).toBeNull();
  });

  it("each preset's models name plans that are on its ladder", () => {
    for (const preset of TOOL_PRESETS) {
      const names = new Set(preset.plans.map((p) => p.name));
      for (const m of preset.models) expect(names.has(m.plan), `${preset.name}: ${m.name}`).toBe(true);
    }
  });

  it("calls Free or $0 plans free and any other plan a subscription, priced or not", () => {
    expect(billingFor({ name: "Free", price: "$0 / month" })).toBe("free");
    expect(billingFor({ name: "Free" })).toBe("free");
    expect(billingFor({ name: "Google AI Pro" })).toBe("subscription");
    expect(billingFor({ name: "Pro", price: "$20 / month" })).toBe("subscription");
  });
});

describe("collated document", () => {
  it("joins node docs with a horizontal rule and names what is needed and made", () => {
    const doc = collatedDoc(sample());
    expect(doc.startsWith("# Todo app")).toBe(true);
    expect(doc.split("\n---\n")).toHaveLength(4);
    // A step is named by its place in the plan, so the first step is "1", not its id.
    expect(doc).toContain("- Needs: DB schema (from 1)");
    expect(doc).toContain("- Makes: API contract, routes and shapes");
    expect(doc).toContain("(Claude Code)");
    expect(doc).toContain("Check: Tests pass");
  });
});

describe("start and end", () => {
  /** Start n1 -> two steps -> End. The first step waits on the Start, the second on the first. */
  function begun() {
    let flow = addStartNode(newFlow("x"));
    flow = addAgentNode(flow, "Design it", "t");
    flow = wire(flow, "n2", { node: "n1", port: "o1" });
    flow = addOutput(flow, "n2", "Design");
    flow = addAgentNode(flow, "Build it", "t");
    flow = wire(flow, "n3", { node: "n2", port: "o1" });
    flow = addOutput(flow, "n3", "App");
    flow = addEndNode(flow);
    flow = wire(flow, "n4", { node: "n3", port: "o1" });
    flow.tools = [{ id: "t", ...tool("T", "free") }];
    return flow;
  }

  it("a Start is always done, so the first step is ready at once", () => {
    const flow = begun();
    expect(doneOf(flow, flow.nodes[0])).toBe(true);
    expect(readyNodes(flow).map((n) => n.id)).toEqual(["n2"]);
  });

  it("Starts and Ends are never offered as work to do", () => {
    const flow = begun();
    expect(isReady(flow, flow.nodes[0])).toBe(false);
    expect(isReady(flow, flow.nodes[3])).toBe(false);
  });

  it("an End is reached once everything it waits for is done", () => {
    let flow = begun();
    expect(doneOf(flow, flow.nodes[3])).toBe(false);
    flow = markDone(markDone(flow, "n2"), "n3");
    expect(doneOf(flow, flow.nodes[3])).toBe(true);
  });

  it("an End with nothing wired to it does not count as reached", () => {
    const flow = addEndNode(newFlow("x"));
    expect(doneOf(flow, flow.nodes[0])).toBe(false);
  });

  it("nothing can wait on a Start's behalf and nothing comes out of an End", () => {
    const flow = begun();
    expect(canWire(flow, "n2", "n1")).toBe(false);
    expect(canWire(flow, "n4", "n2")).toBe(false);
    expect(canWire(flow, "n1", "n3")).toBe(true);
  });

  it("a workflow with a Start, steps and an End has no problems", () => {
    expect(flowIssues(begun())).toEqual([]);
  });

  it("flags a step the Start never reaches, and an End with nothing in it", () => {
    let flow = begun();
    flow = addAgentNode(flow, "Floating", "t");
    flow = addEndNode(flow);
    const kinds = flowIssues(flow).map((i) => `${i.kind}:${i.node}`).sort();
    expect(kinds).toEqual(["end-empty:n6", "unreachable:n5"]);
  });

  it("flags a second Start", () => {
    const flow = addStartNode(begun());
    expect(flowIssues(flow).map((i) => i.kind)).toContain("extra-start");
  });

  it("the only Start cannot be removed, a spare one can", () => {
    const flow = begun();
    expect(canRemove(flow, "n1")).toBe(false);
    expect(canRemove(flow, "n2")).toBe(true);
    expect(canRemove(addStartNode(flow), "n1")).toBe(true);
  });

  it("the read-through numbers only the work", () => {
    const doc = collatedDoc(begun());
    expect(doc).toContain("## 1. Design it");
    expect(doc).toContain("## 2. Build it");
    expect(doc).not.toContain("## 3.");
  });
});

describe("approval and wait", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;
  const claude = () =>
    tool("Claude Code", "subscription", { windows: [{ label: "5 hour", resetsAt: NOW + 5 * HOUR, left: null }] });

  /** n1 Start -> n2 Design -> n3 Approval -> n4 Build. */
  function gated() {
    let flow = addStartNode(newFlow("x"));
    flow = addTool(flow, claude());
    flow = addAgentNode(flow, "Design it", "tool1");
    flow = wire(flow, "n2", { node: "n1", port: "o1" });
    flow = addOutput(flow, "n2", "Design");
    flow = addApprovalNode(flow, "Read the design");
    flow = wire(flow, "n3", { node: "n2", port: "o2" });
    flow = addAgentNode(flow, "Build it", "tool1");
    flow = wire(flow, "n4", { node: "n3", port: "o1" });
    return flow;
  }

  it("an approval is ready once what it waits for is done, and only you finish it", () => {
    let flow = gated();
    expect(readyNodes(flow, NOW).map((n) => n.id)).toEqual(["n2"]);
    flow = markDone(flow, "n2");
    expect(readyNodes(flow, NOW).map((n) => n.id)).toEqual(["n3"]);
    expect(doneOf(flow, flow.nodes[2], NOW)).toBe(false);
  });

  it("steps after an approval wait until it is approved", () => {
    let flow = markDone(gated(), "n2");
    expect(readyNodes(flow, NOW).map((n) => n.id)).not.toContain("n4");
    flow = markDone(flow, "n3", "looks right");
    expect(readyNodes(flow, NOW).map((n) => n.id)).toEqual(["n4"]);
  });

  /** n1 Start -> n2 Wait for the 5 hour limit -> n3 Build. */
  function waiting() {
    let flow = addStartNode(newFlow("x"));
    flow = addTool(flow, claude());
    flow = addWaitNode(flow, "tool1", "5 hour");
    flow = wire(flow, "n2", { node: "n1", port: "o1" });
    flow = addAgentNode(flow, "Build it", "tool1");
    flow = wire(flow, "n3", { node: "n2", port: "o1" });
    return flow;
  }

  it("a wait holds the workflow until the limit resets, then lets it through by itself", () => {
    const flow = waiting();
    expect(waitUntil(flow, flow.nodes[1])).toBe(NOW + 5 * HOUR);
    expect(doneOf(flow, flow.nodes[1], NOW)).toBe(false);
    expect(readyNodes(flow, NOW)).toEqual([]);
    expect(doneOf(flow, flow.nodes[1], NOW + 5 * HOUR + 1)).toBe(true);
    expect(readyNodes(flow, NOW + 5 * HOUR + 1).map((n) => n.id)).toEqual(["n3"]);
  });

  it("the person can say the limit has already reset", () => {
    const flow = markDone(waiting(), "n2");
    expect(readyNodes(flow, NOW).map((n) => n.id)).toEqual(["n3"]);
  });

  it("a wait with no tool or limit is a problem, and one pointing at a real limit is not", () => {
    expect(flowIssues(waiting()).map((i) => i.kind)).not.toContain("no-wait-target");
    let flow = addWaitNode(addStartNode(newFlow("x")), "", "");
    flow = wire(flow, "n2", { node: "n1", port: "o1" });
    expect(flowIssues(flow).map((i) => i.kind)).toContain("no-wait-target");
  });

  it("the read-through shows an approval and skips a wait", () => {
    expect(collatedDoc(gated())).toContain("Approval: Read the design");
    expect(collatedDoc(waiting())).not.toContain("Wait for the limit");
  });
});

describe("note size", () => {
  it("is the default until dragged, and never smaller than the minimum", () => {
    expect(noteSize({})).toEqual({ w: 192, h: 128 });
    expect(noteSize({ w: 240, h: 200 })).toEqual({ w: 240, h: 200 });
    expect(noteSize({ w: 10, h: 10 })).toEqual({ w: 120, h: 72 });
  });
});
