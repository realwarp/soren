import { asksOf, isAnswered, translatedText } from "./flowAsk";
import { dependencies, effectiveModel, type Flow, type FlowAsk, type FlowNode, type PromptAuthor, type PromptSegment } from "./flowModel";
import { wordDiff } from "./diff";

/**
 * A step's prompt as segments, each with an author.
 *
 * Code writes the prompt first: a deterministic template fills it from the step's own fields (what it does, what it
 * relies on, what it makes, its checks, its tool and model, the shared context and the answers that touch it). It is
 * there at once and needs no model. The cloud model only reworks it when asked, and its rewrite is a diff the person
 * accepts or rejects. What is stored on the step is only what the person or an accepted rewrite changed:
 *
 *  - `template` segments are always rewritten from the fields, so they follow the step as it is edited;
 *  - `you` and `ai` segments are kept exactly as they are;
 *  - `basis` remembers what the template said for each field the last time the person settled it, so a field that has
 *    changed since can be offered as a diff against a segment that is no longer the template's.
 */

export type { PromptAuthor, PromptSegment };

/** The template's words for one field of the step. */
export interface TemplatePart {
  key: string;
  text: string;
}

/** A template change that cannot be made silently: it would overwrite words the person or the model wrote. */
export interface TemplateConflict {
  key: string;
  /** The segment it would replace; missing when the template wants to add something that was taken out. */
  segmentId?: string;
  current: string;
  proposed: string;
}

const CONTEXT_LIMIT = 700;
const MAX_DECISIONS = 8;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text);

function listOutputs(node: FlowNode): string[] {
  return node.outputs.map((port) => `- ${port.label}${port.note ? `: ${port.note}` : ""}`);
}

function listInputs(flow: Flow, node: FlowNode): string[] {
  return node.inputs.map((ref) => {
    const source = flow.nodes.find((n) => n.id === ref.node);
    const port = source?.outputs.find((p) => p.id === ref.port);
    const label = port?.label ?? ref.port;
    const note = port?.note ? `: ${port.note}` : "";
    const pasted = source?.kind === "translator" ? translatedText(flow, source).trim() : source?.done?.pasted.trim();
    return `- ${label}${note}${pasted ? `\n  What the earlier step reported:\n  ${pasted.replace(/\n/g, "\n  ")}` : ""}`;
  });
}

const answerOf = (ask: FlowAsk) =>
  ask.fields
    .map((f) => ((f.value ?? "").trim() ? `${f.label || ask.title || f.name}: ${(f.value ?? "").trim()}` : ""))
    .filter(Boolean)
    .join("; ");

/** The checks that wait for this step: the verifiers wired to anything it makes. */
function checksOn(flow: Flow, node: FlowNode): string[] {
  return flow.nodes
    .filter((n) => n.kind === "verifier" && dependencies(n).includes(node.id))
    .map((n) => n.check?.label?.trim() || n.text.trim())
    .filter(Boolean);
}

/**
 * The template: one part per field, in reading order. A field with nothing in it gives no part, and the part's `key`
 * is how a stored segment is tied back to the field it came from.
 */
export function templateParts(flow: Flow, node: FlowNode): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const add = (key: string, lines: string[]) => {
    const text = lines.join("\n").trim();
    if (text) parts.push({ key, text });
  };
  const tool = flow.tools.find((t) => t.id === node.toolId);
  const model = effectiveModel(flow, node);
  const title = flow.title || "a larger plan";

  // Shared context: what the workflow was planned from, and the decisions made about its shape.
  const decided = (flow.asks ?? [])
    .filter((a) => a.kind === "decision" && isAnswered(a) && !a.skipped)
    .map(answerOf)
    .filter(Boolean)
    .slice(0, MAX_DECISIONS);
  const context = [flow.brief?.trim() ? clip(flow.brief.trim(), CONTEXT_LIMIT) : "", ...(decided.length ? ["Decisions made about this work:", ...decided.map((d) => `- ${d}`)] : [])]
    .filter(Boolean)
    .join("\n");

  // Answers to squares this step uses, other than the decisions already shared above.
  const given = asksOf(flow, node)
    .filter((a) => a.kind !== "decision" && isAnswered(a) && !a.skipped)
    .map(answerOf)
    .filter(Boolean);
  const answers = given.length ? ["Answers you have been given:", ...given.map((g) => `- ${g}`)] : [];

  if (node.kind === "verifier") {
    add("intro", [`Check this for "${flow.title || "the project"}": ${node.check?.label ?? node.text}.`]);
    add("context", context ? [context] : []);
    const needs = listInputs(flow, node);
    add("needs", needs.length ? ["The work to check:", ...needs] : []);
    add("answers", answers);
    add("close", ["Run the check and report PASS or FAIL. If it fails, paste the first error and stop."]);
    return parts;
  }

  add("intro", [`You are doing one step of "${title}"${tool ? ` in ${tool.name}${model ? ` using ${model.name}` : ""}` : ""}.`]);
  add("context", context ? [`Background: ${context}`] : []);
  add("step", [`Your step: ${node.text}`]);
  const needs = listInputs(flow, node);
  add("needs", needs.length ? ["You can rely on these existing already:", ...needs] : []);
  add("answers", answers);
  const makes = listOutputs(node);
  add("makes", makes.length ? ["When you are done, these must exist:", ...makes] : []);
  const checks = checksOn(flow, node);
  add("checks", checks.length ? ["These checks will be run on your work afterwards:", ...checks.map((c) => `- ${c}`)] : []);
  add("close", ["Stay inside this step. When finished, say what you made and anything the next step needs to know."]);
  return parts;
}

/** The segments a step reads as, and the template changes waiting on a decision. Nothing is stored here. */
export function resolveSegments(
  stored: PromptSegment[] | undefined,
  basis: Record<string, string> | undefined,
  template: TemplatePart[],
): { segments: PromptSegment[]; conflicts: TemplateConflict[] } {
  if (!stored) {
    return { segments: template.map((t) => ({ id: `t-${t.key}`, author: "template" as const, key: t.key, text: t.text })), conflicts: [] };
  }
  const now = new Map(template.map((t) => [t.key, t.text]));
  const seen = basis ?? {};
  const out: PromptSegment[] = [];
  const conflicts: TemplateConflict[] = [];
  const present = new Set<string>();
  for (const seg of stored) {
    if (seg.author === "template") {
      // A template segment follows its field; one whose field is gone goes with it.
      if (seg.key && now.has(seg.key)) {
        out.push({ ...seg, text: now.get(seg.key)! });
        present.add(seg.key);
      }
      continue;
    }
    out.push(seg);
    if (seg.key) {
      present.add(seg.key);
      const proposed = now.get(seg.key);
      if (proposed !== undefined && seen[seg.key] !== proposed && seg.text !== proposed) {
        conflicts.push({ key: seg.key, segmentId: seg.id, current: seg.text, proposed });
      }
    }
  }
  // Fields with no segment yet: a field never seen before is added where it belongs; one that was taken out on
  // purpose comes back only as a diff, and only if its wording has changed since.
  let after = -1;
  template.forEach((part) => {
    if (present.has(part.key)) {
      after = out.findIndex((s) => s.key === part.key);
      return;
    }
    if (part.key in seen) {
      if (seen[part.key] !== part.text) conflicts.push({ key: part.key, current: "", proposed: part.text });
      return;
    }
    out.splice(after + 1, 0, { id: `t-${part.key}`, author: "template", key: part.key, text: part.text });
    after += 1;
  });
  return { segments: out, conflicts };
}

/** Whether the step has stored any words of its own, so that its prompt is no longer simply the template. */
export function hasOwnWords(node: FlowNode): boolean {
  return Boolean(node.segments) || Boolean(node.prompt?.trim());
}

/** The segments of a step's prompt as they read now. An older step with one written prompt reads as one model-written segment. */
export function promptSegments(flow: Flow, node: FlowNode): { segments: PromptSegment[]; conflicts: TemplateConflict[] } {
  if (!node.segments && node.prompt?.trim()) {
    return { segments: [{ id: "written", author: "ai", text: node.prompt.trim() }], conflicts: [] };
  }
  return resolveSegments(node.segments, node.basis, templateParts(flow, node));
}

/** The prompt text before the sub-steps, reviewer and retry notes are added: segments joined by blank lines. */
export function joinSegments(segments: PromptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** What is sent to be polished, and what a polish is compared with. */
export function basePromptText(flow: Flow, node: FlowNode): string {
  return joinSegments(promptSegments(flow, node).segments);
}

// ---- Changes. Each returns the fields to store on the step: `segments` and `basis`. ----

export interface PromptPatch {
  segments?: PromptSegment[];
  basis?: Record<string, string>;
  prompt?: undefined;
}

let counter = 0;
const newId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Store a list of segments. Every field's wording is settled as the basis, except those already waiting on a decision
 * before this change: a hand edit settles the field it edited (the person has seen the template's words), but not one
 * whose newer wording they have yet to accept or turn down.
 */
function store(flow: Flow, node: FlowNode, segments: PromptSegment[], decided: Record<string, string> = {}): PromptPatch {
  const waiting = new Set(promptSegments(flow, node).conflicts.map((c) => c.key));
  const basis: Record<string, string> = { ...(node.basis ?? {}) };
  for (const part of templateParts(flow, node)) if (!waiting.has(part.key)) basis[part.key] = part.text;
  Object.assign(basis, decided);
  return { segments, basis, prompt: undefined };
}

/** Change the words of one segment by hand. The segment becomes the person's; emptied, it is removed. */
export function editSegment(flow: Flow, node: FlowNode, id: string, text: string): PromptPatch | null {
  const { segments } = promptSegments(flow, node);
  const target = segments.find((s) => s.id === id);
  if (!target || target.text === text) return null;
  const next = text.trim()
    ? segments.map((s) => (s.id === id ? { ...s, author: "you" as const, text } : s))
    : segments.filter((s) => s.id !== id);
  return store(flow, node, next);
}

/** Add a paragraph of the person's own at the end. */
export function addSegment(flow: Flow, node: FlowNode, text: string): PromptPatch | null {
  if (!text.trim()) return null;
  const { segments } = promptSegments(flow, node);
  return store(flow, node, [...segments, { id: newId(), author: "you", text }]);
}

/** Go back to the template alone, dropping every stored word. */
export function resetPrompt(): PromptPatch {
  return { segments: undefined, basis: undefined, prompt: undefined };
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);

function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * Take in a rewrite the person accepted. A paragraph that came back unchanged keeps its author; one that changed is
 * the model's, and keeps the field it grew from so a later change to that field is still offered as a diff.
 */
export function acceptRewrite(flow: Flow, node: FlowNode, rewritten: string): PromptPatch {
  const { segments } = promptSegments(flow, node);
  const blocks = rewritten
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const unused = [...segments];
  const take = (pick: (s: PromptSegment) => boolean) => {
    const at = unused.findIndex(pick);
    return at >= 0 ? unused.splice(at, 1)[0] : undefined;
  };
  // Unchanged paragraphs first, so a lookalike never steals their place.
  const kept = blocks.map((block) => take((s) => s.text.trim() === block));
  const next = blocks.map((block, i): PromptSegment => {
    const same = kept[i];
    if (same) return same;
    let best: PromptSegment | undefined;
    let score = 0.35;
    for (const s of unused) {
      const o = overlap(s.text, block);
      if (o > score) {
        score = o;
        best = s;
      }
    }
    if (best) unused.splice(unused.indexOf(best), 1);
    return { id: best?.id ?? newId(), author: "ai", text: block, ...(best?.key ? { key: best.key } : {}) };
  });
  return store(flow, node, next);
}

/** Take a template change that was waiting on a decision: the field's words replace the segment (or return). */
export function acceptTemplateChange(flow: Flow, node: FlowNode, conflict: TemplateConflict): PromptPatch {
  const { segments } = promptSegments(flow, node);
  const part: PromptSegment = { id: conflict.segmentId ?? `t-${conflict.key}`, author: "template", key: conflict.key, text: conflict.proposed };
  const next = conflict.segmentId ? segments.map((s) => (s.id === conflict.segmentId ? part : s)) : [...segments.slice(0, -1), part, ...segments.slice(-1)];
  return store(flow, node, next, { [conflict.key]: conflict.proposed });
}

/** Turn a template change down: the words stay, and the field is not offered again until it changes once more. */
export function rejectTemplateChange(flow: Flow, node: FlowNode, conflict: TemplateConflict): PromptPatch {
  const { segments } = promptSegments(flow, node);
  return store(flow, node, segments, { [conflict.key]: conflict.proposed });
}

/** Who wrote how much, for a one-line summary. */
export function authorship(segments: PromptSegment[]): Record<PromptAuthor, number> {
  const out: Record<PromptAuthor, number> = { template: 0, ai: 0, you: 0 };
  for (const s of segments) out[s.author] += s.text.length;
  return out;
}

/** Whether a rewrite says anything new. */
export function differs(before: string, after: string): boolean {
  if (before.trim() === after.trim()) return false;
  const diff = wordDiff(before, after);
  return diff.after.some((p) => p.kind !== "same") || diff.before.some((p) => p.kind !== "same");
}
