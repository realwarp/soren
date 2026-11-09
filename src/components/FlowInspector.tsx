import { useState } from "react";
import {
  addOutput,
  autoModel,
  costUnit,
  descendants,
  effectiveModel,
  eligibleModels,
  removeOutput,
  unwire,
  updateNode,
  updateOutput,
  waitUntil,
  wire,
  type Flow,
  type FlowNode,
} from "../flowModel";
import type { Rewrite } from "../flowCloud";
import { PromptEditor } from "./PromptEditor";
import { askVariables, unwireTranslator } from "../flowAsk";
import { criticModel, newCritic } from "../flowCritic";
import { anchorFor, resetsIn } from "../flowTools";
import { PlusIcon, TrashIcon } from "./Icons";

const OPEN_PREFIX = "soren.flow.open.";

/**
 * One collapsible part of the inspector. Each part remembers on its own whether
 * it was left open, and shows a one-line summary while closed, so a glance is
 * enough to check it and nobody has to pick a "mode" first.
 */
function Section({
  id,
  title,
  summary,
  startOpen = false,
  children,
}: {
  id: string;
  title: string;
  summary?: string;
  /** Open the first time, until the person closes it. */
  startOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(OPEN_PREFIX + id);
      return saved === null ? startOpen : saved === "1";
    } catch {
      return startOpen;
    }
  });
  function toggle() {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_PREFIX + id, open ? "0" : "1");
    } catch {
      // Storage can be blocked; the choice still holds for this visit.
    }
  }
  return (
    <section className={`flow-section ${open ? "open" : ""}`}>
      <button type="button" className="flow-disclose" aria-expanded={open} onClick={toggle}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <b>{title}</b>
        {!open && summary && <em>{summary}</em>}
      </button>
      {open && <div className="flow-details">{children}</div>}
    </section>
  );
}

/** Steps, checks and approvals can wait on a question and be conditioned on an answer. */
const isVariableUser = (node: FlowNode) => node.kind === "agent" || node.kind === "verifier" || node.kind === "approval";

/** Only steps and checks have an inside, a prompt and a plan; a Start or End is just a marker. */
const isWorkKind = (node: FlowNode) => node.kind === "agent" || node.kind === "verifier";

const label = (m: { name: string; capability: number; usage?: number; freeHours?: number }) =>
  `${m.name} (${m.capability})${
    m.freeHours !== undefined
      ? ` ${m.freeHours} free h/day`
      : m.usage === 0
        ? " free"
        : m.usage && m.usage !== 1
          ? ` x${m.usage}`
          : ""
  }`;

/**
 * The step editor, in levels. Everything a new person needs is at the top: what
 * the step does, which tool runs it, and what it waits for. The rest sits behind
 * one Details control that remembers whether it was open.
 */
export function FlowInspector({
  flow,
  node,
  embedded = false,
  onOpenInside,
  onChange,
  onRemove,
  onDuplicate,
  onSuggestInside,
  suggesting = false,
  removable = true,
  rewrite,
  polishing = false,
  onPolish,
  onAcceptRewrite,
  onRejectRewrite,
}: {
  flow: Flow;
  node: FlowNode;
  /** Inside another step: no tool, cost, prompt or delegation of its own. */
  embedded?: boolean;
  onOpenInside: () => void;
  onChange: (next: Flow) => void;
  onRemove: () => void;
  /** Put a copy of this step beside it. */
  onDuplicate?: () => void;
  /** Ask the cloud model for sub-steps. Optional: nothing is asked until the button is pressed. */
  onSuggestInside?: () => void;
  suggesting?: boolean;
  /** False for the only Start, which a workflow cannot do without. */
  removable?: boolean;
  /** The rewrite the cloud model offered for this step's prompt, waiting on an Accept or Reject. */
  rewrite?: Rewrite;
  /** A cloud request for prompts is running. */
  polishing?: boolean;
  onPolish?: () => void;
  onAcceptRewrite?: () => void;
  onRejectRewrite?: () => void;
}) {
  const toolOf = flow.tools.find((t) => t.id === node.toolId);
  const waitTime = waitUntil(flow, node);
  const unit = costUnit(toolOf);
  const model = effectiveModel(flow, node);
  const agent = node.kind === "agent" && !embedded;

  // Wiring something that already waits on this node would make a cycle.
  const blocked = descendants(flow, node.id);
  const wired = (nodeId: string, portId: string) =>
    node.inputs.some((ref) => ref.node === nodeId && ref.port === portId);
  const addable = flow.nodes
    .filter((n) => n.id !== node.id && !blocked.has(n.id))
    .flatMap((source) =>
      source.outputs
        .filter((port) => !wired(source.id, port.id))
        .map((port) => ({ key: `${source.id}.${port.id}`, source, port })),
    );

  const auto = node.need === undefined ? undefined : autoModel(toolOf, node.need);
  const eligible = eligibleModels(toolOf, node.need ?? 1);
  const pinned = toolOf?.models.find((m) => m.id === node.modelId);
  const choices = pinned && !eligible.some((m) => m.id === pinned.id) ? [...eligible, pinned] : eligible;

  return (
    <div className="flow-inspector">
      <div className="flow-side-head">
        <h3>{{ verifier: "Check", start: "Start", end: "End", agent: "Step", approval: "Approval", wait: "Wait for reset", translator: "Translator" }[node.kind]}</h3>
        <span className="flow-side-head-actions">
          {onDuplicate && node.kind !== "start" && (
            <button type="button" className="flow-button" title="Copy this step (Cmd or Ctrl + D)" onClick={onDuplicate}>
              Duplicate
            </button>
          )}
          {removable && (
            <button type="button" className="flow-icon-button" aria-label="Remove this step" onClick={onRemove}>
              <TrashIcon />
            </button>
          )}
        </span>
      </div>

      <label className="flow-field">
        <span>
          {node.kind === "verifier"
            ? "What is checked"
            : node.kind === "approval"
              ? "What you will check"
              : node.kind === "wait"
                ? "Why you are waiting"
                : node.kind === "translator"
                ? "What it tells the steps (empty lists each question and answer)"
                : node.kind === "start"
              ? "Where this begins"
              : node.kind === "end"
                ? "What finishing means"
                : "What this step does"}
        </span>
        <textarea
          rows={2}
          value={node.text}
          placeholder="One or two lines"
          onChange={(e) =>
            onChange(
              updateNode(flow, node.id, {
                text: e.target.value,
                ...(node.kind === "verifier" && node.check
                  ? { check: { ...node.check, label: e.target.value } }
                  : {}),
              }),
            )
          }
        />
      </label>

      {!embedded && isVariableUser(node) && (flow.asks?.length ?? 0) > 0 && (
        <p className="flow-muted">
          Answers you can use here: {[...askVariables(flow).keys()].map((n) => `{${n}}`).join(", ") || "none yet"}
        </p>
      )}

      {node.kind === "translator" && (
        <div className="flow-group">
          <h4>Questions it turns into words</h4>
          {(node.askInputs ?? []).length === 0 ? (
            <p className="flow-muted">None yet. Drag from a square's dot onto this node.</p>
          ) : (
            <ul className="flow-chips">
              {(node.askInputs ?? []).map((ref) => {
                const ask = (flow.asks ?? []).find((a) => a.id === ref.ask);
                return (
                  <li key={`${ref.ask}.${ref.port ?? ""}`}>
                    <span>
                      {ask?.title || ask?.fields[0]?.label || ref.ask}
                      {ref.port ? ` · ${ref.port}` : ""}
                    </span>
                    <button type="button" aria-label="Remove this wire" onClick={() => onChange(unwireTranslator(flow, node.id, ref))}>
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="flow-muted">
            It finishes by itself once they are answered, and is skipped when their branch is not taken. Steps that wait for it get the
            text.
          </p>
        </div>
      )}

      {agent && (
        <label className="flow-field">
          <span>Runs in</span>
          <select
            value={node.toolId ?? ""}
            onChange={(e) => onChange(updateNode(flow, node.id, { toolId: e.target.value || undefined }))}
          >
            <option value="">Pick a tool</option>
            {flow.tools.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.name} {tool.tier && `(${tool.tier})`}
              </option>
            ))}
          </select>
        </label>
      )}
      {agent && flow.tools.length === 0 && (
        <p className="flow-muted">Add the tools you use first, with the Tools button above.</p>
      )}

      {node.kind === "wait" && (
        <div className="flow-group">
          <h4>Holds until</h4>
          {flow.tools.length === 0 ? (
            <p className="flow-muted">Add the tools you use first, with the Tools button above.</p>
          ) : (
            <div className="flow-row">
              <label className="flow-field grow">
                <span>Tool</span>
                <select
                  value={node.wait?.toolId ?? ""}
                  onChange={(e) => {
                    const tool = flow.tools.find((t) => t.id === e.target.value);
                    const window = tool?.windows.find((w) => w.resetsAt !== null) ?? tool?.windows[0];
                    onChange(updateNode(flow, node.id, { wait: { toolId: e.target.value, window: window?.label ?? "" } }));
                  }}
                >
                  <option value="">Pick a tool</option>
                  {flow.tools.map((tool) => (
                    <option key={tool.id} value={tool.id}>
                      {tool.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flow-field grow">
                <span>Limit</span>
                <select
                  value={node.wait?.window ?? ""}
                  onChange={(e) =>
                    onChange(updateNode(flow, node.id, { wait: { toolId: node.wait?.toolId ?? "", window: e.target.value } }))
                  }
                >
                  <option value="">Pick a limit</option>
                  {(flow.tools.find((t) => t.id === node.wait?.toolId)?.windows ?? []).map((w) => (
                    <option key={w.label} value={w.label}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <p className="flow-muted">
            {waitTime === null
              ? "Set when this limit resets in the Tools panel and the wait will end by itself."
              : `Resets ${resetsIn(waitTime)}. It finishes by itself then.`}
          </p>
        </div>
      )}

      {node.kind !== "start" && node.kind !== "translator" && (
      <div className="flow-group">
        <h4>Waits for</h4>
        {node.inputs.length === 0 ? (
          <p className="flow-muted">Nothing, so it can start right away.</p>
        ) : (
          <ul className="flow-chips">
            {node.inputs.map((ref) => {
              const source = flow.nodes.find((n) => n.id === ref.node);
              const port = source?.outputs.find((p) => p.id === ref.port);
              return (
                <li key={`${ref.node}.${ref.port}`}>
                  <span>{port?.label || source?.text || ref.node}</span>
                  <button
                    type="button"
                    aria-label={`Stop waiting for ${port?.label || ref.node}`}
                    onClick={() => onChange(unwire(flow, node.id, ref))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {addable.length > 0 ? (
          <select
            className="flow-add-wait"
            value=""
            aria-label="Wait for another step"
            onChange={(e) => {
              const pick = addable.find((a) => a.key === e.target.value);
              if (pick) onChange(wire(flow, node.id, { node: pick.source.id, port: pick.port.id }));
            }}
          >
            <option value="">Wait for another step…</option>
            {addable.map((a) => (
              <option key={a.key} value={a.key}>
                {a.port.label || "Unnamed"} (from {a.source.text || a.source.id})
              </option>
            ))}
          </select>
        ) : (
          <p className="flow-muted">To connect steps, drag from one step's circle onto another.</p>
        )}
      </div>
      )}

      {agent && toolOf && (
        <Section
          id="model"
          title="Model and cost"
          summary={
            model
              ? `${model.name} · ${node.cost} ${unit === "hours" ? "h" : node.cost === 1 ? "prompt" : "prompts"}`
              : "not rated yet"
          }
        >
          <div className="flow-slider-row">
            <input
              type="range"
              min={1}
              max={10}
              value={node.need ?? 5}
              aria-label="Capability needed, 1 to 10"
              onChange={(e) => onChange(updateNode(flow, node.id, { need: Number(e.target.value) }))}
            />
            <span className="flow-slider-value">{node.need ?? "–"}</span>
            {node.need !== undefined && (
              <button
                type="button"
                className="flow-link"
                onClick={() => onChange(updateNode(flow, node.id, { need: undefined, modelId: undefined }))}
              >
                Clear
              </button>
            )}
          </div>
          <p className="flow-muted">
            {node.need === undefined
              ? "Not rated yet. The local planner will rate it, or drag the slider."
              : anchorFor(node.need)}
          </p>
          <div className="flow-row">
            <label className="flow-field grow">
              <span>Model</span>
              <select
                value={node.modelId ?? ""}
                onChange={(e) => onChange(updateNode(flow, node.id, { modelId: e.target.value || undefined }))}
              >
                <option value="">{auto ? `Auto: ${label(auto)}` : "Auto (rate the step first)"}</option>
                {choices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {label(m)}
                    {node.need !== undefined && m.capability < node.need ? " too weak" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flow-field narrow">
              <span>{unit === "hours" ? "Hours" : "Prompts"}</span>
              <input
                type="number"
                min={0}
                max={99}
                step={unit === "hours" ? 0.25 : 1}
                value={node.cost}
                onChange={(e) => {
                  const cost = Math.max(0, Math.min(99, Number(e.target.value) || 0));
                  onChange(updateNode(flow, node.id, { cost }));
                }}
              />
            </label>
          </div>
        </Section>
      )}

      {(node.kind === "agent" || node.kind === "start") && (
        <Section
          id="makes"
          title={node.kind === "start" ? "What you bring" : "Makes"}
          summary={node.outputs.length ? node.outputs.map((p) => p.label || "unnamed").join(", ") : "nothing yet"}
        >
          {node.outputs.map((port) => (
            <div key={port.id} className="flow-output">
              <input
                value={port.label}
                placeholder="Name, e.g. API contract"
                onChange={(e) => onChange(updateOutput(flow, node.id, port.id, { label: e.target.value }))}
              />
              <input
                value={port.note}
                placeholder="What must be in it"
                onChange={(e) => onChange(updateOutput(flow, node.id, port.id, { note: e.target.value }))}
              />
              <button
                type="button"
                className="flow-icon-button"
                aria-label={`Remove ${port.label || "artifact"}`}
                onClick={() => onChange(removeOutput(flow, node.id, port.id))}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          <button type="button" className="flow-button" onClick={() => onChange(addOutput(flow, node.id, ""))}>
            <PlusIcon /> Artifact
          </button>
        </Section>
      )}

      {!embedded && isVariableUser(node) && (flow.asks?.length ?? 0) > 0 && (
        <Section
          id="asks"
          title="Questions for you"
          summary={
            node.when
              ? `only if {${node.when.name}} is ${node.when.equals || "…"}`
              : node.asks?.length
                ? `waits for ${node.asks.length} answer${node.asks.length === 1 ? "" : "s"}`
                : "none"
          }
        >
          <div className="flow-group">
            <h4>Waits for an answer</h4>
            {(node.asks ?? []).map((need) => {
              const ask = (flow.asks ?? []).find((a) => a.id === need.ask);
              return (
                <div key={need.ask} className="flow-row">
                  <span className="flow-need-name">{ask?.title || ask?.fields[0]?.label || need.ask}</span>
                  <label className="flow-check">
                    <input
                      type="checkbox"
                      checked={Boolean(need.optional)}
                      onChange={(e) =>
                        onChange(
                          updateNode(flow, node.id, {
                            asks: (node.asks ?? []).map((n) => (n.ask === need.ask ? { ...n, optional: e.target.checked } : n)),
                          }),
                        )
                      }
                    />
                    <span>can start without it</span>
                  </label>
                  <button
                    type="button"
                    className="flow-icon-button"
                    aria-label="Stop waiting for this answer"
                    onClick={() => onChange(updateNode(flow, node.id, { asks: (node.asks ?? []).filter((n) => n.ask !== need.ask) }))}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <select
              className="flow-add-wait"
              value=""
              aria-label="Wait for an answer"
              onChange={(e) => {
                if (e.target.value) onChange(updateNode(flow, node.id, { asks: [...(node.asks ?? []), { ask: e.target.value }] }));
              }}
            >
              <option value="">Wait for an answer…</option>
              {(flow.asks ?? [])
                .filter((a) => !(node.asks ?? []).some((n) => n.ask === a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title || a.fields[0]?.label || a.id}
                  </option>
                ))}
            </select>
          </div>

          <div className="flow-group">
            <h4>Run only if</h4>
            {(() => {
              const vars = [...askVariables(flow).entries()];
              const picked = node.when ? vars.find(([name]) => name === node.when!.name)?.[1] : undefined;
              const options = picked ? (picked.field.type === "yesno" ? ["yes", "no"] : picked.field.options ?? []) : [];
              return (
                <>
                  <select
                    value={node.when?.name ?? ""}
                    aria-label="The answer this depends on"
                    onChange={(e) => {
                      const name = e.target.value;
                      if (!name) return onChange(updateNode(flow, node.id, { when: undefined }));
                      const field = vars.find(([n]) => n === name)?.[1].field;
                      const first = field?.type === "yesno" ? "yes" : field?.options?.[0] ?? "";
                      onChange(updateNode(flow, node.id, { when: { name, equals: first } }));
                    }}
                  >
                    <option value="">Always</option>
                    {vars.map(([name, v]) => (
                      <option key={name} value={name}>
                        {v.field.label || name} ({`{${name}}`})
                      </option>
                    ))}
                  </select>
                  {node.when && (
                    <label className="flow-field">
                      <span>is</span>
                      {options.length > 0 ? (
                        <select
                          value={node.when.equals}
                          onChange={(e) => onChange(updateNode(flow, node.id, { when: { ...node.when!, equals: e.target.value } }))}
                        >
                          {options.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={node.when.equals}
                          placeholder="the answer it must be"
                          onChange={(e) => onChange(updateNode(flow, node.id, { when: { ...node.when!, equals: e.target.value } }))}
                        />
                      )}
                    </label>
                  )}
                  <p className="flow-muted">
                    {node.when
                      ? "If the answer is anything else, this step is skipped, and so is anything that only waits for it."
                      : "Pick an answer to make this step optional depending on it."}
                  </p>
                </>
              );
            })()}
          </div>
        </Section>
      )}

      {agent && (
        <Section
          id="critic"
          title="Critic"
          summary={node.critic ? `up to ${node.critic.maxRounds} round${node.critic.maxRounds === 1 ? "" : "s"}` : "none"}
        >
          {!node.critic ? (
            <>
              <p className="flow-muted">
                A second prompt reviews what this step made and sends it back for changes, until it approves or the rounds run out.
              </p>
              <button type="button" className="flow-button" onClick={() => onChange(updateNode(flow, node.id, { critic: newCritic() }))}>
                Add a critic
              </button>
            </>
          ) : (
            <>
              <label className="flow-field">
                <span>What the critic checks for</span>
                <textarea
                  rows={3}
                  value={node.critic.criteria}
                  placeholder="Empty means: does it do what the step says, with nothing missing."
                  onChange={(e) => onChange(updateNode(flow, node.id, { critic: { ...node.critic!, criteria: e.target.value } }))}
                />
              </label>
              <label className="flow-field">
                <span>Most rounds before you decide</span>
                <input
                  type="number"
                  min={1}
                  max={9}
                  value={node.critic.maxRounds}
                  onChange={(e) =>
                    onChange(updateNode(flow, node.id, { critic: { ...node.critic!, maxRounds: Math.min(9, Math.max(1, Number(e.target.value) || 1)) } }))
                  }
                />
              </label>
              <details className="flow-more">
                <summary>Which tool and model review it</summary>
                <label className="flow-field">
                  <span>Critic runs in</span>
                  <select
                    value={node.critic.toolId ?? ""}
                    onChange={(e) => onChange(updateNode(flow, node.id, { critic: { ...node.critic!, toolId: e.target.value || undefined } }))}
                  >
                    <option value="">Same tool as the step</option>
                    {flow.tools.map((tool) => (
                      <option key={tool.id} value={tool.id}>
                        {tool.name} {tool.tier && `(${tool.tier})`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flow-field">
                  <span>Capability it needs (default: two below the step)</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={node.critic.need ?? Math.max(1, (node.need ?? 5) - 2)}
                    onChange={(e) =>
                      onChange(updateNode(flow, node.id, { critic: { ...node.critic!, need: Math.min(10, Math.max(1, Number(e.target.value) || 1)) } }))
                    }
                  />
                </label>
                <p className="flow-muted">Reviews with {criticModel(flow, node)?.name ?? "no model picked yet"}.</p>
              </details>
              <button type="button" className="flow-button" onClick={() => onChange(updateNode(flow, node.id, { critic: undefined }))}>
                Remove the critic
              </button>
            </>
          )}
        </Section>
      )}

      {!embedded && isWorkKind(node) && (
        <Section
          id="inside"
          title="Inside this step"
          summary={node.sub?.length ? `${node.sub.length} sub-step${node.sub.length === 1 ? "" : "s"}` : "none"}
        >
          <button type="button" className="flow-button" onClick={onOpenInside}>
            {node.sub?.length ? "Open inside" : "Break into sub-steps"}
          </button>
          {!node.sub?.length && onSuggestInside && (
            <button type="button" className="flow-button" disabled={suggesting || !node.text.trim()} onClick={onSuggestInside}>
              {suggesting ? "Asking…" : "Suggest sub-steps (optional, one request)"}
            </button>
          )}
          <p className="flow-muted">
            Sub-steps are handed to the tool's own subagents inside this step's prompt. You can also double-click a step.
          </p>
        </Section>
      )}

      {!embedded && isWorkKind(node) && (
        <Section id="prompt" title="Plan and prompt" summary="filled in from the step" startOpen>
          <label className="flow-field flow-sticky-field">
            <span>Plain-language plan (what you read to check it)</span>
            <textarea
              className="flow-sticky"
              rows={3}
              value={node.readable ?? ""}
              placeholder={node.text}
              onChange={(e) => onChange(updateNode(flow, node.id, { readable: e.target.value }))}
            />
          </label>
          <div className="flow-field">
            <span>Prompt for the tool</span>
            <PromptEditor
              flow={flow}
              node={node}
              onChange={onChange}
              rewrite={rewrite}
              busy={polishing}
              onPolish={onPolish ?? (() => {})}
              onAcceptRewrite={onAcceptRewrite ?? (() => {})}
              onRejectRewrite={onRejectRewrite ?? (() => {})}
            />
          </div>
        </Section>
      )}
    </div>
  );
}
