import { useEffect, useState } from "react";

/** How long a secret's deletion is held back, so it cannot be a reflex. */
export const SECRET_BARRIER_MS = 5000;

/**
 * Confirmation for deleting a secret. The confirm button stays locked while a translucent
 * bar drains across it, easing in and out, and unlocks when the bar is gone.
 */
export function ConfirmDelete({
  title,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), SECRET_BARRIER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onCancel]);

  return (
    <div className="s-confirm-scrim" onMouseDown={onCancel}>
      <div
        className="s-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3>{title}</h3>
        <p>{detail}</p>
        <div className="s-confirm-actions">
          <button type="button" className="btn quiet" onClick={onCancel}>
            Keep it
          </button>
          <button
            type="button"
            className="btn s-confirm-delete"
            disabled={!ready}
            onClick={onConfirm}
          >
            <span>{confirmLabel}</span>
            {!ready && (
              <i
                className="s-confirm-bar"
                style={{ animationDuration: `${SECRET_BARRIER_MS}ms` }}
              />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
