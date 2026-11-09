import { describe, expect, it } from "vitest";
import { addAgentNode, addEndNode, addOutput, addStartNode, newFlow, planOrder, wire, collatedDoc, type Flow } from "./flowModel";

/** Steps n1..nN as agents, each making one artifact, wired as `after` says: { n2: ["n1"] } means n2 waits for n1. */
function graph(count: number, after: Record<string, string[]>): Flow {
  let flow = newFlow("t", 1);
  for (let i = 1; i <= count; i++) flow = addOutput(addAgentNode(flow, `step ${i}`), `n${i}`, `art ${i}`);
  for (const [to, froms] of Object.entries(after)) for (const from of froms) flow = wire(flow, to, { node: from, port: "o1" });
  return flow;
}

const labels = (flow: Flow) => Object.fromEntries(planOrder(flow).map((s) => [s.node.id, s.label]));

describe("planOrder", () => {
  it("numbers a plain chain 1, 2, 3", () => {
    expect(labels(graph(3, { n2: ["n1"], n3: ["n2"] }))).toEqual({ n1: "1", n2: "2", n3: "3" });
  });

  it("splits parallel steps into A and B, splits a branch again, and rejoins", () => {
    // 1 -> 2A, 2B ; 2A -> 3A ; 2B -> 3BA, 3BB ; all three -> 4
    const flow = graph(7, { n2: ["n1"], n3: ["n1"], n4: ["n2"], n5: ["n3"], n6: ["n3"], n7: ["n4", "n5", "n6"] });
    expect(labels(flow)).toEqual({ n1: "1", n2: "2A", n3: "2B", n4: "3A", n5: "3BA", n6: "3BB", n7: "4" });
  });

  it("reads in plan order, not the order the steps were made", () => {
    const flow = graph(4, { n2: ["n1"], n3: ["n1"], n4: ["n2", "n3"] });
    expect(planOrder(flow).map((s) => s.label)).toEqual(["1", "2A", "2B", "3"]);
  });

  it("names a step that rejoins only part of a split by the branch it rejoins", () => {
    // 1 -> 2A, 2B ; 2B -> 3BA, 3BB ; 4 waits for both halves of B but not for 2A
    const flow = graph(6, { n2: ["n1"], n3: ["n1"], n4: ["n3"], n5: ["n3"], n6: ["n4", "n5"] });
    expect(labels(flow).n6).toBe("4B");
  });

  it("never gives two steps the same name, and does not hang on a loop", () => {
    const flow = graph(3, { n1: ["n3"], n2: ["n1"], n3: ["n2"] });
    const names = planOrder(flow).map((s) => s.label);
    expect(new Set(names).size).toBe(names.length);
  });

  it("looks through the Start and End, which are not steps", () => {
    let flow = graph(2, {});
    flow = addStartNode(flow);
    flow = addOutput(flow, "n3", "x");
    flow = wire(wire(flow, "n1", { node: "n3", port: "o1" }), "n2", { node: "n3", port: "o1" });
    flow = addEndNode(flow);
    expect(Object.values(labels(flow)).sort()).toEqual(["1A", "1B"]);
  });

  it("writes the plan name into the document, and 'from' with the name of the step it needs", () => {
    const flow = graph(3, { n2: ["n1"], n3: ["n1"] });
    const doc = collatedDoc(flow);
    expect(doc).toContain("## 2A. step 2");
    expect(doc).toContain("## 2B. step 3");
    expect(doc).toContain("(from 1)");
  });
});
