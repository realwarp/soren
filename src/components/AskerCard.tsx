import { useEffect, useRef } from "react";
import { isFilled, type DecisionAnswer, type DecisionQuestion } from "../flowDecisions";

/**
 * One major decision at a time, in a card at the spot the person asked from. Options can be picked (several allowed) and
 * the person's own words can go with any pick. Skip leaves the choice to the agent.
 */
export function AskerCard({
  questions,
  answers,
  index,
  busy,
  error,
  retryNote,
  style,
  onAnswer,
  onGo,
  onSkip,
  onDone,
  onCancel,
}: {
  questions: DecisionQuestion[];
  answers: DecisionAnswer[];
  index: number;
  busy: boolean;
  error: string | null;
  retryNote: string | null;
  style: React.CSSProperties;
  onAnswer: (index: number, answer: DecisionAnswer) => void;
  onGo: (index: number) => void;
  onSkip: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const q = questions[index];
  const a = answers[index];
  const last = index === questions.length - 1;
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!busy) field.current?.focus({ preventScroll: true });
  }, [index, busy]);
  if (!q || !a) return null;
  const toggle = (option: string) =>
    onAnswer(index, { ...a, skipped: false, picked: a.picked.includes(option) ? a.picked.filter((o) => o !== option) : [...a.picked, option] });
  return (
    <div className="flow-talk flow-asker" style={style} role="group" aria-label="A decision before the change">
      {busy ? (
        <div className="flow-talk-working" role="status">
          {retryNote ?? "Drawing the change with your answers…"}
        </div>
      ) : (
        <>
          <div className="flow-asker-head">
            <span>
              {index + 1} of {questions.length}
            </span>
            <button type="button" className="flow-asker-close" aria-label="Cancel" title="Cancel" onClick={onCancel}>
              ×
            </button>
          </div>
          <div className="flow-asker-q">{q.question}</div>
          <div className="flow-asker-options">
            {q.options.map((o) => (
              <button key={o} type="button" className={`flow-asker-option ${a.picked.includes(o) ? "on" : ""}`} aria-pressed={a.picked.includes(o)} onClick={() => toggle(o)}>
                {o}
              </button>
            ))}
          </div>
          <input
            ref={field}
            className="flow-asker-text"
            value={a.text}
            placeholder="Or your own words"
            onChange={(e) => onAnswer(index, { ...a, skipped: false, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              else if (e.key === "Enter" && isFilled(a)) {
                e.preventDefault();
                if (last) onDone();
                else onGo(index + 1);
              }
            }}
          />
          {error && <div className="flow-talk-error">{error}</div>}
          <div className="flow-asker-actions">
            <button type="button" className="ghost" disabled={index === 0} onClick={() => onGo(index - 1)}>
              Back
            </button>
            <button type="button" className="ghost" title="The agent picks a sensible default and says so" onClick={onSkip}>
              Skip
            </button>
            <button type="button" className="flow-button primary" disabled={!isFilled(a)} onClick={last ? onDone : () => onGo(index + 1)}>
              {last ? "Done" : "Next"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
