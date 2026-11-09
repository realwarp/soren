import { describe, expect, it } from "vitest";
import {
  addAsk,
  addAskField,
  answerAsk,
  applyQuestionnaire,
  askPorts,
  askState,
  askVariables,
  canWireAsk,
  fillForAsk,
  isSatisfied,
  parseQuestionnaire,
  pendingAsks,
  translatedText,
  translatorState,
  unwireAsk,
  wireAsk,
  wireTranslator,
  blockedByAsks,
  clearAnswer,
  fillVariables,
  isAnswered,
  isSkipped,
  removeAsk,
  skipAsk,
  slug,
  updateAsk,
  updateAskField,
} from "./flowAsk";
import { addAgentNode, addTool, addTranslatorNode, doneOf, flowIssues, isReady, markDone, newFlow, readyNodes, reopen, updateNode, wire, addOutput, type Flow } from "./flowModel";
import { nodePrompt, criticPrompt } from "./flowPrompt";
import { approveAnyway, criticPhase, newCritic, readVerdict, submitMade, submitVerdict } from "./flowCritic";

function base(): Flow {
  let flow = newFlow("App", 1_700_000_000_000);
  flow = addTool(flow, { name: "Claude Code", tier: "Pro", plans: [], billing: "subscription", sessions: null, prefer: false, windows: [], models: [] });
  flow = addAgentNode(flow, "Set up the database with {db}", "tool1");
  flow = addOutput(flow, "n1", "Schema", "tables");
  flow = addAgentNode(flow, "Write the migrations", "tool1");
  flow = wire(flow, "n2", { node: "n1", port: "o1" });
  return flow;
}

/** A decision named db, answered or not. */
function withDecision(answer?: string): Flow {
  let flow = addAsk(base(), "decision", { x: 0, y: 0 });
  flow = updateAskField(flow, "ask1", "f1", { label: "Which database?", type: "choice", options: ["postgres", "sqlite"] });
  return answer ? answerAsk(flow, "ask1", { f1: answer }) : flow;
}

describe("squares and variables", () => {
  it("names a variable from the question until the person names it", () => {
    expect(slug("Which database?")).toBe("which_database");
    let flow = addAsk(base(), "input", { x: 0, y: 0 });
    flow = updateAskField(flow, "ask1", "f1", { label: "Which database?" });
    expect(flow.asks![0].fields[0].name).toBe("which_database");
    flow = updateAskField(flow, "ask1", "f1", { name: "db" });
    flow = updateAskField(flow, "ask1", "f1", { label: "Pick a database" });
    expect(flow.asks![0].fields[0].name).toBe("db");
    expect(flow.asks![0].title).toBe("Pick a database");
  });

  it("keeps variable names unique across squares", () => {
    let flow = addAsk(addAsk(base(), "input", { x: 0, y: 0 }), "input", { x: 0, y: 0 });
    flow = updateAskField(flow, "ask1", "f1", { name: "db" });
    flow = updateAskField(flow, "ask2", "f1", { name: "db" });
    expect([...askVariables(flow).keys()].sort()).toEqual(["db", "db_2"]);
  });

  it("answers, skips only optional squares, and clears", () => {
    let flow = addAsk(base(), "input", { x: 0, y: 0 });
    expect(isAnswered(flow.asks![0])).toBe(false);
    expect(skipAsk(flow, "ask1").asks![0].skipped).toBeUndefined();
    flow = updateAsk(flow, "ask1", { optional: true });
    expect(isAnswered(skipAsk(flow, "ask1").asks![0])).toBe(true);
    flow = answerAsk(flow, "ask1", { f1: "hello" });
    expect(isAnswered(flow.asks![0])).toBe(true);
    expect(isAnswered(clearAnswer(flow, "ask1").asks![0])).toBe(false);
  });

  it("writes answers into text, leaves other braces alone, and drops lines with no answer", () => {
    let flow = updateNode(withDecision("postgres"), "n1", { text: "Use {db}.\nKeep {code} as it is." });
    flow = updateAskField(flow, "ask1", "f1", { name: "db" });
    expect(fillVariables(flow, "Use {db}.\nKeep {code} as it is.")).toBe("Use postgres.\nKeep {code} as it is.");
    const open = updateAskField(withDecision(), "ask1", "f1", { name: "db" });
    expect(fillVariables(open, "Use {db}.\nAlways here.")).toBe("Always here.");
  });

  it("fills variables in a step's prompt", () => {
    const flow = updateAskField(withDecision("sqlite"), "ask1", "f1", { name: "db" });
    expect(nodePrompt(flow, flow.nodes[0])).toContain("Set up the database with sqlite");
  });

  it("removing a square drops the steps' needs for it", () => {
    let flow = updateNode(addAsk(base(), "input", { x: 0, y: 0 }), "n1", { asks: [{ ask: "ask1" }] });
    flow = removeAsk(flow, "ask1");
    expect(flow.nodes[0].asks).toEqual([]);
    expect(flow.asks).toEqual([]);
  });

  it("flags two squares that make the same name and a condition on a name nobody makes", () => {
    let flow = addAsk(addAsk(base(), "input", { x: 0, y: 0 }), "input", { x: 0, y: 0 });
    flow = { ...flow, asks: flow.asks!.map((a) => ({ ...a, fields: a.fields.map((f) => ({ ...f, name: "db" })) })) };
    flow = updateNode(flow, "n2", { when: { name: "nope", equals: "x" } });
    const kinds = flowIssues(flow).map((i) => i.kind);
    expect(kinds).toContain("duplicate-variable");
    expect(kinds).toContain("unknown-variable");
  });
});

describe("what a step waits for from the person", () => {
  it("a required ask holds a step, an optional one does not", () => {
    let flow = addAsk(base(), "input", { x: 0, y: 0 });
    flow = updateNode(flow, "n1", { asks: [{ ask: "ask1" }] });
    expect(blockedByAsks(flow, flow.nodes[0])).toBe(true);
    expect(isReady(flow, flow.nodes[0])).toBe(false);
    flow = updateNode(flow, "n1", { asks: [{ ask: "ask1", optional: true }] });
    expect(isReady(flow, flow.nodes[0])).toBe(true);
    flow = updateNode(flow, "n1", { asks: [{ ask: "ask1" }] });
    expect(isReady(answerAsk(flow, "ask1", { f1: "x" }), flow.nodes[0])).toBe(true);
  });

  it("a condition waits for its answer, then runs the step or skips it and its branch", () => {
    let flow = updateAskField(withDecision(), "ask1", "f1", { name: "db" });
    flow = updateNode(flow, "n1", { when: { name: "db", equals: "postgres" } });
    expect(isReady(flow, flow.nodes[0])).toBe(false);
    const yes = answerAsk(flow, "ask1", { f1: "postgres" });
    expect(isReady(yes, yes.nodes[0])).toBe(true);
    const no = answerAsk(flow, "ask1", { f1: "sqlite" });
    expect(isSkipped(no, no.nodes[0])).toBe(true);
    // The step after it only waits for the skipped one, so it is skipped too, and the branch counts as done.
    expect(isSkipped(no, no.nodes[1])).toBe(true);
    expect(doneOf(no, no.nodes[1])).toBe(true);
    expect(readyNodes(no)).toEqual([]);
  });

  it("a step that also has other inputs is not skipped with one branch", () => {
    let flow = updateAskField(withDecision("sqlite"), "ask1", "f1", { name: "db" });
    flow = updateNode(flow, "n1", { when: { name: "db", equals: "postgres" } });
    flow = addAgentNode(flow, "Other work", "tool1");
    flow = addOutput(flow, "n3", "Other", "x");
    flow = wire(flow, "n2", { node: "n3", port: "o1" });
    expect(isSkipped(flow, flow.nodes[1])).toBe(false);
  });
});

describe("critic loop", () => {
  function criticFlow(): Flow {
    return updateNode(base(), "n1", { critic: { ...newCritic(), maxRounds: 2, criteria: "no raw SQL" } });
  }

  it("goes make, review, then back to make with the reasons in the next prompt", () => {
    let flow = criticFlow();
    expect(criticPhase(flow.nodes[0])).toBe("make");
    flow = submitMade(flow, "n1", "CREATE TABLE users");
    expect(criticPhase(flow.nodes[0])).toBe("review");
    expect(criticPrompt(flow, flow.nodes[0])).toContain("CREATE TABLE users");
    expect(criticPrompt(flow, flow.nodes[0])).toContain("no raw SQL");
    flow = submitVerdict(flow, "n1", "revise", "Use the query builder.");
    expect(criticPhase(flow.nodes[0])).toBe("make");
    const prompt = nodePrompt(flow, flow.nodes[0]);
    expect(prompt).toContain("Use the query builder.");
    expect(prompt).toContain("round 2");
  });

  it("approval finishes the step with the approved attempt", () => {
    let flow = submitMade(criticFlow(), "n1", "good work");
    flow = submitVerdict(flow, "n1", "approve");
    expect(flow.nodes[0].done?.pasted).toBe("good work");
  });

  it("runs out of rounds, then the person can approve anyway; reopening starts over", () => {
    let flow = criticFlow();
    for (let i = 0; i < 2; i += 1) flow = submitVerdict(submitMade(flow, "n1", `try ${i}`), "n1", "revise", "no");
    expect(criticPhase(flow.nodes[0])).toBe("limit");
    flow = approveAnyway(flow, "n1");
    expect(flow.nodes[0].done?.pasted).toBe("try 1");
    expect(reopen(flow, "n1").nodes[0].critic?.rounds).toEqual([]);
    expect(criticPhase(markDone(reopen(flow, "n1"), "n1").nodes[0])).toBe("done");
  });

  it("reads APPROVE or REVISE from the first line of a reply", () => {
    expect(readVerdict("APPROVE\nlooks fine")).toEqual({ verdict: "approve", reasons: "looks fine" });
    expect(readVerdict("Revise.\n1. add tests")).toEqual({ verdict: "revise", reasons: "1. add tests" });
    expect(readVerdict("hmm, maybe")).toBeNull();
  });
});

describe("a form", () => {
  it("holds several questions and is answered only when all are", () => {
    let flow = addAsk(base(), "form", { x: 0, y: 0 });
    flow = addAskField(flow, "ask1");
    expect(flow.asks![0].fields).toHaveLength(2);
    flow = answerAsk(flow, "ask1", { f1: "a" });
    expect(isAnswered(flow.asks![0])).toBe(false);
    flow = answerAsk(flow, "ask1", { f2: "b" });
    expect(isAnswered(flow.asks![0])).toBe(true);
  });
});


describe("wires between squares", () => {
  function two(): Flow {
    return addAsk(addAsk(base(), "input", { x: 0, y: 0 }), "input", { x: 300, y: 0 });
  }

  it("a square is asked only after the ones wired into it", () => {
    let flow = wireAsk(two(), "ask2", { ask: "ask1" });
    expect(askState(flow, flow.asks![1])).toBe("locked");
    expect(pendingAsks(flow).map((a) => a.id)).toEqual(["ask1"]);
    flow = answerAsk(flow, "ask1", { f1: "hi" });
    expect(askState(flow, flow.asks![1])).toBe("open");
    expect(pendingAsks(flow).map((a) => a.id)).toEqual(["ask2"]);
  });

  it("a Decision offers a port per choice, and only the chosen branch is asked", () => {
    let flow = addAsk(addAsk(addAsk(base(), "decision", { x: 0, y: 0 }), "input", { x: 300, y: 0 }), "input", { x: 300, y: 200 });
    expect(askPorts(flow.asks![0]).map((p) => p.port)).toEqual(["yes", "no"]);
    flow = wireAsk(wireAsk(flow, "ask2", { ask: "ask1", port: "yes" }), "ask3", { ask: "ask1", port: "no" });
    expect(askState(flow, flow.asks![1])).toBe("locked");
    flow = answerAsk(flow, "ask1", { f1: "yes" });
    expect(askState(flow, flow.asks![1])).toBe("open");
    expect(askState(flow, flow.asks![2])).toBe("skipped");
    expect(isSatisfied(flow, flow.asks![2])).toBe(true);
  });

  it("a skipped branch takes the squares after it along", () => {
    let flow = addAsk(addAsk(addAsk(base(), "decision", { x: 0, y: 0 }), "input", { x: 0, y: 0 }), "input", { x: 0, y: 0 });
    flow = wireAsk(wireAsk(flow, "ask2", { ask: "ask1", port: "yes" }), "ask3", { ask: "ask2" });
    flow = answerAsk(flow, "ask1", { f1: "no" });
    expect(askState(flow, flow.asks![2])).toBe("skipped");
  });

  it("lets a square read the answers of the squares wired into it, and only those", () => {
    let flow = two();
    flow = updateAskField(flow, "ask1", "f1", { name: "db" });
    flow = answerAsk(flow, "ask1", { f1: "postgres" });
    expect(fillForAsk(flow, flow.asks![1], "Why {db}?")).toBe("Why {db}?");
    flow = wireAsk(flow, "ask2", { ask: "ask1" });
    expect(fillForAsk(flow, flow.asks![1], "Why {db}?")).toBe("Why postgres?");
  });

  it("refuses a loop, a wire to itself, and a repeat", () => {
    let flow = wireAsk(two(), "ask2", { ask: "ask1" });
    expect(canWireAsk(flow, "ask2", "ask1")).toBe(false);
    expect(canWireAsk(flow, "ask1", "ask1")).toBe(false);
    expect(wireAsk(flow, "ask1", { ask: "ask2" })).toBe(flow);
    expect(wireAsk(flow, "ask2", { ask: "ask1" }).asks![1].inputs).toHaveLength(1);
    flow = unwireAsk(flow, "ask2", { ask: "ask1" });
    expect(flow.asks![1].inputs).toEqual([]);
  });

  it("removing a square takes the wires into it away", () => {
    const flow = removeAsk(wireAsk(two(), "ask2", { ask: "ask1" }), "ask1");
    expect(flow.asks![0].inputs).toEqual([]);
    expect(flow.asks!.map((a) => a.id)).toEqual(["ask2"]);
  });
});

describe("the translator", () => {
  function translated(): Flow {
    let flow = addAsk(base(), "decision", { x: 0, y: 0 });
    flow = updateAskField(flow, "ask1", "f1", { label: "Which database?" });
    flow = addTranslatorNode(flow);
    const id = flow.nodes[flow.nodes.length - 1].id;
    flow = wireTranslator(flow, id, { ask: "ask1", port: "yes" });
    return wire(flow, "n1", { node: id, port: "o1" });
  }

  it("waits for its square, then hands the steps after it the answer in words", () => {
    let flow = translated();
    const t = flow.nodes[flow.nodes.length - 1];
    expect(translatorState(flow, t)).toBe("waiting");
    expect(doneOf(flow, t)).toBe(false);
    expect(isReady(flow, flow.nodes[0])).toBe(false);
    flow = answerAsk(flow, "ask1", { f1: "yes" });
    expect(doneOf(flow, t)).toBe(true);
    expect(isReady(flow, flow.nodes[0])).toBe(true);
    expect(translatedText(flow, t)).toBe("- Which database?: yes");
    expect(nodePrompt(flow, flow.nodes[0])).toContain("Which database?: yes");
  });

  it("is skipped when its branch is not taken, and the steps that wait only for it with it", () => {
    let flow = translated();
    flow = answerAsk(flow, "ask1", { f1: "no" });
    const t = flow.nodes[flow.nodes.length - 1];
    expect(translatorState(flow, t)).toBe("skipped");
    expect(isSkipped(flow, flow.nodes[0])).toBe(true);
    expect(doneOf(flow, flow.nodes[0])).toBe(true);
  });

  it("is flagged when nothing is wired into it", () => {
    const flow = wire(addTranslatorNode(base()), "n1", { node: "n3", port: "o1" });
    expect(flowIssues(flow).map((i) => i.kind)).toContain("translator-empty");
  });
});

describe("a questionnaire from the AI", () => {
  const reply = JSON.stringify({
    questions: [
      { id: "q1", question: "Is this for a team?", kind: "decision", type: "yesno" },
      { id: "q2", question: "How big is the team?", type: "text", after: [{ from: "q1", port: "yes" }] },
      { id: "q3", question: "Who will review it?", type: "text", after: [{ from: "q1", port: "no" }] },
    ],
  });

  it("is drawn as squares and wires, branching from the decision", () => {
    const plan = parseQuestionnaire(`Here you go:\n${reply}`);
    const flow = applyQuestionnaire(base(), plan, { x: 0, y: 0 });
    expect(flow.asks).toHaveLength(3);
    expect(flow.asks![0].kind).toBe("decision");
    expect(flow.asks![1].inputs).toEqual([{ ask: "ask1", port: "yes" }]);
    expect(flow.asks![2].inputs).toEqual([{ ask: "ask1", port: "no" }]);
    expect(flow.asks![1].pos.x).toBeGreaterThan(flow.asks![0].pos.x);
  });

  it("refuses a questionnaire that does not hold together", () => {
    const bad = (questions: unknown[]) => () => parseQuestionnaire(JSON.stringify({ questions }));
    expect(() => parseQuestionnaire("no json here")).toThrow(/did not send/);
    expect(bad([{ id: "a", question: "Q?", after: [{ from: "zzz" }] }])).toThrow(/earlier question/);
    expect(
      bad([
        { id: "a", question: "Q?", kind: "decision", type: "yesno" },
        { id: "b", question: "R?", after: [{ from: "a", port: "maybe" }] },
      ]),
    ).toThrow(/does not exist/);
    expect(bad([{ id: "a", question: "Q?", type: "choice", options: ["only one"] }])).toThrow(/two options/);
  });
});
