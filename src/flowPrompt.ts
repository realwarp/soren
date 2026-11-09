import { fillVariables } from "./flowAsk";
import type { Flow, FlowNode } from "./flowModel";
import { basePromptText } from "./flowPromptDoc";

/**
 * The prompt a step is run with, put together by code from the step's own fields (see flowPromptDoc.ts for the template
 * and for who wrote which part). It needs no model and is there as soon as the step is. The cloud model only reworks it
 * when asked, and nothing replaces it without the person accepting the rewrite.
 */
export function nodePrompt(flow: Flow, node: FlowNode): string {
  // Answers the person gave to squares are written in wherever the text says {name}.
  return fillVariables(flow, promptFor(flow, node));
}

/**
 * When a critic sent the work back, the maker's next prompt carries the reviewer's reasons and the last attempt,
 * so the revision starts from them instead of from nothing.
 */
function withCritic(prompt: string, node: FlowNode): string {
  const rounds = node.critic?.rounds ?? [];
  const last = rounds[rounds.length - 1];
  if (!node.critic || node.done || !last || last.verdict !== "revise") return prompt;
  const made = last.made.length > 2000 ? `${last.made.slice(0, 2000)}…` : last.made;
  return [
    prompt,
    "",
    `This is round ${rounds.length + 1} of at most ${node.critic.maxRounds}. A reviewer sent your last attempt back.`,
    "",
    "What the reviewer asked for:",
    last.reasons?.trim() || "(no reasons were given; improve it where you can)",
    ...(made ? ["", "Your last attempt:", made] : []),
    "",
    "Revise it to answer the reviewer. Keep what was fine, and change only what they asked.",
  ].join("\n");
}

/** The prompt for the reviewer of a step: its job, what to look for, and what the maker produced. */
export function criticPrompt(flow: Flow, node: FlowNode): string {
  const rounds = node.critic?.rounds ?? [];
  const last = rounds[rounds.length - 1];
  const makes = node.outputs.map((p) => `- ${p.label}${p.note ? `: ${p.note}` : ""}`);
  return fillVariables(
    flow,
    [
      `You are the reviewer for one step of "${flow.title || "a larger plan"}". You do not write the work; you judge it.`,
      "",
      `The step: ${node.text}`,
      ...(makes.length ? ["", "It had to make:", ...makes] : []),
      "",
      `What to check: ${node.critic?.criteria.trim() || "that it does what the step says, with nothing missing and nothing extra."}`,
      "",
      `The work (round ${rounds.length} of at most ${node.critic?.maxRounds ?? 3}):`,
      last?.made.trim() || "(nothing was pasted)",
      "",
      "Reply with APPROVE or REVISE on the first line.",
      "If REVISE, list the specific changes needed under it, most important first. Do not rewrite the work yourself.",
    ].join("\n"),
  );
}

function promptFor(flow: Flow, node: FlowNode): string {
  if (node.failed && !node.done && node.failed.retry?.trim()) return node.failed.retry.trim();
  const base = withCritic(withSubSteps(basePromptText(flow, node), node), node);
  if (!node.failed || node.done) return base;
  const { attempts, error } = node.failed;
  return [
    base,
    "",
    `This is attempt ${attempts + 1}. The last attempt failed${error ? `, with this:` : "."}`,
    ...(error ? ["", error.replace(/\n{3,}/g, "\n\n")] : []),
    "",
    "Start from what went wrong. Change what caused it instead of repeating the same approach, and if it cannot be fixed inside this step, say so and stop.",
  ].join("\n");
}

/**
 * Sub-steps the person divided a step into are handed to the tool as work for its own subagents. They are
 * descriptions only, so they ride along with the step's prompt instead of getting prompts of their own.
 */
function withSubSteps(prompt: string, node: FlowNode): string {
  const parts = (node.sub ?? []).map((s) => s.text.trim()).filter(Boolean);
  if (parts.length === 0 || prompt.includes("Split this step")) return prompt;
  return [
    prompt,
    "",
    "Split this step into these parts and give each to a subagent (or work through them one by one if you have none):",
    ...parts.map((text, i) => `${i + 1}. ${text}`),
    "Bring the results together before you finish, and report them as one step.",
  ].join("\n");
}
