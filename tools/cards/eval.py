#!/usr/bin/env python3
"""Calibrate a trained run and score it with the shared table.

    python3 tools/cards/eval.py bge-small [minilm-l12 ...] [--missed-target 0.08]

For each run: fit one temperature per head on val + dev (never test), pick the card threshold per
eagerness as the highest one whose missed-card rate on val + dev is at or under the target, then
print test and dev tables at medium and high, per-kind precision / recall, and the variety mask.

Decision rule. With kind probabilities P and level probabilities L (1..3):
    chance a card is wanted at eagerness E  =  (sum of P over allowed non-none kinds) * sum(L[1..E])
    show the card when that clears the threshold; the kind is the best non-none kind.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evalcore as ev

KINDS = ev.KINDS
LOW_VARIETY = {"compare", "weigh", "draft"}


def softmax(x, t=1.0):
    z = x / t
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def fit_t(logits, labels):
    best, best_t = 1e9, 1.0
    for t in np.arange(0.4, 6.01, 0.05):
        p = softmax(logits, t)
        nll = -np.log(p[np.arange(len(labels)), labels] + 1e-9).mean()
        if nll < best:
            best, best_t = nll, float(t)
    return best_t


def decide(kind_logits, level_logits, tk, tl, tau, cap, allowed=None):
    P, L = softmax(kind_logits, tk), softmax(level_logits, tl)
    if allowed is not None:
        mask = np.array([k == "none" or k in allowed for k in KINDS])
        # Masked kinds lose their probability instead of handing it to the allowed ones: a ranking
        # request must become "no card", not a forced comparison.
        P = np.where(mask, P, 0.0)
    chance = P[:, 1:].sum(1) * L[:, :cap].sum(1)
    best = 1 + P[:, 1:].argmax(1)
    return [KINDS[b] if c >= tau else None for b, c in zip(best, chance)], chance


def train_rows():
    rows = {}
    for l in open(os.path.join(ev.ROOT, "data", "cards", "train.jsonl"), encoding="utf-8"):
        r = json.loads(l)
        rows[r["source"]] = r
    return rows


def with_variety(rows, allowed):
    return [dict(r, kind=r["kind"] if r["kind"] in allowed or r["kind"] == "none" else "none",
                 level=r["level"] if r["kind"] in allowed or r["kind"] == "none" else 0) for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--missed-target", type=float, default=0.08)
    ap.add_argument("--json", default=None)
    ap.add_argument("--cal", choices=["mixed", "human"], default="mixed",
                    help="mixed: val + dev; human: dev + anchor only (needs predict_extra.py), the owner's own labels")
    args = ap.parse_args()
    tr = train_rows()
    dev, test = ev.load("dev"), ev.load("test")
    summary = {}
    for name in args.runs:
        d = np.load(os.path.join(ev.ROOT, "data", "cards", "runs", name, "logits.npz"))
        val = [tr[s] for s in d["val_ids"]]
        if args.cal == "human":
            anchors = ev.load("anchor")
            cal_rows = dev + anchors
            ck = np.concatenate([d["dev_kind"], d["anchor_kind"]])
            cl = np.concatenate([d["dev_level"], d["anchor_level"]])
        else:
            cal_rows = val + dev
            ck = np.concatenate([d["val_kind"], d["dev_kind"]])
            cl = np.concatenate([d["val_level"], d["dev_level"]])
        kidx = np.array([KINDS.index(r["kind"]) for r in cal_rows])
        card = np.array([r["kind"] != "none" for r in cal_rows])
        lidx = np.array([max(r["level"], 1) - 1 for r in cal_rows])
        tk = fit_t(ck, kidx)
        tl = fit_t(cl[card], lidx[card])
        taus = {}
        for e, cap in ev.EAGER.items():
            cap_n = cap
            ok = None
            for tau in np.arange(0.99, 0.0, -0.01):
                dec, _ = decide(ck, cl, tk, tl, tau, cap_n)
                if ev.table(cal_rows, dec, e)["missed_rate"] <= args.missed_target:
                    ok = float(round(tau, 2))
                    break
            taus[e] = ok if ok is not None else 0.01
        print(f"\n=== {name}   T_kind {tk:.2f}  T_level {tl:.2f}   thresholds {taus}   (calibrated on {args.cal}, missed target {args.missed_target:.0%})")
        out = {"t_kind": tk, "t_level": tl, "tau": taus}
        for split, rows, kl, ll in (("val", val, d["val_kind"], d["val_level"]), ("dev", dev, d["dev_kind"], d["dev_level"]),
                                     ("TEST", test, d["test_kind"], d["test_level"])):
            for e, cap in ev.EAGER.items():
                dec, _ = decide(kl, ll, tk, tl, taus[e], cap)
                t = ev.table(rows, dec, e)
                print(ev.line(f"{split} @ {e}", t))
                out[f"{split}_{e}"] = t
                if split == "TEST":
                    fam = lambda k: "compare" if k == "weigh" else k
                    tf = ev.table([dict(r, kind=fam(r["kind"])) for r in rows], [fam(x) if x else None for x in dec], e)
                    print(ev.line(f"{split} @ {e}  (compare = weigh)", tf))
                    out[f"{split}_{e}_family"] = tf
        for e, cap in ev.EAGER.items():
            dec, _ = decide(d["test_kind"], d["test_level"], tk, tl, taus[e], cap)
            if e == "medium":
                print("  test per kind at medium:")
                for k, v in ev.per_kind(test, dec, e).items():
                    p = "  - " if v["precision"] is None else f"{v['precision']:.2f}"
                    r = "  - " if v["recall"] is None else f"{v['recall']:.2f}"
                    print(f"    {k:<8} gold {v['gold']:>3} pred {v['pred']:>3}  P {p}  R {r}")
        dec, _ = decide(d["test_kind"], d["test_level"], tk, tl, taus["medium"], 2, allowed=LOW_VARIETY)
        print(ev.line("TEST low variety @ medium", ev.table(with_variety(test, LOW_VARIETY), dec, "medium")))
        summary[name] = out
    if args.json:
        json.dump(summary, open(args.json, "w"), indent=1)


if __name__ == "__main__":
    main()
