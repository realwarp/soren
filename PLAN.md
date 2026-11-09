# PLAN — Turn latency, and the local fast path

Status: Phases 0, 1, 2 and telemetry are implemented and tested. Phases 3 and 4
(the router and local generation) are still proposed, and still gated on
measurement.

| Phase | What it buys | State |
| --- | --- | --- |
| 0 — Never lose the turn | A proposal can no longer delete a reply | Done |
| 1 — One request per step | Question turns stop being three requests | Done |
| 2 — Payload hygiene | The transcript is sent once; the instructions are 35% smaller | Done |
| Telemetry | Real numbers for the next question | Done |
| 3 — Router (Laya) | Skips work a turn does not need | Not started |
| 4 — Local generation (Bonsai) | Removes remote tokens and round trips | Conversational turns now run end to end on Bonsai 2 9B; measured in §13 |

Two goals, in this order:

1. **Stop losing turns.** A turn must never fail because of a proposal, and must
   never delete the words the person already saw.
2. **Stop paying for round trips we do not need.** Every request should buy
   something. A local model should remove work from the remote model, not add a
   third stack.

The local model is Phase 3+. It was never the fix for the 20x. The fix for the
20x was Phase 1.

---

## 0. What actually changed

`ed987e8` (21 Oct) replaced a single-request turn with a streaming request plus a
tool loop.

Before:

```rust
let raw = provider::complete(&config, &system, &messages).await?;   // one call, every turn
```

After, per turn:

| Turn | Requests |
| --- | --- |
| Plain reply | 1 streaming request |
| Needs a question asked | 1 stream (**discarded**) + 1 re-decide + 1 finish = **3** |
| Model asks twice | 4 |
| Background question | up to `MAX_STEPS` = 6 |

Three independent multipliers stacked on top of the call count:

- `prompt.rs:255` put the last 18 messages in the system prompt; `prompt.rs:326`
  sent the same 18 again as chat turns. Duplicate payload on every request.
- `provider.rs:64` and `streaming.rs:135` built a **new `reqwest::Client` per
  request**, so no connection reuse. Measured TLS setup to `opencode.ai`: ~0.6 s.
- No `max_tokens` anywhere, so output length was unbounded.

The observed "20x" was therefore roughly 3x calls x ~2x payload x no reuse. A
local model could not remove any of those multipliers.

Everything below is written against that code, not a rewrite.

---

## 1. Targets

Measured on the user's machine, p50, warm connection, before the fix:

| Turn | Before | Target | After |
| --- | --- | --- | --- |
| `sup` (no tool, no proposal) | ~10 s | < 2 s | 1 request, smaller payload — measure |
| One question asked, no proposal | 60–120 s | < 12 s | 2 requests — measure |
| One question + one proposal | 60–120 s | < 15 s | 2 requests — measure |
| Failed proposal | ~100 s, then nothing | same turn, reply kept, < 1 s extra | reply kept, one repair attempt |

The "after" column is deliberately empty until a traced turn fills it in. That is
what §8 is for: the numbers above were estimates, and estimates are how the
original regression went unnoticed.

If a question turn is still not under ~15 s once traced, stop and read the trace
before building anything local. The remaining latency would then be the model
itself, which is the only thing Phase 4 can remove.

---

## 2. Phase 0 — Never lose the turn

Smallest change with the largest visible effect. No new dependencies.

### 2.1 Proposal failures degrade, they do not fail — done

`validation.rs` called `validate_proposal(state, proposal)?`, so one bad field
discarded the reply. Artifacts already did the right thing.

- `ValidatedTurn` carries the drop in `artifact_notice`, the slot the interface
  already renders under the reply (`Conversation.tsx`, `artifact-notice`).
- `validate_proposal` stays strict; only its caller changed.
- The reply is returned, the proposal is `None`, and the person is told why.

### 2.2 Preserve streamed text on error — done

`App.tsx`'s catch block kept calling `dropStreamedMessage`, which is why a
failure left an empty screen. It now keeps the bubble, marks it `interrupted`,
and commits it. Only a turn with no text at all falls back to "Soren's reply
could not be read".

### 2.3 `tool_calls: []` is not a tool request — done

Many OpenAI-compatible providers put an empty `tool_calls` array on every delta.
Treating that as a request aborted the stream on frame one and cost every single
turn a second request. `absorb_call` now ignores empty arrays, with a regression
test.

### 2.4 Streaming degrades instead of re-asking — done

A parse failure used to return `Err`, which the host turned into "could not be
applied". It now takes the same path as 2.1, and §3.4 adds one repair attempt on
top.

---

## 3. Phase 1 — One request per step

The core fix: the restart is gone.

### 3.1 Stream the tool loop — done

`read_frames` used to return `ToolRequested` and throw the body away. It now
accumulates:

```rust
struct StreamedStep {
    text: String,
    calls: BTreeMap<usize, PartialCall>,   // id, name, concatenated arguments
}
```

- `choices[0].delta.content` is accumulated and shown as it arrives.
- `tool_calls[i]` is assembled by index across frames: `id` and `name` on the
  first frame, argument fragments after.
- On `[DONE]` the whole step is handed to `converse`, which runs the tool and
  asks for the next step — still streaming.
- `run()` no longer owns turn semantics at all: it delegates to `converse`. That
  is the structural fix. The two paths cannot drift again, because there is only
  one loop.

Result: a question turn is two streamed requests, and the first one is not
wasted.

### 3.2 One client, one connection pool — done

`provider::client()` is a `OnceLock<reqwest::Client>` with `connect_timeout(5s)`,
`pool_idle_timeout(90s)` and `tcp_keepalive(30s)`. Removes a TLS handshake from
the critical path of every extra call.

### 3.3 Remove the duplicate fallback request — done

`body_variants` builds the candidate bodies once and deduplicates them. With
tools always offered, the old fallback list sent the identical body twice and
paid for a request that could not have a different outcome.

### 3.4 One repair round trip instead of a blind retry — done

When a turn cannot be used, the model gets its own output plus the exact
complaint, once:

- **Unreadable reply** → the parser's error.
- **Unreadable proposal** → the reason the field could not be read.
- **Valid JSON, invalid proposal** → the notice text, e.g. `unknown item type:
  insight`.

Rules that keep this from becoming a loop:

- One repair per turn, total. Parse-level repair marks the turn repaired, so the
  validation-level repair cannot follow it.
- Never after a question has already been asked: the question is in front of the
  person and is not worth risking for a cleaner sentence.
- A repair that asks for a tool, fails, or overruns the turn budget is ignored
  and the degraded result stands.
- The original `Retry` button in `App.tsx` stays, but it now covers transport
  failures only. A deterministic shape failure is repaired inside the turn, where
  it can actually succeed.

Honest limit: a repair is a second request. It is worth it on a turn that would
otherwise lose a proposal and pointless on one that is already fine, which is why
it is gated on a complaint existing.

### 3.5 Bound the turn — done

- `MAX_STEPS`: 6 → 4. A turn needing five tool calls is a bug, not a turn.
- `max_tokens` on every request: `REPLY_MAX_TOKENS = 3_000`,
  `PLAN_MAX_TOKENS = 8_000`. These are ceilings, not targets; they exist so a
  step cannot spend a minute rambling.
- Whole-turn deadline: 60 s (`TURN_BUDGET`), enforced with `timeout_at` around
  every step, including the repair.

Deliberate deviation: the client-level per-request timeout stays at 120 s rather
than the planned 45 s. The turn budget already bounds the request, and plan
generation legitimately takes longer than 45 s a request. One deadline is easier
to reason about than two.

---

## 4. Phase 2 — Payload hygiene

### 4.1 Stop sending the transcript twice — done

The last 18 messages were in `RECENT CONVERSATION` in the system prompt *and* in
the `messages` array. The system-prompt copy is gone. The chat array stays,
because it is what the model reads as turns.

`EARLIER CONVERSATION` stays: it is the only compaction of older turns, and it
keeps message ids so the model can reference a turn it was not shown.

Test: `the_recent_window_is_sent_once_as_chat_messages`.

### 4.2 Force structured output, or admit we do not — done, option (a)`response_format` used to be set only when tools were absent, and tools were

always present, so JSON mode was dead code. It was then sent alongside the tools;
**that priority was reversed on 23 Oct** when the reply became prose and the brief
became a set of tools (§13). Forcing JSON mode onto a prose turn constrains the
reply to an object nobody asked for and, on llama.cpp, suppresses the very calls
the turn depends on.

- `body_variants` orders the shapes `[tools, json + tools, plain, json]`, minus
  duplicates. A request with no tools (plan generation) still asks for JSON
  first.
- A 400/422 walks to the next shape; a 5xx retries the same body once.
- An empty 200 response is rescued with "tools, no JSON mode" rather than with no
  tools, so a rescued step can still ask its question.
- The accepted shape is recorded per step as `variant`, so a turn that keeps
  landing on an alternate shape is visible in Diagnostics instead of guessed at.

Option (b) — making the reply a schema-enforced tool call — is still the better
long-term answer, because it removes the parse failures and the repair path with
them. It is deferred until the local router lands, since both want the same
"structured output as a call" machinery.

### 4.3 Shrink the instruction block — done, partially

`SYSTEM` went from **6,821 → 4,463 characters** (35%), about 1,700 → 1,100
tokens on every request.

- The whole `TOOLS` section moved into the `ask_questions` tool description,
  where it is read by the model that is about to call it.
- The duplicated two-line JSON example was replaced by one output line plus the
  field list that already sits in `THE PROPOSAL`.
- A test (`the_instruction_block_stays_small`) fails above 4,500 characters, so
  it cannot quietly grow back.

Stopped short of the planned 3,500: the remaining fat is the artifact type list
and the hard rules, and cutting those trades a real behaviour rule for ~150
tokens. 4,463 is the honest floor without editing the product's rules.

---

## 5. Phase 3 — Router (Laya, ONNX, in Rust)

Purpose: skip work the turn does not need. Not to make the model faster.
**Not started. Gated on a rules baseline.**

### 5.1 What it decides

One forward pass, five typed questions, no generation:

| Question | Type | Used for |
| --- | --- | --- |
| `needs_tools` | noul | Attach the tool schema only when the turn may ask |
| `needs_brief` | noul | Skip the brief block for turns that cannot change it |
| `proposes` | noul | Choose the short output shape (no `proposal` field) |
| `workflow` | noul | Pre-select the workflow toggle instead of a manual button |
| `effort` | score | Pick model tier / `max_tokens` |

All of them batched into one call — that is what Laya is built for (33–39 ms on
GPU, all questions in a single pass).

The largest of these is `proposes`: the `proposal` object is the bulk of the
output JSON, so a turn that cannot propose can be asked for a much shorter
object.

### 5.2 The 8,192-token question

The published long-document table is the important number, not the window:
accuracy holds to about **4,000 tokens** and then "results vary". Treat 8,192 as
a hard ceiling and 2,000 as the working budget.

Do not send the conversation. Build a compact structured state, which Laya
accepts as JSON:

```
{
  "last_user": "<last user message, 400 chars>",
  "last_reply": "<last Soren reply, 300 chars>",
  "brief": ["goal|provisional|<80 chars>", ...],   // max 40 items
  "pending_answers": 0,
  "previous_turn": "<optional, 200 chars>"
}
```

Budget: ~150 tokens of option text + ~300 user + ~250 reply + ~500 brief ≈
**1,200 tokens**. Safe, fast, deterministic, and cheap enough to cache.

- Truncate head+tail, never mid-sentence. If the required state exceeds the
  budget, **do not classify** — take the full path. A silent downgrade is worse
  than a slow turn.
- Keep the option count at 3–4 per question. Each option is scored at its own
  `[MASK]` token out of a fixed `head_max_len`; 20 options collapse accuracy.
- Use the English checkpoint by default; route to `multilingual` only when
  non-Latin script is detected.
- Cache key: `(last message id, brief revision)`. Typing and retries cost 0 ms.

### 5.3 Rust integration

`laya[onnx]` exists, so the scoring head is presumably already exported as a
graph. Spike first:

1. Inspect the ONNX graph I/O. If it takes `(token_ids, option_ids)` and returns
   per-option logits, `ort` + the `tokenizers` crate is enough.
2. If the graph is Python-only, budget 3–5 days to port the scorer, or fall back
   to rules for v1.
3. Target EP: CoreML on Apple Silicon, CPU elsewhere. Budget < 100 ms p95, hard
   cap 2 s.

New module: `src-tauri/src/local/` with `mod.rs` (the `LocalEngine` trait),
`rules.rs` (always-shipped deterministic fallback), `laya.rs`, `model_store.rs`.

**Ship the rules router first.** It is 50 lines, costs nothing, and covers "is
this a question?", "does it contain a request to build/plan?", "is it a
greeting?". Laya then improves it rather than enabling it.

### 5.4 Asymmetric confidence gating

Laya ships over-confident (ECE 0.466 before temperature fitting), and zero-shot it
is near chance on typed decisions unless fine-tuned (0.362 against a 0.461
majority baseline). So:

- Only trust `needs_tools = true` at a low threshold. A false negative is safe
  (prose answer, no options). A false positive costs a round trip.
- Never let the router skip the **brief** on a turn it labels as proposing. Gate
  `needs_brief` on `proposes = true`.
- Log every routing decision with its confidence and the outcome, so thresholds
  are tuned against real turns instead of guessed. The trace format in §8 is
  where that record goes.

---

## 6. Phase 4 — Local generation (Ternary Bonsai 2)

**Revised 23 Oct.** The original rule here was "never speaks as Soren, never
proposes", and it was written against a 2B model emitting an envelope. With the
reply reduced to prose and the brief moved behind tools, a 9B model does the
conversational turn end to end (§13). The rule that survives is the one that
matters to the product: the model proposes, the person disposes — every brief
change is staged and none is applied without confirmation.

The guardrail that does **not** survive measurement is clickable questions: the
model asks in prose and will not choose `ask_questions` under automatic tool
choice (§13.4). Decisions below are kept so the reasoning is visible.

### 6.1 Jobs, in order of value

Each job is marked with what the spike (§12) found.

1. **JSON repair.** The model's malformed object plus the parser error in, a
   corrected object out. This is now the in-turn repair of §3.4, served locally
   instead of by a second remote request. **Viable — but only with a
   `json_schema` carrying enums.** Prompted repair echoes the bad value back.
2. **Context compaction.** Summarise old messages into the `EARLIER CONVERSATION`
   block that `prompt.rs` currently builds with keyword matching. Runs once every
   few turns, saves input tokens on every subsequent turn. **Viable,** 0.6 s.
3. **Draft tool arguments.** e.g. propose the `ask_questions` option labels so
   the remote model does not spend output tokens on them. **Dropped:** the labels
   it produced were generic, and a weak option is worse than a paid good one.
4. **Session titles and follow-up suggestions.** Purely local, currently remote
   or absent. **Expected to work,** same shape as compaction; untested.

Everything else stays remote. In particular: no brief items, no proposals, no
workflow artifacts, no text shown in the conversation. The spike gives that rule
teeth: three load-bearing statements produced no proposal at all.

### 6.2 Runtime: the spike has been run

llama.cpp 11669 (Homebrew), `Ternary-Bonsai-2-2B-Q2_0.gguf` (547 MB), Metal, 32k
context:

```
llama-server -m Ternary-Bonsai-2-2B-Q2_0.gguf -ngl 99 -fa on -c 32768 --port 8080 --jinja \
  --temp 0.7 --top-p 0.8 --top-k 20 --min-p 0 --presence-penalty 1.5 \
  --repeat-penalty 1.0 --repeat-last-n 64
```

`--jinja` is not optional: without it the server ignores
`chat_template_kwargs`, so thinking cannot be turned off, and the model's tool
template is not used.

Point Soren at `http://127.0.0.1:8080/v1` as an **OpenAI-compatible provider** —
that path already exists (`provider.rs::active_profile`). Results are in §12.

Sizes: `PTQ1_0` 0.43 GB, `PQ2_0` 0.52 GB, `Q2_0` 0.55 GB for 2B. Apache 2.0.
Upstream llama.cpp runs only `Q2_0`; the PrismML fork is needed for the other two
packings, at the cost of pinning a fork.

### 6.3 Packaging (only after the spike proves value)

- Bundle the **runtime**, download the **model**. A downloaded executable hits
  Gatekeeper on macOS; a downloaded weights file does not. Runtime is ~20–40 MB
  per platform; model is 0.55 GB (`Q2_0`, stock llama.cpp) or 0.52 GB (`PQ2_0`,
  PrismML binaries, faster prompt processing on Apple Silicon).
- Prefer linking llama.cpp into the Rust process (`llama-cpp-2`) over a sidecar:
  no child process to sign, no port, no auth token, no orphaned server on crash.
  Fall back to `llama-server` as a managed sidecar if the build cost is
  unacceptable.
- Download flow: pinned URL per platform + sha256 + resume + a progress event the
  UI already has a place for (`Notifications.tsx`). Store under the app data
  dir, not the bundle.
- Offline / no model: every local job is optional. Missing model means the remote
  path runs, silently. The model is an optimisation, never a dependency.

---

## 7. Guardrails

- The local model never writes text the person reads, and never touches
  proposals, item ids, or workflows.
- Every local call has a hard 2 s budget. Missing it abandons the local path for
  that turn.
- Fallback is invisible. If local is absent, slow, or low-confidence, the normal
  path runs and nothing is shown about it.
- One debug surface (Settings → Diagnostics) shows which path ran and how long
  each step took. Not in the conversation.
- No model download without explicit consent and a visible size.

---

## 8. Telemetry — done

`src-tauri/src/timing.rs`. Without it, every claim above is a guess.

```rust
struct StepTrace { kind, ms, ok, attempt, in_chars, out_chars, variant }
struct TurnTrace { turn_id, at, total_ms, steps, outcome, note }
```

- One JSON line per turn, appended to `<app data>/turn-traces.jsonl`.
- The file is rewritten to its newest 300 lines once it passes 512 KiB, so it
  cannot grow without bound.
- Settings → Diagnostics shows: the last turn as a table (step, kind, time, sent,
  received, request shape), then the previous five turns as rows, then p50/p95
  over the last fifty.
- `variant` is the request shape the provider accepted. A turn that keeps landing
  on `tools` instead of `json + tools` is the JSON-mode risk in §11 happening in
  the open, with a number attached.

Deliberately not recorded: demo turns (no request) and cancelled turns (the
future is dropped, so there is no line to write). Both are honest absences rather
than zeroes.

---

## 9. What is left, in order

| Step | Work | Proves |
| --- | --- | --- |
| 1 | Trace ten real turns | Whether Phases 0–2 hit the §1 targets |
| 2 | Rules router (~50 lines) | Whether routing helps at all, before any model |
| 3 | Bonsai spike via `llama-server` | Whether local generation is worth packaging |
| 4 | Laya ONNX | Replaces the rules router; needs the §5.3 spike first |
| 5 | Local packaging | Only if 3 and 4 both show a win |

Steps 1–3 are the whole remaining ask. 4–5 are gated on measurement.

### Kill criteria

- A question turn stays above 15 s after tracing → the remaining latency is the
  model, and local generation is the only lever left.
- Rules routing changes no turn in ten → drop routing; the labels are not there.
- Laya zero-shot routing is under 80% on 50 hand-labelled real turns → ship rules
  only, revisit with labels.
- Bonsai 2B produces valid repaired JSON under 95% of the time → drop job 1, keep
  compaction.
- Router p95 exceeds 150 ms on the critical path → precompute on idle or drop it;
  a router must not cost a round trip.

---

## 10. Test plan

Shipped coverage (111 Rust tests, 56 frontend tests, all green):

- `validation.rs`: an invalid proposal yields a reply plus a notice, never an
  `Err`.
- `provider.rs`: identical-body fallback is not sent twice; the variant order
  puts JSON mode and tools first.
- `streaming.rs`: `tool_calls: []` does not end the stream; a split `tool_calls`
  delta reassembles into one call; two calls stay in order; a stream that ends
  without `[DONE]` still returns what arrived.
- `lib.rs`: a turn whose proposal fails still returns `Ok` with the reply; an
  unreadable reply is repaired once; a failed repair leaves the original failure;
  a dropped proposal is recovered; no repair is attempted after a question is
  asked; a stepping loop is cut off at `MAX_STEPS`.
- `prompt.rs`: the recent window appears once, as chat messages; the instruction
  block stays under 4,500 characters; earlier excerpts stay traceable by id and
  bounded by size.
- `timing.rs`: a trace round-trips through its JSON line; percentiles are
  nearest-rank on a ten-sample set; attempt order is preserved.
- Frontend: a failed turn keeps the streamed bubble and marks it interrupted.

Still manual, and worth doing once with the tracer running:

- One "sup", one question, one proposal, one invalid proposal, one offline
  provider — all timed and traced.

---

## 11. Risks and open decisions

### The one change with provider-specific risk

`response_format: json_object` is now sent alongside the tools. On a model where
that constrains the assistant into prose and suppresses tool calls, a turn that
should have asked a question will answer in prose instead. The drop is handled
rather than silent:

- `body_variants` puts "tools, no JSON mode" second, so it is one 400 away;
- the empty-response rescue prefers that shape, so a step that returns nothing
  recovers with its tools intact;
- every step records which shape it used, so the pattern shows in Diagnostics.

If a provider turns out to suppress tool calls under JSON mode, swap the first
two entries of `body_variants` and nothing else changes.

### Superseded: JSON mode is no longer the first shape

The paragraph below still describes the mechanism, and the mechanism still
matters — an endpoint that refuses a shape is remembered and skipped. What has
changed is that "json + tools" is no longer the first shape tried, so a local
endpoint that refuses the grammar pays its discovery cost only if a fallback ever
reaches it. The first shape is now prose plus tools, which llama.cpp accepts.

### Confirmed: one provider refuses the combination outright

The spike found a provider that does more than suppress: llama.cpp **cannot parse
a request that sets `response_format` and `tools` at once**. It answers 400
`Failed to initialize samplers: failed to parse grammar`, because the reply
grammar and the tool-call grammar cannot be joined. Both `json_object` and
`json_schema` fail the same way; each works alone.

Soren survives this by design — the 400 walks to the next shape — but the walk
costs a request on every step, and the trace would show `variant: 1` on every
turn with no explanation. So the refusal is now remembered: `provider::shapes`
drops the combination for that endpoint for the rest of the process, keyed by
provider, base URL and model. `note_refusal` records it, `shapes` filters it, and
the first step of a session pays the discovery instead of every step.

A second, narrower lesson: with `--jinja` (required for `chat_template_kwargs`)
even `json_object` alone is rejected, while `json_schema` alone still works. Any
future local provider integration should send a schema, never the `json_object`
shorthand.

### Structure, not tuning

The 20x was not a slow model or a bad prompt. It was three requests where one
would do, plus a duplicate payload, plus a fresh handshake each time. That is why
the fix was deleting a restart rather than tuning a parameter, and why the local
model is last: it removes none of those multipliers.

### Dead code kept on purpose

`prompt::system_prompt` is a back-compatible entry point used by the prompt
tests. It produces one `dead_code` warning and no behaviour. `validate_turn` was
removed on 23 Oct: it existed to validate a proposal, and the turn loop owns that
decision now, so keeping it would have implied a second path that never runs.

---

## 12. Spike result — Ternary Bonsai 2 (2B, Q2_0), 23 Oct

Run through a local `llama-server` with Soren's real system prompt (4,457 chars),
its real tool schema, and `enable_thinking: false`. Each request is one call;
the numbers are wall time on an Apple Silicon laptop, warm model.

| Job | Time | Outcome |
| --- | --- | --- |
| Reply + proposal, turn 1 | 1.6 s | JSON, but **no proposal**, and a prose question |
| Reply + proposal, turn 2 | 1.4 s | prose + a tool call, no object |
| Reply + proposal, turn 3 | 0.6 s | JSON, **no proposal**, prose question |
| Question turn | 3.3 s | correct tool call, but two duplicate calls and generic options |
| JSON repair, prompt only | 1.5 s | **failed**: echoed `type: "insight"` unchanged |
| JSON repair, `json_schema` with enums | 0.8 s | **worked**: corrected to `type: "constraint"` |
| Compact five turns into one line | 0.6 s | **worked** |

### What this settles

1. **Bonsai cannot be Soren.** Zero of three load-bearing statements produced a
   proposal, which is the brief's normal move. It also leaks questions into
   prose, which the system prompt forbids twice. The guardrail in §7 was right,
   and it is now evidence rather than caution.
2. **Bonsai is good at bounded text with a grammar.** Repair and compaction both
   work, sub-second, and the schema version of repair is *guaranteed* correct in
   shape rather than merely likely. Job 1 moves from "prompt the model to be
   careful" to "hand it an enum".
3. **Speed is not the problem.** Every call is 0.6–3.3 s against 10–120 s remote.
   If a single local job replaces a remote round trip, it wins on latency alone.

### What it changes in the plan

- Job 1 (repair) is kept, but implemented as `json_schema` with `draft.type`,
  `status` and `kind` as enums. Prompt-based repair is dead.
- Job 2 (compaction) is kept as specified.
- Job 3 (drafting `ask_questions` options) is **dropped**: the options the model
  produced were generic ("What is your primary goal for this announcement?"), and
  a bad option is worse than the remote model spending tokens on a good one.
- Job 4 (titles, follow-ups) stays, now with a reason to expect it to work: it is
  the same shape as compaction.
- A local *conversational* turn is not attempted. That was never in scope; it is
  now also not tempting.

Next step is unchanged: trace ten real turns, then the rules router. The local
model is worth packaging for two jobs, not for the turn itself.


---

## 13. Bonsai 2 9B — the conversational turn, measured 23 Oct

The 2B spike (§12) concluded that a local model could not be Soren, because it
could not emit the JSON proposal envelope. That conclusion was about the envelope,
not about the model. The turn has since moved to prose plus tool calls (§14), so
the question is reopened with `Ternary-Bonsai-2-9B-Q2_0.gguf` (2.55 GB) on the
same machine.

Run it through `src-tauri/src/replay.rs`, which drives the real `converse` loop
against a real `llama-server` — the same code path the app uses, not a mock:

```sh
cargo test --offline replay -- --ignored --nocapture
```

### 13.1 What it can do

Five turns, warm model, `--jinja`, thinking off:

| Turn | Tool calls | Staged | Time |
| --- | --- | --- | --- |
| A constraint stated plainly | `add_item` | `constraint` | 7.8 s |
| A goal with an unresolved fork | `add_item` | `question` | 3.5 s |
| A greeting, nothing load-bearing | none | none | 0.4 s |
| A correction to an existing item | `edit_item` | edits the right id | 4.4 s |
| The same constraint, said twice | `add_item`, then `edit_item` | one edit | 5.3 s |

The end-to-end path works: the model writes through the tools, the loop stages the
change, the reply is prose the person can read, and a turn that has nothing to
record records nothing. The duplicate row is the loop doing its job — the second
`add_item` was refused with the id of the item it duplicated, and the model
recovered by editing that item instead.

Write expectation met: **5/5**. Question expectation met: **4/5** (§13.4).

The table is one run. Repeats vary, and the variance is part of the result:

- **Duplicates: 6/6 runs.** The refused `add_item` was read, the model switched to
  `edit_item`, and only one change was staged every time. This is the most
  repeatable behaviour measured.
- **Corrections: 5/6 runs.** One run staged `add constraint: The deadline moved to
  April` instead of editing `i1`, leaving the old March goal in place. The edit was
  available and correct in the other five.
- **Classification: unstable.** The same fork produced `goal` once, `question`
  once, and `decision` once, across runs.

### 13.2 What it costs

| | Thinking on | Thinking off |
| --- | --- | --- |
| Tool-using turn | 16–22 s | 3.5–8.5 s |
| Plain greeting | 2.8 s | 0.4 s |
| First token, warm | 2.6 s | 61 ms |
| Eval rate | 31 tok/s | 31 tok/s |

Thinking is not a tuning knob here, it is the whole budget: a step that thinks
spent 576 output tokens before the first word, at 31 tok/s. Nothing measured
improved with it on. `provider::base_body` now sends
`chat_template_kwargs: {"enable_thinking": false}` to local endpoints only.

Memory: `llama-server` RSS **3.4 GB** for the 9B at 32k context, 21% of 16 GB.
The runtime is a stock Homebrew llama.cpp build; nothing is bundled.

First token is 61 ms only because the prefix is cached. A cold first turn pays
about 1.8 s, mostly prompt processing at ~280 tok/s. This is the number the old
sub-second target should be read against: warm yes, cold no.

### 13.3 What is reliable, and what is not

Reliable, measured:

- A load-bearing statement is recorded without being asked twice.
- When a correction becomes an edit, it targets the right item by id (5 of 6 runs).
- A refusal is read and corrected in the same turn (the duplicate row, 6 of 6).
- A redundant item is not created when the model tries to re-record one it already
  staged (the containment rule, added after the first replay showed it).
- A turn with no tool call still returns a usable sentence.
- A turn that spends its step budget ends with a sentence that does not claim to
  have recorded something it did not.

Not reliable:- **Clickable questions.** Across five runs of the five scenarios below (25
  turns), and three direct probes with only `ask_questions` offered, the model put
  its question in prose and called no tool. With `tool_choice: "required"` it called
  the tool correctly, with the nested `questions[].options[]` arguments — so the
  schema and the runtime are fine and the policy is the problem.
  **Addressed in §15** by converting the sentence with one forced call.
- **Edit or add.** A correction usually edits the item it names, and sometimes
  adds a second item beside it. Nothing in the loop detects that the old item is
  now stale, so the brief can hold both. Flagging a contradiction between a new
  item and an existing one is the next correctness problem, not a prompt problem.
- **Exact wording.** The same idea restated differently arrives as a new item
  unless it contains the old one. `normalise` + containment catches growth; it
  does not catch paraphrase.
- **Consistency.** The same prompt staged a `goal`, a `question`, and a `decision`
  on different runs. The brief is not reproducible, and nothing in the loop should
  pretend it is.

### 13.4 What this changes

- The local model is a supported path for the conversational turn, not only for
  bounded jobs. It is configured as an OpenAI-compatible provider; no weights are
  bundled.
- Thinking off is the default for local endpoints, on measurement.
- `ask_questions` is not counted on for a local model. **Done in §15:** a question
  left in prose is converted with one forced call, gated on the reply ending in a
  question mark and on the endpoint being local.
- The rules router (§5) is still the cheapest next win, and still unmeasured.

---

## 14. The turn contract, as of 23 Oct

Recorded because §12's conclusion and the code disagreed until now.

- **The reply is prose.** One to three sentences, no envelope, no fences.
  `parse_turn` still reads an envelope when one is present — a workflow turn asks
  for one — but prose is the normal case, and a reply that starts with `{` is not
  assumed to be JSON.
- **The brief changes through tools**: `add_item`, `edit_item`, `retract_item`,
  and `ask_questions`. Each call stages a change; the person confirms it. The
  model is told the new item has no id yet, so it does not try to edit it.
- **One change and one question per turn.** A second write is refused with the
  reason; a second question is refused likewise.
- **A refusal is a message, not a failure.** The model reads the complaint, gets a
  chance to correct it in the same turn, and the turn still ends with a reply.
- **Duplicates are refused by wording**, including an item that only grows an
  existing one, with the id of what it would duplicate.
- **The request shape follows**: prose plus tools first, JSON mode second (see
  §4.2). The JSON envelope is a fallback, not the contract.

Consequences for tests: anything that asserted "a non-JSON reply is a parse
failure" was asserting the old contract. Those assertions were replaced with the
ones that now matter — an empty envelope is still a failure, an unreadable
envelope proposal is still explained, and prose is never thrown away.

---

## 15. Local preset and question cards — built 23 Oct

Two changes chosen after §13, both scoped to a model on this machine.

### 15.1 The local preset

`Settings → Local (llama.cpp)` points at `http://127.0.0.1:8080/v1` by default.
It sends no key, stores no key, clears one if a config carried it, and gets
thinking off and question cards automatically. The key rule follows the
**address**, not the preset: any loopback endpoint saves without a key, so
pointing the OpenAI-compatible provider at localhost works too. A remote host
still requires one.

The preset does not start the server. `llama-server` is still yours to run, and
the Settings panel says so with the command. Starting it from the app is a
separate decision with a port, an orphan process and signing attached; it is not
in this change.

### 15.2 Question cards

The gate is the reply: if it ends with `?`, the turn had a question that the
model did not put through `ask_questions`. In that case the loop makes **one**
more request to the same model, offering only `ask_questions` and requiring a
call, with the instruction to ask the same question in the same words. It runs
only for a local endpoint, where it was measured to be necessary.

- Cost: 3–6 s on a question turn (measured: 10.5 s, 4.9 s, 10.0 s, 10.6 s, 15.2 s
  total for the five scenarios, against 3.5–10.6 s without cards).
- It is additive. The prose question stays in the reply, so the card is a second
  way to answer, not a replacement for the words.
- Failure is silent and has three shapes, all tested: the request fails, it
  returns a call with unusable arguments, or it returns no `ask_questions` call.
  Each leaves the reply untouched with no card and no notice.
- It records a `question` step in the trace, so Diagnostics shows what it cost.
  That line is also the seed of the data described in 15.3.

Quality is mixed, and the mixed cases are informative. Observed across two runs:

| Reply's question | Card options | Verdict |
| --- | --- | --- |
| "What would need to change to keep people from burning out?" | Add more people / Reduce call frequency / Rotate duties differently | good |
| "What's on your mind?" | I'm stuck / I want to explore an idea / I need help clarifying | good |
| "What does burnout look like in this context?" | Physical / Emotional / Professional | good |
| "How does this affect your priority on other deliverables?" | Shift focus to quality / Expand scope / Maintain pace | thin |
| "Is this a constraint you need to enforce, or an assumption…?" | constraint / assumption | **bad** — it asked the person to do taxonomy |

The bad card is the model's own sentence, faithfully converted: the reply asked a
question the product should never ask. Converting it made a bad question
clickable. That is a reason to leave the card in, not to filter it — the bad
question is visible either way, and it is now visible with options that make the
mistake obvious.

### 15.3 Laya, and why it is not here yet

Laya would be the right component for the *precision* half of this gate: a
trailing question mark says a question exists, not that a card is worth showing,
and the "is this a constraint or an assumption?" card is exactly the case a
classifier should reject. Three things argue for sequencing it after this:

1. The gate is not the cost. It is a character comparison; Laya at ~33 ms saves
   nothing over it, and the second call it would guard is 3–6 s.
2. Zero-shot confidence is the whole risk. PLAN §5 already records Laya as
   over-confident (ECE 0.466) and near chance on typed zero-shot decisions
   (0.362 against a 0.461 majority). A gate that drops good cards is worse than
   no gate, and it fails invisibly.
3. There are no labels in this repository — and Laya is a classifier, so it needs
   them.

The order that respects all three: ship the `?` gate, log every conversion in the
trace, and later label the ones where the person ignored the card or answered in
prose. That set trains the `noul` that replaces the character comparison. Until
it exists, a learned gate would be a guess dressed as a decision.

What Laya remains genuinely valuable for is the job §5 gave it: `needs_tools`,
`needs_brief`, `proposes`, `workflow`, `effort` — skipping work, not approving a
card.

---

## 16. Beyond 9B — where the local model goes next

**Research, 24 Oct. Nothing here is built.** §13 measured the 9B and found it
reliable but shallow, and the user's verdict on it is blunt: very shallow
reasoning, constant errors. This section is the response to that, and it changes
two earlier decisions.

### 16.1 First, what is *not* wrong

The first hypothesis was that the installed ternary model was being run by a
llama.cpp without the Hadamard activation runtime — that would produce garbage
from an apparently successful load, which fits "constant errors" exactly.

It is false. Homebrew's `llama.cpp 0.7.0` (build 11669) ships the runtime, and it
ships the *verifying* form of it: `libllama` contains `llama_verify_hadamard_graph`
plus a family of refusal messages (`Hadamard-folded weight '%s' is consumed
without its activation transform`, `prism.hadamard: arch '%s' is not verified to
apply the activation transform to all folded weights`). A missing or partial
runtime fails loudly here; it does not degrade quietly. The 9B `Q2_0` load is
correct.

So the model is the ceiling, not the plumbing. That matters, because it means no
amount of flag-tuning fixes this.

### 16.2 What is actually on the table

The Bonsai line has moved twice since the 9B was installed. The current flagship
is **Bonsai 2 27B**, built on Qwen3.8-27B, at 5.95 GB (`PTQ1_0`) or 7.21 GB
(`PQ2_0`). Against the 9B's ~2.28 bits/weight and 2.56 GB, that is roughly three
times the parameters for about 2.3× the file size — and it is the first Bonsai
that publishes an agentic score at all (BFCL v3 74.92 against 76.74 at FP16;
84.78 across 14 thinking-mode benchmarks, 98.2% of FP16).

The 9B publishes no agentic number. In a family that publishes one for its
flagship, that absence is the finding.

Decode estimates for this machine, extrapolated from PrismML's M4 Pro (18.0 tok/s)
and M5 Pro (28.1 tok/s) figures against the M2 Pro's 200 GB/s — **estimates, not
measurements**:

- 27B `PTQ1_0` (5.95 GB): ~18–22 tok/s
- 27B `PQ2_0` (7.21 GB): ~15–18 tok/s
- prefill, ~90–100 tok/s: a cold 3,000-token prompt is **~30 s before the first
  token**

That prefill number is the whole reason §13's cache work is now a dependency
rather than a polish item.

### 16.3 The decision — 27B, thinking on, streamed

Chosen: **Bonsai 2 27B with thinking enabled on every turn, streamed to the UI.**

This reverses two earlier positions, deliberately:

1. §13 turned thinking *off* because the trace costs ~20× the words the person
   reads. That was correct for a 9B that thinks shallowly. The premise has
   changed: a 27B's reasoning is the product, not overhead.
2. §15.1's local preset assumes thinking off. It cannot stay.

The brief against 9B was "very shallow reasoning". A 27B with thinking disabled
is a larger model denied its main advantage, so thinking-on is not a tuning
choice here — it is the point.

### 16.4 What thinking-on actually requires

Four changes are coupled. Enabling the flag alone produces a *worse* experience
than today, and the failure is silent.

**Sampling flags must change with it.** The current `dev-with-llama.sh` runs
`--presence-penalty 1.5`, which is PrismML's **non-thinking** preset. Thinking
mode specifies `temperature=1.0, top_p=0.95, min_p=0.05, presence_penalty=0.0`.
A presence penalty of 1.5 actively suppresses the token reuse that reasoning
depends on. This is the single most likely way to try the 27B and wrongly
conclude it is bad.

**`REPLY_MAX_TOKENS = 3000` is too small.** Thinking is billed against the same
budget. PrismML's own warning is explicit: a small cap "ends generation
mid-thought, before any answer." Local needs ~10,000 so the trace can finish and
the reply can follow it.

**`TURN_BUDGET = 120s` is too small.** At ~18 tok/s, 1,000 thinking tokens is
~56 s and 3,000 is ~167 s before the reply starts. The model defaults to `xhigh`
effort, which cannot fit in the current budget; `medium` is the supported setting
for shorter responses ("low is not supported and behaves close to xhigh"), so
effort must be pinned to `medium` explicitly. Budget rises to ~240 s for local.

Note what this means: `effort` becomes the real latency lever, and §5 already
lists `effort` as a router output. The router's job changes from "skip a request"
to "pick a reasoning budget".

**The stream has no channel for it.** `streaming.rs::read_frames` reads only
`delta.content`; `delta.reasoning_content` is discarded. Nothing above the wire
knows a thinking phase exists. Streaming thinking therefore needs a third event
type alongside `delta` and `tool_call`, a contract change in `src/api.ts`, and a
collapsible block in the UI. Without it a thinking turn looks frozen for a
minute — which is precisely how a good model gets judged bad.

### 16.5 Delegating the cheap work — small generator, not classifier

The right instinct, but the wrong mechanism, and the distinction is already in
this plan twice.

A **classifier** decides things (§5's router). §15.3 already argued it is the
wrong tool for the card gate: it needs labels this repository does not have, and
it is near chance zero-shot. That argument still holds.

A **small generator** *does* bounded work. That is a different claim, and it is
the one that pays. The card step currently costs 3–6 s on the 9B, is a mechanical
paraphrase of a sentence the model just wrote, and would cost *more* on the 27B.
It should not touch the 27B at all.

The 2B is already on disk (`Ternary-Bonsai-2-2B-Q2_0.gguf`, 547 MB, measured in
§12). It is the correct engine for that step, thinking off, on its own port. Peak
model memory for 27B + 2B is ~6.5 GB against 16 GB, so both coexist comfortably.

The ladder:

| Tier | Engine | Cost | Does |
| --- | --- | --- | --- |
| 0 | code | 0 ms | validation, shape repair, the `?` gate |
| 1 | 2B, thinking off | ~0.2–0.5 s | card generation, render-to-options |
| 2 | 27B, thinking on | 30–90 s | the turn |

This targets two of the four complaints directly. "Constant repairs and retries"
is mostly *shape* failure, not reasoning failure — tier 0 already catches the
regular half (§4.2), and the rest should be re-asked of tier 1, not tier 2.
"Won't call tools unprompted" is a formatting habit the 2B can be forced into
without burning a 27B turn on it.

What this does **not** address is "very shallow reasoning". That is tier 2's job
and only tier 2 can do it. Delegation makes the turn affordable; it does not make
it smarter, and it must not be sold as if it does.

### 16.6 The bake-off, when we get there

Two candidates, identical prompts, scored on the four complaints:

1. **Bonsai 2 27B** — `PTQ1_0`, thinking on, `medium` effort. Needs PrismML's
   llama.cpp fork (prebuilt macOS arm64 exists); stock rejects `PTQ1_0`/`PQ2_0`.
2. **Qwen3.5-9B Q4_K_M** — 5.68 GB, uncompressed, runs on the installed
   llama.cpp. The control: if this alone fixes the shallowness, compression was
   the problem and the fork install can wait.

Reuse §12's replay harness against real turns. Measure: tokens spent thinking
before the first answer token, whether a card appears without the forced second
request, and repair rate per turn. Do not measure wall-clock alone — a slow turn
that needs no repair can be the faster one.

**Not yet answered:** whether a 27B reasoning model with thinking pinned to
`medium` actually beats a 9B that does not need to think. The 27B is 3× larger
and its thinking is the reason to run it, but `medium` may clip it below its
advantage. That is what the bake-off is for, and it is the one thing that cannot
be settled by reading model cards.

### 16.7 The precedent already in this plan

§13.2 ran the 9B with thinking **on** and recorded the result: a tool-using turn
went from 3.5–8.5 s to 16–22 s, the model spent 576 output tokens before the
first word, and *nothing measured improved*. Thinking was turned off on that
evidence.

That is a warning, not a blocker, and the distinction is worth stating plainly.
The 9B result says "thinking costs, and at 9B it bought nothing." The 27B case
rests on a different premise: PrismML's 84.78 is a **thinking-mode** number. The
published score and the intended configuration match, so thinking is where that
model's advantage is claimed to live. The 9B had no such claim — it published no
agentic number at all.

But it also means the trap is real and already sprung once: enabling thinking and
paying 2–3× latency for no gain. The bake-off has to measure reasoning quality,
not just whether the turn still works.

One correction to a risk worth not carrying too far: §13.2 shows tool calls
succeeding with thinking on at 16–22 s, so there is no evidence here of tool
calls being swallowed by the reasoning trace. The local `enable_thinking: false`
is a cost decision, not a workaround for a broken tool path.

### 16.8 Second-order consequences of "as long as it needs"

Taking that answer seriously changes more than the budget constant:

- **Cancel already exists — correction.** §16.8 originally claimed there was no stop
  affordance. That is wrong: `TurnRegistry` (`streaming.rs:22`), the `cancel_turn`
  command, `wait_for_cancel`, `api.cancelTurn` and `handleStop` (`App.tsx:1028`)
  are all wired, including the "cancelled before it started" race. Stop works
  during a local turn. What is missing is not the mechanism but the *visible
  progress* it would be stopping.
- **The error copy becomes false.** A budget timeout currently says "took longer
  than two minutes, so it was stopped." That sentence stops describing reality.
- **`TURN_BUDGET` is one global constant** (`lib.rs:40`). It needs to be
  per-profile: a local thinking turn and a remote turn do not share a sensible
  ceiling.
- **The trace cannot explain a slow turn.** `steps` records `kind`, `ms`,
  `inChars`, `outChars` — no token counts. Without thinking tokens vs reply
  tokens, a 90 s turn is unattributable between prefill, reasoning and decode,
  and effort can never be tuned against real data.
- **Cold start is paid once per launch regardless of the cache fix.** §13.2
  measured ~280 tok/s prefill on the 9B; the 27B is ~3× slower, so a 1,000-token
  system prompt is ~10 s and a cold session start will feel broken even when
  every subsequent turn is warm. Either warm the server at launch or shrink the
  system prompt — the cache fix alone does not cover turn one.
- **The fork becomes permanent.** §12 already noted that `PTQ1_0`/`PQ2_0` pin you
  to PrismML's build. At 9B that was avoidable by using `Q2_0`; at 27B it is not.
  Homebrew upgrades no longer apply to the model runtime, and that is a standing
  maintenance cost, not a one-time install.

### 16.9 Still open

- Does the card step survive at all under a 27B? §15.2's evidence that the model
  won't choose `ask_questions` unprompted may or may not change at 27B, and it
  may change for the worse if thinking consumes the turn's attention.
- Two servers means two processes to supervise. That strengthens the case for
  §15.1's "the app does not start the server" to be revisited eventually — but
  not in this change.
- `--parallel` is unset, and the live server reported `total_slots: 4`, so each
  request sees 8k of the 32k context. With a 27B and a long system prompt this
  is worth pinning to 1. Unverified against the fork build.

---

## 17. The first change, specified

**Cache fix first, alone.** This section is the design, checked against the code
rather than against intuition. Nothing here is implemented.

### 17.1 The prefix breaks in two places, not one

The earlier note said the brief inside the system prompt was the cache problem.
Reading `prompt.rs` shows there are **two independent breaks**, and fixing only
the obvious one recovers almost nothing.

**Break 1 — the system prompt is volatile.** `system_prompt_for` appends, in
order: the workflow authorization line, `THE CURRENT BRIEF` (six sections), the
`EARLIER CONVERSATION` excerpts, `QUESTIONS YOU HAVE ASKED`, and
`REJECTED OR DEFERRED PROPOSALS`. Every one of those changes as the conversation
moves. The only genuinely stable part is the `SYSTEM` constant plus the workflow
line — roughly 2.4k characters.

**Break 2 — the message window slides.** `chat_messages` returns
`state.messages.iter().rev().take(18).rev()`. Each turn drops the oldest messages
and appends new ones, so the **first element of `messages` changes every turn**.
A KV prefix cache diverges at the first differing token, which is immediately
after the system block. This is why the measurements looked so binary — 4 tokens
of reuse on a hit, 803 on a miss.

The consequence is the part worth internalising: **with the system prompt fixed
and the window still sliding, the turn still re-prefills all 18 messages.** You
would save ~800 tokens of a ~2,000-token prompt and conclude the fix underdelivered.
Both breaks have to go, and they are independent.

### 17.2 The shape

**Stable prefix.** `SYSTEM`, plus the workflow authorization line and nothing
else. `workflow_allowed` changes only when the toggle is pressed, so a workflow
turn is a deliberate cache miss and every other turn is a hit.

**Append-only messages.** Stop slicing the tail of the conversation. Grow the
array, and when it crosses a ceiling (~40 messages) cut it back in one jump to
~20. One expensive rebuild every twenty turns instead of every turn, and the
existing `EARLIER CONVERSATION` excerpt machinery still covers what was dropped.

**Volatile state rides at the tail.** The brief, excerpts, asked questions and
rejected proposals move into the *current user message* — appended after the
person's words as a clearly labelled reference block, not as a second message.
Fold it into the user turn rather than adding a trailing `user` message, because
two consecutive user turns are template-dependent and this must work on every
provider.

Two things follow, and both are tests rather than assumptions:

- The system prompt must say the block is reference material and must not be
  quoted back. The existing output validation catches a JSON envelope, not a
  model that paraphrases its own brief into the reply.
- Baking the block into the user message means the *stored* message and the
  *sent* message differ. That difference has to live in the provider layer, at
  request time, or the transcript will contain text the person never typed.

**Warm at launch** covers the one cold turn the cache cannot help. It costs one
throwaway request with the stable prefix and nothing else.

Expected effect, to be measured rather than claimed: a warm turn re-prefills only
the new user words plus the state block (~300 tokens) instead of the whole prompt.
At the 9B's ~280 tok/s that is under a second today, and at the 27B's ~90 tok/s it
is the difference between ~3 s and ~22 s. **This is the change that makes the 27B
usable at all**, which is why it goes first and alone.

### 17.3 Trace token counts

`StepTrace` records `in_chars`, `out_chars`, `ms`, `variant`. Characters are a
proxy that breaks down exactly when it matters: a thinking turn's trace is mostly
invisible, so a 90 s step is unattributable between prefill, reasoning and decode.

`read_frames` (`streaming.rs:366`) currently reads `delta.content` and
`delta.tool_calls` and **discards every other field in the frame**. Two sources are
being thrown away:

- llama.cpp's final SSE chunk carries a `timings` object with `prompt_n` and
  `predicted_n`. That is the local path, and it needs no request change at all.
- OpenAI-compatible providers only send `usage` on a stream when asked, via
  `stream_options: {"include_usage": true}`. `streaming.rs:220` sets `"stream": true`
  and never sets it.

The inconsistency that matters: the **non-streaming** path has no such problem, so
a token count that exists on one path and not the other would make the bake-off
numbers incomparable. Both paths need the field before any model comparison is run.

Add to `StepTrace`: `prompt_tokens`, `completion_tokens`, and `reasoning_tokens`
(defaulting to 0). `reasoning_tokens` is what turns "effort" from a guess into a
number — it is the only way to know whether `medium` is actually spending less
than `xhigh`, and therefore the only way to tune the latency complaint honestly.

### 17.4 Cancel and the budget

The cancel path is complete (§16.8 correction). What "as long as it needs" needs
is narrower than it first looked:

- **`TURN_BUDGET` becomes per-profile.** One global `Duration` at `lib.rs:40`
  caps both a local thinking turn and a remote turn. Split it: local ~240 s,
  remote unchanged.
- **Fix two copies of the timeout sentence.** `lib.rs` returns "took longer than
  two minutes"; `App.tsx:91` independently says "Soren took too long". The first
  is a literal string that becomes false, the second is vague enough to survive —
  but the number must not be hard-coded in one place and implied in another.
- **Stop is only useful if there is something to see.** With `reasoning_content`
  discarded, a stopped thinking turn keeps nothing. Streaming the trace (§16.4)
  is what makes Stop meaningful rather than just fast.

### 17.5 The 9B's fate

Not a quality question — a setup question, and the answer is uncomfortable.

The 9B runs on **stock** llama.cpp via `Q2_0`. The 27B, as far as its published
file table shows, ships `PTQ1_0` and `PQ2_0` only, both of which stock rejects.
Whether a `Q2_0` build exists for the 27B is **unverified** and decides this: if it
does not, then dropping the 9B means every local user must install a vendor fork
before Soren works offline at all.

That inverts the obvious plan. The 9B is not a worse model to be deleted; it is
the only zero-fork path, and therefore the on-ramp. The shape that survives is
three tiers, not two:

| Tier | Model | Runtime | Role |
| --- | --- | --- | --- |
| default-offline | 9B `Q2_0` | stock llama.cpp | works with one command, no fork |
| best-offline | 27B `PTQ1_0` | PrismML fork | the model this section is about |
| cards | 2B `Q2_0` | stock or fork | cheap, thinking off |

Retiring the 9B is only correct if the fork install becomes something Soren does
for the person (§15.1 explicitly defers that). Until then, deleting it trades a
worse model for a worse first run.

### 17.6 Order

1. Token counts in the trace, both paths. Cheap, and every later claim depends on it.
2. The cache fix: stable prefix, append-only window, volatile state at the tail, warm at launch.
3. Measure the 9B again. It should get faster with no model change — the control.
4. Only then the 27B: fork, thinking on, sampling preset, budget, streamed trace.
5. The 2B card step last, since it only matters once turns are long enough to notice.

Step 3 is the one that keeps this honest. If the cache fix does not visibly move
the 9B, the premise behind step 4 is wrong and the 27B will not rescue it.

---

## 18. The Gemini question

**Research, 24 Oct. Supersedes §16 and §17 if the pipeline below is chosen.**
§16 planned a 27B local model; §17 specified the cache fix that would make it
usable. Both assumed local was the only option. It is not.

### 18.1 The quotas, correctly assigned

An earlier draft of this section swapped two rows and concluded Live was
unusable. It is not. The free-tier figures, read from the dashboard:

| Model | RPD | RPM | TPM | Use |
| --- | --- | --- | --- | --- |
| **Gemini 3.8 Live** | unlimited | unlimited | 65k | voice surface |
| Gemini 3.5 Flash Lite | 500 | 15 | — | text turns |
| Gemini 3.8 Flash | **20** | **3** | — | **not used** |

So Live is genuinely affordable, and **3.8 Flash is the one that is not** — 20
requests a day is a demo allowance, less than a single conversation. It is out.
3.5 Flash Lite at 500 RPD / 15 RPM is the text workhorse instead.

The 65k TPM figure is the only real ceiling on Live, and it is generous for one
person. A minute of conversation costs roughly 1,500 input tokens and 1,500 of
output audio, so ~3,000 tokens/minute against 65k is about 21× headroom. **TPM is
not the binding constraint; the 15-minute session cap in §18.2 is.**

Two caveats survive regardless of quota:

- Google's rate-limit page no longer publishes per-model free-tier numbers at all
  — it defers to `aistudio.google.com/rate-limit` — and warns that limits are
  *more restricted for preview models*. The Live API is Preview, so these numbers
  can move under the design without notice.
- 3.5 Flash Lite is reported as **highly unstable**, which §18.5 treats as a
  feature requirement rather than a nuisance.

### 18.2 What the Live API actually provides

Verified from the capabilities guide, and worth recording separately from the
quota, because these constraints outlive whichever model fills the slot:

- **AUDIO-only response modality on native audio models.** You can *send* audio or
  text (`send_realtime_input`, or `send_client_content` with explicit roles), and
  you receive audio. The text you receive alongside it comes from
  `output_audio_transcription` — an ASR transcript *of the audio*, not the model's
  own token stream. "If you need the model response as text, use the output audio
  transcription feature."

  This is the one thing to test before building on it: the limitation is stated
  for *native audio* models, which implies a non-native-audio Live model may accept
  `responseModalities: ["TEXT"]`. If 3.8 Live does, then Live-as-text returns real
  tokens and the transcript problem evaporates. If it does not, every character of
  text in Soren is a re-hearing of speech.
- **Audio degrades tool calling.** The Live API reference states plainly that
  "audio inputs and audio outputs negatively impact the model's ability to use
  function calling." The architecture chosen in §18.8 depends on Live calling
  tools reliably, and that is the documented weak spot. Test it first, not last.
- **Asynchronous function calling is native and is the default** (`NON_BLOCKING`),
  with function scheduling `SILENT` / `WHEN_IDLE` / `INTERRUPTED`. The
  "half-duplex to full-duplex" conversion is a config flag plus a tool whose
  implementation is a job queue. It does not need to be invented.
- **Audio-only sessions cap at 15 minutes** (2 minutes with video), extendable via
  session resumption and context compression. Native-audio context is 128k.
- **Client-to-server needs ephemeral tokens.** A Tauri app using the person's own
  key is client-to-server, so this is real if Soren ever ships a hosted key — and
  moot if the key never leaves the machine.

### 18.3 The two architectures

**A. Native Live.** One WebSocket session, audio in, audio out, tools called
asynchronously mid-stream. Best voice quality and true barge-in, and on unlimited
RPD/RPM the quota is not the objection. It returns **no text** — only audio plus a
transcript — needs a session-oriented rewrite of a turn loop built around
request/response, and produces no cards, because cards are a text artefact.

**B. The pipeline.** Stream speech in through **3.5 Transcribe Live** (2.6% WER
across 85+ languages, free tier exists, ~$0.009/min paid), run the ordinary turn
through **3.5 Flash Lite** with the existing tools, speak the reply with TTS. The
transcript is the user message and the reply text is the model's own words.

Both are now affordable, so this is a genuine choice rather than a forced one.
B is the better fit for Soren, for a reason that is structural rather than
aesthetic: the whole turn loop — `converse`, the `Ask` closure, tool staging,
`MAX_STEPS`, validation, repair, the trace recorder, `TurnRegistry` cancel — is a
request/response machine. A requires replacing it. B requires only a new provider
profile and two new edges: audio in, audio out. Everything already built keeps
working, including question cards, because the model is still a text model.

B also gives what A cannot: **text and audio from one turn.** A's AUDIO-only rule
is the exact opposite of what was asked for, and the person asked for text-to-voice
to keep working.

What B gives up: native prosody, true mid-word barge-in (client VAD must cut
playback), and the async function-calling affordances — B's tools are ordinary
blocking calls unless a job queue is added on top. Three hops also cost latency
that A does not pay.

The honest case for A is narrower than it looks but not empty: if voice
conversation is the product and text is the fallback, A is simply better at the
thing it does, and the missing text is recoverable from `output_audio_transcription`.

### 18.4 The constraint that is left is time, not quota

With unlimited RPD/RPM and 21× TPM headroom, the only hard edge on Live is the
**15-minute audio-only session cap**. Everything else is negotiable.

That cap is a protocol limit, not a billing one, and it is survivable: session
resumption restores a session under a new connection with its context preserved,
and context-window compression keeps a long conversation inside 128k. But it means
the client must own a *session lifecycle* — detect the cap approaching, resume,
and stitch — rather than opening one connection per conversation.

For Soren that lifecycle is the real work in architecture A, and it is unglamorous:
a resumed session is a visible seam if it lands mid-sentence. Reconnect during a
gap, never during speech, and Stream the resume silently.

### 18.5 The instability is the real engineering

3.5 Flash Lite is reported as highly unstable on the free tier, and the existing
traces already show this shape from other providers — Gemini 400s on
`thought_signature`, NVIDIA 500s, a 120 s timeout. A free-tier lite model will
return 429 and 503 routinely, and a turn that surfaces those to the person is worse
than a slow turn.

The retry layer is therefore part of the feature, not polish:

- Exponential backoff with jitter on 429/500/502/503, capped retries, per request.
- Retries must be invisible: no error card, no aborted draft in the editor, no
  duplicate staged item. The existing `body_variants` mechanism already retries
  with a *different request shape*, which is a different axis — both are needed.
- Idempotency matters because a tool call may have already staged a change when
  the retry fires. `converse` stages into local state, so a retried request that
  re-calls `add_item` must not double-stage. The duplicate check exists; it must
  be proven under retry.
- 15 RPM on Flash Lite is low enough to hit during a fast, tool-heavy turn — a
  turn with reply, repair and card is already three requests. The retry layer and
  the rate limit interact, and a retry storm is a self-inflicted 429.
- A final failure after the cap should degrade to a sentence, not an error, which
  is what §2.1 already established for the proposal path.

### 18.6 What survives

- §17's trace token counts: still needed, more so — three hops means latency
  attribution is harder, and free-tier quota makes wasted tokens expensive.
- §17's cache fix: **only if** the text surface stays local. Under B, 3.5 Flash
  Lite caches server-side and the local prefill problem disappears.
- §16/§17's 27B work: shelved. The 9B remains as the local card/classification
  engine and the offline fallback.
- §13's local measurement work: unchanged and still the right baseline.

### 18.7 Open

- Free-tier limits for TTS — the one quota not yet read, and the pipeline needs it.
- Does 3.5 Flash Lite actually beat the 9B at tool calling? The original complaint
  was shallow reasoning, and a *lite* model is arguably the weakest possible answer
  to it. This is §16.6's bake-off with a different opponent, and it may still lose.
- Flash Lite at 15 RPM against a turn that costs three requests: does a normal
  conversation fit inside the limit, or does the card step need the 2B instead?
- Voice quality of a pipelined TTS reply versus native Live audio, judged by ear
  rather than by benchmark.
- Whether A and B can share one tool layer. If they can, voice mode becomes a
  surface choice rather than a second product, and that decides the whole shape.

### 18.8 The architecture, as chosen

**Gemini 3.8 Live is the orchestrator, and Soren executes the tools.**

- **Voice in and out** through one Live session: audio sent as 16kHz PCM, audio
  received at 24kHz, VAD and barge-in native.
- **Text in** via `send_realtime_input(text=…)` or `send_client_content`. **Text
  out** via `output_audio_transcription`, subject to the modality test in §18.2.
- **Background agents** through asynchronous function calling. The model emits a
  function call; **Soren runs it** — dispatching to 3.5 Flash Lite over HTTP or to
  the local 9B over localhost — and returns the function response out of band.
  `behavior: NON_BLOCKING` is the default, and function scheduling
  (`SILENT`/`WHEN_IDLE`/`INTERRUPTED`) decides whether the model speaks the result
  immediately, waits for a pause, or lets the person interrupt it.

The precision that matters: the Live model does not *spin up* an agent. It asks for
one, and the job queue lives in Rust. That is where retries, timeouts, concurrency
limits and the 15 RPM ceiling on Flash Lite are enforced — not in Google's
infrastructure. It also means a background job survives a Live session ending,
which is the only way a long agent is useful at all.

**This makes the 9B's role genuinely better, not smaller.** It stops being the
conversational model — the thing that was too shallow — and becomes a bounded
worker answering specific questions: convert this sentence into card options,
classify this turn, extract this datum. Shallow reasoning stops being a defect when
the task has no reasoning in it. The complaint was never that the 9B could not
classify; it was that it could not think.

The same logic softens Flash Lite's instability. A background job that retries
three times costs nobody anything, because no one is waiting on it mid-sentence.

**What this kills:** §16's 27B and §17's cache fix. Both existed to make a local
conversational model good enough. There is no local conversational model in this
architecture. If the local text surface ever returns, §17 is still correct and
still unbuilt.

**What it adds, and this is the real cost:** a session lifecycle (15-minute cap,
resumption, reconnect-in-gaps), ephemeral tokens for client-to-server auth, audio
capture and playback in a Tauri webview, client-side VAD for barge-in, and a job
queue with out-of-band function responses. That is a larger surface than everything
§16 and §17 proposed, and it is mostly plumbing rather than intelligence.

### 18.9 The two tests, answered — 24 Oct

Run against `models/gemini-3.8-live` with the free-tier key. Scripts live in
`spikes/`, with `spikes/README.md` mapping each verdict to a consequence.

**Test 1 — TEXT modality: refused.**

```
The requested combination of response modalities (TEXT) is not supported
by the model. models/gemini_api_beyond_live_rev25_
```

So there is no escape hatch. Every character of text Soren shows from a Live
session is an ASR re-hearing of speech. Measured on "Name one fruit": 35,520
bytes of audio, no native text, transcript `'Apple.'` — accurate, and still a
transcript.

**Test 2 — tool calling under audio: works, on both paths.**

| | audio in | text in (control) |
| --- | --- | --- |
| tool calls | 2, correct arguments | 2, correct arguments |
| time to first call | 8.2 s (7.1 s of speech) | 0.7 s |
| audio after the response | 142,082 B | 168,000 B |
| spoken reply | "I have recorded the shipping goal and the hiring constraint." | "I have recorded the shipping date and the hiring restriction in the brief." |

The spoken path produced `{"type":"goal","text":"Shipping by March."}` and
`{"type":"constraint","text":"Cannot hire anyone before March."}` from audio alone.
That is the hard part of the architecture, and it works.

A baseline turn with the tools declared but nothing to call them with returned
59,520 bytes of audio ("Hello to you."), which rules out the other explanation for
an earlier empty result: holding tools does not suppress speech.

**Three findings that matter more than pass/fail.**

1. **`turnComplete` does not mean idle.** The sequence after a tool call is
   `toolCall` → `generationComplete` → `turnComplete` → *new turn* → audio. The
   first spike broke on that first `turnComplete` and reported zero audio, which
   looked exactly like a model that cannot speak while holding a tool. It was a
   harness bug. The capabilities guide says the same thing for async reasoning:
   use `interaction_status` (`IN_PROGRESS` vs `IDLE`), not `turnComplete`. Any
   client that treats `turnComplete` as "done" will silently lose the answer to
   every background agent.
2. **The model emits two tool calls in one turn.** Both trials recorded a goal and
   a constraint in a single turn. Soren's contract is one change per turn (§1), so
   the tool layer must reject the second rather than trusting the model to respect
   it. This is the same class of failure as §13.3's duplicate-row case.
3. **The reply lands ~3–4 s after the tool response.** With the mic open, the model
   will hear its own voice. Echo cancellation is not optional in the real client.

**What this settles:** §18.8 stands. Live can orchestrate, dispatch background
agents, and speak their results. §18.3's pipeline is not needed as a fallback for
tool calling — only, possibly, for text fidelity.

---

## 17. Cards that a 2B can write — measured 27 Oct

The interactive cards were small widgets (a 3-chip Choice, a Slider) that cost the person a context switch and gave less than the composer. They are now rarer and larger, and the local model is asked to write as little as possible. **Bonsai writes a label; code does the work; a cloud session writes the words.**

### 17.1 What the local writer can do

Final prompts and grammars, 2B `Q2_0` on a `llama-server` started exactly as the app starts it (`-c 2048 -np 1`), four topics, four samples each:

| Card | What the 2B writes | Pass |
| --- | --- | --- |
| Rank | one question | 16/16 |
| Quadrant | a question and two axis names | 16/16 |
| Weighing | a title | 16/16 |
| Comparison | a title | 16/16 |
| Draft | a kind and a few words | 15/16 |
| Steps | a short list | 15/16 |

Without a grammar the same prompts passed 51/96 raw and 81/96 after repair, and each card cost 200–700 tokens (3–8 s) because the 2B ran on, or leaked `</think>` (the app starts `llama-server` without `--jinja`). With a grammar a card is 60–90 tokens, about 0.6–1.0 s. A grammar plus the repair step is the shipped path (`ui.rs`: `grammar`, `repair_source`).

The old `Compare(title, columns, rows)` was the one card the 2B could not write (4/16): the cell counts were wrong and the content was empty of meaning. It is now `Comparison(title)` with its cells supplied by the cloud session. The old `Compare`, `Choice` and `Slider` still render, so saved sessions are unchanged.

### 17.2 Where the content comes from

`src-tauri/src/content.rs` asks the configured model, with the conversation, for the checked JSON a card needs (a comparison's cells, the items to rank, a weighing's criteria and first-guess ratings, a draft's text). Brief options are used as they are. What comes back is validated and refused rather than repaired; a card with no content is simply not shown. The program carries it as a `data = "..."` statement. `src/weighing.ts` does the arithmetic (scores, ranking, and the weight at which another option would win), so the model never computes anything.

Run live (`cargo test --offline live_cards -- --ignored --nocapture`, local 2B plus the saved Gemini config), every kind completed: the 2B wrote the program in 0.3–0.6 s and the cloud model supplied the content in 1–6 s on `gemini-3.5-flash-lite`. On the configured `gemini-3.8-live` the same content took 44–53 s per card (compare 3.8 s), so card content goes to the background cloud agent model and counts against its caps; with the agent off it uses the configured model. Live testing also found and fixed: a model listing a header for the criterion column (every comparison row looked short), a draft reply keyed by kind instead of `text`, the 2B copying the example's wording ("for the trip"), the 2B adding stray `TextContent` lines around a content card (the grammar now makes such a card exactly its component), and bad content now gets one retry that quotes the problem.

### 17.2a Build cards are retired (27 Oct)

A live session showed the `build` kind producing a quiz-like card (chips, a "Define" button, an empty "Current stack" heading) for the goal "I'd like to make an ai harness", because Laya's zero-shot "build" question cannot tell a goal from a request for a demo. Build cards are retired for now: nothing starts one, neither Laya nor the explicit-phrase rules. Anything that interactive should get its own place, not a card in the thread. The `Build` writer and its cloud path stay in `ui.rs` / `cloud.rs` until it returns in another form.

### 17.3 Not yet verified

- The Tauri window itself was not driven; cards were rendered from the real pipeline's programs in a browser harness. A `tauri dev` was already running and rebuilt with these changes, but nobody has clicked through it.
- The 4B is untested: only the 2B and 9B files are installed.
- Laya zero-shot is the weak link for the new kinds (it scored a weighing request place 0.80, weigh 0.75, and a draft request steps 0.73, draft 0.70). The app now trusts explicit phrases first and builds from Laya only when one kind leads the runner-up by 0.1. Fine-tuning on logged cards is the real fix.
- Footprint (corrected 27 Oct): the 2B server is about 750 MB resident. An earlier note put Laya at about 80 MB; that was `ps` RSS, which omits GPU memory. Measured with `footprint` on the running process Laya is **about 4.2 GB, 3.7 GB of it on the GPU**, because its encoder is ModernBERT-large. Laya, not the 2B, is what breaks a "whole local pipeline under 2 GB" goal, which is why it is being replaced by a small fine-tuned classifier (see §18).

---

## 18. Replacing Laya with a small fine-tuned card classifier — started 27 Oct

**Why.** Laya zero-shot picks the wrong card kind often (§17.3), and its real footprint is about 4.2 GB (ModernBERT-large, 3.7 GB on the GPU), which is what breaks a "whole local pipeline under 2 GB" goal. The plan is one small encoder (about 100 MB, ONNX int8, no PyTorch at runtime) fine-tuned on labelled exchanges.

**Design.** One model with two outputs. *Kind*: none, compare, weigh, rank, place, steps, draft (build stays retired). *Level*: how eager the setting must be before the card shows (1 at any setting, 2 at medium and up, 3 only at high). Eagerness (low turns the classifier off) is a threshold; variety (low = compare, weigh, draft) is a mask over kinds. Both are runtime settings, not separate models. A missed card is the costlier error. Candidate encoders are compared on a dev set, not chosen in advance.

**Data so far.** 200 seed exchanges were written and then curated by the owner in a review page (kept all 200, changed 26 kinds and 24 levels, one text edit). The curated set is `data/cards/curated.jsonl` (kept untracked) with a stratified split: 102 sealed test examples no generator may see, 40 dev, 58 anchors. Next: batched synthetic generation by fresh-context Haiku agents (3,000–5,000 examples), merge and de-duplicate, baselines against zero-shot Laya, train, calibrate, evaluate against the ship gate (stop and report on any miss), then serve through ONNX.

**Label rules as curated** (the generator briefs must use these):
- *none* means no card at any eagerness: greetings, venting, plain facts, a goal that needs a question first.
- *compare*: named options set against each other, including a plain "should I X or Y" with no stated criteria.
- *weigh*: the person's own criteria are on the table, or the reply sets up a personal trade-off ("the last line does a lot of work").
- *rank*: a "what matters most" question over things already named, even when the reply was framed as a weigh.
- *place*: options differing on two stated dimensions. *steps*: a sequence or plan. *draft*: writing the person wants.
- *level 3* is speculative: at high eagerness a card may be built from a clarifying question or generic options; at medium it should not.
- A card the conversation flows into (not explicitly requested) is a good example; a follow-up to a level-1 card is only level 2. The classifier sees only the last exchange, so flow is a known limit.
- Seed text should sound more natural and casual, and Soren's replies should have prose around the cue, not only the cue.

### Follow-up for a future session: Live's own replies

Not part of the classifier work and not yet done. While curating, the owner noted that the steps examples (`s167`–`s176` in the seed) show how the **main agent (Live) should itself reply** when someone asks how to do something: a short plain sequence in prose, which also gives the classifier a clean cue. Related notes from the same review: `s110`, `s114`, `s119` and `s123` were called excellent examples of replies that set up a weighing or ranking naturally; `s118` was called an awful reply because it is all cue and no warmth. A future session should look at Live's system prompt (`src-tauri/src/prompt.rs`) with those examples and consider tuning it toward them, then check the effect on which cards appear.

### 18.1 Round 1 results — 28 Oct (sealed test: 102 examples; 63 want a card at medium)

Trained on 3,213 synthetic examples (354 held out for calibration), 4 epochs, one seed each. Thresholds were set on val + dev (never test) so that missed cards stay under 8% there. `tools/cards/{baselines,train,eval}.py` reproduce every number.

| At medium | Missed card | Wrong card | Wrong, compare = weigh |
| --- | --- | --- | --- |
| Rules | 88.9% | 14.3% (7 shown) | 14.3% |
| Laya zero-shot, balanced | 55.6% | 45.2% | not measured |
| bge-small (33M) | 20.6% | 18.9% | 9.4% |
| MiniLM-L12 (33M) | 22.2% | 20.8% | 11.3% |
| DeBERTa-v3-small | **12.7%** | 18.6% | 6.8% |
| ModernBERT-base (149M) | 17.5% | 19.6% | 7.1% |

All four beat Laya clearly. **The gate is missed on missed-card rate** (target 10%); the wrong-card target (about 20%) is met. One test example is 1.6%, so the encoders are within noise of each other, and five test examples are missed by all four: three "what's the difference / vs" style compare requests and clarifying-question replies the owner labelled level 2. Latency is not measured yet (needs ONNX); torch on CPU runs the 33M models at about 7 ms.

Causes found in the data: the synthetic set has one compare request containing "difference" and three containing "vs" (its "vs" requests are mostly place); owner-labelled "should I X or Y" decisions are split between compare and weigh, so compare/weigh is label noise rather than model error; offers to draft ("Want me to draft that?") are thin in the draft replies. Low-variety masking must drop the masked kinds' probability rather than renormalise it (renormalising forces a comparison onto a ranking request).

### 18.2 Round 2 — 28 Oct

Round 1 missed the missed-card gate. Causes found in the data were fixed with 480 targeted Haiku examples (compare requests worded "difference" / "vs", offers to write, clarifying-question replies that offer a choice), giving 4,041 training examples. Two seeds per encoder. The card threshold is now calibrated on the owner's own labels (dev 40 + anchor 58), not on synthetic validation, which made the models look more confident than they are on human text (`eval.py --cal human`, anchor logits via `predict_extra.py`).

At medium on the sealed test (63 want a card), seed 7 / seed 11:

| Model | Missed card (≤10%) | Wrong card (≈20%) | Wrong, compare = weigh |
| --- | --- | --- | --- |
| **bge-small (33M)** | 6.3% / 9.5% | 21.9% / 16.7% | 9.4% / 5.0% |
| MiniLM-L12 (33M) | 12.7% / 15.9% | 21.7% / 17.5% | 10.0% / 5.3% |
| DeBERTa-v3-small | 7.9% / 7.9% | 16.1% / 19.4% | 4.8% / 8.1% |
| ModernBERT-base | 3.2% / 9.5% | 18.5% / 18.3% | 6.2% / 6.7% |

bge-small, DeBERTa and ModernBERT pass the missed-card and wrong-card gates; MiniLM does not. **Caveats:** the test set has now shaped both the data and the calibration choice, so these numbers are optimistic; a fresh blind set (from the card decision log) is needed to confirm. At high eagerness the human-calibrated thresholds overshoot (wrong cards 20–31%) and need retuning. Low variety (mask) misses 14–28% because its threshold is set for the full kind set. The p95 latency gate needs the ONNX export, not yet done.

**Recommendation:** ship bge-small (33M): smallest, easiest to retrain on new data, passes both medium gates on both seeds. DeBERTa-v3-small is the fallback.

### 18.3 bge-small exported and served — 28 Oct

`tools/cards/export_onnx.py r2-bge-s11 BAAI/bge-small-en-v1.5` writes `models/card-classifier/` (git-ignored): `model.int8.onnx` (34 MB; the fp32 export is 133 MB), `tokenizer.json`, and `config.json` with the temperatures and thresholds calibrated on the owner's labels *for the int8 model itself*. `scripts/card_classifier_server.py` serves it on the same `POST /classify` route and port as Laya, with `onnxruntime` + `tokenizers` only (no PyTorch). It answers `{"scores": {kind: chance}, "card": kind|null, "chance", "none"}`, and accepts optional `person`, `eagerness` and `variety` fields. Seed 11 was picked over seed 7 because its two rates sum slightly lower; the two are within noise.

- **Quantization matters.** Default dynamic int8 agreed with fp32 on only 96.5% of top kinds (logits off by up to 2.7); per-channel weights agree on 98% (off by under 1.0) at the same size. fp32 ONNX matches PyTorch exactly.
- **Gate, end to end through the server, sealed test at medium:** missed 7.9% (target 10%), wrong 16.4% (target about 20%); at high 8.1% / 23.9%.
- **Latency over HTTP (400 requests):** p50 5.3 ms, p95 10.3 ms, p99 13.7 ms (target p95 under 50 ms).
- **Footprint:** 100 MB for the server process (`footprint`), against about 4.2 GB for Laya.
- **Integration:** done in §18.4. **Still open:** high eagerness (wrong cards 24%) and the low-variety mask (wrong 29%) need their thresholds retuned. A fresh blind set is still needed.
- **Behaviour to know:** "i wanna build an AI to-do list app" now gives no card (0.12), which matches the owner's rule that a bare goal needs a question first, but differs from the earlier live-test expectation of a comparison.

### 18.4 Integrated into the app — 28 Oct

- `ui.rs`: `classify_card(person, reply)` posts the person's message with `mode`, `eagerness` and `variety` and takes the server's `card` decision as given; Laya's `pick`, the 0.1 margin and `same_family` are gone (the server's threshold and the model's own family handling replace them). Request rules ("draft a message", "choosing between") still decide first at any eagerness. A server that is down, disabled, or an old one that sends no `card` falls back to the rules as before, filtered by variety. `Watch` and the follow-up loop pass the message each reply answers.
- Settings: new `cardEagerness` (low / medium / high; low turns the classifier off) and `cardVariety` (few / all; few = compare, weigh, draft) in Settings → Cards. `cardEarlyPct` and `cardReplyPct` are removed. `layaEnabled/Url/TimeoutMs` are now `classifierEnabled/Url/TimeoutMs`, and a saved config with the old names still loads (serde aliases).
- Scripts: `scripts/setup-card-classifier.sh` (private `.card-venv`: onnxruntime, tokenizers, numpy) and `dev-with-llama.sh` start the new server; `laya_server.py` and `setup-laya.sh` are deleted. `CARD_CLASSIFIER_LOG=1` prints each decision to the server's terminal. `.gitignore` also ignores `.env` and `.card-venv/` (a missing newline had hidden `.env`).
- Tests: `cargo test` 141 passed (new: decision parsing, low variety, old-key loading); `npm test` 74 passed; `tsc` clean. `cargo test classifier_end_to_end -- --ignored` checks the Rust client against the live server across eagerness, variety and the server-down fallback.

## 19. A local-only card writer — started 28 Oct

**Decision (owner).** The cloud agent is unreliable on a free key: a live compare card failed with `503 UNAVAILABLE` ("high demand") from both the primary and the fallback model, so the person got a promise of a breakdown and no card. Card content should come from a local model, not the cloud. The local writer will be **LFM3-1.7B**, post-trained heavily to write whole cards (labels and content) straight from the exchange. Steps never used the cloud and stay local.

### 19.1 Steps fix (done)

A live steps card ("how do i set up a home server") came out as "Read definitions / Compare features / Choose your path" under a "Notion vs Obsidian comparison" title: the Bonsai 2B was given the last four messages ahead of the new ask and followed the earlier, longer text. `cards::context_for(Kind::Steps, …)` now gives the steps writer only what was just said. The other kinds still get the brief and recent conversation, because they must name the options discussed.

### 19.2 Bake-off harness

`src-tauri/src/bakeoff.rs` (an ignored test) runs the shipped writer prompts, grammars and repair against any `llama-server` over `data/cards/bakeoff/asks.jsonl` (60 held-out asks, 10 per kind, each after a prior turn on an unrelated topic, with hand-written "want" and "avoid" word stems); `tools/cards/bakeoff_score.py` scores the saved cards: well formed, mentions what was asked, does not repeat the prior topic. Options: `BAKE_CONTEXT=production|full`, `BAKE_CONTENT=none|local` (local = the same server also writes the content JSON), `BAKE_KINDS`. These asks must stay out of every generator brief.

Bonsai 2B, labels only: steps **6/10 with the old context, 10/10 with the fix**; overall 54/60 → 58/60. The remaining misses are a compare label that followed the stale topic ("Piano vs Guitar" for a Kindle question) and a weigh label that ignored the ask, which is why the other kinds need the same treatment or a better model. The checks are deliberately low bars (on topic, not stale), not a measure of how good the steps are: they are generic ("Download software / Install server / Configure DNS").

### 19.3 LFM3-1.7B, as researched (Haiku agent, sourced, 28 Oct)

- Released 27 Oct 2026; 1.7B parameters; 24 layers (13 gated short convolutions, 5 sliding-window and 6 global attention); 256K context. The owner's benchmark figures (IFEval 96.66, IFBench 73.03, BFCL v4 71.39, GPQA Diamond 63.37, about 1 GB at 4-bit) all match the vendor model card (vendor-reported).
- **llama.cpp:** added in PR #31252 (merged 27 Oct); the model page says b11960 (0.8.0) or newer. **The installed llama-server is build 11669 (0.7.0) and will not run it**; an upgrade (or a master build) is needed. Official GGUFs: `LiquidAI/LFM3-1.7B-GGUF` (Q4_K_M 1.1 GB, Q8_0 1.85 GB). **GBNF grammar behaviour is untested** by anyone; the bake-off will find out.
- **Licence:** LFM Open License v1.0: commercial use only while annual revenue (of the user's legal entity) is under $10M; redistribution and derivatives allowed with the licence copy and change notices. Compare Bonsai (Apache 2.0). Fine if Soren stays personal or small; to be decided before shipping.
- **Thinking mode is on by default** (the writer already sends `enable_thinking: false`; the card says that switch "can be inconsistent", so output must be checked for `<think>`). Recommended sampling: temperature 0.1, top-k 50, repetition penalty 1.1. Vendor: not for complex multi-step reasoning, which the card tasks are not.
- **Fine-tuning:** official routes are TRL, Unsloth and Liquid Finetune (LoRA via peft); **no mlx-lm support found**. Memory for a LoRA run on a 16 GB Mac is unsourced (estimate 5–8 GB in bf16); to be measured.

### 19.4 Order of work (owner's change)

1. Bake-off: LFM3-1.7B against Bonsai 2B (and 4B once installed) on the same asks and grammars. Needs a newer llama.cpp and the LFM3 GGUF.
2. **Brief items (goal, constraint, decision, option, assumption, question) and workflows expressed in OpenLang before the training data is written**, so the model learns them too. Display is easy; the write path must still pass through the existing validated proposal and workflow-commit code (revisions, cycle checks), with the OpenLang as a format the backend parses into those commits. The 2B was previously poor at deciding what is load-bearing, so Live keeps the judgment for now and the local model is measured on it before it takes it over.
3. Training data for every card kind plus items and workflows: exchange (person message, reply, brief) to finished OpenLang, from fresh-context Haiku agents, checked by the parser and grammar.
4. LoRA post-training of LFM3-1.7B; evaluate on the held-out asks against the cloud and the 2B; then remove the cloud content path.

### 19.5 Status after the first autonomous block — 28 Oct

- **LFM3 is blocked on llama.cpp.** `brew upgrade llama.cpp` found nothing newer: the formula's stable is still 0.7.0 (build 11669), and the downloaded `LFM3-1.7B-Q4_K_M.gguf` (1,099,627,808 bytes, sha256 matches the repository's) fails with `unknown model architecture: 'lfm3'`. Needs b11960 (0.8.0) or a build from master. The file is in the app's models folder, ready.
- **The no-cloud baseline the 2B sets** (labels from the writer, content from the same 2B, 60 held-out asks): steps 10/10, rank 10/10, place 10/10, draft 8/10, **compare 4/10, weigh 2/10** (rows with the wrong number of cells, unusable options). Median 0.9 s a card. LFM3, post-trained or not, has to beat this and the cloud.

### 19.6 Draft: brief items and workflows in OpenLang (for review, nothing built)

**What exists.** Items reach the brief only through three tools (`add_item(type, text, status, reason?, dependsOn?, basis?)`, `edit_item(itemId, …)`, `retract_item(itemId, reason)`) that become proposals the person accepts, edits or rejects; `validation::validate_proposal` checks them against the session and the store keeps revisions. Workflows are a title plus tasks `{id, text, dependsOn[]}`, checked by `validate_workflow_tasks` (limits, unknown ids, `has_cycle`) and committed with optimistic revisions. Both are rendered by React (`ProposalCard`, `Brief`, `Workflows`), not by OpenLang.

**Proposal.** OpenLang becomes the *format* the local model writes, and the backend parses it into the same structs the tools produce, so every existing check, revision and the accept/edit/reject UI stay exactly as they are. Nothing the model writes can bypass validation. Sketch:

```
root = Proposals([p1, p2])
p1 = AddItem("decision", "Charge $5 a month", "established", "their words")
p2 = EditItem("i3", "Budget is about 2000, firm", "established")
```

```
root = Workflow("Launch the newsletter", [a, b, c])
a = Task("Pick a platform")
b = Task("Draft the first issue", [a])
c = Task("Send it to ten friends", [b])
```

- Task ids are the statement names, so dependencies are references; the grammar fixes the shape, `has_cycle` stays the check, and a repair step drops a back edge instead of rejecting the whole workflow.
- `Workflow` also gets a library renderer (reusing `workflowGraph.ts`) so it can appear inline as a card like today's workflow artifact. Item proposals keep `ProposalCard` (they are stateful: accepted, edited, rejected, with revisions), fed by the parsed proposal rather than rendered from the program.
- **Native arguments, not escaped JSON.** The content kinds currently embed their data as a JSON string inside a string (`data = "{\"columns\":…}"`), which a small model must escape correctly and is where the 2B's compare and weigh failures come from. Training targets should use native OpenLang arguments (`Weighing("…", [criteria], [options], [[ratings]])`), with the old string form still accepted for back-compat.

**Judgment is the risk, not format.** Deciding what is load-bearing, `established` against `provisional`, and which id an edit refers to is what the 2B could not do in the early spike. Live keeps that judgment for now; the local model's job in this phase is to emit the format reliably, and to be measured on the judgment before it takes it over (a held-out set of exchanges with owner-curated items, the same review page as the card seed).

**Training data (draft brief, one record per example).** `{context: brief items + last messages, ask or reply, target: finished OpenLang}` for compare, weigh, rank, place, steps, draft, add/edit/retract item and workflow, about 600 to 800 each, written by fresh-context Haiku agents in batches, every target checked by the parser, the per-kind grammar and the Rust validators before it is kept. Cover stale-context traps (a prior turn on another topic), short and typo-ridden asks, and hard negatives (no card or no item). The 60 bake-off asks stay out of every brief. LoRA on the full-precision weights (about 3.5 GB, a separate download) via TRL or Unsloth; the Mac memory figure is still to be measured.

### 19.7 LFM3-1.7B bake-off, untrained — 28 Oct

llama.cpp built from master (0.8.0-dev, commit 39febd2) in a scratch folder; the brew install (0.7.0) is untouched, so the app still cannot load LFM3 until its server launcher can point at a newer binary. LFM3-1.7B Q4_K_M, vendor sampling (temperature 0.1, top-k 50, repeat penalty 1.1), `enable_thinking: false`, same prompts, grammars and 60 held-out asks as the Bonsai 2B (Q2_0). Scorer now flags unresolved references rather than unused statements (the renderer ignores unused ones).

| 60 asks | steps | compare | rank | place | weigh | draft | all | median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bonsai 2B, labels only | 10 | 9 | 10 | 10 | 9 | 10 | **58** | 0.4 s |
| LFM3, labels only | 10 | 10 | 9 | 10 | 8 | 9 | **56** | 0.5 s |
| Bonsai 2B writes the whole card | 10 | 4 | 10 | 10 | 2 | 8 | **44** | 0.9 s |
| LFM3 writes the whole card | 10 | 5 | 8 | 7 | 3 | 9 | **42** | 1.1 s |

- **Untrained, LFM3 is no better than the 2B**, as expected for a general model: the same failures (compare tables with the wrong number of cells, weigh ratings of the wrong shape, a card that follows the previous topic: "notion" in a weighing, "laptop" in a ranking), and its own habits (extra statements, an undefined reference such as `Stack([login1])`, invented details such as an eligibility question about citizenship). This is the baseline post-training must move.
- **What works:** GBNF grammar-constrained generation is respected (every output is syntactically valid OpenLang, closing the one open question from the research); no `<think>` text leaks with thinking switched off; 112 tokens a second generating, 1,085 tokens a second reading the prompt; **642 MB** process footprint at a 2K context (the 1.1 GB file is memory-mapped), against about 0.43 GB for the 2B.
- **Caveat:** Q4_K_M against the 2B's 2-bit file and one set of sampling settings; the full-precision weights may behave differently, but the point of the plan is to train it, not to rank it untrained.

### 19.8 Can Bonsai 2 be post-trained? (Haiku research, sourced, 28 Oct)

- **No.** PrismML publishes no trainable weights, no quantization-aware-training checkpoint and no training or re-quantization code for Bonsai 2 (2B/4B): only packed GGUF (`PQ2_0` 2.2 bits, `PTQ1_0` 1.8 bits, `Q2_0` 2.3 bits) and MLX 2-bit repos. Whether the ternary step is post-training or quantization-aware is not stated. Fine-tuning the Qwen3.5 base and ternarizing it again would need a third-party pipeline (the PyPI package `ternary-qat` claims one, unverified) and would not necessarily match the released formats; a LoRA on the released GGUF is unverified for these types. PrismML offers post-training only as a paid service.
- **Other facts:** both are vision-language models with a separate vision tower (ignored by us); base Qwen3.5-2B/4B; Apache 2.0; the `Q2_0` file we run (0.55 GB; 0.43 GB is the fork-only `PTQ1_0`) needs upstream llama.cpp b11555 or newer; vendor benchmarks match the owner's summary exactly (2B IFEval 85.77, IFBench 48.00, BFCL v3 60.53, GPQA Diamond 39.6; 4B 88.91, 56.33, 70.16, 63.84), but an independent run of the 2B scored 67.8 on an IFEval metric, so the numbers depend on the harness. Non-thinking sampling recommended: temperature 0.7, top-p 0.8, top-k 20, presence penalty 1.5.
- **Consequence:** post-train LFM3-1.7B, which has an official, standard route (LoRA, merge, GGUF). Keep the Bonsai 2B as the working local writer until LFM3 is trained and beats it, and as the fallback.

### 19.9 Pilot LoRA: stopped at a surprise — 28 Oct

The full-precision LFM3-1.7B weights are downloaded and verified (`models/lfm3-1.7b/`, git-ignored; `model.safetensors` 3,457,635,448 bytes, sha256 matches the repository's; licence, config, tokenizer and chat template alongside; **no Python files fetched**). The pilot has not run: `config.json` points to custom model code (`auto_map` to `configuration_lfm3.py`, `modeling_lfm3.py`, with `lfm3_conv.py`; 57 KB in the repository), and neither the installed transformers 5.9.0 nor a fresh 5.21.0 (installed in an isolated venv outside the project) knows `lfm3` natively. Loading it today means `trust_remote_code=True`, i.e. running Liquid's Python files. Options: (a) audit the three files, then fetch and run them; (b) wait for a transformers release with native `lfm3`; (c) a training stack that bundles its own model code (Liquid Finetune, Unsloth), which would need the same trust decision.

### 19.10 Pilot LoRA: audit clean, first run blew the memory — 28 Oct

- **Audit (clean).** The three model files (`configuration_lfm3.py` 6,113 B, `lfm3_conv.py` 8,532 B, `modeling_lfm3.py` 42,359 B; repository revision `40ebe0aa6662c9d40389c2f5d565b6a2c6aebacd`; sha256 prefixes 176cced3…, 80d4a985…, e8cd5254…) import only torch, transformers, the hub config validator and an optional triton; no `os`, `sys`, `subprocess`, sockets, HTTP, `open`, `eval`/`exec`, pickle or dynamic imports; the only top-level logic is class and function definitions and an `if is_triton_available()` kernel block. Three transformers "hub kernel" decorators can fetch kernels only when the `kernels` package is installed and `use_kernels=True` is passed (neither is true); runs set `HF_HUB_OFFLINE=1` and `USE_HUB_KERNELS=0` anyway. The model builds offline with 1.7288B parameters. LoRA targets found: attention `q_proj k_proj v_proj o_proj`, conv `in_proj out_proj`, MLP `w1 w2 w3`.
- **First run (attention-only LoRA, rank 16, batch 4, 512 tokens, bf16 on MPS, gradient checkpointing off) did not finish 8 steps in 10 minutes:** the process reached 16 GB resident and the machine's swap went from 7.8 GB to 15.7 GB of 16 GB, so it was killed. Cause not yet known (nothing printed, so not even whether the weights loaded). `tools/cards/lora_pilot.py` runs one configuration per process and prints memory and speed; it needs staged diagnosis (load only, then one forward at batch 1, then backward) with a memory watchdog before any more full runs.

### 19.11 Pilot LoRA: why it blew the memory, and what it costs — 28 Oct

Staged runs (`tools/cards/lora_diag.py`, offline, audited model files, bf16 on MPS, LoRA rank 16). The first run was not a bug: it was ordinary activation memory with gradient checkpointing off and 2,048 tokens per step.

| Setup | Tokens per step | GPU memory | Speed |
| --- | --- | --- | --- |
| Weights only, on the GPU | 0 | 4.3 GB | |
| Attention LoRA, no checkpointing | 128 / 512 / 2,048 | 6.2 / 8.2 / **19.8 GB** | 80 / 220 / swapped (81 s backward) |
| All-linear LoRA, checkpointing, batch 2 x 512 | 1,024 | **7.8 GB** | about 210 tokens/s |
| All-linear LoRA, checkpointing, batch 4 x 512 | 2,048 | 12.6 GB | 100–140 tokens/s (the machine was already holding 6 GB of swap) |

- **Verdict:** LFM3 trains on this Mac in 7.8 GB with checkpointing and 1,024 tokens per step. No alternative model is needed. Trainable parameters are small (attention plus conv plus MLP LoRA); the weights are 3.5 GB in bf16.
- **Cost:** about 200 tokens a second. A 6,000-example set at about 350 tokens each is 2.1M tokens, so about 2.8 hours an epoch (about 8 hours for three). 1,000 examples is about 30 minutes an epoch.
- **Levers not yet tried:** drop the long writer system prompt from the training text (the model learns the format); compute the loss only at target positions so the 128K-word output layer runs on a fraction of the tokens; a smaller rank.
- **Alternative if the full run is too slow:** a rented GPU for the single final run (minutes rather than hours); the plan's constraint is on the local pipeline at inference, not on where training happens. Needs an account and a decision, so it has not been touched.

### 19.12 Faster routes than hours of LoRA (Haiku research, sourced, 28 Oct)

Constraints: free only, no cloud GPUs, 16 GB Mac. Ranking from the research, then the decision it supports:

1. **Program of slots plus grammar, no training.** Deterministic code assembles the OpenLang program; the model returns only short strings or a small JSON object under a llama.cpp grammar. Structure is already 56–58 of 60 untrained; the whole-card score (42–44) is lost on content shape and content quality.
2. **Slot-only LoRA on LFM3-1.7B** (rank 8, all linear layers): targets of 30–80 tokens instead of 150–400, so about 25 minutes an epoch at 1,000 examples at the measured 200 tokens a second (estimate, not a benchmark).
3. **Nearest-example few-shot** (retrieve 3–5 gold examples per request) on top of 1; evidence is for large models only.
4. Smaller bases (LFM2-350M/700M, Qwen3-0.6B, Gemma 3 270M): IFEval on their cards is 65/72/52/51 against 96.7 for LFM3-1.7B, and there is no LFM3 under 1.7B. Not recommended.
5. MLX port: no `lfm3` in the mlx-lm model list and no credible MLX-versus-MPS LoRA speed figure found; blocked.

Free GPU tiers exist (Kaggle about 30 GPU-hours a week and Colab's unpublished dynamic limits, both from secondary sources) but were ruled out by the owner.

**Decision.** Try 1 first. The compare and weigh failures in the bake-off are shape errors (a row with the wrong number of cells, ratings of the wrong length, "options not usable"), which a per-request grammar can make impossible: once the columns are known the rows are generated with exactly that many cells; the ratings matrix is generated with options by criteria entries. What remains after that is content quality, measured with the same 60 asks, before any training.

### 19.13 Slot lab: cards built from the reply by code, no training — 28 Oct

`tools/cards/slotlab.py` (a Python prototype for the Rust port). Code assembles the OpenLang program in the forms the app already renders; the model returns one small JSON object whose exact shape a per-request grammar enforces (a comparison's rows have exactly one cell per column, a ranking 3 to 5 items, and so on); a grounding check drops a card when its content strings are not supported by the source text. Compare is two calls (first the things the person named, from the ask alone, then rows with the things as literal keys, so the table cannot be turned on its side). Rank, place and weigh take their items from the person's own message; steps and the cells of a table come from the reply; ratings in a weighing start neutral (3) for the person to set. Sources: `ask` (the model must know the facts), `natural` (a normal reply), `primed` (a reply that states its substance plainly). 60 held-out asks; the replies were written by a Haiku agent (`data/cards/bakeoff/replies.jsonl`), not by Gemini. A card counts when it is well formed, grounded, on topic, uses options the person named and repeats nothing from an earlier topic.

| Cards good out of 60 | steps | compare | rank | place | weigh | draft | all | median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LFM3, from a primed reply | 10 | 8 | 10 | 10 | 10 | 10 | **58** | 0.7 s |
| LFM3, from a natural reply | 10 | 6 | 10 | 10 | 10 | 10 | **56** | 0.7 s |
| LFM3, from the ask only | 0 | 0 | 10 | 10 | 10 | 10 | **40** | 0.6 s |
| Bonsai 2B, primed reply | 10 | 5 | 10 | 10 | 6 | 10 | **51** | 0.5 s |
| Bonsai 2B, natural reply | 10 | 4 | 10 | 10 | 7 | 10 | **51** | 0.5 s |
| Bonsai 2B, from the ask only | 0 | 0 | 10 | 10 | 7 | 10 | **37** | 0.5 s |

- **The reply is what makes steps and tables possible:** from the ask alone, steps and compare are 0 of 10 for both models (every card is dropped by the grounding check; nothing invented is shown). From a reply they are 10 of 10 and 6 to 8 of 10 (LFM3).
- **Failures drop the card, they do not show a wrong one:** the remaining compare failures are cells the reply never states ("not mentioned"), which the check removes.
- **Earlier numbers this replaces:** the same asks scored 42 to 44 of 60 when the model wrote the whole card, and a first pass of this lab scored 0 of 10 on compare before the table orientation and the source of the options were fixed.
- **LFM3 beats the 2B by 5 to 7 cards of 60** on reply-based sources, mainly on compare and weigh, and by eye its cells are right where the 2B's are often vacuous ("more", "less"). Both work with no training.
- **Limits:** the replies are not Gemini's; the check measures support by the source, topic and option names, not full semantic correctness; draft text quality is ungraded; ratings are neutral by design; compare is two model calls (about 1.8 s).

### 19.14 Bonsai 2 4B in the slot lab — 28 Oct

`Ternary-Bonsai-2-4B-Q2_0.gguf` (1,212,103,520 bytes, sha256 matches the repository's `SHA256SUMS`), same prompts, grammars and 60 asks, installed llama.cpp 0.7.0.

| Cards good of 60 | steps | compare | rank | place | weigh | draft | all | median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bonsai 2 4B, primed reply | 10 | 3 | 10 | 10 | 8 | 10 | **51** | 1.2 s |
| Bonsai 2 4B, natural reply | 10 | 3 | 10 | 10 | 7 | 10 | **50** | 1.0 s |
| Bonsai 2 2B, primed / natural | 10 | 5 / 4 | 10 | 10 | 6 / 7 | 10 | **51 / 51** | 0.5 s |
| LFM3-1.7B, primed / natural | 10 | 8 / 6 | 10 | 10 | 10 | 10 | **58 / 56** | 0.7 s |

- **The 4B is no better than the 2B here** (51 against 51, compare is lower) and about twice as slow; LFM3 stays 5 to 8 cards ahead. With a grammar fixing the shape and the source text supplying the facts, extra parameters in the Bonsai line buy nothing on this task.
- **Memory (fresh server, `-c 4096`, three short requests):** 2B 296 MB footprint (875 MB resident), 4B 567 MB (1.8 GB resident), LFM3 about 640 MB. All three are under 1 GB of private memory. **Observation, not yet investigated:** the 4B's footprint grew to 9.2 GB after the 180 grammar-constrained requests of the lab; the 2B and LFM3 did not show that after comparable runs. Worth a check before relying on the 4B.

### 19.15 The slot writer in the app (Rust), Bonsai 2B by default — 29 Oct

`src-tauri/src/slots.rs` is the Python lab ported: per-kind grammars, a two-request comparison, code that assembles the OpenLang, and the grounding check. `ui.rs` builds every card through it; `content.rs` (the cloud JSON request) is deleted, so **no card path calls the cloud**. The OpenLang forms are unchanged, so the renderer needed no change (all 138 programs of the last run parse in the real library: `src/openui/slotcards.test.ts`).

- **Flow.** A ranking, map, weighing or draft is built at once from the person's message. Steps and tables are *waiting* cards: the classifier still decides from the message (or the streaming reply), Live is told to state the substance in plain sentences (`pending_note`), and the card is written from the whole reply once it exists, including the elaboration. A card the check cannot support is not shown.
- **Model-agnostic.** Settings → Card writer: *Writer model* (a fragment of the weights file name: `Bonsai-2-2B` default, `Bonsai-2-4B`, `LFM3-1.7B`) and *llama-server to use* (empty = PATH; LFM3 needs build 11960 or newer). The launcher starts it with `-c 4096`; a name containing `lfm` gets LFM3's sampling. Verified by starting both through the app's own launcher (`cargo test cards_end_to_end -- --ignored`, with `SOREN_LLAMA_NEW`).
- **Rust against the Python prototype** (Bonsai 2B, same 60 asks and Haiku-written replies, `cargo test bakeoff`, scored by `slotlab.py score`): natural reply 51, primed reply 54, ask only 37 (Python: 51, 51, 37). Median 0.4–0.5 s a card.
- **Changes from the prototype, found by reading cards rather than counting them:** a weighing may have **2 to 5** criteria (a person who names two had a third invented; weigh 6–7 → 10 of 10); a draft is refused when it only repeats the request or its label is the prompt's own words (the 2B did both), and `[bracketed placeholders]` are removed; the draft prompt has an example.
- **Not fixed, by choice:** the check also grounds a comparison's row labels, which costs about four good tables of ten per mode (the cells are supported but the label is the model's own word). Relaxing it would show some rows whose label does not fit their cells (a "Cost" row with cells about flexibility), so it stays strict.
- **What reading the cards says about the model choice:** the 2B's draft prose is weak (a landlord message that asks the landlord whether the heating is broken; the same ask on LFM3 was a clear, usable message), and its tables are vaguer. Counting good cards did not measure draft quality. Switching to LFM3 is a setting once llama.cpp is newer.
- **Removed on the way:** the in-loop pending mark during Live's follow-up (it told Live a card was still being built after it had landed), the preload's dependency on a configured local chat model, and the `cardModelSize` setting.
- **Not done:** the app window itself was not driven (no keys here to talk to Live); the headless chain classifier → launcher → writer → card is what ran. A fresh blind set, retuning high eagerness and low variety, and the 4B memory growth remain open.

**19.15 addendum — "could you gimme some choices?" showed no card (29 Oct).** The classifier was right (the message alone: no card; Soren's reply: compare, 0.96) and the card was built, then refused: the message names nothing, so the first step of the comparison copied "Tea" from the prompt's example and the check (correctly) said nobody named it. A ranking from the same exchange was junk for the same reason. Fix: when the options are not in the message, one more try takes them from the reply and checks them against the reply only (the message no longer counts as support). That opened the door to cards that merely copy the reply (a weighing option "hmmm", axis labels that were slices of a sentence, cells ending in "...", a table with the same long cell twice, columns "A" and "B"), so the check now also refuses: a name with no real word or longer than 8 words; an axis with no word or over 5; any slot with "...", "?" or "!"; a long cell that appears twice. Result on this exchange: the 2B and LFM3 both make the ranking, both decline the comparison (the 2B invents a cell, LFM3 cuts a sentence); no junk card passes. Bake-off after the change (2B, Rust): natural 54, primed 56, ask-only 37.

## 20. Invented cards: tools the model wires, code runs — 29 Oct

### 20.1 What the owner decided (first five design questions)

- A card is an answer, a tool and a way to decide, but not "just say something". Functionality first; plain-answer cards come later.
- Cards live in the chat and on a board, so they are saved, editable things.
- You can tweak numbers and edit anything, the formula included. "Let it act" was not picked.
- Both "a few very polished kinds" and "model invents each one" were picked. Fixed templates alone "defeat the point"; the owner worries the local model is not smart enough to invent.
- Look stays Paper (Instrument only if a dark mode is wanted later).
- Radical direction chosen: cards as tiny programs. More research and questions wanted; recommendations in prose.
- Standing: everything local and free; no cloud at runtime.

### 20.2 Probe: can a local model invent a working calculator card? (rough, n = 12 asks x 4 samples)

Setup: the model writes one JSON object, shape enforced by a JSON schema (title, 2 to 6 variables with min/max/step/start and whether the start came from the message or was assumed, 1 to 4 outputs with formulas over the variables and earlier outputs). One worked example in the prompt. A checker (probe in the session scratchpad, not committed) evaluates every formula at the start, at each variable's extremes and at random points, and rejects ids that clash, ranges that are inconsistent, variables that change nothing, and "from the message" numbers that are not in the message. Correctness of the valid ones was graded by reading the formulas, by hand.

| Model | First sample valid | Valid in at least 1 of 4 | All 48 valid | Median per sample | Right by my reading (of 12 asks) |
|---|---|---|---|---|---|
| Bonsai 2B (default) | 2 | 6 | 9 | 2.6 s | about 0 to 1 |
| LFM3 1.7B | 2 | 4 | 4 | 3.6 s | about 0 |
| Bonsai 4B | 4 | 4 | 7 | 7.1 s | about 1 to 2 |
| Bonsai 9B | 8 | 9 | 23 | 14.8 s | 6 (CI sharding, freelancer rate, database size, coffee, 1%-a-day growth, support agents); 3 wrong (battery, Redis, context); 3 invalid |

Reading: the dilemma is real and size dominates. The grammar makes the shape always parse; what fails is the maths (formulas that are well-formed and wrong) and, secondarily, number ranges that code could repair (steps, start outside min/max). Only the 9B writes usable models about half the time, and it needs 2.5 GB on disk and about 15 s a card.

Caveats: 12 asks, one run, one prompt, graded by me; Q2 ternary quantisation may cost the Bonsai models accuracy; no repair or retry beyond best-of-4 was tried; the earlier slot writer (cards filled from a reply, 54 of 60 good on the 2B) is a different and easier task.

### 20.3 Direction (recommended, not yet agreed)

Do not ask a small model to derive the maths. Split invention into what small models can do (name the quantities, give units and ranges, copy numbers from the message, pick among known relationships) and what they cannot (derive a new formula). Then:

1. A library of tested "bricks": about 60 to 100 relationships with units (rate x time, percent change, compound growth, break-even, capacity against demand, size = count x size x time, amortisation, splits with overhead, unit conversion). Authored once at build time; zero cost at run time. The model picks and binds bricks and chains them. The card shape comes out of the chain, so it is not one of six templates.
2. Dimensional analysis as a deterministic critic: every quantity carries a unit and code rejects formulas whose units do not work out. Expected to catch the wrong 9B cards (battery, Redis, context) and most small-model nonsense; cannot catch right units with wrong logic. Untested.
3. Repair instead of reject for ranges and steps; best-of-N with an answer-sanity check.
4. Show the working: values from the message in one colour, assumed values flagged and editable, the formula visible and editable. Wrong becomes fixable, not fatal.
5. Tiers: the small resident model for chat and polished kinds; a bigger local model (9B class) loaded on demand for "build me a tool", streamed so the build is visible, then unloaded. Resident footprint stays small. A 2B drafting for the 9B (speculative decoding) might halve the wait: untested.
6. Ladder for "tiny programs": level 0 formulas (this plan); level 1 rows and columns (schedules, amortisation tables, retry delays); level 2 small scripts in a sandbox with no network and hard limits, shown as editable code, only once measured reliable; "act on the machine" not built (not picked).
7. Distillation (train the 2B on verifier-checked specs) is the real way a 2B gets good at this, but it is the hours-of-training route the owner declined; park it.

The six polished kinds stay as presets and as few-shot examples; later they can be expressed in the same language.

### 20.4 Order of work (no dates)

A. Spec v1, a Rust evaluator with shared test vectors for the TypeScript one, the dimension checker, range repair. Exit: 30 hand-written specs pass.
B. The brick library and retrieval of 3 to 5 relevant bricks per ask (bge-small is already in the app). Exit: the owner reviews the library.
C. The real test: 60 new asks with known answers (so grading is mechanical, not my reading), free-form against bricks, on 2B, 4B and 9B, with the verifier. Ship gate written before the run; stop and report on a miss.
D. Renderer: a Model card in the OpenLang library on the Paper look (inputs, readouts, a chart or table, assumption chips, editable formula bar), behind the classifier's tool decision.
E. Board persistence (cards saved as small JSON), the on-demand builder, streaming.
F. The ladder: rows, then sandboxed scripts.

### 20.5 Open questions for the owner (next round)

How long is a tool card allowed to take (instant against 15 s with a visible build); what the card does when unsure (decline, show with flagged assumptions, or ask one question); which calculations and decisions the owner really makes in a day (to choose the first bricks); whether loading a 3 GB model on demand is acceptable; what a card does once the chat moves on (stays live and editable, snapshot, or both).
