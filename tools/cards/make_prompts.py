#!/usr/bin/env python3
"""Fill the generator brief once per batch, writing one prompt file per batch.

    python3 tools/cards/make_prompts.py OUT_DIR

Anchors come only from the "anchor" split of data/cards/curated.jsonl. The sealed test and
dev examples are never put in a prompt. Each prompt names its own output file under
data/cards/synth/. The batch plan (kinds, sizes, level mixes) is the table below.
"""
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SYNTH = os.path.join(ROOT, "data", "cards", "synth")

# kind -> (number of batches, examples per batch, level mix for the kind, neighbouring kinds)
PLAN = {
    "none":    (10, 120, None,                          ["compare", "rank", "steps", "draft"]),
    "compare": (4, 140, "level 1 about 55%, level 2 about 35%, level 3 about 10%", ["weigh", "rank", "none"]),
    "weigh":   (4, 120, "level 1 about 35%, level 2 about 30%, level 3 about 35%",  ["compare", "rank", "none"]),
    "rank":    (4, 120, "level 1 about 40%, level 2 about 25%, level 3 about 35%",  ["weigh", "compare", "none"]),
    "place":   (2, 120, "level 1 about 65%, level 2 about 35%, no level 3",         ["compare", "rank", "none"]),
    "steps":   (3, 100, "level 1 about 70%, level 2 about 25%, level 3 about 5%",   ["draft", "none", "compare"]),
    "draft":   (3, 100, "level 1 about 80%, level 2 about 20%",                      ["steps", "none"]),
}

TOPICS = [
    "careers and work", "software and product building", "data and machine learning", "personal money",
    "health and fitness", "travel and moving", "learning and school", "writing and publishing",
    "music and performing", "cooking and food", "hobbies and crafts", "small business",
    "side projects", "event planning", "home and renting", "family logistics", "tech purchases",
    "stress and workload", "design and branding", "science and research", "community and volunteering",
    "creative projects", "managing a team", "freelancing and clients",
]
TONES = [
    "terse fragments", "lowercase and chatty", "typos and dropped words", "voice dictation with um and like",
    "formal and careful", "long and rambling", "non-native phrasing", "stressed or emotional",
]
SHAPES = """- Empathy or framing first, then the substance.
- Substance first, with nothing offered or asked at the end.
- A single short sentence.
- Starts from one specific detail the person gave, then builds on it.
- Ends with a question to the person (not an offer to do more).
- Two or three sentences in a plain, slightly dry tone.
- Speaks only to this person's situation instead of giving a generic overview."""

BOUNDARY = {
    "none": """- none against compare: the same person text ("I can't decide between the red one and the blue one") with a Soren reply that only asks a clarifying question (none) and one that describes the options in parallel (compare).
- none against rank: a reply that only asks about the situation (none) against a reply that names several things and asks which matters most (rank).
- none against steps: a plain fact or explanation (none) against a how-to answered as a sequence (steps).
- none against draft: venting about a hard conversation (none) against the same message with a request or offer to write it (draft).""",
    "compare": """- compare against weigh: the same person text with a Soren reply that only describes the options in parallel (compare) and one whose last line asks how much the person values specific things against each other (weigh).
- compare against rank: options described in parallel (compare) against a reply that asks which of the named things matters most (rank).
- compare against none: a reply that only asks a clarifying question about the options, with no parallel description (none).""",
    "weigh": """- weigh against compare: a plain "should I X or Y" with no criteria stated is compare, even when the person adds "idk" or "no idea" (write those as compare level 1). A weigh REQUEST must name something the person cares about or is worried about ("I care about the team not burning out but we need output by June"); a weigh REPLY ends by asking how much they value those things against each other.
- weigh level 3 is only for a reply that asks a clarifying question over a few generic options in a decision (what is pulling you, what are you afraid of), or a request with no options at all and a clear wish to weigh something. It is never a bare "X or Y?" request.
- weigh against rank: when the closing question is which of the named things matters MOST, it is rank, not weigh.
- weigh against none: a clarifying question only (none). At level 3, a clarifying question that could be turned into a card of generic options at the highest setting is weigh.""",
    "rank": """- rank against weigh: "which matters most / which first" over named things is rank; a reply that sets up how much the person values things against each other in a decision is weigh.
- rank against compare: named options described in parallel is compare; the same options followed by "which comes first" or "which matters most" is rank.
- rank against none: a reply that only asks about the situation is none. At level 3, a clarifying question over a few generic options could be a ranking at the highest setting.""",
    "place": """- place against compare: options described only in parallel is compare; options that clearly differ on two stated dimensions (cost against effort, speed against quality), where the reply names both dimensions, is place.
- place against rank: asking which matters most is rank; asking where things sit on two dimensions is place.
- place against none: a clarifying question only is none.""",
    "steps": """- steps against draft: asking how to do something, or a reply that is a short sequence, is steps; asking for the text of a message or document is draft.
- steps against none: a plain explanation or a single fact is none; the same topic as an ordered how-to is steps.
- steps against compare: describing two ways to do it in parallel is compare; one way laid out in order is steps.""",
    "draft": """- draft against steps: asking for the words themselves (a message, email, bio, summary, rewrite) is draft; asking how to go about something is steps.
- draft against none: venting about a hard conversation, with no request or offer to write it, is none; the same message with a request or an offer to write it is draft.""",
}


def why(r):
    k, lvl = r["kind"], r["level"]
    reply = r["mode"] == "reply"
    if k == "none":
        if r["seed_kind"] == "none":
            return r["seed_note"]
        return "No card at medium or below."
    if r["seed_kind"] == "none" and lvl == 3:
        return ("Level 3: only at the highest setting could a clarifying question like this become a card of "
                "generic options. At medium it would be no card.")
    return {
        "compare": "Options named and set against each other with no stated criteria." + (" The reply describes them in parallel." if reply else ""),
        "weigh": ("The reply names what matters to the person and asks how much they value those things against each other."
                  if reply else "A decision where the person already names what matters to them."),
        "rank": "Named things and a which-matters-most or which-first question, or a request to prioritise.",
        "place": "Options that differ on two stated dimensions, where a grid helps.",
        "steps": ("The reply is a short ordered sequence." if reply else "A how-to or plan request."),
        "draft": ("The reply offers to write it, or gives a first version." if reply else "A request to write something."),
    }[k] + (f" Level {lvl}." if lvl == 3 else "")


def anchor_text(rows, kind, neighbours, rnd):
    anchors = [r for r in rows if r["split"] == "anchor"]
    def take(k, n):
        c = [r for r in anchors if r["kind"] == k]
        rnd.shuffle(c)
        return c[:n]
    chosen = take(kind, 10 if kind != "none" else 8)
    if kind != "none":
        chosen += take("none", 3)
    for k in neighbours[:2]:
        chosen += take(k, 2)
    rnd.shuffle(chosen)
    out = []
    for r in chosen:
        d = {"mode": r["mode"], "person": r["person"], "soren": r["soren"], "kind": r["kind"], "level": r["level"]}
        out.append(json.dumps(d, ensure_ascii=False) + "\n   why: " + why(r))
    return "\n".join(out)


def targets_text(kind, n, mix, neighbours):
    contrast = round(n * 0.15)
    main = n - contrast
    if kind == "none":
        return (f"{n} examples in total, centred on the kind \"none\".\n"
                f"- About {main} are none (level 0): greetings, venting, plain facts, goals that need a question first, "
                "clarifying-question replies, thanks, small talk. Roughly 45% request and 55% reply.\n"
                f"- About {contrast} are contrast items from the neighbouring kinds ({', '.join(neighbours)}), each paired "
                "with a none example that shares its person text or situation, so the classifier learns the edge. Use levels 1 and 2 for these.")
    return (f"{n} examples in total, centred on the kind \"{kind}\".\n"
            f"- About {main} are {kind} ({mix}; roughly half request, half reply).\n"
            f"- About {contrast} are contrast items from the neighbouring kinds ({', '.join(neighbours)}), each paired with "
            f"a {kind} example that shares its person text or situation, so the classifier learns the edge.")


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(SYNTH, exist_ok=True)
    rows = [json.loads(l) for l in open(os.path.join(ROOT, "data", "cards", "curated.jsonl"), encoding="utf-8")]
    tpl = open(os.path.join(ROOT, "data", "cards", "generator-brief.md"), encoding="utf-8").read().split("\n---\n", 1)[1].strip()
    batches = []
    index = 0
    for kind, (count, n, mix, neighbours) in PLAN.items():
        for b in range(1, count + 1):
            bid = f"{kind}_{b:02d}"
            rnd = random.Random(f"{bid}-brief")
            start = (index * 5) % len(TOPICS)
            topics = "; ".join(TOPICS[(start + i) % len(TOPICS)] for i in range(8))
            tones = list(TONES)
            rnd.shuffle(tones)
            prompt = (tpl.replace("{BATCH_ID}", bid).replace("{N}", str(n))
                      .replace("{OUT_PATH}", os.path.join(SYNTH, bid + ".jsonl"))
                      .replace("{TARGETS}", targets_text(kind, n, mix, neighbours))
                      .replace("{TOPICS}", topics).replace("{TONES}", "; ".join(tones))
                      .replace("{SHAPES}", SHAPES).replace("{BOUNDARY}", BOUNDARY[kind])
                      .replace("{ANCHORS}", anchor_text(rows, kind, neighbours, rnd)))
            path = os.path.join(out_dir, bid + ".txt")
            open(path, "w", encoding="utf-8").write(prompt)
            batches.append({"id": bid, "n": n, "prompt": path, "out": os.path.join(SYNTH, bid + ".jsonl")})
            index += 1
    json.dump(batches, open(os.path.join(out_dir, "batches.json"), "w"), indent=1)
    print(len(batches), "batches,", sum(b["n"] for b in batches), "examples")
    leak = [r["id"] for r in rows if r["split"] != "anchor" and any(r["person"] in open(b["prompt"]).read() for b in batches[:3])]
    print("held-out text found in the first three prompts:", leak or "none")


if __name__ == "__main__":
    main()
