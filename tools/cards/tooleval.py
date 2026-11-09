#!/usr/bin/env python3
"""Score a model on the sealed dev (or test) set: does it write cards that are valid, right, and honest?

    python tools/cards/tooleval.py --url http://localhost:8088 --set dev [--limit 10] [--no-grammar] [--out file.json]

For every ask the model writes a card (greedy, under the grammar unless --no-grammar). Then:

  valid           parses and passes toolspec.problems
  right           answerable asks only: the first output equals the reference (units understood, 2 percent)
  soft right      under-specified asks: valid, flags at least one assumption, answer within 3x of the reference
  wrong-confident a valid, non-declined card that is not right (the number the 5 percent ceiling applies to)
  decline         for asks that are not calculations: did it decline?
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import statistics
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import toolspec as ts  # noqa: E402
import tooldata as td  # noqa: E402

HELD_OUT = {"network", "ml_infra", "other"}


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def generate(url: str, ask: str, grammar: str | None, max_tokens: int = 900) -> tuple[str, float, int]:
    body = {"model": "x", "stream": False, "max_tokens": max_tokens, "temperature": 0.0,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": ts.SYSTEM_PROMPT}, {"role": "user", "content": ask}]}
    if grammar:
        body["grammar"] = grammar
    req = urllib.request.Request(url.rstrip("/") + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t = time.time()
    r = json.load(urllib.request.urlopen(req, timeout=300))
    return r["choices"][0]["message"]["content"] or "", time.time() - t, r["usage"]["completion_tokens"]


def judge(row: dict, text: str) -> dict:
    """One ask, one output: what happened."""
    out = {"id": row["id"], "kind": row["kind"], "area": row["area"], "held_out": row["area"] in HELD_OUT, "status": "invalid"}
    try:
        card = json.loads(text)
    except ValueError:
        return out
    if not isinstance(card, dict):
        return out
    declined = card.get("decline") is not None
    card = ts.repair(card) if not declined else card
    probs = ts.problems(card, row["ask"])
    if probs:
        out["problem"] = probs[0]
        return out
    out["canonical"] = ts.canonical_text(card) == text
    if row["kind"] == "decline":
        out["status"] = "declined_right" if declined else "answered_a_decline"
    elif declined:
        out["status"] = "declined_wrongly"
    elif row["kind"] == "answerable":
        how = td.same_answer(card, row["reference"], row.get("unit"))
        out["status"] = "right" if how else "wrong_confident"
        out["answer"], out["reference"] = ts.answer(card), row["reference"]
    else:
        ratio = ts.answer(card) / row["reference"] if row["reference"] else math.inf
        ok = any(v["from"] == "assumed" for v in card["vars"]) and 1 / 3 <= ratio <= 3
        out["status"] = "soft_right" if ok else "wrong_confident"
    return out


def summarise(results: list[dict], latencies: list[float], tokens: list[int]) -> dict:
    def count(pred):
        return sum(1 for r in results if pred(r))
    ans = [r for r in results if r["kind"] == "answerable"]
    under = [r for r in results if r["kind"] == "underspecified"]
    dec = [r for r in results if r["kind"] == "decline"]
    n_calc = len(ans) + len(under)
    valid = count(lambda r: r["status"] != "invalid")
    right = count(lambda r: r["status"] == "right")
    soft = count(lambda r: r["status"] == "soft_right")
    wrong = count(lambda r: r["status"] == "wrong_confident")
    drec = count(lambda r: r["kind"] == "decline" and r["status"] == "declined_right")
    held = [r for r in ans if r["held_out"]]
    seen = [r for r in ans if not r["held_out"]]
    s = {
        "n": len(results), "valid": valid, "valid_rate": valid / max(1, len(results)),
        "answerable": len(ans), "right": right, "right_rate": right / max(1, len(ans)), "right_ci": wilson(right, len(ans)),
        "underspecified": len(under), "soft_right": soft,
        "wrong_confident": wrong, "wrong_confident_rate": wrong / max(1, n_calc), "wrong_ci": wilson(wrong, n_calc),
        "declines": len(dec), "declined_right": drec, "decline_recall": drec / max(1, len(dec)),
        "answered_a_decline": count(lambda r: r["status"] == "answered_a_decline"),
        "declined_wrongly": count(lambda r: r["status"] == "declined_wrongly"),
        "right_seen_domains": f"{sum(r['status'] == 'right' for r in seen)}/{len(seen)}",
        "right_held_out": f"{sum(r['status'] == 'right' for r in held)}/{len(held)}",
        "p50_s": statistics.median(latencies) if latencies else None,
        "p95_s": sorted(latencies)[int(0.95 * (len(latencies) - 1))] if latencies else None,
        "mean_tokens": statistics.mean(tokens) if tokens else None,
        "canonical_form": count(lambda r: r.get("canonical")) / max(1, valid),
    }
    by_area: dict = {}
    for r in ans:
        a = by_area.setdefault(r["area"], [0, 0])
        a[1] += 1
        a[0] += r["status"] == "right"
    s["right_by_area"] = {k: f"{a}/{b}" for k, (a, b) in by_area.items()}
    return s


def show(s: dict) -> str:
    ci = lambda t: f"{100 * t[0]:.0f}-{100 * t[1]:.0f}%"  # noqa: E731
    lines = [
        f"asks {s['n']}  valid {s['valid']} ({100 * s['valid_rate']:.0f}%)  canonical form {100 * s['canonical_form']:.0f}% of valid",
        f"answerable right {s['right']}/{s['answerable']} ({100 * s['right_rate']:.0f}%, 95% CI {ci(s['right_ci'])})   seen domains {s['right_seen_domains']}   held-out {s['right_held_out']}",
        f"assumption asks soft-right {s['soft_right']}/{s['underspecified']}",
        f"wrong but confident {s['wrong_confident']} ({100 * s['wrong_confident_rate']:.0f}% of calculations, CI {ci(s['wrong_ci'])}; ceiling 5%)",
        f"declines {s['declined_right']}/{s['declines']} right; answered a decline {s['answered_a_decline']}; declined a calculation {s['declined_wrongly']}",
        f"latency p50 {s['p50_s']:.1f}s p95 {s['p95_s']:.1f}s, mean {s['mean_tokens']:.0f} tokens" if s["p50_s"] is not None else "latency n/a",
    ]
    return "\n".join(lines)


def rejudge(path: str, which: str) -> dict:
    """Re-score a saved evaluation file with the current rules (no model needed)."""
    saved = json.load(open(path))
    rows = {json.loads(l)["id"]: json.loads(l) for l in open(td.DATA / which / "pass1_ok.jsonl") if l.strip()}
    results = []
    for r in saved["rows"]:
        res = judge(rows[r["id"]], r["output"])
        results.append(res)
    return summarise(results, [], [])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rejudge", default="", help="re-score a saved evaluation file instead of calling a model")
    ap.add_argument("--url", default="")
    ap.add_argument("--set", default="dev", choices=["dev", "test", "pilot", "holdout"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--no-grammar", action="store_true")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    if a.rejudge:
        s = rejudge(a.rejudge, a.set)
        s["p50_s"] = s["p95_s"] = s["mean_tokens"] = None
        print(show(s).replace("latency p50 None", "latency n/a"))
        return
    rows = [json.loads(l) for l in open(td.DATA / a.set / "pass1_ok.jsonl") if l.strip()]
    if a.limit:
        rows = rows[: a.limit]
    grammar = None if a.no_grammar else ts.grammar()
    results, lats, toks, raw = [], [], [], []
    for row in rows:
        try:
            text, dt, n = generate(a.url, row["ask"], grammar)
        except Exception as e:  # noqa: BLE001
            text, dt, n = "", 0.0, 0
            print(f"{row['id']}: request failed: {e}", file=sys.stderr)
        res = judge(row, text)
        results.append(res)
        if dt:
            lats.append(dt); toks.append(n)
        raw.append({"id": row["id"], "ask": row["ask"], "output": text, **res})
        print(f"{row['id']:>5} {row['kind'][:5]:5} {res['status']:16s} {dt:4.1f}s", flush=True)
    s = summarise(results, lats, toks)
    print("\n" + show(s))
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps({"summary": s, "rows": raw}, indent=1))


if __name__ == "__main__":
    main()
