import { describe, expect, it } from "vitest";
import {
  addAgentNode,
  addContainer,
  addNote,
  addOutput,
  addStartNode,
  addTool,
  hiddenByContainers,
  insertCopy,
  markDone,
  markFailed,
  moveNode,
  newFlow,
  removeNote,
  setRetry,
  setSubSteps,
  updateContainer,
  updateNote,
  type Flow,
} from "./flowModel";
import { nodePrompt } from "./flowPrompt";
import { exportFlow, parseFlowFile } from "./flowFile";
import { rewriteRetryPrompt, suggestSubSteps } from "./flowAssist";

function sample(): Flow {
  let flow = newFlow("Todo app", 1_700_000_000_000);
  flow = addTool(flow, { name: "Claude Code", tier: "Pro", plans: [], billing: "subscription", sessions: null, prefer: false, windows: [], models: [] });
  flow = addAgentNode(flow, "Design the schema", "tool1");
  flow = addOutput(flow, "n1", "DB schema", "tables and keys");
  flow = addAgentNode(flow, "Build the API", "tool1");
  return flow;
}

describe("copying a step", () => {
  it("makes a fresh, unwired, not-done copy and tells its artifact apart", () => {
    let flow = markDone(sample(), "n1", "ok");
    flow = insertCopy(flow, flow.nodes[0], { x: 10, y: 20 });
    const copy = flow.nodes[flow.nodes.length - 1];
    expect(copy.id).not.toBe("n1");
    expect(copy.text).toBe("Design the schema");
    expect(copy.done).toBeUndefined();
    expect(copy.inputs).toEqual([]);
    expect(copy.pos).toEqual({ x: 10, y: 20 });
    expect(copy.outputs[0].label).toBe("DB schema (copy)");
  });

  it("drops a tool the target flow does not have, and never copies a Start", () => {
    const other = newFlow("Other", 1);
    const copy = insertCopy(other, sample().nodes[0], { x: 0, y: 0 }).nodes[0];
    expect(copy.toolId).toBeUndefined();
    const withStart = addStartNode(newFlow("S", 1));
    expect(insertCopy(other, withStart.nodes[0], { x: 0, y: 0 })).toBe(other);
  });
});

describe("notes and folded containers", () => {
  it("adds, edits and removes a note without unlocking", () => {
    let flow = { ...sample(), locked: true };
    flow = addNote(flow, { x: 8, y: 16 });
    const id = flow.notes![0].id;
    flow = updateNote(flow, id, { text: "why Claude here" });
    expect(flow.notes![0].text).toBe("why Claude here");
    expect(flow.locked).toBe(true);
    expect(removeNote(flow, id).notes).toEqual([]);
  });

  it("hides the steps whose middle sits inside a folded container", () => {
    let flow = moveNode(moveNode(sample(), "n1", { x: 100, y: 100 }), "n2", { x: 900, y: 900 });
    flow = addContainer(flow, { x: 0, y: 0 }, { w: 500, h: 400 });
    const cid = flow.containers![0].id;
    expect(hiddenByContainers(flow, { w: 256, h: 96 }).size).toBe(0);
    flow = updateContainer(flow, cid, { collapsed: true });
    const hidden = hiddenByContainers(flow, { w: 256, h: 96 });
    expect([...hidden.keys()]).toEqual(["n1"]);
    expect(hidden.get("n1")).toBe(cid);
  });
});

describe("sub-steps and the prompt", () => {
  it("hands the sub-steps to the tool's own subagents in the prompt", () => {
    const flow = setSubSteps(sample(), "n2", ["Write the routes", "Write the tests"]);
    expect(flow.nodes[1].sub).toHaveLength(2);
    const prompt = nodePrompt(flow, flow.nodes[1]);
    expect(prompt).toContain("1. Write the routes");
    expect(prompt).toContain("2. Write the tests");
    expect(prompt).toContain("subagent");
  });

  it("an AI-written retry replaces the plain one until the step is done", () => {
    let flow = markFailed(sample(), "n1", "boom");
    flow = setRetry(flow, "n1", "Try again, but start the database first.");
    expect(nodePrompt(flow, flow.nodes[0])).toBe("Try again, but start the database first.");
    const plain = setRetry(flow, "n1", undefined);
    expect(nodePrompt(plain, plain.nodes[0])).toContain("boom");
    const done = markDone(flow, "n1");
    expect(nodePrompt(done, done.nodes[0])).not.toContain("start the database");
  });
});

describe("workflow files", () => {
  it("round-trips a workflow as a new one", () => {
    const flow = addNote(sample(), { x: 0, y: 0 }, "hi");
    const back = parseFlowFile(exportFlow(flow), 5);
    expect(back.id).not.toBe(flow.id);
    expect(back.nodes).toEqual(flow.nodes);
    expect(back.notes).toEqual(flow.notes);
    expect(back.title).toBe("Todo app");
  });

  it("says what is wrong with a file that is not a workflow", () => {
    expect(() => parseFlowFile("nope")).toThrow(/not valid JSON/);
    expect(() => parseFlowFile(JSON.stringify({ hello: 1 }))).toThrow(/not a Soren workflow/);
    expect(() => parseFlowFile(JSON.stringify({ type: "soren-workflow", flow: { nodes: [{ id: "a", kind: "bogus" }] } }))).toThrow(/unknown kind/);
  });
});

describe("optional AI helpers", () => {
  it("writes a retry prompt from the error, and strips code fences", async () => {
    const flow = markFailed(sample(), "n1", "port 5432 refused");
    let seen = "";
    const text = await rewriteRetryPrompt(async (_s, p) => ((seen = p), "```\nStart postgres first.\n```"), flow, flow.nodes[0]);
    expect(seen).toContain("port 5432 refused");
    expect(text).toBe("Start postgres first.");
  });

  it("reads a list of sub-steps from the reply, and refuses anything else", async () => {
    const flow = sample();
    expect(await suggestSubSteps(async () => 'Here: ["Routes", " Tests ", 3]', flow, flow.nodes[1])).toEqual(["Routes", "Tests"]);
    await expect(suggestSubSteps(async () => "no list", flow, flow.nodes[1])).rejects.toThrow(/list/);
  });
});
