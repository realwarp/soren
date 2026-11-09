import { describeGraph } from "./flowCloud";
import { oneLine } from "./flowNotes";
import { readDecisions, type DecisionQuestion } from "./flowDecisions";
import type { Flow } from "./flowModel";

export { leaveNotes, oneLine } from "./flowNotes";

/**
 * The agent you talk to from the canvas. There is no thread: you say one thing where you double-clicked, the agent
 * answers in one line, and both lines are left on the canvas as notes. The notes are the only memory, so they are
 * short and written for the next agent to read.
 */

const AGENT_SYSTEM = `You work inside a workflow canvas, beside the person who is looking at it.
You get the workflow (one line per step: id [kind · tool] text | needs | makes), the notes already left on the canvas (one line each, written by earlier agents and by the person), and one request.
Answer in ONE line of plain words, 140 characters at most: what you found, or what you are about to do. Write it as a note for the next agent to read, not as a chat message. No greeting, no markdown.
When the person asks you to change or build something in the workflow (add, remove, delete, clear, reword, rewire steps, change everything, start over, or a whole goal like \"build a harness\"), you MUST call the change_workflow tool; saying you will do it in your line is not doing it, only the tool changes the graph. "Delete the workflow" and "change everything" are changes: call the tool, and say in your line what you are changing. Give the tool the person's whole goal with every detail they gave, not a shortened version: the editor turns a goal into all the steps it takes. The change is drawn for them to look over before it is kept. Do not call it for questions.
Before you call it, ask yourself whether the request hides a MAJOR decision: one that changes the graph's shape (adding, splitting, removing or reordering steps, or choosing between structurally different approaches) and that the person has not already settled in the request or the notes. If so, pass those in the tool's decisions list (at most 4, each with 2 to 4 short options) so the person answers them first. Never ask about wording or small details. If nothing major is open, leave decisions out.`;

export interface AgentReply {
  /** What to leave on the canvas for the next agent. */
  line: string;
  /** An instruction for the graph editor, when the person asked for a change. */
  change: string | null;
  /** Major decisions to put to the person before the change is drawn. Empty when there are none. */
  decisions: DecisionQuestion[];
}

const QUESTION_START = /^\s*(what|why|how|which|who|when|where|is|are|does|do|did|can you (tell|explain)|could you (tell|explain)|explain|tell me|summari[sz]e|describe|show me)\b/i;
const ORDER_WORDS = /\b(delete|remove|clear|wipe|erase|redo|rebuild|replace|rewrite|reword|rewire|change|add|build|make|create|split|merge|reorder|rename|swap|drop|start over|get rid)\b/i;

/** True when the request reads as an instruction to change the workflow, not a question about it. */
export function looksLikeOrder(request: string): boolean {
  return ORDER_WORDS.test(request) && !QUESTION_START.test(request);
}

/** Ask the chat model one thing about the workflow: one line back, and a change to draw when it called the tool. */
export async function askAgent(ask: (system: string, prompt: string) => Promise<{ text: string; change: string | null; decisions?: unknown }>, flow: Flow, request: string): Promise<AgentReply> {
  // Each notes container is read as what was asked, then what the agent did about it; loose notes come last.
  const stacks = flow.noteStacks ?? [];
  const notes = [
    ...stacks.flatMap((s) => [`Asked: ${s.title}`, ...(flow.notes ?? []).filter((n) => n.stack === s.id && !n.diff).map((n) => n.text)]),
    ...(flow.notes ?? []).filter((n) => !n.diff && (!n.stack || !stacks.some((s) => s.id === n.stack))).map((n) => n.text),
  ]
    .map((t) => t.trim())
    .filter(Boolean);
  const tools = flow.tools.map((t) => t.name).join(", ");
  const prompt = [
    `Workflow: ${flow.title || "untitled"}`,
    tools ? `Tools: ${tools}` : "",
    "Graph:",
    describeGraph(flow) || "(no steps yet)",
    notes.length ? `Notes on the canvas:\n${notes.map((t) => `- ${oneLine(t)}`).join("\n")}` : "",
    "",
    `Request: ${request.trim()}`,
  ]
    .filter((line, i) => line !== "" || i > 0)
    .join("\n");
  const reply = await ask(AGENT_SYSTEM, prompt);
  // The chat model sometimes answers an order in words and forgets the tool. An order is still an order: hand the
  // request itself to the editor. Nothing changes until the person applies the drawn result.
  const change = reply.change?.trim() || (looksLikeOrder(request) ? request.trim() : null);
  const line = oneLine(reply.text) || (change ? oneLine(change) : "");
  if (!line) throw new Error("The agent sent back nothing.");
  return { line, change, decisions: change ? readDecisions(reply.decisions) : [] };
}
