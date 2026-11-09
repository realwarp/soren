"""Shared scoring for the card classifier: the same table for rules, Laya and the fine-tune.

A decision is the kind of card shown at an eagerness, or None. Eagerness medium shows labels
of level 1 and 2; high shows 1, 2 and 3. Low turns the classifier off, so it has no row.

  missed card   a card the label wants at this eagerness (kind != none, level <= E) and no card shown
  wrong card    a card shown that is not the labelled kind (none counts as wrong)
  unwanted      a card shown for a label whose level is above E (right kind, too eager). Counted
                separately and also folded into "wrong (strict)"
"""
import collections
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KINDS = ["none", "compare", "weigh", "rank", "place", "steps", "draft"]
EAGER = {"medium": 2, "high": 3}


def load(split):
    path = os.path.join(ROOT, "data", "cards", "curated.jsonl")
    return [r for r in (json.loads(l) for l in open(path, encoding="utf-8")) if r["split"] == split]


def table(rows, decisions, eagerness):
    """decisions: list of kind-or-None, one per row."""
    cap = EAGER[eagerness]
    wanted = shown = missed = wrong_kind = unwanted = right = 0
    for r, d in zip(rows, decisions):
        want = r["kind"] != "none" and r["level"] <= cap
        wanted += want
        if d is None:
            missed += want
            continue
        shown += 1
        if d != r["kind"]:
            wrong_kind += 1
        elif r["level"] > cap:
            unwanted += 1
        else:
            right += 1
    return {
        "n": len(rows), "wanted": wanted, "shown": shown, "right": right,
        "missed": missed, "missed_rate": missed / wanted if wanted else 0.0,
        "wrong_kind": wrong_kind, "unwanted": unwanted,
        "wrong_rate": wrong_kind / shown if shown else 0.0,
        "wrong_strict_rate": (wrong_kind + unwanted) / shown if shown else 0.0,
    }


def per_kind(rows, decisions, eagerness):
    """Precision and recall per kind at an eagerness (a shown card of the right kind but too high a level is a miss for precision)."""
    cap = EAGER[eagerness]
    out = {}
    for k in KINDS[1:]:
        tp = sum(1 for r, d in zip(rows, decisions) if d == k and r["kind"] == k and r["level"] <= cap)
        pred = sum(1 for d in decisions if d == k)
        gold = sum(1 for r in rows if r["kind"] == k and r["level"] <= cap)
        out[k] = {"gold": gold, "pred": pred, "tp": tp,
                  "precision": tp / pred if pred else None, "recall": tp / gold if gold else None}
    return out


def confusion(rows, decisions, eagerness):
    cap = EAGER[eagerness]
    c = collections.Counter()
    for r, d in zip(rows, decisions):
        gold = r["kind"] if (r["kind"] != "none" and r["level"] <= cap) else "none"
        c[(gold, d or "none")] += 1
    return c


def line(name, t):
    return (f"{name:<34} wanted {t['wanted']:>3}  shown {t['shown']:>3}  right {t['right']:>3}  "
            f"missed {t['missed_rate']*100:5.1f}%  wrong {t['wrong_rate']*100:5.1f}%  strict {t['wrong_strict_rate']*100:5.1f}%")
