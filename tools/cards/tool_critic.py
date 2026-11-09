#!/usr/bin/env python3
"""Second look at every training card: a strong reviewer reads the ask and the card as a harsh critic.

    python3 tools/cards/tool_critic.py build [--per 50] [--only-first N]    # writes data/cards/tool/critic/in_<k>.json and brief_<k>.md
    python3 tools/cards/tool_critic.py summary                              # joins out_<k>.jsonl, prints the drop rate by wave, kind and issue
    python3 tools/cards/tool_critic.py export                               # writes critic/ok/<wave>.jsonl (rows the critic kept)

Pool = every kept training row (pilot, a1, a2, a3, b1, c1, c2, rs1), shuffled with a fixed seed. The reviewer never sees the
reference expressions, only the ask and the card with its answers computed at the start values, so it judges the card on its own.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tooldata as td  # noqa: E402
import toolspec as ts  # noqa: E402
import toolunits as tu  # noqa: E402

OUT = td.DATA / "critic"
FILES = {"pilot": "train_ready.jsonl", "a1": "kept.jsonl", "a2": "kept.jsonl", "a3": "kept.jsonl", "b1": "kept.jsonl",
         "c1": "kept.jsonl", "c2": "kept.jsonl", "rs1": "kept.jsonl"}

BRIEF = """You are a harsh, careful reviewer of training data for a small calculator assistant. Work alone. Read only the files named here; do not read or search anything else on this computer. You may run python3 for arithmetic only.

Read {inp} (a JSON list of {n} items). Each item has an id, the question a person typed (ask), whether the question is complete (answerable) or leaves a number out so a sensible assumption is needed (underspecified), and a card another model wrote for it: a plan, sliders (vars) with a start value, and the formulas of its outputs with their values at the start values. The FIRST output is the answer to the question.

For every item, judge the card as a skeptical senior engineer would, BEFORE trusting it:
1. Work the answer out yourself from the ask alone (use python3 if it helps), then compare with the card's first output. Mark own_answer.
2. Check the card for each of these faults:
   - answer_wrong: the first output is not what the question asks for, or the formula combines the numbers wrongly.
   - unit_or_scale: a per-minute / per-second / per-hour / per-month mix-up, ms vs s, bits vs bytes, MB vs GB vs TB, thousands / millions / billions, percent vs fraction.
   - convention: breaks these conventions without the question saying so: a month is 30 days (720 h), a year is 365 days; storage and memory sizes are binary (1 TB = 1024 GB, 1 GB = 1024 MB); network and link rates are decimal (1 Gbps = 1000 Mbps, 8 bits per byte); headroom of X percent means provision = load / (1 - X/100).
   - hidden_assumption: the question leaves a number out (underspecified) but the card hides the missing number inside a formula as a constant, instead of exposing it as a slider whose "from" is "assumed"; or an answerable card invents a number the question did not give.
   - bad_assumption: an assumed value is unrealistic or not what a sensible engineer would assume.
   - misleading_label: a title, label or unit tells the user something untrue (wrong unit, wrong name).
   - bad_range: a slider range that cannot reach its start sensibly, is absurd, or makes the card unusable.
   - ask_unusable: the question is too vague, self-contradictory or not a calculation, so no honest card exists.
   - other: any other fault that would make an engineer trust a wrong number.
3. Decide a verdict: "keep" if the card is correct and honest, or has only cosmetic problems; "drop" if any fault above would make the card give a wrong or misleading number, or mislead the user about what was assumed. When in real doubt, drop: a wrong example does more harm than a missing one. But do not drop for style, wording or because you would have written it differently.

Write your result to {out} as JSON Lines: one object per item, in the same order, nothing else in the file:
{{"id": ..., "verdict": "keep" or "drop", "issue": "none" or one of the fault names above, "own_answer": your number or null, "reason": one short sentence}}

When done, reply with one line: how many items you reviewed and how many you dropped.
"""


def rows() -> list[dict]:
    out = []
    for w, f in FILES.items():
        for l in open(td.DATA / w / f):
            if l.strip():
                r = json.loads(l)
                r["wave"] = w
                out.append(r)
    return out


def render(r: dict, units: bool = False) -> dict:
    c = r["card"]
    res = {}
    try:
        res = tu.run(c) if units else ts.run(c)
    except Exception:  # noqa: BLE001
        pass
    return {"id": r["id"], "kind": r["kind"], "ask": r["ask"],
            "card": {"plan": c.get("plan"), "title": c.get("title"),
                     "vars": [{k: v.get(k) for k in ("id", "label", "unit", "start", "min", "max", "from")} for v in c.get("vars", [])],
                     "outputs": [{"id": o["id"], "label": o["label"], "unit": o.get("unit"), "formula": o["formula"],
                                  "value_at_start": res.get(o["id"])} for o in c.get("outputs", [])]}}


def build(per: int, only_first: int) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pool = rows()
    random.Random(11).shuffle(pool)
    (OUT / "pool.json").write_text(json.dumps({r["id"]: r["wave"] for r in pool}))
    chunks = [pool[i:i + per] for i in range(0, len(pool), per)]
    if only_first:
        chunks = chunks[:only_first]
    for k, ch in enumerate(chunks, 1):
        (OUT / f"in_{k}.json").write_text(json.dumps([render(r) for r in ch], indent=1))
        (OUT / f"brief_{k}.md").write_text(BRIEF.format(inp=OUT / f"in_{k}.json", out=OUT / f"out_{k}.jsonl", n=len(ch)))
    print(f"{len(pool)} cards in the pool; wrote {len(chunks)} reviewer inputs of up to {per} to {OUT}")


def load_results() -> dict[str, dict]:
    res = {}
    for f in sorted(OUT.glob("out_*.jsonl")):
        for l in open(f):
            if l.strip():
                try:
                    d = json.loads(l)
                    res[d["id"]] = d
                except (ValueError, KeyError):
                    pass
    return res


def summary() -> None:
    res, pool = load_results(), json.loads((OUT / "pool.json").read_text())
    meta = {r["id"]: r for r in rows()}
    print(f"reviewed {len(res)} of {len(pool)} cards")
    drops = [d for d in res.values() if d.get("verdict") == "drop"]
    print(f"dropped {len(drops)} ({100 * len(drops) / max(1, len(res)):.0f}%)")
    for title, key in (("wave", lambda i: pool[i]), ("kind", lambda i: meta[i]["kind"]), ("area", lambda i: meta[i]["area"])):
        tot, bad = Counter(key(i) for i in res if i in pool), Counter(key(d["id"]) for d in drops if d["id"] in pool)
        print(f"by {title}:", {k: f"{bad[k]}/{tot[k]}" for k in sorted(tot)})
    print("by issue:", dict(Counter(d.get("issue") for d in drops).most_common()))


def export() -> None:
    res, pool = load_results(), json.loads((OUT / "pool.json").read_text())
    (OUT / "ok").mkdir(exist_ok=True)
    meta = {r["id"]: r for r in rows()}
    kept = Counter()
    handles = {w: open(OUT / "ok" / f"{w}.jsonl", "w") for w in FILES}
    for i, d in res.items():
        if d.get("verdict") == "keep" and i in meta:
            handles[meta[i]["wave"]].write(json.dumps({k: v for k, v in meta[i].items() if k != "wave"}) + "\n")
            kept[meta[i]["wave"]] += 1
    for h in handles.values():
        h.close()
    print("critic-approved rows by wave:", dict(kept), "(only reviewed cards are included)")


UNIT_NOTE = """
NOTE: these cards use the UNIT-AWARE format. Formulas contain no conversion constants: each var declares a unit (ms, h, GB, MB/s, Gbps, %, req/min, ...), the code converts everything to base units, and the output is shown in the unit it declares ("%" values are typed as percentages and behave as fractions; the names year, month, day, hour, week stand for one of that unit; sizes are binary, link rates decimal bits). So for these cards two more faults matter, and you must check them against the ask:
   - var_unit_mismatch: a var's declared unit or start value is not what the ask says next to that number (the ask says "250 ms" but the var is declared in s, or a start of 0.25), or an output's unit is not what the question asks for.
   - gamed_assumption: for an underspecified ask, an assumed value that is not a sensible engineer's assumption, or an assumed var that is really a number the ask states.
"""


def build_port(name: str, per: int = 0) -> None:
    """Reviewer inputs for the cards ported to the unit-aware format (data/cards/tool/port/<name>/kept.jsonl).

    per=0 writes one input (critic_in.json); per>0 splits into critic_in_<k>.json of up to `per` cards each."""
    d = td.DATA / "port" / name
    rows = [json.loads(l) for l in open(d / "kept.jsonl") if l.strip()]
    chunks = [rows[i:i + per] for i in range(0, len(rows), per)] if per else [rows]
    for k, ch in enumerate(chunks, 1):
        suffix = f"_{k}" if per else ""
        (d / f"critic_in{suffix}.json").write_text(json.dumps([render(r, units=True) for r in ch], indent=1))
        brief = BRIEF.format(inp=d / f"critic_in{suffix}.json", out=d / f"critic_out{suffix}.jsonl", n=len(ch)).replace("3. Decide a verdict", UNIT_NOTE + "3. Decide a verdict")
        (d / f"critic_brief{suffix}.md").write_text(brief)
    print(f"{len(rows)} ported cards ready for review in {len(chunks)} input(s) under {d}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "summary", "export", "build-port"])
    ap.add_argument("--name", default="pilot")
    ap.add_argument("--per", type=int, default=50)
    ap.add_argument("--only-first", type=int, default=0)
    a = ap.parse_args()
    {"build": lambda: build(a.per, a.only_first), "summary": summary, "export": export, "build-port": lambda: build_port(a.name, a.per)}[a.cmd]()
