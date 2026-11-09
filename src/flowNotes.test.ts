import { describe, expect, it } from "vitest";
import { addAgentNode, addTool, hiddenNotes, newFlow, noteSize, notesInside, removeNote, setNotesInside, stackNotes, STACK_SIZE, updateNote, type Flow } from "./flowModel";
import { ensurePositions } from "./flowLayout";
import { expandStack, leaveNotes, noteFit } from "./flowNotes";
import { addNote, setSub, subFlow, updateNoteStack } from "./flowModel";

function sample(): Flow {
  let flow = newFlow("Todo app", 1_700_000_000_000);
  flow = addTool(flow, { name: "Claude Code", tier: "Pro", plans: [], billing: "subscription", sessions: null, prefer: false, windows: [], models: [] });
  flow = addAgentNode(flow, "Design the schema", "tool1");
  return ensurePositions(flow);
}

const rects = (flow: Flow, stackId: string) => [
  ...flow.noteStacks!.filter((s) => s.id === stackId).map((s) => ({ id: `stack:${s.id}`, x: s.x, y: s.y, ...STACK_SIZE })),
  ...stackNotes(flow, stackId).map((n) => ({ id: n.id, x: n.x, y: n.y, ...noteSize(n) })),
];
const touch = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("notes container", () => {
  const lines = Array.from({ length: 9 }, (_, i) => ({ text: `Step ${i + 1}: add a long enough sentence that it has to wrap over several lines of a note`, touched: i === 0 ? "n1" : null }));

  it("keeps every note, sized to its text, and none of them touch", () => {
    const flow = leaveNotes(sample(), { x: 0, y: 0 }, "Build the whole thing", lines);
    expect(flow.noteStacks).toHaveLength(1);
    const stack = flow.noteStacks![0];
    expect(stack.title).toBe("Build the whole thing");
    expect(stackNotes(flow, stack.id)).toHaveLength(9);
    expect(stackNotes(flow, stack.id).every((n) => n.text.length > 0 && !n.text.includes("more changes"))).toBe(true);
    for (const n of stackNotes(flow, stack.id)) expect(noteSize(n).h).toBeGreaterThanOrEqual(noteFit(n.text).h);
    const all = rects(flow, stack.id);
    const step = { id: "n1", x: flow.nodes[0].pos!.x, y: flow.nodes[0].pos!.y, w: 192, h: 96 };
    for (let i = 0; i < all.length; i += 1) {
      expect(touch(all[i], step)).toBe(false);
      for (let j = i + 1; j < all.length; j += 1) expect(touch(all[i], all[j])).toBe(false);
    }
  });

  it("a turn's notes are all held inside the card, not spread on the workflow", () => {
    const flow = leaveNotes(sample(), { x: 0, y: 0 }, "Build it", lines);
    expect(flow.noteStacks![0].expanded).toBe(false);
    expect(hiddenNotes(flow).size).toBe(9);
  });

  it("a second turn does not land on the first once both are expanded", () => {
    let flow = leaveNotes(sample(), { x: 0, y: 0 }, "First", lines);
    flow = leaveNotes(flow, { x: 0, y: 0 }, "Second", lines.slice(0, 4));
    flow = expandStack(expandStack(flow, flow.noteStacks![0].id), flow.noteStacks![1].id);
    const [a, b] = flow.noteStacks!;
    const first = rects(flow, a.id);
    const second = rects(flow, b.id);
    for (const p of first) for (const q of second) expect(touch(p, q)).toBe(false);
  });

  it("shrinking hides the notes, expanding puts them back without overlap", () => {
    let flow = leaveNotes(sample(), { x: 0, y: 0 }, "First", lines);
    const id = flow.noteStacks![0].id;
    flow = updateNoteStack(flow, id, { expanded: false });
    expect(hiddenNotes(flow).size).toBe(9);
    // Something is put where the notes used to be.
    const first = stackNotes(flow, id)[0];
    flow = leaveNotes(flow, { x: first.x, y: first.y }, "Second", lines.slice(0, 3));
    flow = expandStack(flow, id);
    // Only the second turn's three notes are still folded into their card.
    expect(hiddenNotes(flow).size).toBe(3);
    flow = expandStack(flow, flow.noteStacks![1].id);
    expect(hiddenNotes(flow).size).toBe(0);
    const all = [...rects(flow, id), ...rects(flow, flow.noteStacks![1].id)];
    for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < all.length; j += 1) if (all[i].id !== all[j].id) expect(touch(all[i], all[j])).toBe(false);
  });

  it("the inside is a tidy grid, and edits come back without moving the notes", () => {
    let flow = leaveNotes(sample(), { x: 0, y: 0 }, "First", lines.slice(0, 4));
    const id = flow.noteStacks![0].id;
    const before = stackNotes(flow, id).map((n) => ({ x: n.x, y: n.y }));
    let inside = notesInside(flow, id);
    expect(inside.notes).toHaveLength(4);
    inside = updateNote(inside, inside.notes![0].id, { text: "Reworded" });
    flow = setNotesInside(flow, id, inside);
    expect(stackNotes(flow, id)[0].text).toBe("Reworded");
    expect(stackNotes(flow, id).map((n) => ({ x: n.x, y: n.y }))).toEqual(before);
  });

  it("deleting the last note takes the card with it, and its lines", () => {
    let flow = leaveNotes(sample(), { x: 0, y: 0 }, "First", lines.slice(0, 2));
    for (const n of stackNotes(flow, flow.noteStacks![0].id)) flow = removeNote(flow, n.id);
    expect(flow.noteStacks).toEqual([]);
    expect(flow.noteLinks).toEqual([]);
  });
});

describe("a step's inside shows its notes", () => {
  it("shows the notes linked to the step, and writes edits and new notes back", () => {
    let flow = leaveNotes(sample(), { x: 0, y: 0 }, "Ask", [{ text: "About the first step", touched: "n1" }, { text: "Elsewhere", touched: null }]);
    let inside = subFlow(flow, "n1");
    expect(inside.notes?.map((n) => n.text)).toEqual(["About the first step"]);
    inside = updateNote(inside, inside.notes![0].id, { text: "Reworded" });
    inside = addNote(inside, { x: 300, y: 0 }, "Made inside", "yellow");
    flow = setSub(flow, "n1", inside);
    expect(flow.notes?.map((n) => n.text)).toEqual(["Reworded", "Elsewhere", "Made inside"]);
    expect(subFlow(flow, "n1").notes?.map((n) => n.text)).toEqual(["Reworded", "Made inside"]);
  });
});
