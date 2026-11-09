# Soren — Product Foundation

Status: working foundation, v0.1. The interaction model is a hypothesis under test, not a proven specification.

## The problem

People arrive with ideas that are incomplete, contradictory, or not yet articulable. Chat-based AI rewards fluent output before the user knows what they mean, and leaves no durable record of what was settled. A session can feel productive while the idea itself does not move.

The cost is not just time. It is that the user cannot tell the difference between having thought something through and having read a good-sounding transcript.

## What Soren is

A thinking environment where the idea is a persistent, inspectable object.

Conversation is where exploration happens. The **brief** is what accumulates: a small set of typed items with statuses and provenance. Soren's job is to maintain the brief, derive consequences, and keep every claim traceable to the user's own words.

The product is general-purpose. It is not a software tool, and it does not execute the user's project.

## The core interaction: propose, inspect, dispose

1. The user talks normally, in fragments. No polished prompt is required.
2. Soren maintains a brief of typed items: goal, constraint, decision, option, assumption, question.
3. When something is load-bearing or genuinely ambiguous, Soren proposes **one** specific change to the brief, with a rationale and the consequences of accepting it.
4. The user accepts, edits, rejects, or defers. The brief updates locally; items that depended on the change are flagged for review, not silently rewritten.
5. A rejected proposal keeps its reason and is not proposed again.

Most turns are conversation, not proposals. The interaction is not a quiz, and it is not a mandatory ritual on every message.

### Why this is not chat with panels

In chat, a correction is another message. The wrong interpretation keeps equal visual weight, consequences arrive as optional follow-up text, and rejected ideas recur because nothing records that they were rejected.

Here, the correction changes state. The rejected reading is retained **as rejected, with its reason**. Consequences are attached to the decision they belong to. The invariant is:

> Every item in the brief has a status and a provenance, and nothing becomes established without the user's act.

The difference is not the presence of a sidebar. It is that the idea has state, and Soren is accountable to it.

## Boundaries

Soren is **not**:

- an IDE or coding assistant;
- an autonomous coding agent;
- an agent operating system or execution harness;
- a model router;
- a workflow automation engine;
- a generic chatbot with decorative comparison panels.

Soren may help produce a plan, specification, or brief as an export. It does not run the project or become the environment in which the project is implemented.

## Behavior principles

1. **Stake rarely, specifically.** One pending proposal at a time. A proposal is a committed interpretation that can be wrong, not a survey question.
2. **Consequence before commitment.** Every proposal says what it rules out, requires, or costs.
3. **Local repair.** Correct one item; Soren flags what depends on it and shows what changed. Never rebuild the whole idea to fix one line.
4. **Provenance or silence.** If a claim cannot be traced to the user's words or to explicit reasoning, it is labeled an inference and stays provisional.
5. **No advocacy.** Soren derives and displays costs. It does not argue for a position or manufacture objections.
6. **The brief is in the user's voice.** Accepted inferences are labeled. Any line can be edited directly. The user can change a status without asking Soren.
7. **Uncertainty stays visible.** Established, provisional, open, resolved, rejected, and retracted are distinct states, not tones of voice.

## The current hypothesis

Proposal-based refinement reduces the cost of articulation: correcting a specific, legible interpretation is cheaper than composing your view from scratch. It also makes challenge structural rather than tonal — the challenge is a consequence, not a personality.

This can fail in four ways:

- proposals feel like paperwork;
- interpretations are strawmen or subtly misrepresent the user;
- the brief feels like Soren's notes rather than the user's idea;
- the user cannot tell which consequences actually follow.

The product should be judged by whether it fails in those ways, not by whether it looks novel.

## Open assumptions

- Users will inspect and maintain a brief rather than only talk.
- Soren can generate diagnostic, legible interpretations without strawmanning.
- One proposal at a time is the right pace.
- Local dependency flags are enough; full consequence propagation is not needed for v1.
- The brief remains the user's, even when Soren writes most of its sentences.

## What v1 must prove

In one session, a user with a vague idea can produce a brief they would defend, containing at least:

- one distinction they did not arrive with;
- one rejected alternative with a reason;
- one accepted trade-off;
- one open question they now know matters.

And they can point to where each came from.

A successful first version does not need to solve collaborative thinking. It needs to make this one loop coherent enough to evaluate.
