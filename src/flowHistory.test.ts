import { beforeEach, describe, expect, it } from "vitest";
import { MAX_TURNS, forgetHistory, loadHistory, recordDecisions, recordTurn, resetHistoryCache } from "./flowHistory";
import { emptyAnswer } from "./flowDecisions";

const turn = (ask: string) => ({ ask, reply: "ok", decisions: [], outcome: "answered" as const, changes: [] });

describe("workflow history", () => {
  beforeEach(() => {
    resetHistoryCache();
    forgetHistory("a");
    forgetHistory("b");
  });

  it("lists the newest turn first and keeps each workflow apart", () => {
    recordTurn("a", turn("first"), 1000);
    recordTurn("a", turn("second"), 2000);
    recordTurn("b", turn("other"), 3000);
    expect(loadHistory("a").map((t) => t.ask)).toEqual(["second", "first"]);
    expect(loadHistory("b").map((t) => t.ask)).toEqual(["other"]);
  });

  it("returns the same list until something is added", () => {
    recordTurn("a", turn("one"), 1);
    expect(loadHistory("a")).toBe(loadHistory("a"));
  });

  it("drops the oldest turns past the limit", () => {
    for (let i = 0; i < MAX_TURNS + 5; i += 1) recordTurn("a", turn(`ask ${i}`), i);
    const turns = loadHistory("a");
    expect(turns).toHaveLength(MAX_TURNS);
    expect(turns[0].ask).toBe(`ask ${MAX_TURNS + 4}`);
  });

  it("forgets a deleted workflow", () => {
    recordTurn("a", turn("gone soon"), 1);
    forgetHistory("a");
    expect(loadHistory("a")).toEqual([]);
  });

  it("writes the Asker's answers as plain lines", () => {
    const lines = recordDecisions(
      [
        { question: "One app or two?", options: ["One", "Two"] },
        { question: "Which database?", options: ["SQLite", "Postgres"] },
      ],
      [{ ...emptyAnswer(), picked: ["One"] }, { ...emptyAnswer(), skipped: true }],
    );
    expect(lines).toEqual([
      { question: "One app or two?", answer: "One" },
      { question: "Which database?", answer: "Left to the agent" },
    ]);
  });
});
