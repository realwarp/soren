import { describe, expect, it } from "vitest";
import {
  BATCH_OUTPUT_TOKENS,
  defaultTools,
  extractJson,
  generateGraph,
  mergeSections,
  parseOutline,
  polishPlans,
  parseGraph,
  planBatches,
  skeletonFlow,
  type BatchItem,
  type Complete,
} from "./flowCloud";

const GRAPH = JSON.stringify({
  title: "Todo app",
  nodes: [
    { id: "a", kind: "start", text: "The idea", makes: [{ label: "Brief", note: "what to build" }] },
    { id: "b", kind: "agent", text: "Design the schema", tool: "claude code", need: 6, needs: ["a"], makes: [{ label: "DB schema", note: "tables" }] },
    { id: "c", kind: "agent", text: "Build the screens", tool: "Codex", need: 4, needs: ["a"], makes: [{ label: "UI", note: "screens" }] },
    { id: "d", kind: "verifier", check: "tests", text: "Tests pass", needs: ["b", "c"] },
  ],
});

describe("extractJson", () => {
  it("reads an object out of fences and chatter", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("calls a reply cut off at the token limit unusable rather than guessing", () => {
    expect(() => extractJson('{"nodes":[{"id":"n1"')).toThrow();
  });
});

describe("parseGraph", () => {
  const skeleton = skeletonFlow(defaultTools([]), 1);

  it("builds the graph through the flow model, with independent steps left parallel", () => {
    const { flow } = parseGraph(GRAPH, skeleton);
    const [start, schema, screens, tests] = flow.nodes;
    expect(start.kind).toBe("start");
    expect(schema.inputs.map((r) => r.node)).toEqual([start.id]);
    expect(screens.inputs.map((r) => r.node)).toEqual([start.id]);
    expect(schema.toolId).not.toBe(screens.toolId);
    expect(tests.inputs.map((r) => r.node).sort()).toEqual([schema.id, screens.id].sort());
  });

  it("adds an End wired to whatever nothing else waits for", () => {
    const { flow } = parseGraph(GRAPH, skeleton);
    const end = flow.nodes.find((n) => n.kind === "end")!;
    expect(end.inputs.map((r) => r.node)).toEqual([flow.nodes[3].id]);
  });

  it("drops a link to a node that does not exist, with a note", () => {
    const bad = JSON.stringify({ nodes: [{ id: "a", kind: "start", text: "x" }, { id: "b", kind: "agent", text: "y", needs: ["zzz"] }] });
    const { flow, notes } = parseGraph(bad, skeleton);
    expect(notes.length).toBe(1);
    // It still hangs from the Start, so it is not left unreachable.
    expect(flow.nodes[1].inputs[0].node).toBe(flow.nodes[0].id);
  });
});

describe("planBatches", () => {
  const items = (count: number): BatchItem[] =>
    Array.from({ length: count }, (_, i) => ({ id: `n${i}`, kind: "agent", weight: 600, after: i ? [`n${i - 1}`] : [] }));

  it("places every node in exactly one batch, and no batch is over budget", () => {
    for (const count of [1, 7, 16, 17, 40]) {
      const list = items(count);
      const batches = planBatches(list);
      expect(batches.flat().sort()).toEqual(list.map((i) => i.id).sort());
      for (const ids of batches) expect(ids.length * 600).toBeLessThanOrEqual(BATCH_OUTPUT_TOKENS);
    }
  });
});

const request = { ask: "a todo app", messages: [{ role: "user" as const, text: "I want a todo app" }], items: [], tools: defaultTools([]) };

const OUTLINE = JSON.stringify({
  title: "Todo app",
  start: "The idea",
  sections: [
    { id: "a", name: "Data", nodes: 2, takes: ["Starting point"], gives: ["DB schema"], brief: "Design the schema." },
    { id: "b", name: "Screens", nodes: 2, takes: ["DB schema"], gives: ["UI"], brief: "Build the screens." },
  ],
});
const SECTION_A = JSON.stringify({
  nodes: [
    { id: "1", kind: "agent", text: "Design the schema", tool: "claude code", need: 6, needs: ["in:Starting point"], makes: [{ label: "DB schema", note: "tables" }] },
    { id: "2", kind: "verifier", check: "tests", text: "Schema migrates", needs: ["1"] },
  ],
});
const SECTION_B = JSON.stringify({
  nodes: [
    { id: "1", kind: "agent", text: "Build the screens", tool: "Codex", need: 4, needs: ["in:DB schema"], makes: [{ label: "UI", note: "screens" }] },
    { id: "2", kind: "approval", text: "Look at the screens", needs: ["1"] },
  ],
});

/** Answers the planner and each section by what the prompt says it is. */
const twoStep: Complete = async (_system, prompt) => {
  if (prompt.includes("Your section: a")) return SECTION_A;
  if (prompt.includes("Your section: b")) return SECTION_B;
  return OUTLINE;
};

describe("parseOutline", () => {
  it("keeps the brief and the artifacts each section takes and gives", () => {
    const outline = parseOutline(OUTLINE);
    expect(outline.sections.map((s) => s.id)).toEqual(["a", "b"]);
    expect(outline.sections[1].takes).toEqual(["DB schema"]);
    expect(outline.sections[0].brief).toBe("Design the schema.");
  });

  it("leaves out a section with no brief, with a note", () => {
    const outline = parseOutline(JSON.stringify({ sections: [{ id: "a", brief: "x" }, { id: "b" }] }));
    expect(outline.sections.length).toBe(1);
    expect(outline.notes.length).toBe(1);
  });
});

describe("mergeSections", () => {
  it("scopes ids by section and points in: needs at the node that makes the artifact", () => {
    const outline = parseOutline(OUTLINE);
    const merged = mergeSections(outline, [
      { section: outline.sections[0], nodes: JSON.parse(SECTION_A).nodes },
      { section: outline.sections[1], nodes: JSON.parse(SECTION_B).nodes },
    ]);
    const screens = merged.nodes.find((n) => n.id === "b_1")!;
    expect(screens.needs).toEqual(["a_1:DB schema"]);
    expect(merged.nodes[0].kind).toBe("start");
  });
});

describe("generateGraph", () => {
  it("is a planner request and one per section, writes no prompts, and keeps the conversation for the lock", async () => {
    let calls = 0;
    const result = await generateGraph(request, async (...args) => {
      calls += 1;
      return twoStep(...args);
    });
    expect(calls).toBe(3);
    expect(result.requests).toBe(3);
    expect(result.flow.locked).toBe(false);
    expect(result.flow.nodes.filter((n) => n.kind === "agent").length).toBe(2);
    expect(result.flow.nodes.every((n) => !n.prompt && !n.readable)).toBe(true);
    expect(result.flow.brief).toContain("I want a todo app");
  });

  it("wires a section to what an earlier section made", async () => {
    const { flow } = await generateGraph(request, twoStep);
    const [schema, screens] = flow.nodes.filter((n) => n.kind === "agent");
    expect(screens.inputs.map((r) => r.node)).toEqual([schema.id]);
  });

  it("asks the planner once more when its reply cannot be read, and no more", async () => {
    let planner = 0;
    const complete: Complete = async (...args) => {
      if (args[1].includes("Your section:")) return twoStep(...args);
      planner += 1;
      return planner === 1 ? '{"sections":[{"id":"a"' : OUTLINE;
    };
    expect((await generateGraph(request, complete)).requests).toBe(4);
    await expect(generateGraph(request, async () => "no json")).rejects.toThrow();
  });

  it("keeps the steps a cut-off section finished, and says so", async () => {
    const cut = SECTION_B.slice(0, SECTION_B.indexOf('"id":"2"') - 1);
    const { flow, notes } = await generateGraph(request, async (...args) => (args[1].includes("Your section: b") ? cut : twoStep(...args)));
    expect(flow.nodes.some((n) => n.text === "Build the screens")).toBe(true);
    expect(notes.some((n) => n.includes("cut off"))).toBe(true);
  });

  it("leaves a failed section out with a note instead of failing the workflow", async () => {
    const { flow, notes } = await generateGraph(request, async (...args) => {
      if (args[1].includes("Your section: b")) throw new Error("The cloud agent has used its requests for today.");
      return twoStep(...args);
    });
    expect(flow.nodes.some((n) => n.text === "Design the schema")).toBe(true);
    expect(notes.some((n) => n.includes("Screens could not be written"))).toBe(true);
  });
});

describe("polishPlans", () => {
  const textsOf = (flow: Awaited<ReturnType<typeof generateGraph>>["flow"]) =>
    new Map(flow.nodes.filter((n) => n.kind === "agent" || n.kind === "verifier").map((n) => [n.id, { prompt: `template ${n.id}`, readable: `readable ${n.id}` }]));
  const polished: Complete = async (_system, prompt) => {
    const ids = prompt.match(/these nodes only: (.*)$/)![1].split(", ");
    return JSON.stringify({ nodes: ids.map((id) => ({ id, prompt: `polished ${id}`, readable: `polished readable ${id}` })) });
  };

  it("polishes every step with a prompt in one request when they fit, and nothing for Start or End", async () => {
    const { flow } = await generateGraph(request, twoStep);
    let calls = 0;
    const result = await polishPlans(flow, textsOf(flow), async (system, prompt, max) => {
      calls += 1;
      return polished(system, prompt, max);
    });
    expect(calls).toBe(1);
    expect(result.missing).toEqual([]);
    expect([...result.rewrites.keys()].sort()).toEqual(["n2", "n3", "n4"]);
    expect(result.rewrites.get("n2")).toEqual({
      prompt: { base: "template n2", text: "polished n2" },
      readable: { base: "readable n2", text: "polished readable n2" },
    });
  });

  it("offers nothing for a step the model returned unchanged", async () => {
    const { flow } = await generateGraph(request, twoStep);
    const result = await polishPlans(flow, textsOf(flow), async (_system, prompt) => {
      const ids = prompt.match(/these nodes only: (.*)$/)![1].split(", ");
      return JSON.stringify({ nodes: ids.map((id) => ({ id, prompt: id === "n2" ? "template n2" : `polished ${id}`, readable: id === "n2" ? "readable n2" : `polished readable ${id}` })) });
    });
    expect([...result.rewrites.keys()].sort()).toEqual(["n3", "n4"]);
    expect(result.missing).toEqual([]);
  });

  it("asks only about the steps it is given", async () => {
    const { flow } = await generateGraph(request, twoStep);
    let asked = "";
    await polishPlans(flow, new Map([["n3", { prompt: "template n3", readable: "readable n3" }]]), async (system, prompt, max) => {
      asked = prompt.match(/these nodes only: (.*)$/)![1];
      return polished(system, prompt, max);
    });
    expect(asked).toBe("n3");
  });

  it("keeps the flow and says what is missing when a request fails", async () => {
    const { flow } = await generateGraph(request, twoStep);
    const result = await polishPlans(flow, textsOf(flow), async () => {
      throw new Error("The cloud agent has used its requests for today.");
    });
    expect(result.missing.length).toBe(3);
    expect(result.rewrites.size).toBe(0);
    expect(result.notes.some((n) => n.includes("used its requests"))).toBe(true);
  });
});
