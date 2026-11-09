import { describe, expect, it } from "vitest";
import { addAgentNode, addOutput, addTool, newFlow, updateNode, wire, type Flow, type FlowNode } from "./flowModel";
import { nodePrompt } from "./flowPrompt";
import {
  acceptRewrite,
  acceptTemplateChange,
  addSegment,
  basePromptText,
  editSegment,
  promptSegments,
  rejectTemplateChange,
  resetPrompt,
} from "./flowPromptDoc";

function sample(): Flow {
  let flow = newFlow("Todo app", 1_700_000_000_000);
  flow = addTool(flow, { name: "Claude Code", tier: "Pro", plans: [], billing: "subscription", sessions: null, prefer: false, windows: [], models: [] });
  flow = addAgentNode(flow, "Design the schema", "tool1");
  flow = addOutput(flow, "n1", "DB schema", "tables and keys");
  flow = addAgentNode(flow, "Build the API", "tool1");
  flow = wire(flow, "n2", { node: "n1", port: "o1" });
  return flow;
}

const node = (flow: Flow, id: string): FlowNode => flow.nodes.find((n) => n.id === id)!;
const apply = (flow: Flow, id: string, patch: object | null): Flow => (patch ? updateNode(flow, id, patch as never) : flow);

describe("the template prompt", () => {
  it("is there with no model, and names the step, what it relies on and what it makes", () => {
    const flow = sample();
    const text = nodePrompt(flow, node(flow, "n2"));
    expect(text).toContain("Your step: Build the API");
    expect(text).toContain("DB schema: tables and keys");
    expect(text).toContain("Claude Code");
    const first = nodePrompt(flow, node(flow, "n1"));
    expect(first).toContain("these must exist");
  });

  it("is all template-authored until someone changes it, and stores nothing", () => {
    const flow = sample();
    const { segments, conflicts } = promptSegments(flow, node(flow, "n2"));
    expect(segments.every((s) => s.author === "template")).toBe(true);
    expect(conflicts).toEqual([]);
    expect(node(flow, "n2").segments).toBeUndefined();
  });

  it("follows the step's fields as they change", () => {
    const flow = updateNode(sample(), "n2", { text: "Build the REST API" });
    expect(nodePrompt(flow, node(flow, "n2"))).toContain("Your step: Build the REST API");
  });

  it("copies as plain text: the segments joined, with no marks", () => {
    let flow = sample();
    flow = apply(flow, "n2", addSegment(flow, node(flow, "n2"), "Use TypeScript."));
    const plain = nodePrompt(flow, node(flow, "n2"));
    expect(plain).toBe(basePromptText(flow, node(flow, "n2")));
    expect(plain).toContain("Use TypeScript.");
    expect(plain).not.toMatch(/template|\[you\]|\[ai\]/);
  });
});

describe("who wrote what", () => {
  it("a hand edit becomes yours and the rest stays the template's", () => {
    let flow = sample();
    const step = promptSegments(flow, node(flow, "n2")).segments.find((s) => s.key === "step")!;
    flow = apply(flow, "n2", editSegment(flow, node(flow, "n2"), step.id, "Your step: Build the API with Fastify"));
    const { segments } = promptSegments(flow, node(flow, "n2"));
    expect(segments.find((s) => s.key === "step")?.author).toBe("you");
    expect(segments.filter((s) => s.author === "template").length).toBeGreaterThan(0);
  });

  it("a field that changes later rewrites only template segments and leaves yours alone", () => {
    let flow = sample();
    const step = promptSegments(flow, node(flow, "n2")).segments.find((s) => s.key === "step")!;
    flow = apply(flow, "n2", editSegment(flow, node(flow, "n2"), step.id, "Your step: Build the API with Fastify"));
    flow = addOutput(flow, "n2", "API contract", "routes");
    const { segments, conflicts } = promptSegments(flow, node(flow, "n2"));
    expect(segments.find((s) => s.key === "makes")?.text).toContain("API contract");
    expect(segments.find((s) => s.key === "makes")?.author).toBe("template");
    expect(segments.find((s) => s.key === "step")?.text).toBe("Your step: Build the API with Fastify");
    expect(conflicts).toEqual([]);
  });

  it("offers a changed field as a diff when it would overwrite your words, and remembers a no", () => {
    let flow = sample();
    const step = promptSegments(flow, node(flow, "n2")).segments.find((s) => s.key === "step")!;
    flow = apply(flow, "n2", editSegment(flow, node(flow, "n2"), step.id, "Your step: Build the API with Fastify"));
    flow = updateNode(flow, "n2", { text: "Build the REST API" });
    const first = promptSegments(flow, node(flow, "n2"));
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0].proposed).toBe("Your step: Build the REST API");
    expect(first.segments.find((s) => s.key === "step")?.text).toBe("Your step: Build the API with Fastify");

    const kept = apply(flow, "n2", rejectTemplateChange(flow, node(flow, "n2"), first.conflicts[0]));
    expect(promptSegments(kept, node(kept, "n2")).conflicts).toEqual([]);
    expect(promptSegments(kept, node(kept, "n2")).segments.find((s) => s.key === "step")?.author).toBe("you");

    const taken = apply(flow, "n2", acceptTemplateChange(flow, node(flow, "n2"), first.conflicts[0]));
    const after = promptSegments(taken, node(taken, "n2"));
    expect(after.segments.find((s) => s.key === "step")).toMatchObject({ author: "template", text: "Your step: Build the REST API" });
    expect(after.conflicts).toEqual([]);
  });

  it("an accepted rewrite keeps unchanged paragraphs' authors and marks the new words as the model's", () => {
    let flow = sample();
    const base = basePromptText(flow, node(flow, "n2"));
    const blocks = base.split(/\n\s*\n/);
    const rewritten = blocks.map((b) => (b.startsWith("Your step:") ? "Your step: Build the API, keeping routes thin." : b)).join("\n\n");
    flow = apply(flow, "n2", acceptRewrite(flow, node(flow, "n2"), rewritten));
    const { segments } = promptSegments(flow, node(flow, "n2"));
    const step = segments.find((s) => s.text.startsWith("Your step:"))!;
    expect(step.author).toBe("ai");
    expect(step.key).toBe("step");
    expect(segments.some((s) => s.author === "template")).toBe(true);
    expect(basePromptText(flow, node(flow, "n2"))).toBe(rewritten);
  });

  it("an older written prompt reads as one model-written segment, and Back to the template drops it", () => {
    let flow = sample();
    flow = updateNode(flow, "n2", { prompt: "Old written prompt." });
    const { segments } = promptSegments(flow, node(flow, "n2"));
    expect(segments).toMatchObject([{ author: "ai", text: "Old written prompt." }]);
    flow = apply(flow, "n2", resetPrompt());
    expect(promptSegments(flow, node(flow, "n2")).segments.every((s) => s.author === "template")).toBe(true);
  });
});
