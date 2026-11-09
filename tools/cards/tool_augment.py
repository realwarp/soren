#!/usr/bin/env python3
"""More training cards from the verified unit-aware ones, made by code (no model, no agent quota).

    TOOL_FORMAT=units python3 tools/cards/tool_augment.py [--out data/cards/tool/aug] [--seed 3]

Two kinds of new card, each checked before it is kept:
  unit swap   "a 250 ms timeout" becomes "a 0.25 s timeout": the var's unit, start, range and step change with the question text and
              the plan; the formula stays as it is because the code converts units. The first answer must stay exactly the same.
  assumption  a stated number is dropped from the question (a whole comma-separated clause that holds only that number); the var
              becomes an assumed one with the same start, and the plan says so. The first answer must stay exactly the same.
Nothing here reads dev, test or holdout cards; their questions are also kept out of the result.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import random
import re
import sys
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tooldata as td  # noqa: E402
import toolspec as ts  # noqa: E402
import toolunits as tu  # noqa: E402

SWAPS = {"ms": ["s"], "s": ["ms", "min"], "min": ["s", "h"], "h": ["min", "day"], "day": ["h"],
         "KB": ["MB"], "MB": ["KB", "GB"], "GB": ["MB", "TB"], "TB": ["GB"]}
NUM = r"(\d[\d,]*\.?\d*)"


def nice(x: float) -> str | None:
    """x as plain text with at most 6 significant digits, or None when that would not round-trip."""
    if x <= 0 or x != x:
        return None
    t = format(x, ".6g")
    if "e" in t or abs(float(t) - x) > 1e-9 * abs(x):
        return None
    return t


def first_answer(card: dict, ask: str) -> float | None:
    try:
        if ts.problems(card, ask):
            return None
        return ts.answer(card)
    except Exception:  # noqa: BLE001
        return None


def unit_swaps(row: dict, rng: random.Random) -> list[dict]:
    out = []
    card = row["card"]
    base = first_answer(card, row["ask"])
    if base is None:
        return out
    cands = []
    for v in card["vars"]:
        u = v.get("unit", "")
        if v.get("from") != "message" or u not in SWAPS:
            continue
        for new in SWAPS[u]:
            cands.append((v, u, new))
    rng.shuffle(cands)
    for v, old, new in cands[:2]:
        f = tu.UNITS[old][1] / tu.UNITS[new][1]
        pat = re.compile(rf"(?<![\w.]){NUM}(\s*){re.escape(old)}(?![A-Za-z0-9/])")
        hits = [m for m in pat.finditer(row["ask"]) if abs(float(m.group(1).replace(",", "")) - v["start"]) < 1e-9 * max(1, abs(v["start"]))]
        if len(hits) != 1:
            continue
        vals = {k: nice(v[k] * f) if k != "min" or v[k] > 0 else "0" for k in ("start", "max", "step")}
        mn = "0" if v["min"] == 0 else nice(v["min"] * f)
        if mn is None or any(x is None for x in vals.values()):
            continue
        m = hits[0]
        ask2 = row["ask"][:m.start()] + vals["start"] + m.group(2) + new + row["ask"][m.end():]
        card2 = json.loads(json.dumps(card))
        new_id = v["id"]
        suffix = re.search(rf"_{re.escape(old.lower())}$", v["id"])
        if suffix:
            new_id = v["id"][:suffix.start()] + "_" + new.lower()
            if new_id in {w["id"] for w in card["vars"]}:
                continue
        elif re.search(rf"(?<![A-Za-z]){re.escape(old)}(?![A-Za-z])", v["id"], re.I):
            continue
        for w in card2["vars"]:
            if w["id"] == v["id"]:
                w.update(id=new_id, unit=new, start=float(vals["start"]), min=float(mn), max=float(vals["max"]), step=float(vals["step"]))
                w["label"] = re.sub(rf"(?<![A-Za-z]){re.escape(old)}(?![A-Za-z])", new, w["label"], flags=re.I)
        if new_id != v["id"]:
            for o in card2["outputs"]:
                o["formula"] = re.sub(rf"\b{re.escape(v['id'])}\b", new_id, o["formula"])
        plan = card["plan"]
        plan_pat = re.compile(rf"(?<![\w.]){NUM}(\s*){re.escape(old)}(?![A-Za-z0-9/])")
        plan = plan_pat.sub(lambda mm: vals["start"] + mm.group(2) + new if abs(float(mm.group(1).replace(",", "")) - v["start"]) < 1e-9 * max(1, abs(v["start"])) else mm.group(0), plan)
        old_num = nice(v["start"]) or str(v["start"])
        if re.search(rf"(?<![\w.]){re.escape(old_num)}(?![\w]|\.\d)", plan):
            continue
        card2["plan"] = plan
        if not (20 <= len(plan) <= 600):
            continue
        a2 = first_answer(card2, ask2)
        if a2 is None or abs(a2 - base) > 1e-9 * max(1.0, abs(base)):
            continue
        out.append({"id": f"{row['id']}_u{len(out) + 1}", "ask": ask2, "kind": row["kind"], "area": row["area"], "card": card2, "aug": "unit"})
    return out


def assumption(row: dict, rng: random.Random) -> dict | None:
    if row["kind"] != "answerable":
        return None
    card = row["card"]
    msg = [v for v in card["vars"] if v.get("from") == "message"]
    if len(msg) < 2:
        return None
    base = first_answer(card, row["ask"])
    if base is None:
        return None
    rng.shuffle(msg)
    ask = row["ask"]
    for v in msg:
        d = tu.parse_unit(v.get("unit", ""))[0]
        if d[3:] != (0, 0) or d[:3] not in ((0, 0, 0), (1, 0, 0), (-1, 0, 0)):
            continue
        # the clause that holds the number: between commas (or the start / a full stop), and no other number
        segs = re.split(r"(,\s+(?:and\s+)?|;\s+|\.\s+)", ask)
        idx = [i for i in range(0, len(segs), 2) if i > 0 and re.search(NUM, segs[i])]
        hit = None
        for i in idx:
            nums = [float(x.replace(",", "")) for x in re.findall(NUM, segs[i]) if x.strip(",.")]
            if len(nums) == 1 and abs(nums[0] - v["start"]) < 1e-9 * max(1, abs(v["start"])) and len(segs[i].split()) <= 9:
                hit = i
                break
        if hit is None:
            continue
        rest = segs[:hit - 1] + segs[hit + 1:] if hit + 1 < len(segs) else segs[:hit - 1]
        ask2 = "".join(rest).strip()
        if hit + 1 < len(segs) and segs[hit + 1].startswith(".") is False and hit + 1 < len(segs):
            pass
        if not ask2 or len(ask2) < 25:
            continue
        card2 = json.loads(json.dumps(card))
        for w in card2["vars"]:
            if w["id"] == v["id"]:
                w["from"] = "assumed"
        shown = nice(v["start"]) or str(v["start"])
        card2["plan"] = (f"The question does not give {v['label'].lower()}, so it is exposed as an assumed value of {shown}"
                         f"{(' ' + v['unit']) if v.get('unit') else ''} that you can change. "
                         f"{card['outputs'][0]['label']} then follows from the numbers that are stated.")
        a2 = first_answer(card2, ask2)
        if a2 is None or abs(a2 - base) > 1e-9 * max(1.0, abs(base)):
            continue
        return {"id": f"{row['id']}_a1", "ask": ask2, "kind": "underspecified", "area": row["area"], "card": card2, "aug": "assume"}
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(td.DATA / "aug"))
    ap.add_argument("--seed", type=int, default=3)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    rows = [json.loads(l) for l in open(td.DATA / "port" / "final" / "ok.jsonl") if l.strip()]
    sealed = {json.loads(l)["ask"].strip().lower() for s in ("dev", "test", "holdout") for l in open(td.DATA / s / "pass1_ok.jsonl") if l.strip()}
    made, seen = [], set()
    for r in rows:
        if r["ask"].strip().lower() in sealed:
            continue
        new = unit_swaps(r, rng)
        asm = assumption(r, rng)
        if asm:
            new.append(asm)
        for n in new:
            key = n["ask"].strip().lower()
            if key in sealed or key in seen:
                continue
            seen.add(key)
            made.append(n)
    assume = [r for r in made if r["aug"] == "assume"]
    rng.shuffle(assume)
    keep_assume = {r["id"] for r in assume[:250]}
    made = [r for r in made if r["aug"] != "assume" or r["id"] in keep_assume]
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "aug.jsonl").write_text("".join(json.dumps(r) + "\n" for r in made))
    print(f"{len(made)} new cards from {len(rows)}:", dict(Counter(r["aug"] for r in made)), "→", out / "aug.jsonl")


if __name__ == "__main__":
    main()
