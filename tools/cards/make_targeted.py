#!/usr/bin/env python3
"""Round-2 prompts: small batches aimed at what round 1 got wrong.

    python3 tools/cards/make_targeted.py OUT_DIR

Uses the same generator brief and anchors as make_prompts.py (anchors only from the anchor
split), with these targets and boundaries instead. Round 1 missed: compare requests phrased as
"difference" or "vs", offers to write something, and clarifying-question replies that offer a
choice. Nothing from the sealed test or dev examples appears here; the scenarios are described
by pattern and every example the agents write is invented.
"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_prompts as mp

ROOT, SYNTH = mp.ROOT, mp.SYNTH

# id -> (n, targets, boundary, neighbours for anchors, kind for anchors)
BATCHES = {
    "t_diff_01": (120, """120 examples in total, centred on compare REQUESTS in the plain "how do these differ" voice.
- About 85 are compare requests (about 65 level 1, 20 level 2). Roughly 90% mode "request", the rest "reply".
- Vary the phrasing a lot. Cover each of these in at least a dozen examples, in different words: "what's the difference between A and B", "A vs B", "A versus B for X", "A or B, what's the diff", "how do A and B differ", "A and B side by side", "what's different about A and B right now", "which is better, A or B", "can you line up A and B". Many are fragments, some have a typo, some carry one short bit of context ("for my app", "for a small team") but never stated criteria.
- Level 2 is for the same phrasing when the options are loose or the need is thin (a vague topic, no clear options yet).
- About 35 are contrast items, each paired with a compare example that shares topic or wording: weigh (the person also states what they care about), none (a single-subject question like "what is X", or small talk), and rank (which of several things first).""",
     mp.BOUNDARY["compare"] + """
- "what's the difference between X and Y" / "X vs Y" with no stated criteria is compare level 1. Add "I care about A and B" and it becomes weigh. "What is X?" about one thing is none.
- "torn between two options" or "can't decide between two things" with no criteria named is weigh level 1 (the person is stuck in a decision); "what's the difference between them" is compare.""",
     ["weigh", "rank"], "compare"),
    "t_diff_02": (120, None, None, ["weigh", "none"], "compare"),
    "t_draft_01": (120, """120 examples in total, centred on draft: the writing the person wants, or Soren's offer to write it.
- About 85 are draft (about 65 level 1, 20 level 2). Roughly 65% mode "reply", 35% "request".
- In replies, Soren often OFFERS to write or has just started: "Want me to draft that?", "I can put together a short note you can edit", "I can write a first version", "Here is a first pass you can change", "Let me pull together a summary of where we are". Make about 45 replies of the offer kind in different words and different sentence positions (offer first, offer after empathy, offer after a question), and about 15 where a first version is already given. Also include requests ("can you word this for me", "need something to say to my landlord", "write up what we have so far").
- Level 2 is when the writing need is real but not stated (venting about a conversation the person must have, where the reply offers to write it).
- About 35 are contrast items sharing the person's text: none (the same venting with a reply that only asks how they feel, or offers a different kind of help that is not writing, like talking it through), and steps (how to do it as a sequence).""",
     mp.BOUNDARY["draft"] + """
- An offer to write the words ("want me to draft it?") is draft. An offer to explain, talk it through or think it over is none.
- A reply that only gives advice about what to say (no offer, no wording) is none or steps, not draft.""",
     ["steps", "none"], "draft"),
    "t_clarify_01": (120, """120 examples in total, all mode "reply": Soren answers with a QUESTION, and the label depends on what kind of question it is.
- About 22 are rank level 2: the question asks which of the things already named should win, go first, stay or go ("Which of these would you actually miss?"). The person's message names or implies several things.
- About 20 are compare level 2: the question offers two framings or options to pick between ("Is it more about days or about how it feels?").
- About 10 are weigh level 2: the question asks how much the person values things against each other in a decision they described.
- About 24 are level 3 (rank or weigh, mostly rank): an open question over a few generic things at the highest setting only ("What matters to you most in this?" over a vague situation).
- About 44 are none: questions that are about the person's feelings, history, or a fact needed first, with no set of options to choose among ("What happened the last time?", "How are you feeling now that it's out?"). Write them in the same warm voice and on similar topics so the classifier must read the question, not the topic.
- Pair them: for many person messages, write one reply whose question offers a choice (card) and one whose question is open and personal (none).""",
     """- clarifying question that offers a choice between named or implied things (rank or compare, level 2) against one that asks about feelings or history (none).
- level 2 against level 3: if the person's message already names several things, the which-first question is level 2; if the situation is vague and the question is generic ("what matters most to you here?"), it is level 3.
- Never put the words "rank", "compare", "weigh" or "trade-off" in Soren's reply.""",
     ["weigh", "compare", "none"], "rank"),
}
BATCHES["t_diff_02"] = (BATCHES["t_diff_01"][0], BATCHES["t_diff_01"][1], BATCHES["t_diff_01"][2], BATCHES["t_diff_02"][3], "compare")


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    rows = [json.loads(l) for l in open(os.path.join(ROOT, "data", "cards", "curated.jsonl"), encoding="utf-8")]
    tpl = open(os.path.join(ROOT, "data", "cards", "generator-brief.md"), encoding="utf-8").read().split("\n---\n", 1)[1].strip()
    listing = []
    for index, (bid, (n, targets, boundary, neighbours, kind)) in enumerate(BATCHES.items()):
        rnd = random.Random(f"{bid}-brief")
        start = (index * 7 + 3) % len(mp.TOPICS)
        topics = "; ".join(mp.TOPICS[(start + i) % len(mp.TOPICS)] for i in range(8))
        tones = list(mp.TONES)
        rnd.shuffle(tones)
        prompt = (tpl.replace("{BATCH_ID}", bid).replace("{N}", str(n))
                  .replace("{OUT_PATH}", os.path.join(SYNTH, bid + ".jsonl"))
                  .replace("{TARGETS}", targets)
                  .replace("{TOPICS}", topics).replace("{TONES}", "; ".join(tones))
                  .replace("{SHAPES}", mp.SHAPES).replace("{BOUNDARY}", boundary)
                  .replace("{ANCHORS}", mp.anchor_text(rows, kind, neighbours, rnd)))
        path = os.path.join(out_dir, bid + ".txt")
        open(path, "w", encoding="utf-8").write(prompt)
        listing.append({"id": bid, "n": n, "prompt": path, "out": os.path.join(SYNTH, bid + ".jsonl")})
    json.dump(listing, open(os.path.join(out_dir, "batches.json"), "w"), indent=1)
    print(len(listing), "batches,", sum(b["n"] for b in listing), "examples")


if __name__ == "__main__":
    main()
