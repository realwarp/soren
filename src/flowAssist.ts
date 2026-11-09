import { effectiveModel, type Flow, type FlowNode } from "./flowModel";
import { nodePrompt } from "./flowPrompt";
import { parseQuestionnaire, type Questionnaire } from "./flowAsk";
import type { Complete } from "./flowCloud";

/**
 * Two optional helpers that ask the cloud model for one thing each. Nothing here runs by itself:
 * the person presses a button, one request goes out, and what comes back is shown for them to keep or drop.
 */

const RETRY_SYSTEM =
  "You write prompts for coding agents. A step of a larger plan was tried and failed. " +
  "Write the prompt to try that step again: say what the step is, what went wrong in the last attempt and the likely cause, " +
  "what to change this time, and what must exist when it is done. Keep it under 250 words. " +
  "Reply with the prompt only, with no preface and no code fences around it.";

/** A retry prompt that reads the error and plans around it, instead of the plain template with the error attached. */
export async function rewriteRetryPrompt(complete: Complete, flow: Flow, node: FlowNode): Promise<string> {
  const failed = node.failed;
  const model = effectiveModel(flow, node);
  const tool = flow.tools.find((t) => t.id === node.toolId);
  const original = nodePrompt({ ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? { ...n, failed: undefined } : n)) }, { ...node, failed: undefined });
  const prompt = [
    `Workflow: ${flow.title || "untitled"}`,
    `Step: ${node.text}`,
    tool ? `Tool: ${tool.name}${model ? `, model ${model.name}` : ""}` : "",
    `Attempts so far: ${failed?.attempts ?? 1}`,
    "",
    "The prompt that was used:",
    original,
    "",
    "What the person saw when it failed:",
    failed?.error || "(nothing was pasted)",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  const text = (await complete(RETRY_SYSTEM, prompt, 1200)).trim();
  if (!text) throw new Error("The model sent back nothing.");
  return text.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
}

const SUBSTEP_SYSTEM =
  "You split one step of a coding workflow into parts that a main model can hand to subagents. " +
  "Give 2 to 6 parts. Each is one short sentence naming what that subagent does and what it hands back. " +
  "Parts must not depend on each other. Reply with a JSON array of strings and nothing else.";

/** Plain-language sub-steps for a step, for the person to look over and edit. */
export async function suggestSubSteps(complete: Complete, flow: Flow, node: FlowNode): Promise<string[]> {
  const made = node.outputs.map((p) => `${p.label}${p.note ? ` (${p.note})` : ""}`).join("; ");
  const prompt = [`Workflow: ${flow.title || "untitled"}`, `Step: ${node.text}`, made ? `It must make: ${made}` : ""].filter(Boolean).join("\n");
  const raw = await complete(SUBSTEP_SYSTEM, prompt, 800);
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("The model did not send a list of parts.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("The model's list could not be read.");
  }
  const parts = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean) : [];
  if (parts.length === 0) throw new Error("The model sent no parts.");
  return parts.slice(0, 6);
}

const QUESTIONNAIRE_SYSTEM =
  "You write short questionnaires that a coding agent puts to a person, as a graph of questions. " +
  'Reply with JSON only, shaped {"questions":[{"id":"q1","question":"...","kind":"input"|"decision","type":"text"|"choice"|"yesno","options":["..."],"optional":false,"after":[{"from":"q1","port":"yes"}]}]}. ' +
  'Use "decision" with type "yesno" or "choice" when the answer changes what to ask next. "after" lists the earlier question ids this one follows; ' +
  'add "port" (a choice of a decision, or "yes"/"no") to ask it only on that branch. Only refer to earlier ids. ' +
  "Ask 4 to 10 questions, plain words, one thing each, nothing the person already told you.";

/** A questionnaire as validated data. It is drawn at once, so the person looks it over on the canvas and can undo it. */
export async function draftQuestionnaire(complete: Complete, flow: Flow, topic: string): Promise<Questionnaire> {
  const steps = flow.nodes
    .filter((n) => n.kind === "agent" && n.text.trim())
    .slice(0, 30)
    .map((n) => `- ${n.text.trim()}`);
  const known = (flow.asks ?? []).map((a) => `- ${a.title || a.fields[0]?.label || a.id}`);
  const prompt = [
    `Workflow: ${flow.title || "untitled"}`,
    `What the questions are for: ${topic.trim() || "setting this workflow up"}`,
    steps.length ? `Its steps:\n${steps.join("\n")}` : "",
    known.length ? `Questions that already exist (do not repeat them):\n${known.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return parseQuestionnaire(await complete(QUESTIONNAIRE_SYSTEM, prompt, 2500));
}
