import { useEffect, useState } from "react";
import { OUTCOME_LABEL, useHistory, type HistoryTurn } from "../flowHistory";
import { CloseIcon } from "./Icons";

/** How long ago, in a few plain words. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function Turn({ turn, open, onToggle }: { turn: HistoryTurn; open: boolean; onToggle: () => void }) {
  return (
    <li className={`flow-history-turn ${open ? "open" : ""}`}>
      <button type="button" className="flow-history-line" onClick={onToggle} aria-expanded={open}>
        <span className="flow-history-when">{ago(turn.at)}</span>
        <span className="flow-history-ask">{turn.ask}</span>
        <span className={`flow-history-outcome ${turn.outcome}`}>{OUTCOME_LABEL[turn.outcome]}</span>
      </button>
      {open && (
        <div className="flow-history-detail">
          <p>
            <span className="flow-history-label">You asked</span> {turn.ask}
          </p>
          {turn.decisions.length > 0 && (
            <ul className="flow-history-decisions">
              {turn.decisions.map((d, i) => (
                <li key={i}>
                  <span className="flow-history-label">{d.question}</span> {d.answer}
                </li>
              ))}
            </ul>
          )}
          <p>
            <span className="flow-history-label">Agent</span> {turn.reply || "No note."}
          </p>
          {turn.outcome !== "answered" && (
            <>
              {turn.summary && (
                <p>
                  <span className="flow-history-label">{turn.outcome === "applied" ? "Kept" : "Turned down"}</span> {turn.summary}
                </p>
              )}
              {turn.changes.length > 0 && (
                <ul className="flow-history-changes">
                  {turn.changes.slice(0, 12).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                  {turn.changes.length > 12 && <li>...and {turn.changes.length - 12} more</li>}
                </ul>
              )}
            </>
          )}
          <p className="flow-history-time">{new Date(turn.at).toLocaleString()}</p>
        </div>
      )}
    </li>
  );
}

/**
 * What you have asked the agent in this workflow, newest first, one line each. A line opens in place to show the
 * questions you were asked and your answers, the agent's note, and what became of its change.
 */
export function FlowHistory({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const turns = useHistory(flowId);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="flow-history" role="dialog" aria-label="History">
      <div className="flow-history-head">
        <strong>History</strong>
        <span className="flow-muted">{turns.length === 0 ? "" : `${turns.length} ask${turns.length === 1 ? "" : "s"}`}</span>
        <button type="button" className="ghost flow-history-close" onClick={onClose} aria-label="Close history">
          <CloseIcon size={14} />
        </button>
      </div>
      {turns.length === 0 ? (
        <p className="flow-muted flow-history-empty">Nothing yet. Double-click the canvas and ask the agent something; it is listed here.</p>
      ) : (
        <ul className="flow-history-list">
          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} open={openId === turn.id} onToggle={() => setOpenId(openId === turn.id ? null : turn.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}
