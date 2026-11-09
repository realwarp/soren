#!/usr/bin/env python3
"""Merge the synthetic batches into one training file.

    python3 tools/cards/merge.py [--out data/cards/train.jsonl]

Safe to rerun whenever more batches arrive. In order it:
  1. reads every data/cards/synth/*.jsonl (the compare pilot included),
  2. applies data/cards/audit.json: per-example relabels and drops, and the global rule
     that synthetic compare level 3 becomes level 2,
  3. removes exact and near duplicates (keeping the first),
  4. removes anything close to a sealed test or dev example in data/cards/curated.jsonl,
  5. writes the rest with a source reference and a training weight (synthetic level 3 is
     weighted lower because those labels are the least reliable).
Prints what was removed and why, and the final balance.
"""
import argparse
import collections
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SIM_DUP = 0.70
SIM_LEAK = 0.55
L3_WEIGHT = 0.5


def grams(text):
    t = " " + " ".join(text.lower().split()) + " "
    return {t[i:i + 3] for i in range(len(t) - 2)}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def text_of(r):
    return " ".join(x for x in (r.get("person"), r.get("soren")) if x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "cards", "train.jsonl"))
    args = ap.parse_args()

    audit = json.load(open(os.path.join(ROOT, "data", "cards", "audit.json"), encoding="utf-8"))
    items = audit.get("items", {})
    l3_to = audit.get("rules", {}).get("compare_level_3_becomes")

    removed = collections.Counter()
    rows = []
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "cards", "synth", "*.jsonl"))):
        batch = os.path.basename(path)[:-6]
        for n, line in enumerate(open(path, encoding="utf-8"), 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                removed["not JSON"] += 1
                continue
            if set(r) != {"mode", "person", "soren", "kind", "level"}:
                removed["wrong fields"] += 1
                continue
            ref = f"{batch}:{n}"
            decision = items.get(ref)
            if decision:
                if decision["action"] == "drop":
                    removed["dropped by audit"] += 1
                    continue
                r["kind"], r["level"] = decision["kind"], decision["level"]
                r["audited"] = True
            if l3_to and r["kind"] == "compare" and r["level"] == 3:
                r["level"] = l3_to
            if (r["kind"] == "none") != (r["level"] == 0):
                removed["level does not fit kind"] += 1
                continue
            if (r["mode"] == "reply") != bool(r["soren"]):
                removed["mode does not fit reply"] += 1
                continue
            r["source"] = ref
            rows.append(r)

    held = [json.loads(l) for l in open(os.path.join(ROOT, "data", "cards", "curated.jsonl"), encoding="utf-8")]
    held = [h for h in held if h["split"] in ("test", "dev")]
    held_g = [grams(text_of(h)) for h in held]
    held_exact = {(h["person"].lower().strip(), (h["soren"] or "").lower()) for h in held}

    kept, kept_g, seen = [], [], set()
    for r in rows:
        key = (r["person"].lower().strip(), (r["soren"] or "").lower())
        if key in seen:
            removed["exact duplicate"] += 1
            continue
        if key in held_exact:
            removed["identical to a test or dev example"] += 1
            continue
        g = grams(text_of(r))
        if any(jaccard(g, hg) >= SIM_LEAK for hg in held_g):
            removed["close to a test or dev example"] += 1
            continue
        if any(jaccard(g, kg) >= SIM_DUP for kg in kept_g):
            removed["near duplicate"] += 1
            continue
        seen.add(key)
        kept.append(r)
        kept_g.append(g)

    with open(args.out, "w", encoding="utf-8") as f:
        for r in kept:
            r["weight"] = L3_WEIGHT if r["level"] == 3 else 1.0
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"read {len(rows) + sum(removed[k] for k in ('not JSON', 'wrong fields', 'dropped by audit', 'level does not fit kind', 'mode does not fit reply'))} lines from "
          f"{len(glob.glob(os.path.join(ROOT, 'data', 'cards', 'synth', '*.jsonl')))} files; wrote {len(kept)} to {args.out}")
    print("removed:", dict(removed) or "nothing")
    print("kind x level:")
    for k in ("none", "compare", "weigh", "rank", "place", "steps", "draft"):
        print(f"  {k:<8}", dict(sorted(collections.Counter(r["level"] for r in kept if r["kind"] == k).items())),
              "total", sum(1 for r in kept if r["kind"] == k))
    print("modes:", dict(collections.Counter(r["mode"] for r in kept)))


if __name__ == "__main__":
    main()
