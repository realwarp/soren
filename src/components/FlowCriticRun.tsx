import { useEffect, useState } from "react";
import { copyText } from "../clipboard";
import { approveAnyway, criticModel, criticPhase, readVerdict, submitMade, submitVerdict } from "../flowCritic";
import type { Flow, FlowNode } from "../flowModel";
import { criticPrompt, nodePrompt } from "../flowPrompt";
import { CheckIcon, CopyIcon } from "./Icons";

/**
 * Running a step that has a critic. The step goes round: the maker's prompt, what it made, the critic's prompt,
 * the critic's verdict, and back to the maker with the reasons, until the critic approves or the rounds run out.
 * Soren calls nothing; each prompt is copied out and each reply pasted back, as in any other step.
 */
export function CriticRun({
  flow,
  node,
  onFlow,
  onReopen,
}: {
  flow: Flow;
  node: FlowNode;
  onFlow: (next: Flow) => void;
  onReopen: () => void;
}) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const critic = node.critic!;
  const phase = criticPhase(node);
  const rounds = critic.rounds;
  // A new round starts with an empty box.
  useEffect(() => setText(""), [node.id, rounds.length]);

  const prompt = phase === "review" ? criticPrompt(flow, node) : nodePrompt(flow, node);
  const reading = phase === "review" ? readVerdict(text) : null;
  const reviewer = criticModel(flow, node);
  const round = phase === "make" ? rounds.length + 1 : rounds.length;

  async function copy() {
    await copyText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="flow-critic-run">
      <p className="flow-muted">
        Round {round} of {critic.maxRounds} ·{" "}
        {phase === "make"
          ? "the step's tool makes it"
          : phase === "review"
            ? `the critic reviews it${reviewer ? ` (${reviewer.name})` : ""}`
            : "out of rounds"}
      </p>

      {rounds.some((r) => r.verdict) && (
        <ul className="flow-critic-history">
          {rounds.map((r, i) =>
            r.verdict ? (
              <li key={r.at + i} className={r.verdict}>
                <b>Round {i + 1}: {r.verdict === "approve" ? "approved" : "sent back"}.</b> {r.reasons}
              </li>
            ) : null,
          )}
        </ul>
      )}

      {phase === "limit" ? (
        <>
          <p className="flow-warn-box">
            The critic still wanted changes after {critic.maxRounds} round{critic.maxRounds === 1 ? "" : "s"}. Take the last attempt as it
            is, or start over.
          </p>
          <div className="flow-run-actions">
            <button type="button" className="flow-button primary" onClick={() => onFlow(approveAnyway(flow, node.id))}>
              <CheckIcon /> Take the last attempt
            </button>
            <button type="button" className="flow-button" onClick={onReopen}>
              Start over
            </button>
          </div>
        </>
      ) : (
        <>
          <pre className="flow-prompt">{prompt}</pre>
          <button type="button" className="flow-button primary" onClick={() => void copy()}>
            <CopyIcon /> {copied ? "Copied" : phase === "review" ? "Copy the critic's prompt" : "Copy prompt"}
          </button>
          <label className="flow-field">
            <span>{phase === "review" ? "What the critic said" : "What the step made (pasted back)"}</span>
            <textarea
              rows={4}
              value={text}
              placeholder={phase === "review" ? "Paste its reply. APPROVE or REVISE on the first line is read for you." : "Paste the tool's result."}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {phase === "make" ? (
            <button
              type="button"
              className="flow-button primary"
              disabled={!text.trim()}
              onClick={() => onFlow(submitMade(flow, node.id, text))}
            >
              Send it to the critic
            </button>
          ) : (
            <>
              {reading && <p className="flow-muted">This reads as {reading.verdict === "approve" ? "an approval" : "a request for changes"}.</p>}
              <div className="flow-run-actions">
                <button
                  type="button"
                  className={`flow-button ${reading?.verdict === "approve" ? "primary" : ""}`}
                  onClick={() => onFlow(submitVerdict(flow, node.id, "approve", reading?.reasons ?? text))}
                >
                  <CheckIcon /> Approve
                </button>
                <button
                  type="button"
                  className={`flow-button ${reading?.verdict === "revise" ? "primary" : ""}`}
                  disabled={!text.trim()}
                  onClick={() => onFlow(submitVerdict(flow, node.id, "revise", reading?.reasons ?? text))}
                >
                  Send back for changes
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
