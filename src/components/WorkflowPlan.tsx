import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../clipboard";
import { collatedDoc, effectiveModel, isWork, planOrder, type Flow, type FlowNode } from "../flowModel";
import { fillVariables } from "../flowAsk";
import { nodePrompt } from "../flowPrompt";
import { joinSegments, promptSegments } from "../flowPromptDoc";
import { addStepAtEnd, headingEditable, moveStep, removeStep, renameStep, setStepBody } from "../flowPlanEdit";
import { proposalWaitingFor, subscribeProposalGate } from "../flowStore";
import { anchorFor } from "../flowTools";
import { CheckIcon, CloseIcon, CopyIcon, ExpandIcon } from "./Icons";

/**
 * The plan's steps, each a heading and its text, joined by rules. Given `onPick`, a heading is a
 * button for its step (`ids` says which step each part is: one part per work step, in order).
 */
function Steps({
  parts,
  ids,
  picked,
  onPick,
}: {
  parts: string[];
  ids?: string[];
  picked?: string | null;
  onPick?: (id: string) => void;
}) {
  return (
    <>
      {parts.map((part, i) => {
        const text = part.trim();
        const [first, ...rest] = text.split("\n");
        const heading = first.startsWith("## ") ? first.slice(3) : null;
        const id = ids?.[i];
        const on = Boolean(id && picked === id);
        return (
          <div key={i} data-step-block={id}>
            {i > 0 && <hr />}
            {heading && (
              <h3 className="plan-step">
                {onPick && id ? (
                  <button
                    type="button"
                    className={`plan-step-pick ${on ? "picked" : ""}`}
                    aria-expanded={on}
                    data-step={id}
                    title={on ? "Hide this step's prompt and details" : "Show this step's prompt and details in the margins (or use the arrow keys)"}
                    onClick={() => onPick(id)}
                  >
                    {heading}
                  </button>
                ) : (
                  heading
                )}
              </h3>
            )}
            <pre className="flow-doc-part">{(heading ? rest.join("\n") : text).trim()}</pre>
          </div>
        );
      })}
    </>
  );
}

/** A text box that grows to its text and changes nothing outside itself until it loses focus. */
function BodyBox({ value, readOnly, onCommit, onKey }: { value: string; readOnly?: boolean; onCommit: (v: string) => void; onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(fit, [value]);
  return (
    <textarea
      ref={ref}
      className="plan-edit-body"
      defaultValue={value}
      readOnly={readOnly}
      rows={1}
      spellCheck={false}
      onInput={fit}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
        else onKey(e);
      }}
    />
  );
}

/** The generated lines under a step (what it needs, makes and holds); they are read from the graph and not edited here. */
function generatedLines(part: string): string {
  return part
    .split("\n")
    .filter((l) => /^- (Needs|Makes|Inside): /.test(l))
    .join("\n");
}

/**
 * The plan's steps as fields. A heading renames its step and the text under it is the step's description; both are saved
 * when the field loses focus (Enter on a heading), so typing never redraws the canvas. Alt+Up and Alt+Down move a step
 * one place when the steps are in a plain chain. A cross removes the step and a box at the end adds one.
 */
function EditableSteps({ flow, parts, onEdit }: { flow: Flow; parts: string[]; onEdit: (next: Flow) => void }) {
  const steps = useMemo(() => planOrder(flow), [flow]);
  const [note, setNote] = useState<string | null>(null);
  const focusId = useRef<string | null>(null);
  const noteTimer = useRef(0);
  const say = (text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 4500);
  };
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  // After a move the step keeps the cursor.
  useEffect(() => {
    const id = focusId.current;
    if (!id) return;
    focusId.current = null;
    document.querySelector<HTMLElement>(`[data-edit-block="${CSS.escape(id)}"] .plan-edit-heading`)?.focus({ preventScroll: true });
  }, [steps]);

  // While the agent's proposal waits on the canvas the workflow is held, as it is there; an edit here would be overwritten.
  const held = useSyncExternalStore(subscribeProposalGate, () => proposalWaitingFor(flow.id));
  const heldNote = "The agent has proposed changes. Apply or reject them on the canvas before editing here.";
  const change = (next: Flow) => {
    if (next === flow) return;
    if (held) return say(heldNote);
    onEdit(next);
  };
  const move = (id: string, dir: -1 | 1) => {
    if (held) return say(heldNote);
    const result = moveStep(flow, id, dir);
    if (result.note) say(result.note);
    else if (result.flow !== flow) {
      focusId.current = id;
      onEdit(result.flow);
    }
  };
  const altMove = (id: string) => (e: React.KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    move(id, e.key === "ArrowUp" ? -1 : 1);
  };
  const toolName = (n: FlowNode) => flow.tools.find((t) => t.id === n.toolId)?.name;

  return (
    <>
      {steps.map(({ node, label }, i) => {
        const body = node.readable?.trim() || node.text;
        const canHead = headingEditable(flow, node.id);
        const prefix = node.kind === "approval" ? "Approval: " : node.kind === "verifier" ? "Check: " : "";
        return (
          <div key={node.id} data-edit-block={node.id} className="plan-edit-block">
            {i > 0 && <hr />}
            <div className="plan-edit-head">
              <span className="plan-edit-label">{label}.</span>
              {prefix && <span className="plan-edit-label">{prefix}</span>}
              {canHead ? (
                <input
                  key={`${node.id}:${node.text}`}
                  className="plan-edit-heading"
                  defaultValue={node.text}
                  readOnly={held}
                  aria-label={`Step ${label} heading`}
                  onBlur={(e) => {
                    const v = e.currentTarget.value;
                    if (!v.trim()) e.currentTarget.value = node.text;
                    else change(renameStep(flow, node.id, v));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") {
                      e.currentTarget.value = node.text;
                      e.currentTarget.blur();
                    } else altMove(node.id)(e);
                  }}
                />
              ) : (
                <span className="plan-edit-heading fixed" title="A check is named on the canvas">
                  {node.check?.label ?? node.text}
                </span>
              )}
              {toolName(node) && <span className="plan-edit-tool">({toolName(node)})</span>}
              <span className="plan-edit-actions">
                <button type="button" aria-label="Move up" title="Move up (Alt+Up)" disabled={held || i === 0} onClick={() => move(node.id, -1)}>
                  ↑
                </button>
                <button type="button" aria-label="Move down" title="Move down (Alt+Down)" disabled={held || i === steps.length - 1} onClick={() => move(node.id, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  aria-label="Remove this step"
                  title="Remove this step"
                  disabled={held}
                  onClick={() => {
                    if (held) return say(heldNote);
                    change(removeStep(flow, node.id));
                    say("Step removed. Press Cmd+Z on the canvas to undo.");
                  }}
                >
                  ×
                </button>
              </span>
            </div>
            <BodyBox key={`${node.id}:${body}`} value={body} readOnly={held} onCommit={(v) => change(setStepBody(flow, node.id, v))} onKey={altMove(node.id)} />
            {generatedLines(parts[i] ?? "") && <pre className="flow-doc-part plan-edit-extra">{generatedLines(parts[i] ?? "")}</pre>}
          </div>
        );
      })}
      <input
        className="plan-edit-add"
        placeholder="Add a step: type a heading, press Enter"
        aria-label="Add a step"
        readOnly={held}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !e.currentTarget.value.trim()) return;
          change(addStepAtEnd(flow, e.currentTarget.value));
          e.currentTarget.value = "";
        }}
      />
      {(held || note) && (
        <div className="plan-edit-note" role="status">
          {held ? heldNote : note}
        </div>
      )}
    </>
  );
}

/**
 * The right-hand column of the Workflows tab: every step of the open workflow in plain English,
 * in order, joined by rules. It is what the person reads to check everything that will happen
 * before they run it, so it follows the workflow as it is edited and as its plans are written.
 * It can also be opened full screen, for reading the whole thing at once.
 */
export function WorkflowPlan({ flow, onClose, onEdit }: { flow: Flow | null; onClose?: () => void; onEdit?: (next: Flow) => void }) {
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(false);
  const doc = useMemo(() => (flow ? collatedDoc(flow) : ""), [flow]);
  const steps = flow ? flow.nodes.filter(isWork).length : 0;
  // The document opens with the workflow's title, which this panel already shows in its header.
  const parts = useMemo(() => doc.replace(/^# .*\n+/, "").split("\n---\n"), [doc]);
  const title = flow ? flow.title || "Untitled workflow" : "Plan";

  // Without a workflow there is nothing to read, so a full-screen view would be left open on nothing.
  useEffect(() => {
    if (!flow) setFull(false);
  }, [flow]);

  async function copyPlan() {
    await copyText(doc);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  const copyButton = (
    <button
      type="button"
      className="copy-btn"
      onClick={() => void copyPlan()}
      disabled={steps === 0}
      title="Copy the plan as Markdown"
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );

  return (
    <div className="brief">
      <div className="brief-head">
        <div className="brief-title-row">
          <div>
            <div className="brief-eyebrow">The whole plan</div>
            <h2 className="brief-title">{title}</h2>
          </div>
          <div className="brief-tools">
            <span className="brief-count" title="Steps in the plan">
              {steps}
            </span>
            <button
              type="button"
              className="copy-btn"
              onClick={() => setFull(true)}
              disabled={!flow || steps === 0}
              title="Read the whole plan full screen"
            >
              <ExpandIcon size={14} />
              <span>Full screen</span>
            </button>
            {copyButton}
            {onClose && (
              <button type="button" className="brief-close" onClick={onClose} aria-label="Close plan" title="Close plan">
                <CloseIcon size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="brief-body flow-doc">
        {!flow ? (
          <p className="flow-muted">Open a workflow and its whole plan is read out here, step by step.</p>
        ) : steps === 0 && !onEdit ? (
          <p className="flow-muted">Nothing to read yet. Add a step and it appears here.</p>
        ) : onEdit ? (
          <EditableSteps flow={flow} parts={parts} onEdit={onEdit} />
        ) : (
          <Steps parts={parts} />
        )}
      </div>
      {full && flow && (
        <FullScreen flow={flow} parts={parts} title={title} steps={steps} copyButton={copyButton} onClose={() => setFull(false)} />
      )}
    </div>
  );
}

/**
 * The plan over the whole window, as one centred column to read. Clicking a step's heading puts
 * its prompt in the left margin and what the step exposes (tool, inputs, outputs, status) in the
 * right one; clicking it again clears both. Only one step is shown at a time, and the margins sit
 * beside the column rather than in it, so the text never moves. It is drawn on the page itself,
 * outside the side pane, which clips what is inside it. Escape closes it.
 */
function FullScreen({
  flow,
  parts,
  title,
  steps,
  copyButton,
  onClose,
}: {
  flow: Flow;
  parts: string[];
  title: string;
  steps: number;
  copyButton: ReactNode;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const work = useMemo(() => flow.nodes.filter(isWork), [flow]);
  // The document lists steps in plan order (1, 2A, 2B, 3...), so the headings are matched to steps the same way.
  const ids = useMemo(() => planOrder(flow).map((s) => s.node.id), [flow]);
  // A step taken out while it is showing clears the margins rather than leaving them stale.
  const picked = work.find((n) => n.id === pickedId) ?? null;

  useEffect(() => close.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Left and right arrows step through the headings. With none picked, Right starts at the first and
  // Left at the last; at either end they stay put rather than wrapping round.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || ids.length === 0) return;
      e.preventDefault();
      const at = pickedId ? ids.indexOf(pickedId) : -1;
      const next =
        at < 0
          ? e.key === "ArrowRight"
            ? 0
            : ids.length - 1
          : Math.min(ids.length - 1, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)));
      setPickedId(ids[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ids, pickedId]);

  // A picked step is brought on screen whole, heading and text, so what its margins describe is what is
  // in front of the reader, moving the page as little as it takes: one already fully in view stays put,
  // one further down is scrolled until the end of its text is at the bottom, and one above until its
  // heading is at the top. A step taller than the screen is lined up by its heading instead.
  useEffect(() => {
    if (!pickedId) return;
    const body = document.querySelector<HTMLElement>(".plan-full-body");
    const block = document.querySelector<HTMLElement>(`[data-step-block="${CSS.escape(pickedId)}"]`);
    if (!body || !block) return;
    const pad = 24;
    const b = block.getBoundingClientRect();
    const c = body.getBoundingClientRect();
    const fits = b.height <= c.height - 2 * pad;
    if (b.top < c.top + pad) {
      body.scrollBy({ top: b.top - c.top - pad, behavior: "smooth" });
    } else if (b.bottom > c.bottom - pad) {
      body.scrollBy({ top: fits ? b.bottom - c.bottom + pad : b.top - c.top - pad, behavior: "smooth" });
    }
  }, [pickedId]);

  return createPortal(
    <div className="plan-full" role="dialog" aria-modal="true" aria-label={`${title}, the whole plan`}>
      <div className="plan-full-head">
        <div className="plan-full-title">
          <span className="brief-eyebrow">The whole plan</span>
          <h2>{title}</h2>
        </div>
        <span className="brief-count" title="Steps in the plan">
          {steps}
        </span>
        {copyButton}
        <button ref={close} type="button" className="copy-btn" onClick={onClose} title="Back (Esc)">
          <CloseIcon size={14} />
          <span>Close</span>
        </button>
      </div>
      <div className="plan-full-body">
        <div className={`plan-full-doc flow-doc ${picked ? "has-pick" : ""}`}>
          <div className="plan-margin left">{picked && <PromptCard flow={flow} node={picked} />}</div>
          <div className="plan-doc-main">
            <Steps parts={parts} ids={ids} picked={pickedId} onPick={(id) => setPickedId((cur) => (cur === id ? null : id))} />
          </div>
          <div className="plan-margin right">{picked && <StepInfo flow={flow} node={picked} />}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The prompt a step will be run with, as it would be pasted, with a button to copy it. */
function PromptCard({ flow, node }: { flow: Flow; node: FlowNode }) {
  const [copied, setCopied] = useState(false);
  const prompt = nodePrompt(flow, node);
  // An approval is done by a person, so there is nothing to paste anywhere.
  const pasteable = node.kind !== "approval";

  async function copyPrompt() {
    await copyText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <span className="brief-eyebrow">The prompt</span>
        {pasteable && (
          <button type="button" className="copy-btn" onClick={() => void copyPrompt()}>
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        )}
      </div>
      {!pasteable ? (
        <p className="flow-muted">A person does this one. There is nothing to paste into a tool.</p>
      ) : (
        <>
          <PromptText flow={flow} node={node} prompt={prompt} />
        </>
      )}
    </div>
  );
}

/**
 * The prompt as it will be pasted, with a faint rule at the left of each part saying who wrote it: code, the model (a
 * rewrite you accepted) or you. Copying gives plain text only.
 */
function PromptText({ flow, node, prompt }: { flow: Flow; node: FlowNode; prompt: string }) {
  const { segments } = useMemo(() => promptSegments(flow, node), [flow, node]);
  const base = fillVariables(flow, joinSegments(segments));
  const marked = base !== "" && prompt.startsWith(base);
  if (!marked) return <pre className="plan-card-text">{prompt}</pre>;
  const tail = prompt.slice(base.length).trim();
  return (
    <>
      <div className="plan-card-text prompt-readonly">
        {segments.map((seg) => (
          <div key={seg.id} className={`prompt-seg ${seg.author}`} title={seg.author === "template" ? "Written by code" : seg.author === "ai" ? "Rewritten by the model, accepted by you" : "Written by you"}>
            {fillVariables(flow, seg.text)}
          </div>
        ))}
        {tail && <div className="prompt-seg template">{tail}</div>}
      </div>
      <p className="prompt-legend">
        <span className="prompt-key template" /> code <span className="prompt-key ai" /> model, accepted <span className="prompt-key you" /> you
      </p>
    </>
  );
}

const KIND_LABEL: Record<string, string> = { agent: "Step", verifier: "Check", approval: "Approval" };

/** Everything a step exposes besides its prompt: where it runs, what it takes in and puts out, and how far along it is. */
function StepInfo({ flow, node }: { flow: Flow; node: FlowNode }) {
  const tool = flow.tools.find((t) => t.id === node.toolId);
  const model = effectiveModel(flow, node);
  const needs = node.inputs.map((ref) => {
    const source = flow.nodes.find((n) => n.id === ref.node);
    const port = source?.outputs.find((p) => p.id === ref.port);
    return { key: `${ref.node}.${ref.port}`, label: port?.label ?? ref.port, from: source?.text || ref.node };
  });
  const makes = node.kind === "verifier" ? [] : node.outputs;
  const rows: Array<[string, string]> = [["Kind", KIND_LABEL[node.kind] ?? node.kind]];
  if (tool) rows.push(["Tool", `${tool.name}, ${tool.tier} plan`]);
  if (model) rows.push(["Model", `${model.name}, capability ${model.capability} of 10`]);
  if (node.need !== undefined) rows.push(["Needs a model of", `${node.need} of 10: ${anchorFor(node.need).toLowerCase()}`]);
  if (node.kind === "agent") rows.push(["Expected cost", `${node.cost} prompt${node.cost === 1 ? "" : "s"}`]);
  if (node.check) rows.push(["Checks that", node.check.label]);

  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <span className="brief-eyebrow">This step</span>
      </div>
      <h3 className="plan-card-title">{node.text || "Untitled step"}</h3>
      <dl className="plan-facts">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>Status</dt>
          <dd>
            {node.done
              ? `Done ${new Date(node.done.at).toLocaleString()}${node.done.pasted.trim() ? `. It reported: ${node.done.pasted.trim()}` : ""}`
              : "Not done yet"}
          </dd>
        </div>
      </dl>
      {needs.length > 0 && (
        <>
          <h4>Takes in</h4>
          <ul className="plan-card-list">
            {needs.map((n) => (
              <li key={n.key}>
                <b>{n.label}</b> <span>from {n.from}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {makes.length > 0 && (
        <>
          <h4>Puts out</h4>
          <ul className="plan-card-list">
            {makes.map((p) => (
              <li key={p.id}>
                <b>{p.label}</b> {p.note && <span>{p.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {node.delegation && (
        <>
          <h4>Hands parts to subagents</h4>
          {node.sub && node.sub.length > 0 ? (
            <ul className="plan-card-list">
              {node.sub.map((step) => (
                <li key={step.id}>{step.text || step.id}</li>
              ))}
            </ul>
          ) : (
            <p className="flow-muted">Its tool is expected to split this up itself.</p>
          )}
        </>
      )}
    </div>
  );
}
