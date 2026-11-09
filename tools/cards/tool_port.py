#!/usr/bin/env python3
"""Port verified tool cards to the unit-aware format (toolunits.py) with agents that can check their own work.

    python3 tools/cards/tool_port.py build <name> --n 60 --per 30 [--seed 5]   # inputs under data/cards/tool/port/<name>/
    python3 tools/cards/tool_port.py check <name> <k>                          # an agent runs this on its own output until all pass
    python3 tools/cards/tool_port.py score <name>                              # gate: keep only cards that pass; writes kept.jsonl

Each input item carries the ask, the verified reference answer (and its unit) and the old card. The agent writes
port/<name>/out_<k>.jsonl with {"id", "card"} lines. A card passes when
  - toolunits.problems(card) is empty (units parse, dimensions agree, no bare conversion constants),
  - its first output agrees with the verified reference (exact, rounded, or the same quantity in another unit),
  - the numbers in the ask appear in the cards' message-sourced vars (toolspec.problems).
Nothing is kept on the agent's say-so: `score` re-runs the same checks.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tooldata as td  # noqa: E402
import toolspec as ts  # noqa: E402
import toolunits as tu  # noqa: E402

PORT = td.DATA / "port"
FILES = {"pilot": "train_ready.jsonl", "a1": "kept.jsonl", "a2": "kept.jsonl", "a3": "kept.jsonl", "b1": "kept.jsonl", "c1": "kept.jsonl", "c2": "kept.jsonl"}



BRIEF = """You are porting verified calculator cards to a new, unit-aware format. Work alone. Read only the files named here; do not read or search anything else on this computer. You may run python3 for the checks below and for arithmetic.

Input: {inp} (a JSON list of {n} items: id, ask, reference + reference_unit = the VERIFIED right answer, and old_card). Output: write {out} as JSON Lines, one object per line, {{"id": ..., "card": {{...}}}}, one line for every id in the input, nothing else in the file.

The old card is correct but writes unit conversions into its formulas (/60, *1000, /1024, /100, ...). In the new format the CODE converts units, so formulas contain no conversion constants at all.

How the new format works
- Every var and output has a "unit" from the closed table below. The evaluator turns each var into base units (seconds, bytes, dollars), evaluates the formula, and converts the answer into the unit the output declares. So `msgs_min / part_rate` with units msg/min and msg/s just works.
- A var's "start" is the number exactly as the ask states it, in the unit the ask uses (the ask says "250 ms" -> unit "ms", start 250; "99.9%" -> unit "%", start 99.9; "780k msgs per minute" -> unit "msg/min", start 780000). Never pre-convert a start value. Choose min/max/step sensibly for that unit.
- "%" values are typed as percentages (65) but behave as fractions (0.65) inside formulas: write `jobs * job_time / busy`, never `/ 100` or `* 0.01`.
- Formulas may NOT contain these numbers (the units do the work): 8, 12, 24, 30, 60, 100, 360, 365, 720, 730, 1000, 1024, 3600, 86400, 1000000, 1000000000. Any other literal (2, 3, 0.5, 7, 99) is fine when it is a real quantity of the problem.
- Every unit name stands for one of that unit inside a formula (second, minute, hour, day, week, month, year, ms, s, min, h, KB, MB, GB, TB, k, M, bn for thousand, million, billion, ...), so `rate * year` needs no 365 and no extra var, and to round a quantity up to whole units you divide by the unit, round, and multiply back: `ceil(t / hour) * hour`, `ceil(size / GB)`. A cap at 100% is `min(x, 1)` (a % var is a fraction inside formulas); never drop a clamp, cap or ceil from the old card, keep it. A literal 0 fits any unit, so `max(0, budget - spent)` is fine.
- For an underspecified ask the item carries "reference_assumptions": the numbers the verified answer assumed. Use exactly those as the assumed vars' start values ("from": "assumed"); a number the ask does not state can never be "message".
- Add or subtract only quantities of the same kind (time with time, bytes with bytes, dollars with dollars). `min`, `max` need the same kind. `ceil`, `floor`, `round` need a plain number (the result of dividing like by like, e.g. servers = load / capacity).
- The OUTPUT unit must be what the formula really measures, and the first output answers the question in the unit the question asks for. Pick output units from the table (a plain count noun such as workers or partitions is fine for counts).
- Percent helpers work on fractions: percent_of(total, p), add_percent(base, p), less_percent(base, p), before_percent(result, p) (= result / (1 - p)), as_percent(part, whole), percent_change(old, new), grow(start, p, periods), periods_to_reach(start, target, p). Use them with "%" vars.
- Keep the old card's plan wording, title, labels, ids and var ids where they are still right; fix anything the new format makes wrong (a plan that says "divide by 60" can say what is being compared instead). Keep "from": "message" or "assumed" as in the old card. Keep decline null and 1 to 6 vars, 1 to 4 outputs.

Unit table (anything else is rejected): time: us ms s min h day week month year; bytes (binary): B KB MB GB TB PB; bits (decimal): bit Kb Mb Gb Tb; money: $ USD cent (cents); plain scale: % x k M bn; compounds with / and -: req/s, MB/s, $/GB, $/GB-mo, Gbps (= Gb/s), /min, /day; count nouns such as req, msg, users, nodes, workers, shards, partitions, pods, jobs, items are plain counts. A month is 30 days and a year 365 days. Sizes are binary (1 GB = 1024 MB); link rates are decimal bits (1 Gbps = 125,000,000 bytes per second); bytes and bits are converted for you.

Check your work: after writing the file run
    python3 {tool} check {name} {k}
It re-runs the exact gate that decides whether a card is kept: units parse, dimensions agree, no conversion constants, and the first output matches the verified answer. Fix every FAIL and run it again until it prints "{n} of {n} pass". If a card cannot pass because the old card or the reference seems wrong, write your best card anyway and say which ids in your final line; do not weaken a check.

Final reply: one line, how many pass and any ids you could not fix.
"""


def agrees(card: dict, ref: float, ref_unit: str | None, rtol: float = 0.02) -> str | None:
    got = tu.answer(card)
    close = lambda a, b: abs(a - b) <= rtol * max(abs(b), 1e-9)  # noqa: E731
    if close(got, ref):
        return "exact"
    if abs(ref - round(ref)) < 1e-9 and (math.ceil(got - 1e-9) == round(ref) or round(got) == round(ref)):
        return "rounded"
    od, of, _ = tu.parse_unit(card["outputs"][0].get("unit", ""))
    rd, rf, _ = tu.parse_unit(ref_unit or "")
    if od == rd and close(got, ref * rf / of):
        return "units"
    return None


def verdict(card: dict, ask: str, ref: float, ref_unit: str | None) -> tuple[bool, str]:
    p = tu.problems(card)
    if p:
        return False, "; ".join(p)
    p = tu.shape_problems(card, ask)
    if p:
        return False, "card shape: " + "; ".join(p)
    how = agrees(card, ref, ref_unit)
    if how is None:
        return False, f"first output is {ts.fmt_num(tu.answer(card))} {card['outputs'][0].get('unit', '')} but the verified answer is {ts.fmt_num(ref)} {ref_unit or ''}"
    return True, how


def pool() -> dict[str, dict]:
    rows = {}
    for w, f in FILES.items():
        ref = {json.loads(l)["id"]: json.loads(l) for l in open(td.DATA / w / "pass1_ok.jsonl") if l.strip()}
        for l in open(td.DATA / w / f):
            if l.strip():
                r = json.loads(l)
                if r["card"].get("decline") is None and r["id"] in ref:
                    rows[r["id"]] = {"id": r["id"], "kind": r["kind"], "area": r["area"], "ask": r["ask"], "reference": ref[r["id"]]["reference"],
                                     "reference_unit": ref[r["id"]].get("unit"), "reference_assumptions": ref[r["id"]].get("assumptions"), "old_card": r["card"]}
    return rows


def build(name: str, n: int, per: int, seed: int) -> None:
    rows = list(pool().values())
    random.Random(seed).shuffle(rows)
    rows = rows[:n] if n else rows
    out = PORT / name
    out.mkdir(parents=True, exist_ok=True)
    for k, i in enumerate(range(0, len(rows), per), 1):
        (out / f"in_{k}.json").write_text(json.dumps(rows[i:i + per], indent=1))
        (out / f"brief_{k}.md").write_text(BRIEF.format(inp=out / f"in_{k}.json", out=out / f"out_{k}.jsonl", n=len(rows[i:i + per]), tool="tools/cards/tool_port.py", name=name, k=k))
    print(f"{len(rows)} cards in {math.ceil(len(rows) / per)} inputs under {out}")


def load_out(path: pathlib.Path) -> dict[str, dict]:
    res = {}
    if path.exists():
        for l in open(path):
            if l.strip():
                try:
                    d = json.loads(l)
                    res[d["id"]] = d["card"]
                except (ValueError, KeyError):
                    print("unreadable line:", l[:80])
    return res


def check(name: str, k: int) -> int:
    items = json.loads((PORT / name / f"in_{k}.json").read_text())
    out = load_out(PORT / name / f"out_{k}.jsonl")
    bad = 0
    for it in items:
        card = out.get(it["id"])
        if card is None:
            print(f"{it['id']}: MISSING")
            bad += 1
            continue
        ok, why = verdict(card, it["ask"], it["reference"], it["reference_unit"])
        if not ok:
            bad += 1
        print(f"{it['id']}: {'ok (' + why + ')' if ok else 'FAIL ' + why}")
    print(f"{len(items) - bad} of {len(items)} pass")
    return bad


def score(name: str) -> None:
    kept, total, why = [], 0, {}
    for f in sorted((PORT / name).glob("in_*.json")):
        k = f.stem.split("_")[1]
        out = load_out(PORT / name / f"out_{k}.jsonl")
        for it in json.loads(f.read_text()):
            total += 1
            card = out.get(it["id"])
            ok, reason = verdict(card, it["ask"], it["reference"], it["reference_unit"]) if card else (False, "missing")
            if ok:
                kept.append({"id": it["id"], "kind": it["kind"], "area": it["area"], "ask": it["ask"], "card": card, "match": reason})
            else:
                why[reason[:40]] = why.get(reason[:40], 0) + 1
    (PORT / name / "kept.jsonl").write_text("".join(json.dumps(r) + "\n" for r in kept))
    print(f"{name}: kept {len(kept)} of {total}")
    for r, n in sorted(why.items(), key=lambda x: -x[1])[:8]:
        print(f"  dropped {n}: {r}")


def audit(name: str) -> None:
    """Find ported cards that lost something the old card had (a clamp, a cap, a ceil, an output) or invented an assumed var."""
    import re
    flagged: dict[str, list[str]] = {}
    for f in sorted((PORT / name).glob("in_*.json")):
        k = f.stem.split("_")[1]
        out = load_out(PORT / name / f"out_{k}.jsonl")
        for it in json.loads(f.read_text()):
            new = out.get(it["id"])
            if not new:
                continue
            old = it["old_card"]
            fn = lambda c: set(re.findall(r"\b(ceil|floor|min|max|round)\(", " ".join(o["formula"] for o in c["outputs"])))  # noqa: E731
            why = []
            if fn(old) - fn(new):
                why.append("dropped " + "/".join(sorted(fn(old) - fn(new))))
            if len(new["outputs"]) < len(old["outputs"]):
                why.append("dropped an output")
            ra = it.get("reference_assumptions") or {}
            for v in new["vars"]:
                if v.get("from") == "assumed" and not ra:
                    old_ids = {x["id"] for x in old["vars"]}
                    if v["id"] not in old_ids:
                        why.append(f"invented assumed var {v['id']}")
            if why:
                flagged[it["id"]] = why
    (PORT / name / "flagged.json").write_text(json.dumps(flagged, indent=1))
    print(f"{len(flagged)} flagged:", json.dumps(flagged)[:600])


def reissue(name: str, new: str, per: int) -> None:
    """Inputs for a fresh port attempt of the flagged ids of `name` (original old cards), as a new batch `new`."""
    flagged = json.loads((PORT / name / "flagged.json").read_text())
    items = [it for f in sorted((PORT / name).glob("in_*.json")) for it in json.loads(f.read_text()) if it["id"] in flagged]
    out = PORT / new
    out.mkdir(parents=True, exist_ok=True)
    for k, i in enumerate(range(0, len(items), per), 1):
        (out / f"in_{k}.json").write_text(json.dumps(items[i:i + per], indent=1))
        (out / f"brief_{k}.md").write_text(BRIEF.format(inp=out / f"in_{k}.json", out=out / f"out_{k}.jsonl", n=len(items[i:i + per]), tool="tools/cards/tool_port.py", name=new, k=k))
    print(f"{len(items)} cards to port again in {math.ceil(len(items) / per)} inputs under {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "check", "score", "audit", "reissue"])
    ap.add_argument("name")
    ap.add_argument("k", nargs="?", type=int, default=1)
    ap.add_argument("--new", default="redo")
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--per", type=int, default=30)
    ap.add_argument("--seed", type=int, default=5)
    a = ap.parse_args()
    if a.cmd == "build":
        build(a.name, a.n, a.per, a.seed)
    elif a.cmd == "audit":
        audit(a.name)
    elif a.cmd == "reissue":
        reissue(a.name, a.new, a.per)
    elif a.cmd == "check":
        sys.exit(1 if check(a.name, a.k) else 0)
    else:
        score(a.name)
