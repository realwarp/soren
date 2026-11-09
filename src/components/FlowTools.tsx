import { useState } from "react";
import {
  addTool,
  availableModels,
  planRank,
  removeTool,
  updateTool,
  type Billing,
  type Flow,
  type FlowTool,
  type ModelEntry,
  type QuotaWindow,
} from "../flowModel";
import {
  ageLabel,
  BILLING_LABEL,
  billingFor,
  isStale,
  PAYG_NOTE,
  presetToTool,
  resetsIn,
  TOOL_PRESETS,
} from "../flowTools";
import { PlusIcon, TrashIcon } from "./Icons";

type Patch = (patch: Partial<Omit<FlowTool, "id">>) => void;

function number(value: string): number | null {
  const n = Number(value);
  return value.trim() === "" || !Number.isFinite(n) ? null : Math.max(0, n);
}

function ModelTable({ tool, set }: { tool: FlowTool; set: Patch }) {
  const hours = tool.windows.some((w) => w.unit === "hours");
  const hasPlans = tool.plans.length > 0;
  const edit = (id: string, patch: Partial<ModelEntry>) =>
    set({ models: tool.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const cols = ["1fr", "44px", hasPlans ? "104px" : null, hours ? "48px" : null, "26px"].filter(Boolean).join(" ");
  return (
    <div className="ft-table" style={{ gridTemplateColumns: cols }}>
      <span className="ft-th">Model</span>
      <span className="ft-th" title="How hard a job it can take, 1 to 10">
        Level
      </span>
      {hasPlans && (
        <span className="ft-th" title="The lowest plan that includes it">
          Plan
        </span>
      )}
      {hours && (
        <span className="ft-th" title="Hours spent per hour of work: 1 is normal, 20 is twenty times, 0 is free">
          Rate
        </span>
      )}
      <span />
      {tool.models.map((m) => (
        <div key={m.id} className="ft-row" style={{ gridTemplateColumns: cols }}>
          <input value={m.name} aria-label="Model name" onChange={(e) => edit(m.id, { name: e.target.value })} />
          <input
            inputMode="numeric"
            value={m.capability}
            aria-label={`${m.name} level`}
            onChange={(e) =>
              edit(m.id, { capability: Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1))) })
            }
          />
          {hasPlans && (
            <select
              value={m.plan ?? ""}
              aria-label={`${m.name} plan`}
              onChange={(e) => edit(m.id, { plan: e.target.value || undefined })}
            >
              <option value="">Any plan</option>
              {tool.plans.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {hours && (
            <input
              inputMode="decimal"
              value={m.usage ?? 1}
              aria-label={`${m.name} hours spent per hour`}
              onChange={(e) => edit(m.id, { usage: Math.max(0, Number(e.target.value) || 0) })}
            />
          )}
          <button
            type="button"
            className="ft-x"
            aria-label={`Remove ${m.name}`}
            onClick={() => set({ models: tool.models.filter((x) => x.id !== m.id) })}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ft-add"
        onClick={() => {
          let n = tool.models.length + 1;
          while (tool.models.some((m) => m.id === `m${n}`)) n += 1;
          set({ models: [...tool.models, { id: `m${n}`, name: "New model", capability: 5 }] });
        }}
      >
        <PlusIcon /> Model
      </button>
    </div>
  );
}

function LimitTable({ tool, set }: { tool: FlowTool; set: Patch }) {
  const edit = (i: number, next: QuotaWindow) =>
    set({ windows: tool.windows.map((x, j) => (j === i ? next : x)) });
  const cols = "1fr 64px 72px 26px";
  return (
    <div className="ft-table" style={{ gridTemplateColumns: cols }}>
      <span className="ft-th">Limit</span>
      <span className="ft-th" title="Hours until it resets">
        Resets in
      </span>
      <span className="ft-th">Left</span>
      <span />
      {tool.windows.map((w, i) => {
        const hours = w.resetsAt === null ? "" : String(Math.max(0, Math.round((w.resetsAt - Date.now()) / 3_600_000)));
        const touch = (patch: Partial<QuotaWindow>) => edit(i, { ...w, ...patch, updatedAt: Date.now() });
        return (
          <div key={i} className="ft-row ft-limit" style={{ gridTemplateColumns: cols }}>
            <input
              value={w.label}
              aria-label="Limit name"
              placeholder="5 hour"
              onChange={(e) => touch({ label: e.target.value })}
            />
            <input
              inputMode="numeric"
              value={hours}
              placeholder={w.resetsAt === null ? "never" : ""}
              aria-label={`${w.label} resets in hours`}
              onChange={(e) => {
                const h = number(e.target.value);
                touch({ resetsAt: h === null ? null : Date.now() + h * 3_600_000 });
              }}
            />
            <input
              inputMode="numeric"
              value={w.left === null ? "" : w.left}
              placeholder={w.unit === "hours" ? "hours" : "prompts"}
              aria-label={`${w.label} ${w.unit === "hours" ? "hours" : "prompts"} left`}
              onChange={(e) => touch({ left: number(e.target.value) })}
            />
            <button
              type="button"
              className="ft-x"
              aria-label={`Remove ${w.label}`}
              onClick={() => set({ windows: tool.windows.filter((_, j) => j !== i) })}
            >
              <TrashIcon />
            </button>
            <span className={`ft-note ${isStale(w.updatedAt) ? "stale" : ""}`}>
              {w.role === "supply" && w.resetsAt === null ? "carries over, never resets" : resetsIn(w.resetsAt)} · set{" "}
              {ageLabel(w.updatedAt)}
            </span>
          </div>
        );
      })}
      <button
        type="button"
        className="ft-add"
        onClick={() =>
          set({ windows: [...tool.windows, { label: "", resetsAt: null, left: null, updatedAt: Date.now() }] })
        }
      >
        <PlusIcon /> Limit
      </button>
    </div>
  );
}

/** Models on the person's plan stay in view; ones that need a higher plan sit behind a toggle. */
function ModelList({ tool }: { tool: FlowTool }) {
  const [showHigher, setShowHigher] = useState(false);
  const have = planRank(tool, tool.tier);
  const groups: Array<{ name: string; detail?: string; rank: number; models: ModelEntry[] }> = tool.plans.map((p, i) => ({
    name: p.name,
    detail: planDetail(p),
    rank: i,
    models: tool.models.filter((m) => m.plan === p.name),
  }));
  const placed = new Set(groups.flatMap((g) => g.models.map((m) => m.id)));
  const loose = tool.models.filter((m) => !placed.has(m.id));
  if (loose.length > 0) groups.push({ name: "Any plan", rank: -1, models: loose });
  const usable = (g: { rank: number }) => have < 0 || g.rank < 0 || g.rank <= have;
  const shown = groups.filter((g) => g.models.length > 0 && usable(g));
  const higher = groups.filter((g) => g.models.length > 0 && !usable(g));
  const higherCount = higher.reduce((n, g) => n + g.models.length, 0);

  const renderGroup = (g: (typeof groups)[number], dim: boolean) => (
    <div key={g.name} className={`ft-group ${dim ? "dim" : ""}`}>
      <div className="ft-group-head">
        <b>{g.name}</b>
        {g.detail && <span>{g.detail}</span>}
      </div>
      <ul className="ft-models">
        {g.models.map((m) => (
          <li key={m.id} title={m.note}>
            <span className="ft-model-name">{m.name}</span>
            <span className="ft-badge" title="How hard a job it can take, 1 to 10">
              {m.capability}
            </span>
            {m.freeHours !== undefined ? (
              <span className="ft-badge soft">{m.freeHours} free h/day</span>
            ) : m.usage === 0 ? (
              <span className="ft-badge soft">free</span>
            ) : m.usage !== undefined && m.usage !== 1 ? (
              <span className="ft-badge soft" title="Hours spent per hour of work">
                ×{m.usage}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div>
      {shown.map((g) => renderGroup(g, false))}
      {higherCount > 0 && (
        <button type="button" className="ft-more" onClick={() => setShowHigher(!showHigher)}>
          {showHigher ? "Hide" : "Show"} {higherCount} model{higherCount === 1 ? "" : "s"} on higher plans
        </button>
      )}
      {showHigher && higher.map((g) => renderGroup(g, true))}
    </div>
  );
}

/** "21 h a day + 60 h wallet" for plans sold in hours. */
function planDetail(plan: { price?: string; perDay?: number; wallet?: number }): string {
  const parts = [plan.price];
  if (plan.perDay !== undefined) parts.push(`${plan.perDay} h a day`);
  if (plan.wallet) parts.push(`${plan.wallet} h wallet`);
  return parts.filter(Boolean).join(" · ");
}

function ToolCard({ tool, flow, onChange }: { tool: FlowTool; flow: Flow; onChange: (next: Flow) => void }) {
  const [editing, setEditing] = useState(false);
  const set: Patch = (patch) => onChange(updateTool(flow, tool.id, patch));
  const usable = availableModels(tool).length;
  return (
    <section className="ft-card">
      <div className="ft-head">
        <input className="ft-name" value={tool.name} aria-label="Tool name" onChange={(e) => set({ name: e.target.value })} />
        {tool.plans.length > 0 ? (
          <select
            className="ft-plan"
            value={tool.tier}
            aria-label={`${tool.name} plan`}
            onChange={(e) => {
              const plan = tool.plans.find((p) => p.name === e.target.value);
              set({ tier: e.target.value, ...(plan ? { billing: billingFor(plan) } : {}) });
            }}
          >
            {tool.plans.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.price ? ` · ${p.price}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="ft-plan"
            value={tool.tier}
            aria-label="Plan"
            placeholder="Plan"
            onChange={(e) => set({ tier: e.target.value })}
          />
        )}
        <button type="button" className="ft-x" aria-label={`Remove ${tool.name}`} onClick={() => onChange(removeTool(flow, tool.id))}>
          <TrashIcon />
        </button>
      </div>

      <div className="ft-body">
        <div className="ft-line">
          <label>
            <span>Paid by</span>
            <select value={tool.billing} onChange={(e) => set({ billing: e.target.value as Billing })}>
              {(Object.keys(BILLING_LABEL) as Billing[]).map((b) => (
                <option key={b} value={b}>
                  {BILLING_LABEL[b]}
                </option>
              ))}
            </select>
          </label>
          <label className="narrow">
            <span>Sessions</span>
            <input
              inputMode="numeric"
              value={tool.sessions === null ? "" : tool.sessions}
              placeholder="ask"
              onChange={(e) => set({ sessions: number(e.target.value) })}
            />
          </label>
          <label className="tick">
            <input type="checkbox" checked={tool.prefer} onChange={(e) => set({ prefer: e.target.checked })} />
            <span>Use first</span>
          </label>
        </div>
        {tool.billing === "payg" && <p className="ft-warn">{PAYG_NOTE}</p>}

        <h4 className="ft-h">What is left</h4>
        <LimitTable tool={tool} set={set} />

        <div className="ft-h-row">
          <h4 className="ft-h">
            Models <em>{usable} on your plan</em>
          </h4>
          <button type="button" className="ft-link" onClick={() => setEditing(!editing)}>
            {editing ? "Done editing" : "Edit models"}
          </button>
        </div>
        {editing ? <ModelTable tool={tool} set={set} /> : <ModelList tool={tool} />}
      </div>
    </section>
  );
}

/** Deal tools into two columns, each to the lighter one, keeping their order within a column. */
function balanced(tools: FlowTool[]): FlowTool[][] {
  const columns: FlowTool[][] = [[], []];
  const weight = [0, 0];
  for (const tool of tools) {
    const side = weight[0] <= weight[1] ? 0 : 1;
    columns[side].push(tool);
    weight[side] += 8 + tool.models.length * 0.6 + tool.windows.length * 2;
  }
  return columns;
}

export function FlowTools({ flow, onChange }: { flow: Flow; onChange: (next: Flow) => void }) {
  const [preset, setPreset] = useState("");
  return (
    <section className="ft-wide" id="flow-tools" aria-label="Your tools">
      <div className="ft-wide-head">
        <div>
          <h3>Your tools</h3>
          <p className="flow-muted">
            What you have and what is left. Soren spends subscriptions first, then free tiers, then pay as you go.
          </p>
        </div>
        <label className="ft-addtool">
          <span>Add a tool</span>
          <select
            value={preset}
            onChange={(e) => {
              const value = e.target.value;
              setPreset("");
              if (value === "custom") {
                onChange(
                  addTool(flow, {
                    name: "New tool",
                    tier: "",
                    plans: [],
                    billing: "free",
                    sessions: null,
                    prefer: false,
                    models: [],
                    windows: [],
                  }),
                );
              } else if (value) {
                const found = TOOL_PRESETS.find((p) => p.name === value);
                if (found) onChange(addTool(flow, presetToTool(found)));
              }
            }}
          >
            <option value="">Choose…</option>
            {TOOL_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            <option value="custom">Something else</option>
          </select>
        </label>
      </div>
      <div className="ft-grid">
        {balanced(flow.tools).map((column, i) => (
          <div key={i} className="ft-col">
            {column.map((tool) => (
              <ToolCard key={tool.id} tool={tool} flow={flow} onChange={onChange} />
            ))}
          </div>
        ))}
      </div>
      {flow.tools.length === 0 && <p className="flow-muted">No tools yet. Add the ones you use.</p>}
    </section>
  );
}
