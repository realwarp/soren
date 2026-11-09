# Soren reference (before 1.0)

> Archived from the README as it stood before 1.0. Parts of it are out of date: for example, Soren now has a Run tab. It stays here until there is a wiki.


Soren is a thinking partner for ideas that aren't finished yet. It holds a
conversation and a living brief side by side: you say what you're working
through, Soren proposes at most one change to the brief at a time, and nothing
becomes part of the brief until you accept it.

The brief is the point. Each item has a type (goal, constraint, decision,
option, assumption, question) and a status (established, provisional, open,
rejected, retracted, resolved). Every item keeps its provenance: which message
or proposal it came from, and why. You can edit any item directly, mark it
reviewed when a dependency changes, or rule it out with a reason.

Replies can also contain typed, display-only artifacts: a word-level diff, a
comparison matrix, a sequence, or a workflow. Soren places them between
sentences, and the app validates them locally; a malformed artifact is dropped
without removing the reply around it. Short follow-up prompts under a reply
prefill the composer; they never send themselves.

Sessions are versioned. Every accepted change is an ordered commit, and you can
branch from any message in a new session without modifying the original. A
branch inherits the conversation and brief at that point, then evolves on its
own. The complete conversation is kept; long sessions give the model the latest
18 messages plus excerpts from earlier turns, each keyed to its stored message
id.

Turns belong to their session. You can switch to an earlier session while Soren
is still replying: the session list marks which conversations are running, and
a small in-app notice opens a background session when its reply lands.

Replies stream as they are written. **Stop** (or `Esc`) keeps the partial text
and marks the last word red. The final reply can be regenerated. Brief changes
can be undone item by item from a stale-change banner or the Changes tab;
undo restores the items and leaves the proposal record as it was.

Workflows live in a global library, across sessions. Soren only shapes one when
you start the turn from the composer's **Workflow** action. A graph can be
edited and approved, and approval only permits plans to be drafted — nothing in
this app executes a workflow. Plans are stored per task and can be edited or
copied. Changing a task keeps its old plan visible with a warning until the
plan is regenerated.

This repository is an early prototype. It is a desktop app built with Tauri 2,
React, and SQLite.

## Requirements

- Node.js 20 or newer
- Rust (stable) with Cargo
- The platform dependencies Tauri needs:
  - macOS: Xcode Command Line Tools
  - Linux: `webkit2gtk`, `libgtk-3`, and the other packages listed in the
    [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  - Windows: WebView2 and the C++ build tools

## Run it

```sh
npm install
npm run tauri dev
```

`npm install` was verified with `npx --yes npm@latest install` because npm
10.8.2 fails on this lockfile with `Cannot read properties of null (reading
'edgesOut')`. If your npm is older, use the `npx` form.

On first launch the app is in **Demo mode**: a scripted reliability session
that needs no API key and exercises proposals, edits, rejections, and the
brief. It exists to evaluate the interaction, not to think through your own
idea.

To use a real model, open **Settings** (the mode pill in the top bar, or
`⌘,`) and choose a source:

- **Local (llama.cpp)** — a model server running on this machine, usually
  `llama-server` on `http://127.0.0.1:8080/v1`. No API key is needed or stored.
  Thinking is turned off automatically, and a question the model asks in prose is
  converted into one you can click. Start the server yourself; Soren does not
  bundle a runtime. Weights for the local card writer and classifier can be
  downloaded from **Settings → Local helpers → Downloads**; nothing is fetched
  until you press the button. The writer is LFM3 1.7B from Liquid AI, used under
  the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/blob/main/LICENSE),
  which limits commercial use for organisations with $10 million or more in annual revenue.
- **OpenAI-compatible** — any endpoint that accepts OpenAI-style chat
  completions; enter its base URL, model, and key.
- **Gemini** — a Google AI Studio key, using Gemini's OpenAI-compatible
  endpoint.
- **NVIDIA** — an NVIDIA NIM key, using `integrate.api.nvidia.com`.
- **OpenCode** — an OpenCode Console service-account key (`oc_sk_…`), using
  the OpenAI Chat Completions endpoint at `opencode.ai/inference/openai/v1`.

Each provider keeps its own key and model when you switch. The default models
are `gpt-4.1-mini`, `gemini-3.8-flash`,
`nvidia/nemotron-3-super-120b-a12b`, and `kimi-k2.6` respectively; edit the
model field to use another one. Every non-demo provider expects a key. Turns
stream when the provider supports it; a tool call or an endpoint that refuses
streaming falls back to the normal request loop. Stopping a turn cancels it
without discarding the text already received.

Saved keys are write-only from the interface's point of view. The app receives
only whether a key is set; it never receives the stored value back. Entering a
new key replaces the saved one, and the settings panel can remove it.

## Build

```sh
npm test                      # frontend unit tests
npm run build                 # typecheck and build the frontend
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build           # packaged app
```

For a quick build without bundling installers:

```sh
npm run tauri build -- --debug --no-bundle
```

## Where things are stored

The app uses the identifier `com.soren.desktop`.

- Sessions: `soren.sqlite3` in the app data directory
  (macOS: `~/Library/Application Support/com.soren.desktop/`)
- Settings: `config.json` in the app config directory
  (macOS: `~/Library/Application Support/com.soren.desktop/config.json`)

The provider keys and models live in `config.json`, which is written atomically
with `0600` permissions on Unix. The frontend never receives the saved key
values. Keychain storage is a later step. There is no telemetry and no server
component.

## How a session works

1. You send a message. Soren replies, and may include one proposal, typed
   artifacts, follow-up prompts, or an interactive card (a pick-one, a slider, a
   text box) whose answer goes back as your next message.
2. A proposal says what it would add, change, or retract, why it thinks so, the
   consequences if accepted, and the part of the conversation it is based on.
3. You accept it, edit it before accepting, reject it with an optional reason,
   or defer it. A rejected proposal keeps its reason in Changes.
4. Accepted items land in the brief. If an accepted change touches other items,
   those items are flagged for review rather than rewritten. The flag propagates
   through dependencies, and reviewing one item does not clear the others.
5. The **Changes** tab lists the evolution of the idea, newest first, with the
   cause, before/after wording, affected items, and what remains uncertain.
   Changes that touched items can be undone there.
6. Questions can be answered with a click or number key, skipped for later, and
   answered again; changing an answer starts a new turn and keeps the earlier
   answers in the question's history.
7. Any message has a **Branch** action. The new session inherits the state at
   that message and stays isolated from the original. Its lineage is shown in
   the session list and in a parent link above the conversation.
8. The last reply has a **Regenerate** action, and a running turn has a **Stop**
   action. Stopping preserves the partial reply.
9. Opening **Workflows** shows the global graph library. Selecting a workflow
   lets you edit its tasks and dependencies, approve it, generate or regenerate
   plans for selected tasks, edit plans, and copy the graph or plans.
10. When there are at least two live options, the brief can show them side by
    side with the consequences recorded when each was proposed.

Rejecting a proposal that would add an option is treated as a decision about
that option: it goes to the brief's **Ruled out** section with your reason, so
it does not quietly return later.

## Project layout

```
src/                     frontend
  App.tsx                session state, ordered commits, turn lifecycle, layout
  state.ts               pure brief logic: proposals, status, staleness, undo, export
  artifacts.ts           artifact/block validation and fallback placement
  workflows.ts           workflow graph, plan freshness, and document helpers
  diff.ts                shared word-level diff
  api.ts                 Tauri commands and turn-scoped streaming events
  providers.ts           provider labels, endpoints, and settings hints
  components/
    Conversation.tsx     transcript, artifacts, follow-ups, stale banners
    ProposalCard.tsx     proposal presentation and resolution
    Artifacts.tsx        diff, matrix, timeline, and workflow previews
    Workflows.tsx        global workflow library, editor, approval, and plans
    WordDiff.tsx         two-sided word diff
    Brief.tsx            brief, item details, provenance, Changes, comparison
    Settings.tsx         provider and model configuration
    Sessions.tsx         session list and lineage
src-tauri/
  src/lib.rs             Tauri commands, run_turn entry
  src/demo.rs            scripted reliability session and demo plans
  src/provider.rs        OpenAI-compatible request, tool calls, and JSON parsing
  src/streaming.rs       streaming events, turn registry, and cancellation
  src/tools.rs           tools the model can call mid-turn (add_item, edit_item, retract_item, delegation)
  src/plans.rs           approved-workflow plan generation and fingerprints
  src/prompt.rs          system prompt, brief, and traceable long-session context
  src/store.rs           SQLite revisions, branches, commits, workflows, and config
  src/types.rs           shared data model
  src/validation.rs      validation for model-authored changes, artifacts, and workflows
PRODUCT.md               product thesis and behavior principles
EXPERIENCE.md            a full target session, written before the build
MVP.md                   essential, supporting, and deferred scope
```

## Limits in this version

- Inline artifacts cover diffs, matrices, timelines, and workflows. Charts are
  not implemented and are not advertised to the model.
- Workflows and plans are local documents. Nothing executes them; there is no
  runner, scheduler, or external integration.
- Undo is item-scoped and only covers recorded brief mutations. It does not
  reopen a resolved proposal or reverse a conversation turn.
- Five provider presets, all using OpenAI-compatible chat completions. The local
  one assumes a server you started; arbitrary providers can be configured through
  the OpenAI-compatible option.
- The OpenCode preset covers models served by its OpenAI Chat Completions
  endpoint, not its Anthropic, Gemini, or Responses routes.
- Provider keys are stored in plain text in the config file; Keychain storage
  is a later step.
- Demo mode is scripted and advances by user-message count.
- Sessions created before versioned history migrate with one snapshot. Branching
  works from their latest message; earlier messages have no saved state to fork.
- Deleting a session hides it and keeps its history, but there is no restore UI.
- The brief is local to the machine; there is no sync or sharing.
