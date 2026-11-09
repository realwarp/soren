import type { CSSProperties } from "react";
import { themeVars } from "../theme";
import type { ThemeFamily } from "../theme";

/**
 * A drawn miniature of the app in a candidate theme. It is a picture, not the app: the
 * variables are set on this one element, so nothing outside it repaints.
 */
export function ThemePreview({ family, accent }: { family: ThemeFamily; accent: string }) {
  return (
    <div className="s-preview" style={themeVars(family, accent) as CSSProperties} aria-hidden="true">
      <div className="s-preview-bar">
        <span>Workflows</span>
        <span>Sessions</span>
        <span className="s-preview-pill">
          <i /> Gemini
        </span>
      </div>
      <div className="s-preview-body">
        <div className="s-preview-line user" />
        <div className="s-preview-line" style={{ width: "86%" }} />
        <div className="s-preview-line" style={{ width: "64%" }} />
        <div className="s-preview-card">
          <i />
          <b />
        </div>
      </div>
      <div className="s-preview-composer">
        <span>Say what you're thinking…</span>
        <em />
      </div>
    </div>
  );
}

/** A square split between the theme's page and its accent, for the picker. */
export function FamilyGlyph({ family }: { family: ThemeFamily }) {
  const vars = themeVars(family, "default");
  return (
    <span
      className="s-family-glyph"
      style={{ background: `linear-gradient(135deg, ${vars["--paper"]} 50%, ${vars["--teal"]} 50%)` }}
    />
  );
}
