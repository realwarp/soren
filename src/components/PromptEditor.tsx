import { useMemo, useRef, useState } from "react";
import { fillVariables } from "../flowAsk";
import { updateNode, type Flow, type FlowNode, type PromptAuthor, type PromptSegment } from "../flowModel";
import {
  acceptTemplateChange,
  addSegment,
  editSegment,
  hasOwnWords,
  promptSegments,
  rejectTemplateChange,
  resetPrompt,
  type PromptPatch,
  type TemplateConflict,
} from "../flowPromptDoc";
import type { Rewrite } from "../flowCloud";
import { WordDiff } from "./WordDiff";

const AUTHOR_LABEL: Record<PromptAuthor, string> = {
  template: "Written by code from the step's fields",
  ai: "Rewritten by the model, and accepted by you",
  you: "Written by you",
};

const FIELD_LABEL: Record<string, string> = {
  intro: "opening line",
  context: "background",
  step: "step text",
  needs: "inputs",
  answers: "answers",
  makes: "outputs",
  checks: "checks",
  close: "closing line",
};

/** One segment: read as text with a quiet rule at its left that says who wrote it; click to change it. */
function Segment({ flow, segment, onEdit }: { flow: Flow; segment: PromptSegment; onEdit: (id: string, text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  if (editing) {
    return (
      <div className={`prompt-seg ${segment.author}`}>
        <textarea
          ref={(el) => {
            area.current = el;
            if (el) requestAnimationFrame(() => (el.focus(), fit()));
          }}
          className="prompt-seg-edit"
          defaultValue={segment.text}
          rows={2}
          spellCheck={false}
          onInput={fit}
          onBlur={(e) => {
            setEditing(false);
            onEdit(segment.id, e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.value = segment.text;
              e.currentTarget.blur();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={`prompt-seg ${segment.author}`}
      title={`${AUTHOR_LABEL[segment.author]}. Click to change it.`}
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") setEditing(true);
      }}
    >
      {fillVariables(flow, segment.text)}
    </div>
  );
}

/**
 * A step's prompt, in the step panel. It is the template's words until you or an accepted rewrite change them; a quiet rule
 * at the left of each part says who wrote it. Polish asks the cloud model for a rewrite, which comes back as a diff that
 * only an Accept makes real. Copying a prompt elsewhere gives its plain text.
 */
export function PromptEditor({
  flow,
  node,
  onChange,
  rewrite,
  busy,
  onPolish,
  onAcceptRewrite,
  onRejectRewrite,
}: {
  flow: Flow;
  node: FlowNode;
  onChange: (next: Flow) => void;
  /** The rewrite the model offered for this step, waiting on an answer. */
  rewrite?: Rewrite;
  /** A cloud request is running. */
  busy: boolean;
  onPolish: () => void;
  onAcceptRewrite: () => void;
  onRejectRewrite: () => void;
}) {
  const { segments, conflicts } = useMemo(() => promptSegments(flow, node), [flow, node]);
  const [adding, setAdding] = useState(false);
  const apply = (patch: PromptPatch | null) => {
    if (patch) onChange(updateNode(flow, node.id, patch));
  };
  const used = new Set(segments.map((s) => s.author));
  const decide = (conflict: TemplateConflict, take: boolean) =>
    apply(take ? acceptTemplateChange(flow, node, conflict) : rejectTemplateChange(flow, node, conflict));

  return (
    <div className="prompt-editor">
      <div className="prompt-segs">
        {segments.map((segment) => (
          <Segment key={segment.id} flow={flow} segment={segment} onEdit={(id, text) => apply(editSegment(flow, node, id, text))} />
        ))}
        {segments.length === 0 && <p className="flow-muted">Nothing here yet.</p>}
      </div>
      <p className="prompt-legend">
        <span className="prompt-key template" /> code{used.has("template") ? "" : " (none left)"}
        <span className="prompt-key ai" /> model, accepted{used.has("ai") ? "" : " (none)"}
        <span className="prompt-key you" /> you{used.has("you") ? "" : " (none)"}
      </p>

      {conflicts.map((conflict) => (
        <div className="prompt-offer" key={conflict.key}>
          <p>
            The {FIELD_LABEL[conflict.key] ?? "step"} changed, but its words in the prompt are not the template's.{" "}
            {conflict.segmentId ? "Take the template's new words?" : "Add the new words back?"}
          </p>
          <WordDiff before={conflict.current} after={conflict.proposed} beforeLabel="In the prompt" afterLabel="Template now" />
          <div className="flow-run-actions">
            <button type="button" className="flow-button primary" onClick={() => decide(conflict, true)}>
              Accept
            </button>
            <button type="button" className="flow-button" onClick={() => decide(conflict, false)}>
              Keep mine
            </button>
          </div>
        </div>
      ))}

      {rewrite && (
        <div className="prompt-offer">
          <p>The model offers this rewrite. Nothing changes until you accept.</p>
          {rewrite.readable && (
            <>
              <div className="mini-label">Plan text</div>
              <WordDiff before={rewrite.readable.base} after={rewrite.readable.text} beforeLabel="Now" afterLabel="Polished" />
            </>
          )}
          {rewrite.prompt && (
            <>
              <div className="mini-label">Prompt</div>
              <WordDiff before={rewrite.prompt.base} after={rewrite.prompt.text} beforeLabel="Now" afterLabel="Polished" />
            </>
          )}
          <div className="flow-run-actions">
            <button type="button" className="flow-button primary" onClick={onAcceptRewrite}>
              Accept
            </button>
            <button type="button" className="flow-button" onClick={onRejectRewrite}>
              Reject
            </button>
          </div>
        </div>
      )}

      {adding && (
        <textarea
          className="prompt-add"
          rows={2}
          autoFocus
          placeholder="Your own lines, added to the end. Cmd+Enter to keep."
          onBlur={(e) => {
            setAdding(false);
            apply(addSegment(flow, node, e.currentTarget.value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.value = "";
              e.currentTarget.blur();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
          }}
        />
      )}
      <div className="flow-run-actions">
        <button type="button" className="flow-button" disabled={busy || !!rewrite} onClick={onPolish} title="Sends this prompt to the cloud model: one request. You see its rewrite as a diff before anything changes.">
          {busy ? "Polishing…" : "Polish with AI"}
        </button>
        <button type="button" className="flow-button" onClick={() => setAdding(true)}>
          Add text
        </button>
        {hasOwnWords(node) && (
          <button type="button" className="flow-button" title="Drop every change and use the template's words" onClick={() => apply(resetPrompt())}>
            Back to the template
          </button>
        )}
      </div>
      {(node.sub?.length || node.critic || node.failed) && (
        <p className="flow-muted">Sub-steps, reviewer rounds and retry notes are added when the prompt is copied.</p>
      )}
    </div>
  );
}
