import type { Billing, FlowTool, PlanTier, QuotaWindow } from "./flowModel";

/**
 * Starting points for the tool picker, taken from the person's own list of what
 * each tool offers. Ratings are theirs; prices and hours come from the tools'
 * plan pages and change, so the person can correct any of it.
 */
export interface ToolPreset {
  name: string;
  /** Lowest plan first. */
  plans: PlanTier[];
  defaultPlan: string;
  sessions: number | null;
  /** The limits for a plan; amounts left are unknown until the person sets them. */
  windows: (plan: PlanTier, now: number) => QuotaWindow[];
  models: Array<{
    name: string;
    capability: number;
    plan: string;
    usage?: number;
    freeHours?: number;
    note?: string;
  }>;
}

/** What each rating means, so the slider and the local planner share one scale. */
export const CAPABILITY_ANCHORS: Array<{ at: number; label: string }> = [
  { at: 1, label: "Mechanical: rename something, reformat a file, fix a typo" },
  { at: 3, label: "Small and clear: one function or one test from a precise spec" },
  { at: 5, label: "A feature in a few files that follows patterns already there" },
  { at: 7, label: "Multi-file design with edge cases, or a tricky bug to track down" },
  { at: 10, label: "Ambiguous, cross-cutting or security-critical work in a large codebase" },
];

/** The anchor at or just below a rating, for a one-line hint under the slider. */
export function anchorFor(need: number): string {
  const found = [...CAPABILITY_ANCHORS].reverse().find((a) => a.at <= need);
  return (found ?? CAPABILITY_ANCHORS[0]).label;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function limit(label: string, resetsAt: number | null, now: number): QuotaWindow {
  return { label, unit: "prompts", role: "limit", resetsAt, left: null, updatedAt: now };
}

export const TOOL_PRESETS: ToolPreset[] = [
  {
    name: "Claude Code",
    plans: [
      { name: "Pro", price: "$20 / month" },
      { name: "Max 5x", price: "$100 / month" },
      { name: "Max 20x", price: "$200 / month" },
    ],
    defaultPlan: "Pro",
    sessions: null,
    windows: (_plan, now) => [limit("5 hour", now + 5 * HOUR, now), limit("weekly", now + 7 * DAY, now)],
    models: [
      { name: "Fable 5.1", capability: 10, plan: "Max 5x" },
      { name: "Opus 5.5", capability: 8, plan: "Pro" },
      { name: "Sonnet 5.5", capability: 7, plan: "Pro" },
      { name: "Haiku 5.5", capability: 4, plan: "Pro" },
    ],
  },
  {
    name: "Codex",
    plans: [
      { name: "Free", price: "$0" },
      { name: "Go", price: "$2 / month" },
      { name: "Plus", price: "$20 / month" },
      { name: "Pro", price: "$200 / month" },
    ],
    defaultPlan: "Free",
    sessions: 1,
    windows: (_plan, now) => [limit("monthly", now + 30 * DAY, now)],
    models: [
      { name: "GPT 6 Luna", capability: 5, plan: "Free" },
      { name: "GPT 6 Sol", capability: 7, plan: "Plus" },
      { name: "GPT 6.1 Terra", capability: 7, plan: "Plus" },
      { name: "GPT 6.1 Sol", capability: 8, plan: "Plus" },
      { name: "GPT 6 Astra", capability: 10, plan: "Plus" },
    ],
  },
  {
    name: "Antigravity",
    plans: [{ name: "Free" }, { name: "Google AI Pro" }, { name: "Google AI Ultra" }],
    defaultPlan: "Free",
    sessions: 1,
    windows: (_plan, now) => [limit("weekly", now + 7 * DAY, now)],
    models: [
      { name: "Gemini 3.1 Pro (old)", capability: 4, plan: "Free" },
      { name: "Gemini 3.6 Flash", capability: 6, plan: "Free" },
      { name: "Gemini 3.7 Flash", capability: 6, plan: "Free" },
      { name: "Gemini 3.8 Flash", capability: 7, plan: "Free" },
      { name: "Gemini 4 Argon", capability: 8, plan: "Google AI Pro" },
      { name: "Gemini 4 Carbon", capability: 10, plan: "Google AI Ultra" },
    ],
  },
  {
    name: "Freebuff",
    plans: [
      { name: "Free", price: "$0 / month", perDay: 5, wallet: 5 },
      { name: "Starter", price: "$8 / month", perDay: 21, wallet: 60 },
      { name: "Plus", price: "$25 / month", perDay: 40, wallet: 100 },
      { name: "Pro", price: "$60 / month", perDay: 70, wallet: 160 },
    ],
    defaultPlan: "Free",
    sessions: 1,
    // Daily hours do not carry over; wallet hours do and last a year, so the
    // daily window resets and the wallet never does. They add together.
    windows: (plan, now) => [
      { label: "daily hours", unit: "hours", role: "supply", resetsAt: now + DAY, left: plan.perDay ?? null, updatedAt: now },
      { label: "wallet hours", unit: "hours", role: "supply", resetsAt: null, left: plan.wallet ?? null, updatedAt: now },
    ],
    models: [
      { name: "Solar Mini 4 (promotional)", capability: 2, plan: "Free", usage: 0, note: "Unlimited while promotional" },
      { name: "Glyph Cluster", capability: 3, plan: "Free", usage: 0, note: "Unlimited" },
      { name: "Solar Pro 4 (promotional)", capability: 4, plan: "Free", usage: 0, note: "Unlimited while promotional" },
      { name: "Nemotron 3.5 Lightning", capability: 2, plan: "Free", usage: 1 },
      { name: "MiMo V2.6 Flash Slow", capability: 5, plan: "Free", usage: 1 },
      { name: "MiMo V2.6 Flash Fast", capability: 5, plan: "Free", usage: 2 },
      { name: "Deepseek V4.1 Flash Slow", capability: 7, plan: "Free", usage: 2 },
      { name: "Deepseek V4.1 Flash 10/17", capability: 8, plan: "Free", usage: 3 },
      { name: "GLM 5.3 Flash", capability: 6, plan: "Free", usage: 4 },
      { name: "Muse Spark 1.3", capability: 6, plan: "Starter", usage: 3 },
      { name: "Deepseek V4.1 Flash 10/17 Fast", capability: 8, plan: "Starter", usage: 5 },
      { name: "GPT 6 Luna", capability: 5, plan: "Starter", usage: 10 },
      { name: "GPT 6.1 Terra", capability: 7, plan: "Starter", usage: 15 },
      { name: "Claude Haiku 5.5 (100k context)", capability: 4, plan: "Starter", usage: 20 },
      {
        name: "GPT 6.1 Sol",
        capability: 8,
        plan: "Pro",
        usage: 0,
        freeHours: 1,
        note: "One free hour a day on the Pro plan. Once it is used the model is gone until tomorrow; it has no price.",
      },
    ],
  },
];

/** Free means a plan named Free or priced at $0; every other plan is a subscription, priced or not. */
export function billingFor(plan: PlanTier): Billing {
  return plan.name.toLowerCase() === "free" || /^\$0(\D|$)/.test(plan.price ?? "") ? "free" : "subscription";
}

export function presetToTool(
  preset: ToolPreset,
  now = Date.now(),
  planName = preset.defaultPlan,
): Omit<FlowTool, "id"> {
  const plan = preset.plans.find((p) => p.name === planName) ?? preset.plans[0];
  return {
    name: preset.name,
    tier: plan.name,
    plans: preset.plans.map((p) => ({ ...p })),
    billing: billingFor(plan),
    sessions: preset.sessions,
    prefer: false,
    models: preset.models.map((m, i) => ({ id: `m${i + 1}`, ...m })),
    windows: preset.windows(plan, now),
  };
}

export const BILLING_LABEL: Record<Billing, string> = {
  subscription: "Subscription",
  free: "Free tier",
  payg: "Pay as you go",
};

export const PAYG_NOTE =
  "Pay as you go spends real money for each prompt. Soren spends it last and cannot see your balance.";

/** "in 3 h", "in 2 d", "reset" — how far away a window's reset is. */
export function resetsIn(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null) return "no reset set";
  const ms = resetsAt - now;
  if (ms <= 0) return "reset";
  const hours = ms / 3_600_000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `in ${Math.round(hours)} h`;
  return `in ${Math.round(hours / 24)} d`;
}

export function ageLabel(at: number | undefined, now = Date.now()): string {
  if (!at) return "never set";
  const hours = (now - at) / 3_600_000;
  if (hours < 1) return "just now";
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function isStale(at: number | undefined, now = Date.now()): boolean {
  return !at || now - at > 24 * 3_600_000;
}
