# The First Experience

A complete session, showing the conversation, the proposals, and the brief. The example is deliberately ordinary: a team lead with a half-formed goal and no specification.

The surface has three parts:

- **Conversation** — the user talks; Soren replies briefly. Most turns contain no proposal.
- **Proposal** — a card inline in the conversation. One at a time. It names the change, the reason, and the consequences.
- **Brief** — the persistent state, on the right. Every line has a type, a status, and a provenance. Rejected options are kept, with reasons.

---

## Session: Reliability without bureaucracy

**Priya:** I want the product to be more reliable, but I don't want to slow everything down with unnecessary rules.

**Soren:** I'll take a first pass: your objection isn't to process, it's to process that depends on a person catching things. You'd accept a rule that runs itself. Is that close?

> **Proposal · add constraint · provisional**
> No manual approval steps. Automatic safeguards are acceptable.
>
> **Why** — "unnecessary rules" reads as human gates, not automation.
> **If accepted** — rules out approval queues; requires automated checks.
>
> `Accept` `Edit` `Reject` `Not now`

Priya accepts. The constraint lands in the brief under **Constraints**, marked provisional, with a "why" that points back to her sentence.

**Priya:** Close. I'd accept automatic checks. But I don't want us shipping half-baked things just because rollback is easy.

**Soren:** That's a second constraint, and it changes the first: rollback can't be the excuse for low quality. I'll keep them separate rather than folding one into the other.

> **Proposal · add constraint · provisional**
> A fast rollback must not become a substitute for pre-ship quality.
>
> **Why** — "just because rollback is easy" names a specific failure mode.
> **If accepted** — rules out "ship it, we can revert" as a policy; requires a quality bar independent of recovery.
>
> `Accept` `Edit` `Reject` `Not now`

Priya accepts, then opens the first constraint and promotes it to **established**. The wording is Soren's; the commitment is hers.

**Priya:** The real fear is a customer hitting something broken on a Friday and us not knowing until Monday.

**Soren:** Then the failure you care about is silent failure, not failure itself. That has a consequence worth seeing: detection matters more than prevention, and review gates don't address it. It also makes monitoring the thing that actually delivers "reliable."

> **Proposal · add goal · provisional**
> Customers should not be the first to discover a failure.
>
> **Why** — the Friday-to-Monday gap is the scenario you described.
> **If accepted** — prioritizes detection and alerting; rules out "add more review" as the main fix; costs monitoring and on-call attention.
>
> `Accept` `Edit` `Reject` `Not now`

Priya accepts. The brief now has a goal and two constraints. The goal is provisional because it is Soren's formulation of her fear, not her words.

**Priya:** I don't want to become an on-call company either.

**Soren:** Fair. Then the constraint isn't "detection at any cost," it's "detection that doesn't require someone watching a dashboard." That's narrower: automatic detection, a human only when something is actually wrong.

> **Proposal · add constraint · provisional**
> Detection must be automatic. Humans respond only to real alerts.
>
> **Why** — "on-call company" limits the kind of detection, not the goal.
> **If accepted** — requires alerting that fires on real failures; rules out dashboard-watching and alert fatigue; costs tuning.
> **Affects** — the goal above. Its "monitoring and on-call" cost is now narrower.
>
> `Accept` `Edit` `Reject` `Not now`

Priya accepts. The goal itself is not rewritten. Its detail shows: *reviewed after this change — the cost narrowed; the goal did not.*

**Priya:** I keep saying "reliable." I think I mean customers trust us, not that we never break.

**Soren:** That's a different goal, and it's worth separating from "reliable" rather than letting one word do both jobs. I'll change the goal text but keep it provisional — you said "I think."

> **Proposal · edit goal · provisional**
> Customers trust us.
>
> **Why** — "I think I mean" is a tentative redefinition, not a decision.
> **If accepted** — makes communication part of reliability; the old wording stays in Changes, not in the brief.
>
> `Accept` `Edit` `Reject` `Not now`

Priya accepts.

**Priya:** Yes. That's it.

**Soren:** Then I'll mark it established. One consequence is now live: if trust is the goal, how you handle a failure matters as much as how often it happens.

> **Proposal · edit goal · established**
> Customers trust us.
>
> **Why** — explicit confirmation.
> **If accepted** — the goal becomes a premise; later proposals are checked against it.
>
> `Accept` `Edit` `Reject` `Not now`

Priya accepts.

**Priya:** So what do we actually do?

**Soren:** The obvious move is a status page and public incident notes. That follows from "trust," but it may not follow from you.

> **Proposal · add option · open**
> Publish a status page and incident notes.
>
> **Why** — if trust is the goal, visible communication is a candidate.
> **If accepted** — would make outages legible; costs the appearance of stability.
>
> `Accept` `Edit` `Reject` `Not now`

**Priya:** No. A status page says outages are a normal thing. That's the opposite of what I want.

**Soren:** That doesn't follow from your goal. It was my inference, and it was wrong. I'll retract it and keep the reason so I don't propose it again.

> **Retraction · accepted**
> "Publish a status page" — withdrawn.
>
> **Your objection** — it signals that outages are normal.
> **What this adds** — reliability work must not make instability visible as a category.
>
> `Record as constraint` `Dismiss`

**Priya:** Yes. Record that.

> **Proposal · add constraint · established**
> Reliability work must not signal that outages are normal.
>
> **Why** — your rejection of the status page. This constrains the form of the work, not just the work.
> **If accepted** — rules out status pages, public incident feeds, and "known issues" pages as trust tools; requires fixes to be quiet.
>
> `Accept` `Edit` `Reject` `Not now`

Priya accepts.

---

## The brief at the end

**Goal**
- Customers trust us. — *established*

**Constraints**
- No manual approval steps. Automatic safeguards are acceptable. — *established*
- A fast rollback must not become a substitute for pre-ship quality. — *established*
- Detection must be automatic. Humans respond only to real alerts. — *provisional*
- Reliability work must not signal that outages are normal. — *established*

**Ruled out**
- Publish a status page and incident notes. — *rejected* — signals that outages are normal.

**Assumptions**
- Automatic alerting can be tuned well enough to avoid alert fatigue. — *unverified*

**Open question**
- How do we build trust without making failure visible as a category? — *open*

**Changes**
- Goal reworded from "Be more reliable" to "Customers trust us" (provisional → established).
- Constraint added after the status-page rejection.
- Goal's on-call cost narrowed after the detection constraint.
- Status page proposed, rejected, and kept as a reason.

---

## What Priya leaves with

She arrived with one sentence containing a goal, a constraint, and a contradiction. She leaves with:

- a goal she chose, not one Soren substituted;
- three constraints that are hers, one still provisional;
- a rejected option with a reason she can defend;
- an open question she now knows is the real one;
- a test for future proposals: does this make instability visible?

The brief is short enough to reread. The transcript is not.

## What the example exposes

The status-page moment is the important one. Soren's inference was logically valid — visible communication is a reasonable response to a trust goal — but socially wrong. The user's rejection was about meaning, not logic.

That is the characteristic failure of this interaction: a consequence can follow and still be the wrong thing to say. The repair is not better logic. It is treating every consequence as a proposal, keeping the rejection as a constraint, and letting the user's objection become part of the idea.

The example also leaves a tension unresolved: "fixes must be quiet" can shade into hiding problems. Soren should surface that tension rather than resolve it on Priya's behalf. Whether quiet recovery is trust or concealment is exactly the kind of question the brief should keep open.
