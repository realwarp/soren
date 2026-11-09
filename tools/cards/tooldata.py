#!/usr/bin/env python3
"""Tool-card training data: assignments, briefs for the Haiku agents, and the checks on what they write.

Two passes by different agents, then code decides what to keep:

  pass 1  asker and solver: writes the question and a reference solution, twice, independently
  pass 2  card writer: sees only the question and writes the card (the shape in toolspec.py)
  code    keeps an example only when the card's answer equals the reference

    python tools/cards/tooldata.py assign  <wave> <prefix> <agents> <answerable> <underspec> <decline> [--held-out-weight 1] [--no-held-out] [--twists]
    python tools/cards/tooldata.py verify1 <wave>      # reference double-check, dedupe, decontamination
    python tools/cards/tooldata.py briefs2 <wave> <agents>
    python tools/cards/tooldata.py score2  <wave>      # join cards to references, keep the right ones
    python tools/cards/tooldata.py status  <wave>

Everything lives under data/cards/tool/<wave>/ (git-ignored; never commit data/).
"""
from __future__ import annotations

import ast
import json
import math
import pathlib
import random
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import toolspec as ts  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "cards" / "tool"
TAX = json.loads((pathlib.Path(__file__).parent / "tool_taxonomy.json").read_text())

# ---- safe evaluation of the agents' reference expressions -------------------------------------

_REF_FUNCS = {"sqrt": math.sqrt, "ceil": math.ceil, "floor": math.floor, "log": math.log, "exp": math.exp,
              "min": min, "max": max, "round": round, "abs": abs, "sum": sum, "range": range}
_OK = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Call, ast.Name, ast.Constant, ast.Load, ast.Add, ast.Sub, ast.Mult, ast.Div,
       ast.Pow, ast.Mod, ast.FloorDiv, ast.USub, ast.UAdd, ast.GeneratorExp, ast.ListComp, ast.comprehension, ast.Store,
       ast.IfExp, ast.Compare, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq, ast.NotEq, ast.BoolOp, ast.And, ast.Or, ast.Tuple, ast.List)


def ref_eval(expr: str, names: dict[str, float]) -> float:
    tree = ast.parse(expr, mode="eval")
    for n in ast.walk(tree):
        if not isinstance(n, _OK):
            raise ValueError(f"not allowed: {type(n).__name__}")
        if isinstance(n, ast.Call) and not (isinstance(n.func, ast.Name) and n.func.id in _REF_FUNCS):
            raise ValueError("call not allowed")
        if isinstance(n, ast.Constant) and not isinstance(n.value, (int, float)):
            raise ValueError("only numbers")
    v = eval(compile(tree, "<ref>", "eval"), {"__builtins__": {}, **_REF_FUNCS}, dict(names))  # noqa: S307 (whitelisted AST)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError("not a finite number")
    return float(v)


# ---- units: the same answer in hours or minutes is still the same answer -----------------------

_TIME = {"ms": 1e-3, "millisecond": 1e-3, "s": 1, "sec": 1, "second": 1, "min": 60, "minute": 60, "h": 3600, "hr": 3600, "hour": 3600,
         "day": 86400, "week": 604800}
_DATA = {"b": 1, "byte": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12, "pb": 1e15}


def unit_factor(unit: str | None):
    """(dimension, factor to the base unit) for a leading time or data unit word, else None."""
    if not unit:
        return None
    word = re.match(r"\s*([A-Za-z]+)", unit)
    if not word:
        return None
    w = word.group(1).lower().rstrip("s") if word.group(1).lower() not in ("s", "ms") else word.group(1).lower()
    if w in _TIME:
        return ("time", _TIME[w])
    if w in _DATA:
        return ("data", _DATA[w])
    return None


def same_answer(card: dict, ref: float, ref_unit: str | None, rtol: float = 0.02) -> str | None:
    """How the card's answer agrees with the reference: 'exact', 'units', or None."""
    try:
        got = ts.answer(card)
    except Exception:  # noqa: BLE001
        return None
    close = lambda a, b: abs(a - b) <= rtol * max(abs(b), 1e-9)  # noqa: E731
    if close(got, ref):
        return "exact"
    if abs(ref - round(ref)) < 1e-9 and math.ceil(got - 1e-9) == round(ref) or abs(ref - round(ref)) < 1e-9 and round(got) == round(ref) and got != round(got):
        return "rounded"   # the reference is a whole number (servers, months) and the card's answer rounds to it
    uc, ur = unit_factor(card["outputs"][0].get("unit")), unit_factor(ref_unit)
    if uc and ur and uc[0] == ur[0]:
        factor = ur[1] / uc[1]
        # data sizes are quoted in steps of 1000 or 1024, so allow a few of the 2.4 percent steps
        slack = [1.024 ** k for k in range(-4, 5)] if uc[0] == "data" else [1.0]
        if any(close(got, ref * factor * f) for f in slack):
            return "units"
    return None


# ---- briefs ----------------------------------------------------------------------------------

CONVENTIONS = """Conventions (use these whenever the question does not say otherwise):
- Headroom of X percent means spare capacity. The capacity you provision is the load divided by (1 - X/100), so you run at (100 - X) percent utilisation at peak. For example 30 percent headroom on a peak of 700 means provisioning for 700 / 0.7 = 1000.
- A month is 30 days (720 hours) and a year is 365 days.
- Storage and memory sizes are binary: 1 TB = 1024 GB, 1 GB = 1024 MB, 1 MB = 1024 KB. Network and link rates are decimal: 1 Gbps = 1000 Mbps, and a byte is 8 bits.
"""

BRIEF1 = """You are helping build a training set for a small calculator assistant. Work alone. Do not read or search any other files in this repository or on this computer: use only this brief.

Your job: write {n} realistic questions that software and systems engineers type when they want a quick calculation, each with a reference solution. The table at the end gives, for every row, its id, kind, area, the specific situation (cell) the question must be about, and the writing style.

Write your result to {out} as JSON Lines: exactly one JSON object per line, nothing else in the file, {n} lines in the same order as the table. When done, reply with one line: how many rows you wrote.

Fields by kind:
- answerable: id, area, cell, kind, ask, inputs, ref_a, ref_b, unit
- underspecified: id, area, cell, kind, ask, inputs, assumptions, ref_a, ref_b, unit
- decline: id, area, cell (copy the theme), kind, ask, decline_reason

Definitions:
- ask: the question exactly as the person would type it, 1 to 3 sentences, in the given style. Use realistic numbers that are not all round. Never mention formulas, cards, calculators or tools.
- inputs: an object mapping short snake_case names to the numbers the ask states (every number the references use that appears in the ask, and no others). Plain numbers, not strings: 2M events is 2000000, 99.9% is 99.9, 250 ms is 250.
- answerable: the ask states every number needed. The only numbers the references may use that are not in inputs are universal constants: 60 (seconds per minute, minutes per hour), 24, 7, 30 or 365 (days), 1024 (storage size steps), 1000 (network rate steps and ms to s), 8 (bits per byte), 100 (percent).
- underspecified: the ask leaves out one or two numbers a sensible engineer would assume. Put what you assumed in assumptions (name to number). The references use both inputs and assumptions. Never put the assumed numbers in the ask.
- ref_a and ref_b: each is a single Python expression over the names in inputs (and assumptions) using + - * / **, parentheses, and only these functions: sqrt, ceil, floor, log, exp, min, max, round, abs, sum, range. It returns the one number that answers the question. ref_b must be derived independently of ref_a, by a different route (a different decomposition, a different order of unit conversions, or working with the complement), not a copy with renamed parts. They must agree numerically. Use ceil or floor where whole servers, agents or instances are natural.
- unit: what the answer is measured in, a few words.
- decline: the ask sounds like a systems question but is not a calculation (see the theme). decline_reason is one short line saying why no calculator fits.

Rules: no two rows alike; vary magnitudes and scenarios; keep each ask self-contained; follow each row's style.

{conventions}

Example rows (examples only; do not reuse their scenarios):
{{"id":"X001","area":"capacity","cell":"servers needed for a peak requests per second given per-server capacity and headroom","kind":"answerable","ask":"we expect 4.2k req/s at peak and each box does 350 req/s, want 25% headroom, how many boxes","inputs":{{"peak_rps":4200,"per_server_rps":350,"headroom_pct":25}},"ref_a":"ceil(peak_rps / (per_server_rps * (1 - headroom_pct / 100)))","ref_b":"ceil(peak_rps / per_server_rps / (1 - headroom_pct / 100))","unit":"servers"}}
{{"id":"X002","area":"caching","cell":"theme: which technology to choose","kind":"decline","ask":"redis or memcached for session storage?","decline_reason":"A choice between tools, with no numbers to compute."}}

Rows:
{table}
"""

BRIEF2 = """You write small calculator cards for questions that engineers ask. Work alone. Read only the file named below: do not read or search any other files in this repository or on this computer.

Read the questions in {inp} (a JSON list of {{"id","ask"}}). For each, write one card. Write all cards to {out} as JSON Lines: one object per line, {{"id": ..., "card": {{...}}}}, nothing else in the file, {n} lines in the same order. When done, reply with one line: how many cards you wrote.

A card is a JSON object with exactly these keys:
- plan: 2 to 5 plain sentences naming the quantities, their time periods (per second, per day, per month) and how they combine to give the answer. Write the reasoning here first.
- decline: null for a calculation. If the question is not a calculation (it asks which tool to pick, to explain something, to write code, or for an opinion), set decline to a one-line reason, and then title is "", vars is [] and outputs is [].
- title: a short name for the card (under 40 characters).
- vars: 1 to 6 numbers the person can change. Each: id (lowercase letters, digits and underscores, starting with a letter, at most 15 characters, unique), label, unit (a few characters), min, max, step, start, from. min < max, min <= start <= max, step > 0, and (max - min) / step between 1 and 5000, with a sensible slider range around start. from is "message" when start is a number the question states, otherwise "assumed". A number the question states must be "message" with exactly that value. If a needed number is missing, assume a sensible value and mark it "assumed". Do not invent numbers and call them "message".
- outputs: 1 to 4 results in the order they are computed. Each: id (unique, not a var id), label, unit, formula. The FIRST output is the answer to the question. A formula may use var ids and the ids of earlier outputs, numbers, + - * / ^ ( ), the functions min, max, round, ceil, floor, sqrt, abs, ln, and these helpers where they fit (percent arguments are plain numbers, 20 means 20%): percent_of(total, percent), add_percent(base, percent), less_percent(base, percent), before_percent(result, percent) (the amount before a percent was taken out), as_percent(part, whole), percent_change(old, new), grow(start, percent, periods), periods_to_reach(start, target, percent), payment(principal, yearly_percent, months), months_to_clear(principal, yearly_percent, payment). No other functions exist: no pow, if, sum or range. Powers are written with ^. Changing any var must change at least one output. Choose the slider ranges so that no output goes negative or divides by zero anywhere inside them.

Convert units inside the formulas (minutes to hours, bytes to GB) and keep every number in a formula either a var or an obvious constant such as 60, 24, 1000, 100.

{conventions}

Example question: "How many support agents do I need for 900 tickets a week if each takes 12 minutes?"
{{"plan":"Weekly workload in hours is tickets times minutes each divided by 60. Agents needed is that workload divided by the hours one agent works in a week, rounded up.","decline":null,"title":"Support agents","vars":[{{"id":"tickets","label":"Tickets a week","unit":"tickets","min":100,"max":3000,"step":50,"start":900,"from":"message"}},{{"id":"minutes","label":"Minutes each","unit":"min","min":1,"max":60,"step":1,"start":12,"from":"message"}},{{"id":"week","label":"Hours per agent per week","unit":"h","min":10,"max":60,"step":1,"start":40,"from":"assumed"}}],"outputs":[{{"id":"agents","label":"Agents needed","unit":"agents","formula":"ceil(tickets * minutes / 60 / week)"}}]}}
Example decline: "redis or memcached for session storage?"
{{"plan":"This asks which tool to choose, so there is nothing to calculate.","decline":"A choice between tools, with no numbers to compute.","title":"","vars":[],"outputs":[]}}
"""


def _write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _read_jsonl(path: pathlib.Path) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                rows.append({"_bad": line[:80]})
    return rows


# ---- assign ----------------------------------------------------------------------------------

def assign(wave: str, prefix: str, agents: int, n_ans: int, n_under: int, n_dec: int, held_w: float, no_held: bool, seed: int = 7, twists: bool = False) -> None:
    rng = random.Random(f"{wave}{seed}")
    areas = [a for a in TAX["areas"] if not (no_held and a["held_out"])]
    weights = [a["share"] * (held_w if a["held_out"] else 1) for a in areas]
    kinds = ["answerable"] * n_ans + ["underspecified"] * n_under + ["decline"] * n_dec
    rng.shuffle(kinds)
    cell_use: Counter = Counter()
    rows = []
    for i, kind in enumerate(kinds):
        area = rng.choices(areas, weights)[0]
        if kind == "decline":
            cell = "theme: " + rng.choice(TAX["decline_themes"])
        else:
            options = sorted(area["cells"], key=lambda c: (cell_use[(area["id"], c)], rng.random()))
            cell = options[0]
            cell_use[(area["id"], cell)] += 1
            if twists:   # a targeted wave: every ask also has to contain one of these unit or structure traps
                cell += " | include this trap, adjusting the scenario slightly if it does not fit: " + TAX["twists"][i % len(TAX["twists"])]
        rows.append({"id": f"{prefix}{i + 1:03d}", "kind": kind, "area": area["id"], "cell": cell, "style": rng.choice(TAX["styles"])})
    per = math.ceil(len(rows) / agents)
    for k in range(agents):
        chunk = rows[k * per:(k + 1) * per]
        if not chunk:
            continue
        table = "\n".join(f"| {r['id']} | {r['kind']} | {r['area']} | {r['cell']} | {r['style']} |" for r in chunk)
        table = "| id | kind | area | cell | style |\n| --- | --- | --- | --- | --- |\n" + table
        out = DATA / wave / f"pass1_{k + 1}.jsonl"
        _write(DATA / wave / f"assign_{k + 1}.json", json.dumps(chunk, indent=1))
        _write(DATA / wave / f"brief1_{k + 1}.md", BRIEF1.format(n=len(chunk), out=out, table=table, conventions=CONVENTIONS))
    print(f"{wave}: {len(rows)} rows across {math.ceil(len(rows) / per)} agents; areas:",
          dict(Counter(r['area'] for r in rows)), dict(Counter(r['kind'] for r in rows)))


# ---- verify pass 1 ---------------------------------------------------------------------------

def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def _jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / max(1, len(a | b))


def sealed_asks(exclude_wave: str) -> list[tuple[str, set[str]]]:
    out = []
    for wave in ("dev", "test"):
        if wave == exclude_wave:
            continue
        p = DATA / wave / "pass1_ok.jsonl"
        if p.exists():
            out += [(f"{wave}:{r['id']}", _tokens(r["ask"])) for r in _read_jsonl(p)]
    return out


def verify1(wave: str) -> None:
    assigned = {}
    for f in sorted((DATA / wave).glob("assign_*.json")):
        for r in json.loads(f.read_text()):
            assigned[r["id"]] = r
    got = {}
    for f in sorted((DATA / wave).glob("pass1_[0-9]*.jsonl")):
        for r in _read_jsonl(f):
            got[r.get("id")] = r
    ok, drops = [], Counter()
    seen: list[tuple[str, set[str]]] = []
    sealed = sealed_asks(wave) if wave not in ("dev", "test") else []
    for rid, spec in assigned.items():
        r = got.get(rid)
        if not r or "_bad" in r:
            drops["missing or not JSON"] += 1
            continue
        if r.get("kind") != spec["kind"] or not isinstance(r.get("ask"), str) or len(r["ask"]) < 12:
            drops["wrong kind or bad ask"] += 1
            continue
        tk = _tokens(r["ask"])
        if any(_jaccard(tk, t) > 0.8 for _, t in seen):
            drops["near duplicate"] += 1
            continue
        if any(_jaccard(tk, t) > 0.6 for _, t in sealed):
            drops["too close to a sealed set"] += 1
            continue
        if spec["kind"] == "decline":
            if not r.get("decline_reason"):
                drops["decline without reason"] += 1
                continue
            r.update(area=spec["area"], cell=spec["cell"], style=spec["style"])
            ok.append(r); seen.append((rid, tk))
            continue
        try:
            num = lambda v: int(v) if float(v).is_integer() else float(v)  # noqa: E731  (range() needs ints)
            inputs = {k: num(v) for k, v in r["inputs"].items()}
            assumed = {k: num(v) for k, v in r.get("assumptions", {}).items()} if spec["kind"] == "underspecified" else {}
            names = {**inputs, **assumed}
            a, b = ref_eval(r["ref_a"], names), ref_eval(r["ref_b"], names)
        except Exception as e:  # noqa: BLE001
            drops[f"reference error: {str(e)[:40]}"] += 1
            continue
        if abs(a - b) > 0.005 * max(abs(a), 1e-9):
            drops["ref_a and ref_b disagree"] += 1
            continue
        nums = ts.numbers_in(r["ask"])
        missing = [k for k, v in inputs.items() if not any(abs(v - n) <= 1e-9 * max(1, abs(v)) for n in nums)]
        if missing:
            drops["an input is not in the ask"] += 1
            continue
        if spec["kind"] == "underspecified" and not assumed:
            drops["underspecified without assumptions"] += 1
            continue
        r.update(area=spec["area"], cell=spec["cell"], style=spec["style"], reference=a, inputs=inputs)
        ok.append(r); seen.append((rid, tk))
    _write(DATA / wave / "pass1_ok.jsonl", "\n".join(json.dumps(r) for r in ok) + "\n")
    print(f"{wave} pass 1: kept {len(ok)} of {len(assigned)}")
    for k, v in drops.most_common():
        print(f"  dropped {v}: {k}")


# ---- pass 2 ----------------------------------------------------------------------------------

def briefs2(wave: str, agents: int) -> None:
    rows = _read_jsonl(DATA / wave / "pass1_ok.jsonl")
    per = math.ceil(len(rows) / agents)
    for k in range(agents):
        chunk = rows[k * per:(k + 1) * per]
        if not chunk:
            continue
        inp, out = DATA / wave / "in2" / f"asks_{k + 1}.json", DATA / wave / f"pass2_{k + 1}.jsonl"
        _write(inp, json.dumps([{"id": r["id"], "ask": r["ask"]} for r in chunk], indent=1))
        _write(DATA / wave / f"brief2_{k + 1}.md", BRIEF2.format(inp=inp, out=out, n=len(chunk), conventions=CONVENTIONS))
    print(f"{wave}: pass 2 briefs for {len(rows)} asks, {agents} agents")


def score2(wave: str) -> None:
    ref = {r["id"]: r for r in _read_jsonl(DATA / wave / "pass1_ok.jsonl")}
    cards = {}
    for f in sorted((DATA / wave).glob("pass2_[0-9]*.jsonl")):
        for r in _read_jsonl(f):
            if "id" in r and "card" in r:
                cards[r["id"]] = r["card"]
    kept, drops = [], Counter()
    by_kind: defaultdict = defaultdict(lambda: [0, 0])
    by_area: defaultdict = defaultdict(lambda: [0, 0])
    for rid, r in ref.items():
        by_kind[r["kind"]][1] += 1
        by_area[r["area"]][1] += 1
        card = cards.get(rid)
        if card is None:
            drops["no card"] += 1
            continue
        if r["kind"] == "decline":
            good = isinstance(card, dict) and card.get("decline") and ts.problems(card, r["ask"]) == []
            if not good:
                drops["should have declined"] += 1
                continue
            kept.append({**r, "card": card, "soft": False})
        else:
            if isinstance(card, dict) and card.get("decline") is not None:
                drops["declined an answerable ask"] += 1
                continue
            card = ts.repair(card) if isinstance(card, dict) else card
            probs = ts.problems(card, r["ask"])
            if probs:
                drops[f"invalid: {re.sub(r'[a-z0-9_]+: ', '', probs[0])[:40]}"] += 1
                continue
            got = ts.answer(card)
            if r["kind"] == "answerable":
                how = same_answer(card, r["reference"], r.get("unit"))
                if how is None:
                    drops["answer does not match the reference"] += 1
                    continue
                kept.append({**r, "card": card, "soft": False, "match": how})
            else:
                has_assumed = any(v["from"] == "assumed" for v in card["vars"])
                ratio = got / r["reference"] if r["reference"] else math.inf
                if not has_assumed or not (1 / 3 <= ratio <= 3):
                    drops["underspecified: no assumed var or answer far from reference"] += 1
                    continue
                kept.append({**r, "card": card, "soft": True})
        by_kind[r["kind"]][0] += 1
        by_area[r["area"]][0] += 1
    _write(DATA / wave / "kept.jsonl", "\n".join(json.dumps(r) for r in kept) + "\n")
    total = len(ref)
    print(f"{wave} pass 2: kept {len(kept)} of {total} ({100 * len(kept) / max(total, 1):.0f}% yield)")
    print("  by kind:", {k: f"{a}/{b}" for k, (a, b) in by_kind.items()})
    print("  by area:", {k: f"{a}/{b}" for k, (a, b) in by_area.items()})
    for k, v in drops.most_common():
        print(f"  dropped {v}: {k}")


# ---- migrating a convention change ------------------------------------------------------------

_SIZE = re.compile(r"\b\d[\d,\.]*\s*(?:k|m|g|t|p)i?b\b|\bterabyte|\bgigabyte|\bmegabyte|\bpetabyte|\bTB\b|\bGB\b|\bMB\b|\bPB\b", re.I)

MIGRATE_BRIEF = """Some reference solutions were written with decimal storage sizes (1000 per step). The convention has changed. Work alone and read only this file.

{conventions}
For each row below, keep the question and the inputs exactly as they are, and rewrite ref_a and ref_b so they follow the conventions above: every conversion between storage or memory size units (KB, MB, GB, TB, bytes) uses 1024; network and link rates (Mbps, Gbps) and conversions between milliseconds and seconds still use 1000; a byte is 8 bits; 60, 24, 100 and 365/30 stay as they are. The two expressions must be derived independently of each other (different decomposition or order), use only the names in inputs (plus assumptions where listed) and the functions sqrt, ceil, floor, log, exp, min, max, round, abs, sum, range, and agree numerically. If a row has nothing to change under the new convention, return it unchanged.

Write {out} as JSON Lines: one object per row, in the same order, with exactly the fields id, ref_a, ref_b. Nothing else in the file. When done, reply with one line: how many rows you wrote.

Rows (JSON Lines: id, ask, inputs, assumptions, unit, old ref_a, old ref_b):
{rows}
"""


def affected(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r["kind"] != "decline" and not r.get("migrated") and _SIZE.search(r["ask"])
            and "1000" in r.get("ref_a", "") + r.get("ref_b", "")]


def migrate(wave: str) -> None:
    rows = _read_jsonl(DATA / wave / "pass1_ok.jsonl")
    aff = affected(rows)
    body = "\n".join(json.dumps({"id": r["id"], "ask": r["ask"], "inputs": r["inputs"], "assumptions": r.get("assumptions", {}),
                                  "unit": r.get("unit"), "old_ref_a": r["ref_a"], "old_ref_b": r["ref_b"]}) for r in aff)
    out = DATA / wave / "migrated.jsonl"
    _write(DATA / wave / "brief_migrate.md", MIGRATE_BRIEF.format(conventions=CONVENTIONS, out=out, rows=body))
    print(f"{wave}: {len(aff)} rows to migrate -> {DATA / wave / 'brief_migrate.md'}")


def apply_migrate(wave: str) -> None:
    path = DATA / wave / "pass1_ok.jsonl"
    rows = _read_jsonl(path)
    new = {r["id"]: r for r in _read_jsonl(DATA / wave / "migrated.jsonl") if "id" in r}
    kept, dropped, changed = [], [], 0
    for r in rows:
        if r["id"] not in {a["id"] for a in affected(rows)}:
            kept.append(r)
            continue
        m = new.get(r["id"])
        try:
            names = {**r["inputs"], **{k: v for k, v in r.get("assumptions", {}).items()}}
            a, b = ref_eval(m["ref_a"], names), ref_eval(m["ref_b"], names)
            if abs(a - b) > 0.005 * max(abs(a), 1e-9):
                raise ValueError("disagree")
        except Exception as e:  # noqa: BLE001
            dropped.append((r["id"], str(e)[:40]))
            continue
        changed += abs(a - r["reference"]) > 1e-9 * max(1, abs(a))
        kept.append({**r, "ref_a": m["ref_a"], "ref_b": m["ref_b"], "reference_old": r["reference"], "reference": a, "migrated": True})
    _write(path, "\n".join(json.dumps(r) for r in kept) + "\n")
    print(f"{wave}: {len(kept)} rows kept, {changed} references changed, dropped {dropped}")


def retire(wave: str) -> None:
    """Remove the affected rows from a wave outright (used for the pilot, which only feeds the dry run)."""
    path = DATA / wave / "pass1_ok.jsonl"
    rows = _read_jsonl(path)
    gone = {r["id"] for r in affected(rows)}
    _write(path, "\n".join(json.dumps(r) for r in rows if r["id"] not in gone) + "\n")
    for name in ("kept.jsonl", "kept_all.jsonl"):
        f = DATA / wave / name
        if f.exists():
            _write(f, "\n".join(json.dumps(r) for r in _read_jsonl(f) if r["id"] not in gone) + "\n")
    print(f"{wave}: retired {len(gone)} rows: {sorted(gone)}")


def status(wave: str) -> None:
    d = DATA / wave
    for pat in ("assign_*.json", "pass1_[0-9]*.jsonl", "pass1_ok.jsonl", "pass2_[0-9]*.jsonl", "kept.jsonl"):
        files = sorted(d.glob(pat))
        n = sum(len(_read_jsonl(f)) for f in files if f.suffix == ".jsonl")
        print(f"{pat:22s} {len(files)} files" + (f", {n} rows" if pat.endswith("jsonl") else ""))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__)
    elif a[0] == "assign":
        hw = float(a[a.index("--held-out-weight") + 1]) if "--held-out-weight" in a else 1.0
        assign(a[1], a[2], int(a[3]), int(a[4]), int(a[5]), int(a[6]), hw, "--no-held-out" in a, twists="--twists" in a)
    elif a[0] == "verify1":
        verify1(a[1])
    elif a[0] == "briefs2":
        briefs2(a[1], int(a[2]))
    elif a[0] == "score2":
        score2(a[1])
    elif a[0] == "status":
        status(a[1])
    elif a[0] == "migrate":
        migrate(a[1])
    elif a[0] == "apply-migrate":
        apply_migrate(a[1])
    elif a[0] == "retire":
        retire(a[1])
    else:
        print(__doc__)
