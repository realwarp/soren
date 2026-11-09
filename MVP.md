# Soren — Minimum Viable Product

The smallest coherent experience that demonstrates the core loop. Not a feature list.

## The one experience

A user arrives with a vague idea, talks for a while, corrects Soren a few times, and leaves with a short brief they can defend. The brief contains a goal, at least one constraint, a rejected option with a reason, and a genuinely open question. Every line can be traced to something the user said or to an inference they accepted.

Everything below exists to make that experience work, or to keep it from breaking.

## Essential

1. **Conversation.** Normal chat: send a message, get a short reply. No perfect prompt required. No streaming in v1; a thinking indicator is enough.
2. **The brief.** Typed items — goal, constraint, decision, option, assumption, question — with a status and a provenance. Grouped by type. Rejected and retracted items are kept in a "Ruled out" section with reasons.
3. **Proposals.** Soren can propose one change at a time: add, edit, or retract. Each proposal shows the draft, the reason, and the consequences. The user accepts, edits, rejects, or defers.
4. **Local repair.** Accepting a change flags items that depend on it as needing review. It does not rewrite them. The user can mark them reviewed.
5. **Provenance.** Every item can answer "where did this come from?" — the user's message, an accepted inference, or a direct edit. The reason for a rejection is kept.
6. **Persistence.** Sessions are stored locally in SQLite as ordered, versioned revisions. Writes are transactional, commit ids are idempotent, and a failed save blocks further local changes until it is retried or reloaded. The user can return to a brief and start a new session without losing the old one.
7. **First-party model presets.** OpenAI-compatible, Gemini, NVIDIA, and OpenCode, each with its own saved key and model. Saved keys are write-only from the frontend: the settings screen learns only whether a key exists. A scripted demo mode works without a key.
8. **Copy the brief.** Export the current brief as Markdown, in the user's voice, with statuses and reasons.
9. **Branching.** Any message can fork a new session with the conversation and brief state at that message. The original is untouched; the branch records its parent and stays isolated.

## Supporting

- A "Changes" view: the chronological evolution of the brief, with cause, before/after, affected items, and remaining uncertainty.
- Direct editing of any brief item, including its status.
- A "why" detail on every item: provenance, rationale, and dependents.
- Assumption actions for challenging, deferring, or ruling out a reading without rewriting it.
- A comparison of live options using the consequences recorded when each was proposed.
- Long sessions keep their full transcript; the model gets the latest 18 messages plus excerpts from earlier turns, each keyed to its stored message id.
- Automatic session titles from the first message.
- Keyboard: Enter to send, Shift+Enter for a newline; Escape to close a panel.

## Deliberately later

- Streaming responses.
- Keychain storage for provider keys.
- Restoring soft-deleted sessions.
- A raw revision browser (Changes exposes logical changes, not every commit).
- Side-by-side comparison of two entire briefs.
- Web research or document ingestion.
- Rich artifacts: diagrams, tables, timelines.
- Collaboration or sharing.
- Templates and domain packs.
- Automatic consequence propagation (as opposed to flagging).

## Non-goals

- Agents, tool execution, workflows, or an execution environment.
- A coding IDE.
- A model router, a provider marketplace, or automatic per-turn model selection.
- A plugin architecture.
- A generic chatbot with comparison cards.

## Build order

1. State model and persistence (sessions, items, proposals, changes, provenance).
2. Conversation shell and the brief panel.
3. Proposal generation and resolution.
4. Provider integration, with demo mode as the fallback.
5. Local repair flags and the Changes view.
6. Versioned commits, branching, and save recovery.
7. Model-change validation, long-session context, option comparison, and
   write-only provider keys.
8. Polish: typography, empty states, error recovery, copy/export.

## What to evaluate

Run the reliability session with five people who have a real unfinished idea. Ask:

- Can they point to a distinction they did not arrive with?
- Can they explain why an option was rejected?
- Is the brief in their voice, or Soren's?
- Did any proposal feel like paperwork or a strawman?
- Did they correct the brief directly, or only talk?
- When they branched, did both versions stay legible as alternatives?
- Would they return to the brief tomorrow?

The failure that matters most: a polished brief that the user does not recognize as theirs.
