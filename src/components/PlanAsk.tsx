import { useEffect, useRef, useState } from "react";
import { emptyAnswer, isFilled, type DecisionAnswer } from "../flowDecisions";
import type { FlowAsk } from "../flowModel";

/**
 * The answer box of a question the agent put on the canvas while planning. It sits beside the square it answers. Options
 * can be picked (several allowed) and the person's own words can go with any pick; Skip leaves the choice to the agent.
 */
export function PlanAsk({
  ask,
  style,
  onAnswer,
}: {
  ask: FlowAsk;
  style: React.CSSProperties;
  onAnswer: (answer: DecisionAnswer) => void;
}) {
  const field = ask.fields[0];
  const [answer, setAnswer] = useState<DecisionAnswer>(emptyAnswer);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [ask.id]);
  if (!field) return null;
  const toggle = (option: string) =>
    setAnswer((a) => ({ ...a, skipped: false, picked: a.picked.includes(option) ? a.picked.filter((o) => o !== option) : [...a.picked, option] }));
  return (
    <div className="flow-talk flow-asker flow-plan-ask" style={style} role="group" aria-label="A question from the agent" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flow-asker-head">
        <span>The agent asks</span>
      </div>
      <div className="flow-asker-q">{field.label || ask.title}</div>
      <div className="flow-asker-options">
        {(field.options ?? []).map((o) => (
          <button key={o} type="button" className={`flow-asker-option ${answer.picked.includes(o) ? "on" : ""}`} aria-pressed={answer.picked.includes(o)} onClick={() => toggle(o)}>
            {o}
          </button>
        ))}
      </div>
      <input
        ref={input}
        className="flow-asker-text"
        value={answer.text}
        placeholder="Or your own words"
        onChange={(e) => setAnswer({ ...answer, skipped: false, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isFilled(answer)) {
            e.preventDefault();
            onAnswer(answer);
          }
        }}
      />
      <div className="flow-asker-actions">
        <button type="button" className="ghost" title="The agent picks a sensible default and says so" onClick={() => onAnswer({ picked: [], text: "", skipped: true })}>
          Skip
        </button>
        <button type="button" className="flow-button primary" disabled={!isFilled(answer)} onClick={() => onAnswer(answer)}>
          Answer
        </button>
      </div>
    </div>
  );
}
