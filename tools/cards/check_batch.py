#!/usr/bin/env python3
"""Check a batch of synthetic card examples before it is merged.

    python3 tools/cards/check_batch.py data/cards/synth/pilot_compare.jsonl [--show 12]

Reports schema problems, label balance, near-duplicates inside the batch, and any example
that is close to a sealed test or dev example in data/cards/curated.jsonl (those must never
be trained on, or the evaluation numbers mean nothing).
"""
import argparse
import collections
import json
import random
import sys

KINDS = {"none", "compare", "weigh", "rank", "place", "steps", "draft"}
FIELDS = {"mode", "person", "soren", "kind", "level"}
SIM_DUP = 0.70    # trigram Jaccard at or above which two examples count as near-duplicates
SIM_LEAK = 0.55   # at or above which an example is too close to a held-out one


def text_of(row):
    return " ".join(x for x in (row.get("person"), row.get("soren")) if x).lower()


def grams(text):
    t = " " + " ".join(text.split()) + " "
    return {t[i:i + 3] for i in range(len(t) - 2)}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--curated", default="data/cards/curated.jsonl")
    ap.add_argument("--show", type=int, default=0, help="print this many random examples")
    ap.add_argument("--expect", type=int, default=None, help="the line count the batch was asked for")
    args = ap.parse_args()

    rows, problems = [], []
    for n, line in enumerate(open(args.path, encoding="utf-8"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            problems.append(f"line {n}: not JSON ({e.msg})")
            continue
        extra = set(row) - FIELDS
        missing = FIELDS - set(row)
        if extra or missing:
            problems.append(f"line {n}: fields extra={sorted(extra)} missing={sorted(missing)}")
            continue
        if row["kind"] not in KINDS:
            problems.append(f"line {n}: unknown kind {row['kind']!r}")
        if row["mode"] not in ("request", "reply"):
            problems.append(f"line {n}: unknown mode {row['mode']!r}")
        if (row["kind"] == "none") != (row["level"] == 0) or row["level"] not in (0, 1, 2, 3):
            problems.append(f"line {n}: level {row['level']} does not fit kind {row['kind']}")
        if (row["mode"] == "reply") != bool(row["soren"]):
            problems.append(f"line {n}: mode {row['mode']} but soren is {'set' if row['soren'] else 'empty'}")
        if not str(row["person"]).strip():
            problems.append(f"line {n}: empty person text")
        row["_line"] = n
        rows.append(row)

    print(f"{args.path}: {len(rows)} examples" + (f" (asked for {args.expect})" if args.expect else ""))
    if args.expect is not None and len(rows) != args.expect:
        problems.append(f"expected {args.expect} lines, found {len(rows)}")
    print("kind x level:", {k: dict(sorted(collections.Counter(r["level"] for r in rows if r["kind"] == k).items()))
                            for k in sorted({r["kind"] for r in rows})})
    print("modes:", dict(collections.Counter(r["mode"] for r in rows)))
    openings = collections.Counter(" ".join(r["person"].lower().split()[:2]) for r in rows)
    repeated = {k: v for k, v in openings.items() if v >= 3}
    if repeated:
        print("repeated two-word openings (3+):", repeated)

    g = [grams(text_of(r)) for r in rows]
    dups = [(rows[i]["_line"], rows[j]["_line"], round(jaccard(g[i], g[j]), 2))
            for i in range(len(rows)) for j in range(i + 1, len(rows)) if jaccard(g[i], g[j]) >= SIM_DUP]
    print(f"near-duplicate pairs inside the batch (>= {SIM_DUP}): {dups or 'none'}")

    held = [json.loads(l) for l in open(args.curated, encoding="utf-8")]
    held = [h for h in held if h["split"] in ("test", "dev")]
    hg = [grams(text_of(h)) for h in held]
    leaks = []
    for i, r in enumerate(rows):
        best = max(range(len(held)), key=lambda k: jaccard(g[i], hg[k]))
        s = jaccard(g[i], hg[best])
        if s >= SIM_LEAK:
            leaks.append((r["_line"], held[best]["id"], held[best]["split"], round(s, 2)))
    print(f"too close to a sealed test or dev example (>= {SIM_LEAK}): {leaks or 'none'}")

    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems[:40]:
            print("  -", p)
    else:
        print("\nno schema problems")
    if args.show:
        print()
        for r in random.Random(3).sample(rows, min(args.show, len(rows))):
            print(f"[{r['_line']:>3}] {r['kind']} L{r['level']} ({r['mode']})")
            print(f"      person: {r['person']}")
            if r["soren"]:
                print(f"      soren:  {r['soren']}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
