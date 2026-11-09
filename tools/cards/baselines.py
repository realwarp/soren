#!/usr/bin/env python3
"""Zero-shot Laya and the current rules, scored on the curated splits with the shared table.

    python3 tools/cards/baselines.py [--split test] [--laya http://127.0.0.1:8090/classify]

Laya is called the way ui.rs calls it: the person's message in request mode, only Soren's
reply in reply mode, then the same `pick` (threshold + margin 0.1, compare and weigh kept apart
from each other's score). Laya has no level, so it shows the same card at medium and high.
"""
import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evalcore as ev

MARGIN = 0.1


def rules(r):
    if r["mode"] == "request":
        text = r["person"].lower()
        has = lambda ws: any(w in text for w in ws)
        if has(["draft a", "draft me", "write an email", "write a message", "summarise this", "summarize this", "write up"]):
            return "draft"
        if has(["choosing between", "deciding between", "decide between", "torn between", "should i buy", "weigh up", "weigh the"]):
            return "weigh"
        if has(["what matters most", "which matters most", "prioritise", "prioritize", "rank these"]):
            return "rank"
        return None
    text = r["soren"].lower()
    has = lambda ws: any(w in text for w in ws)
    if has(["weigh the", "weigh up", "decide between", "deciding between", "which option should", "which one should", "should i buy"]):
        return "weigh"
    if has(["trade-off", "tradeoff", "versus", " vs ", "compare", "side by side", "pros and cons"]):
        return "compare"
    if has(["what matters most", "prioritise", "prioritize", "rank these", "in order of"]):
        return "rank"
    if has(["two axes", "on a spectrum", "where do they sit", "map these"]):
        return "place"
    if has(["step by step", "first,", "steps:", "then you"]):
        return "steps"
    return None


def laya_scores(url, r):
    text = r["person"] if r["mode"] == "request" else r["soren"]
    body = json.dumps({"text": text, "mode": r["mode"]}).encode()
    req = urllib.request.Request(url, body, {"content-type": "application/json"})
    s = json.load(urllib.request.urlopen(req, timeout=120))["scores"]
    return {k: v for k, v in s.items() if k != "build"}


def same_family(a, b):
    return {a, b} == {"compare", "weigh"}


def pick(scores, threshold):
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    kind, score = ranked[0]
    nxt = next((s for k, s in ranked[1:] if not same_family(kind, k)), 0.0)
    return kind if score >= threshold and score - nxt >= MARGIN else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="test")
    ap.add_argument("--laya", default="http://127.0.0.1:8090/classify")
    ap.add_argument("--cache", default=None, help="json file to cache Laya scores")
    args = ap.parse_args()
    rows = ev.load(args.split)

    cache = {}
    if args.cache and os.path.exists(args.cache):
        cache = json.load(open(args.cache))
    scores = []
    for r in rows:
        if r["id"] not in cache:
            cache[r["id"]] = laya_scores(args.laya, r)
        scores.append(cache[r["id"]])
    if args.cache:
        json.dump(cache, open(args.cache, "w"))

    print(f"split {args.split}: {len(rows)} examples, {sum(r['kind'] == 'none' for r in rows)} none\n")
    results = {"rules": [rules(r) for r in rows]}
    for name, (early, reply) in {"careful": (0.75, 0.85), "balanced": (0.60, 0.70), "eager": (0.45, 0.55)}.items():
        results[f"laya {name}"] = [pick(s, early if r["mode"] == "request" else reply) for r, s in zip(rows, scores)]
    for name, decisions in results.items():
        for e in ("medium", "high"):
            print(ev.line(f"{name} @ {e}", ev.table(rows, decisions, e)))
        print()

    d = results["laya balanced"]
    print("laya balanced, per kind at medium (precision / recall):")
    for k, v in ev.per_kind(rows, d, "medium").items():
        p = "-" if v["precision"] is None else f"{v['precision']:.2f}"
        rc = "-" if v["recall"] is None else f"{v['recall']:.2f}"
        print(f"  {k:<8} gold {v['gold']:>3} pred {v['pred']:>3}  P {p}  R {rc}")


if __name__ == "__main__":
    main()
