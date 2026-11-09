import { wordDiff } from "../diff";

interface Props {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}

/** Two-sided prose diff. Removed and added words are marked inline. */
export function WordDiff({
  before,
  after,
  beforeLabel = "Before",
  afterLabel = "After",
}: Props) {
  const diff = wordDiff(before, after);
  return (
    <div className="word-diff">
      <div className="word-diff-side">
        <div className="mini-label">{beforeLabel}</div>
        <p>
          {diff.before.map((part, index) => (
            <span key={index} className={`diff-${part.kind}`}>
              {part.text}
            </span>
          ))}
        </p>
      </div>
      <div className="word-diff-side">
        <div className="mini-label">{afterLabel}</div>
        <p>
          {diff.after.map((part, index) => (
            <span key={index} className={`diff-${part.kind}`}>
              {part.text}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
