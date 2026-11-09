import { useEffect, useState } from "react";
import {
  addAskField,
  answerAsk,
  ASK_KIND_INFO,
  branchesOf,
  askState,
  clearAnswer,
  fillForAsk,
  isAnswered,
  refState,
  removeAskField,
  skipAsk,
  unwireAsk,
  updateAsk,
  updateAskField,
} from "../flowAsk";
import type { AnswerType, AskField, AskKind, Flow, FlowAsk } from "../flowModel";
import { PlusIcon, TrashIcon } from "./Icons";

/** What shows in the square itself: the answer, or what it is waiting for. */
export function askSummary(ask: FlowAsk): string {
  if (ask.skipped) return "Skipped";
  if (!isAnswered(ask)) return ask.kind === "constant" ? "Set a value" : "Waiting for you";
  if (ask.fields.length > 1) return `${ask.fields.length} answered`;
  const value = ask.fields[0].value ?? "";
  return ask.fields[0].type === "yesno" ? (value === "yes" ? "Yes" : "No") : value;
}

/** `title` is the square's heading with the answers it may read written in. */
export function AskSquareBody({ ask, title }: { ask: FlowAsk; title?: string }) {
  return (
    <>
      <span className="flow-ask-kind">
        {ASK_KIND_INFO[ask.kind].label}
        {ask.origin === "agent" ? " · from the agent" : ask.optional ? " · optional" : ""}
      </span>
      <span className="flow-ask-title">{title || ask.title || "Untitled question"}</span>
      <span className="flow-ask-answer">{askSummary(ask)}</span>
    </>
  );
}

const parseChoices = (text: string) => text.split("\n").map((o) => o.trim()).filter(Boolean);

/**
 * The choices, one on each line. It keeps the text as typed and saves the cleaned list beside it: showing the saved
 * list back would drop the empty line a new Enter makes, and you could never start a new line.
 */
function ChoicesInput({ options, onChange }: { options: string[]; onChange: (options: string[]) => void }) {
  const [text, setText] = useState(() => options.join("\n"));
  // The choices changed from somewhere else (undo, another square): show those instead of what was typed.
  useEffect(() => {
    setText((current) => (parseChoices(current).join("\n") === options.join("\n") ? current : options.join("\n")));
  }, [options]);
  return (
    <label className="flow-field">
      <span>The choices, one on each line</span>
      <textarea
        rows={3}
        value={text}
        placeholder={"postgres\nsqlite"}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseChoices(e.target.value));
        }}
      />
    </label>
  );
}

const TYPE_LABEL: Record<AnswerType, string> = { text: "Free text", choice: "A choice", yesno: "Yes or no" };

/** The control that gives one question its answer. `onPick` is called at once for a yes/no or a choice. */
function Control({
  field,
  value,
  onChange,
  readOnly = false,
}: {
  field: AskField;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  if (field.type === "yesno" || field.type === "choice") {
    const options = field.type === "yesno" ? ["yes", "no"] : field.options ?? [];
    if (options.length === 0) return <p className="flow-muted">No choices yet. Add some while planning.</p>;
    return (
      <div className="flow-choices" role="radiogroup" aria-label={field.label || "Choice"}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            disabled={readOnly}
            className={`flow-choice ${value === option ? "on" : ""}`}
            onClick={() => onChange(option)}
          >
            {field.type === "yesno" ? (option === "yes" ? "Yes" : "No") : option}
          </button>
        ))}
      </div>
    );
  }
  return (
    <textarea rows={3} value={value} readOnly={readOnly} placeholder="Type your answer" onChange={(e) => onChange(e.target.value)} />
  );
}

/**
 * The panel for a selected square. While planning it edits the question; during a run it takes the answer.
 * Anything past the question itself (the variable name, one question's type) sits behind More, in place.
 */
export function AskPanel({
  flow,
  ask,
  mode,
  onChange,
  onRemove,
}: {
  flow: Flow;
  ask: FlowAsk;
  mode: "plan" | "run";
  onChange: (next: Flow) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  // A different square, or an answer that changed from outside, starts the draft over from what is saved.
  useEffect(() => setDraft(Object.fromEntries(ask.fields.map((f) => [f.id, f.value ?? ""]))), [ask.id, ask.fields, ask.skipped]);

  const single = ask.fields.length === 1 && ask.kind !== "form";
  const answered = isAnswered(ask);
  const state = askState(flow, ask);
  const titleOf = (id: string) => {
    const a = (flow.asks ?? []).find((x) => x.id === id);
    return a ? a.title || a.fields[0]?.label || a.id : id;
  };
  const waitingOn = (ask.inputs ?? []).filter((ref) => refState(flow, ref) === "pending").map((ref) => titleOf(ref.ask));

  if (mode === "run") {
    const instant = single && (ask.fields[0].type === "yesno" || ask.fields[0].type === "choice");
    return (
      <div className="flow-inspector">
        <div className="flow-side-head">
          <h3>{ASK_KIND_INFO[ask.kind].label}</h3>
        </div>
        {state === "locked" && (
          <p className="flow-warn-box">Not asked yet. It comes after: {waitingOn.join(", ") || "another square"}.</p>
        )}
        {state === "skipped" && <p className="flow-muted">Not asked: the branch that leads here was not taken.</p>}
        {ask.kind === "form" && ask.title && <p className="flow-readable">{ask.title}</p>}
        {ask.fields.map((field) => (
          <div key={field.id} className="flow-field">
            <span>{fillForAsk(flow, ask, field.label) || "Untitled question"}</span>
            <Control
              field={field}
              value={draft[field.id] ?? ""}
              readOnly={ask.kind === "constant" || state !== "open"}
              onChange={(value) => {
                setDraft({ ...draft, [field.id]: value });
                if (instant) onChange(answerAsk(flow, ask.id, { [field.id]: value }));
              }}
            />
          </div>
        ))}
        {ask.kind === "constant" ? (
          <p className="flow-muted">A constant. Its value is set while planning.</p>
        ) : state !== "open" ? null : (
          <div className="flow-run-actions">
            {!instant && (
              <button type="button" className="flow-button primary" onClick={() => onChange(answerAsk(flow, ask.id, draft))}>
                Save the answer
              </button>
            )}
            {ask.optional && !answered && (
              <button type="button" className="flow-button" onClick={() => onChange(skipAsk(flow, ask.id))}>
                Skip
              </button>
            )}
            {answered && (
              <button type="button" className="flow-button" onClick={() => onChange(clearAnswer(flow, ask.id))}>
                Take the answer back
              </button>
            )}
          </div>
        )}
        <p className="flow-muted">
          {ask.fields.map((f) => `{${f.name}}`).join(", ")} {ask.fields.length === 1 ? "is" : "are"} what steps use to read{" "}
          {ask.fields.length === 1 ? "this" : "these"}.
        </p>
      </div>
    );
  }

  const set = (fieldId: string, patch: Partial<Omit<AskField, "id">>) => onChange(updateAskField(flow, ask.id, fieldId, patch));
  return (
    <div className="flow-inspector">
      <div className="flow-side-head">
        <h3>{ASK_KIND_INFO[ask.kind].label}</h3>
        <button type="button" className="flow-icon-button" aria-label="Remove this square" onClick={onRemove}>
          <TrashIcon />
        </button>
      </div>
      <p className="flow-muted">{ASK_KIND_INFO[ask.kind].hint}</p>

      {(ask.inputs ?? []).length > 0 && (
        <div className="flow-group">
          <h4>Comes after</h4>
          <ul className="flow-chips">
            {(ask.inputs ?? []).map((ref) => (
              <li key={`${ref.ask}.${ref.port ?? ""}`}>
                <span>
                  {titleOf(ref.ask)}
                  {ref.port ? ` · ${ref.port}` : ""}
                </span>
                <button type="button" aria-label="Remove this wire" onClick={() => onChange(unwireAsk(flow, ask.id, ref))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <p className="flow-muted">It is asked once those are answered, and its question can use their answers as {"{name}"}.</p>
        </div>
      )}
      {ask.kind === "decision" && <p className="flow-muted">Drag from a choice's dot on the square's right edge to what follows that answer.</p>}

      {ask.kind === "form" && (
        <label className="flow-field">
          <span>What this form is for</span>
          <input value={ask.title} placeholder="Project setup" onChange={(e) => onChange(updateAsk(flow, ask.id, { title: e.target.value }))} />
        </label>
      )}

      {ask.fields.map((field, index) => (
        <div key={field.id} className="flow-group">
          {ask.kind === "form" && <h4>Question {index + 1}</h4>}
          <label className="flow-field">
            <span>{ask.kind === "constant" ? "What it is" : "The question"}</span>
            <input value={field.label} placeholder="Which database should we use?" onChange={(e) => set(field.id, { label: e.target.value })} />
          </label>

          {ask.kind === "constant" && (
            <label className="flow-field">
              <span>Its value</span>
              <input value={field.value ?? ""} placeholder="postgres" onChange={(e) => set(field.id, { value: e.target.value })} />
            </label>
          )}

          {ask.kind !== "constant" && (
            <label className="flow-field">
              <span>The answer is</span>
              <select value={field.type} onChange={(e) => set(field.id, { type: e.target.value as AnswerType })}>
                {(Object.keys(TYPE_LABEL) as AnswerType[]).map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
            </label>
          )}

          {field.type === "choice" && ask.kind !== "constant" && (
            <ChoicesInput key={`${ask.id}.${field.id}`} options={field.options ?? []} onChange={(options) => set(field.id, { options })} />
          )}

          <details className="flow-more">
            <summary>More</summary>
            <label className="flow-field">
              <span>Name steps use to read this answer</span>
              <input value={field.name} onChange={(e) => set(field.id, { name: e.target.value })} />
            </label>
            <p className="flow-muted">
              Write <code>{`{${field.name}}`}</code> in a step's text or prompt to put the answer there.
            </p>
            {ask.kind === "form" && ask.fields.length > 1 && (
              <button type="button" className="flow-button" onClick={() => onChange(removeAskField(flow, ask.id, field.id))}>
                Remove this question
              </button>
            )}
          </details>

          {branchesOf(flow, field.name).map((branch) => (
            <p key={branch.equals} className="flow-muted">
              If <b>{branch.equals}</b>: {branch.nodes.map((n) => n.text || n.id).join(", ")}
            </p>
          ))}
        </div>
      ))}

      {ask.kind === "form" && (
        <button type="button" className="flow-button" onClick={() => onChange(addAskField(flow, ask.id))}>
          <PlusIcon /> Question
        </button>
      )}

      {ask.kind !== "constant" && (
        <label className="flow-check">
          <input type="checkbox" checked={Boolean(ask.optional)} onChange={(e) => onChange(updateAsk(flow, ask.id, { optional: e.target.checked }))} />
          <span>You can skip it</span>
        </label>
      )}

      <details className="flow-more">
        <summary>Change what kind of square this is</summary>
        <label className="flow-field">
          <span>Kind</span>
          <select value={ask.kind} onChange={(e) => onChange(updateAsk(flow, ask.id, { kind: e.target.value as AskKind }))}>
            {(Object.keys(ASK_KIND_INFO) as AskKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {ASK_KIND_INFO[kind].label}
              </option>
            ))}
          </select>
        </label>
      </details>
    </div>
  );
}
