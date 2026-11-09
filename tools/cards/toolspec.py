"""Tool-card spec: the one definition of what a trained model writes and how it is checked.

A tool card is a small JSON object: a plain-words plan, an optional decline, and (when it is a
calculation) the numbers a person can change and formulas that compute results from them.

    {"plan": "...", "decline": null, "title": "...",
     "vars":    [{"id", "label", "unit", "min", "max", "step", "start", "from"}],
     "outputs": [{"id", "label", "unit", "formula"}]}

The first output is the answer. `from` says whether a start value came from the person's message
("message") or was assumed ("assumed"). A decline has empty vars and outputs and a reason string.

Everything that generates, grades or trains on these cards imports this file, so a card means the
same thing everywhere. The Rust and TypeScript evaluators must reproduce `VECTORS` (toolspec_vectors.json).

    python tools/cards/toolspec.py check cards.jsonl     # verify {"ask", "spec"} lines
"""
from __future__ import annotations

import json
import math
import random
import re
import sys
from typing import Any

IDENT = re.compile(r"^[a-z][a-z0-9_]{0,14}$")

# ---- formula language ------------------------------------------------------------------------

def _loan_payment(principal, yearly_percent, months):
    r = yearly_percent / 1200
    return principal / months if r == 0 else principal * r / (1 - (1 + r) ** (-months))


def _months_to_clear(principal, yearly_percent, payment):
    r = yearly_percent / 1200
    return principal / payment if r == 0 else -math.log(1 - principal * r / payment) / math.log(1 + r)


# round(x) and round(x, digits) round halves up (floor(x * 10^digits + 0.5) / 10^digits), as Math.round does.
def _round(x, digits=0):
    scale = 10 ** digits
    return math.floor(x * scale + 0.5) / scale


BUILTINS = {"min": min, "max": max, "round": _round, "ceil": math.ceil, "floor": math.floor,
            "sqrt": math.sqrt, "abs": abs, "ln": math.log}
HELPERS = {
    "percent_of": lambda total, percent: total * percent / 100,
    "add_percent": lambda base, percent: base * (1 + percent / 100),
    "less_percent": lambda base, percent: base * (1 - percent / 100),
    "before_percent": lambda result, percent: result / (1 - percent / 100),
    "as_percent": lambda part, whole: part / whole * 100,
    "percent_change": lambda old, new: (new - old) / old * 100,
    "grow": lambda start, percent, periods: start * (1 + percent / 100) ** periods,
    "periods_to_reach": lambda start, target, percent: math.log(target / start) / math.log(1 + percent / 100),
    "payment": _loan_payment,
    "months_to_clear": _months_to_clear,
}
FUNCS = {**BUILTINS, **HELPERS}
_TOKEN = re.compile(r"\d+\.?\d*(?:e[+-]?\d+)?|[A-Za-z_]\w*|\S", re.I)


class FormulaError(ValueError):
    pass


def evaluate(src: str, env: dict[str, float]) -> float:
    """Evaluate a formula over `env`. Raises FormulaError for anything that is not a clean number."""
    toks = _TOKEN.findall(src)
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take():
        t = peek()
        pos[0] += 1
        return t

    def expr():
        v = term()
        while peek() in ("+", "-"):
            op, r = take(), term()
            v = v + r if op == "+" else v - r
        return v

    def term():
        v = unary()
        while peek() in ("*", "/"):
            op, r = take(), unary()
            if op == "/" and r == 0:
                raise FormulaError("division by zero")
            v = v * r if op == "*" else v / r
        return v

    def unary():
        if peek() == "-":
            take()
            return -unary()
        return power()

    def power():
        base = atom()
        if peek() == "^":
            take()
            return base ** unary()
        return base

    def atom():
        t = take()
        if t is None:
            raise FormulaError("the formula ends too early")
        if t[0].isdigit():
            return float(t)
        if t == "(":
            v = expr()
            if take() != ")":
                raise FormulaError("missing )")
            return v
        if re.match(r"[A-Za-z_]", t):
            if peek() == "(":
                take()
                args = []
                if peek() != ")":
                    args.append(expr())
                    while peek() == ",":
                        take()
                        args.append(expr())
                if take() != ")":
                    raise FormulaError("missing )")
                if t not in FUNCS:
                    raise FormulaError(f"unknown function {t}")
                try:
                    return FUNCS[t](*args)
                except (TypeError, ValueError, ZeroDivisionError, OverflowError) as e:
                    raise FormulaError(f"{t}: {e}") from None
            if t not in env:
                raise FormulaError(f"unknown name {t}")
            return env[t]
        raise FormulaError(f"unexpected {t}")

    try:
        v = expr()
        if pos[0] < len(toks):
            raise FormulaError(f"unexpected {toks[pos[0]]}")
        if isinstance(v, complex) or not math.isfinite(v):
            raise FormulaError("not a finite number")
    except OverflowError:
        raise FormulaError("number too large") from None
    return float(v)


# ---- running a card --------------------------------------------------------------------------

def start_env(spec: dict) -> dict[str, float]:
    return {v["id"]: v["start"] for v in spec["vars"]}


def run(spec: dict, env: dict[str, float] | None = None) -> dict[str, float]:
    """Values of every output for the given variable values (default: the start values)."""
    values = dict(start_env(spec) if env is None else env)
    for o in spec["outputs"]:
        values[o["id"]] = evaluate(o["formula"], values)
    return values


def answer(spec: dict, env: dict[str, float] | None = None) -> float:
    return run(spec, env)[spec["outputs"][0]["id"]]


def repair(spec: dict) -> dict:
    """Fix range slips code can fix for certain: start outside min/max, silly step counts."""
    s = json.loads(json.dumps(spec))
    for v in s.get("vars", []):
        try:
            if v["max"] > v["min"]:
                v["start"] = min(max(v["start"], v["min"]), v["max"])
                n = (v["max"] - v["min"]) / v["step"] if v["step"] > 0 else 0
                if n < 1 or n > 5000:
                    v["step"] = (v["max"] - v["min"]) / 100
        except (KeyError, TypeError):
            pass
    return s


# ---- checking a card -------------------------------------------------------------------------

# a word or letter after a number, and what it multiplies the number by (a % divides by 100)
SUFFIX = {"k": 1e3, "thousand": 1e3, "m": 1e6, "mn": 1e6, "million": 1e6, "b": 1e9, "bn": 1e9, "billion": 1e9,
          "lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "lacs": 1e5, "crore": 1e7, "crores": 1e7, "cr": 1e7, "%": 0.01}


def numbers_in(text: str) -> set[float]:
    """Every number a person wrote, with k / m / b / lakh / crore / thousand / million / % and thousands commas understood."""
    found: set[float] = set()
    for m in re.finditer(r"(\d[\d,]*\.?\d*)\s*(lakhs?|lacs?|crores?|thousand|million|billion|mn|bn|cr|k|m|b|%|x)?(?![A-Za-z0-9])", text, re.I):
        raw = m.group(1).replace(",", "")
        try:
            v = float(raw)
        except ValueError:
            continue
        found.add(v)
        mult = SUFFIX.get((m.group(2) or "").lower())
        if mult is not None:
            found.add(v * mult)
    return found


def problems(spec: Any, ask: str | None = None) -> list[str]:
    """Why a card is not usable. Empty list means valid (right is a separate question: see matches)."""
    if not isinstance(spec, dict):
        return ["not an object"]
    for key in ("plan", "decline", "title", "vars", "outputs"):
        if key not in spec:
            return [f"missing {key}"]
    if not isinstance(spec["plan"], str) or len(spec["plan"].strip()) < 20:
        return ["plan too short"]
    if spec["decline"] is not None:
        if not isinstance(spec["decline"], str) or not spec["decline"].strip():
            return ["decline must be a reason"]
        return [] if not spec["vars"] and not spec["outputs"] else ["a decline must have no vars or outputs"]
    vs, outs = spec["vars"], spec["outputs"]
    if not (1 <= len(vs) <= 6):
        return ["need 1 to 6 vars"]
    if not (1 <= len(outs) <= 4):
        return ["need 1 to 4 outputs"]
    ids = [v.get("id") for v in vs] + [o.get("id") for o in outs]
    if any(not isinstance(i, str) or not IDENT.match(i) for i in ids):
        return ["bad id"]
    if len(set(ids)) != len(ids):
        return ["duplicate ids"]
    out: list[str] = []
    for v in vs:
        try:
            lo, hi, st, s0 = v["min"], v["max"], v["step"], v["start"]
            if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (lo, hi, st, s0)):
                out.append(f"{v['id']}: not numbers")
            elif not lo < hi:
                out.append(f"{v['id']}: min must be below max")
            elif not st > 0:
                out.append(f"{v['id']}: step must be positive")
            elif not lo <= s0 <= hi:
                out.append(f"{v['id']}: start outside min and max")
            elif not 1 <= (hi - lo) / st <= 5000:
                out.append(f"{v['id']}: odd step count")
            if v.get("from") not in ("message", "assumed"):
                out.append(f"{v['id']}: from must be message or assumed")
        except KeyError as e:
            out.append(f"{v.get('id')}: missing {e}")
    if out:
        return out
    base = start_env(spec)
    try:
        run(spec, base)
        for v in vs:
            lo_env, hi_env = dict(base, **{v["id"]: v["min"]}), dict(base, **{v["id"]: v["max"]})
            a, b = run(spec, lo_env), run(spec, hi_env)
            if all(abs(a[o["id"]] - b[o["id"]]) < 1e-9 for o in outs):
                out.append(f"{v['id']} changes nothing")
        rng = random.Random(1)
        for _ in range(6):
            run(spec, {v["id"]: rng.uniform(v["min"], v["max"]) for v in vs})
    except (FormulaError, KeyError, TypeError) as e:
        return [f"formula: {e}"]
    first = outs[0]["formula"].strip()
    if first in base:
        out.append("the answer just repeats an input")
    if ask is not None:
        nums = numbers_in(ask)
        for v in vs:
            if v["from"] == "message" and not any(abs(v["start"] - n) <= 1e-9 * max(1, abs(n)) for n in nums):
                out.append(f"{v['id']}: says message but {v['start']} is not in the ask")
    return out


def matches(spec: dict, reference: float, rtol: float = 0.01, env: dict[str, float] | None = None) -> bool:
    """Is the card right? Its answer, with the variables set to the numbers in the ask, equals the reference."""
    try:
        got = answer(spec, env)
    except (FormulaError, KeyError, TypeError):
        return False
    return abs(got - reference) <= rtol * max(abs(reference), 1e-9)


# ---- grammar ---------------------------------------------------------------------------------

def grammar() -> str:
    """GBNF for llama.cpp. Only real function names can be called; ids and ranges are checked after."""
    names = " | ".join(f'"{f}"' for f in FUNCS)
    return r'''
root ::= "{\"plan\":" plan (card | decline)
card ::= ",\"decline\":null,\"title\":" str ",\"vars\":[" var ("," var){0,5} "],\"outputs\":[" out ("," out){0,3} "]}"
decline ::= ",\"decline\":" reason ",\"title\":\"\",\"vars\":[],\"outputs\":[]}"
reason ::= "\"" [^"\\\n]{1,120} "\""
plan ::= "\"" [^"\\\n]{20,600} "\""
str ::= "\"" [^"\\\n]{1,60} "\""
id ::= "\"" [a-z] [a-z0-9_]{0,14} "\""
num ::= "-"? [0-9]+ ("." [0-9]+)?
src ::= "\"message\"" | "\"assumed\""
unit ::= "\"" [^"\\\n]{0,14} "\""
var ::= "{\"id\":" id ",\"label\":" str ",\"unit\":" unit ",\"min\":" num ",\"max\":" num ",\"step\":" num ",\"start\":" num ",\"from\":" src "}"
out ::= "{\"id\":" id ",\"label\":" str ",\"unit\":" unit ",\"formula\":\"" expr "\"}"
expr ::= term (" "? op " "? term)*
op ::= "+" | "-" | "*" | "/" | "^"
term ::= num | name | "(" expr ")" | "-" term | call
name ::= [a-zA-Z] [a-zA-Z0-9_]{0,14}
call ::= fname "(" expr (", " expr)* ")"
fname ::= ''' + names + "\n"


# ---- canonical text: the one exact way a card is written ----------------------------------------
# Training text, model output under the grammar, and the checker all use this form, so the model never
# has to learn two spellings of the same card.

SYSTEM_PROMPT = ("Answer with a tool card as JSON: a short plan, then either a decline (when the question is not a "
                 "calculation) or the numbers a person can change and the formulas that compute the answer.")


def fmt_num(x: float) -> str:
    """A number the grammar accepts: no exponent, no trailing zeros, integers without a point."""
    if float(x).is_integer() and abs(x) < 1e15:
        return str(int(x))
    out = format(float(x), ".10f").rstrip("0").rstrip(".")
    return "0" if out in ("", "-0") else out


def canon_formula(f: str) -> str | None:
    """Re-spell a formula: spaces around binary operators, ', ' between arguments, no exponents."""
    toks = _TOKEN.findall(f)
    out: list[str] = []
    prev = None  # the previous token's kind: 'val' (number, name, ')') or 'op' / 'open' / 'comma' / None
    for t in toks:
        if t[0].isdigit():
            try:
                t = fmt_num(float(t))
            except ValueError:
                return None
            out.append(t); prev = "val"
        elif re.match(r"[A-Za-z_]", t):
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,14}", t):
                return None
            out.append(t); prev = "val"
        elif t == "(":
            out.append(t); prev = "open"
        elif t == ")":
            out.append(t); prev = "val"
        elif t == ",":
            out.append(", "); prev = "comma"
        elif t in "+-*/^":
            if t == "-" and prev in (None, "op", "open", "comma"):
                out.append("-")          # unary minus stays attached to what follows
            else:
                out.append(f" {t} "); prev = "op"
            if t == "-" and out[-1] == "-":
                prev = "op"
        else:
            return None
    return "".join(out)


def _clean(text: str, lo: int, hi: int) -> str | None:
    t = re.sub(r"\s+", " ", str(text)).replace('"', "'").replace("\\", "/").strip()
    return t if lo <= len(t) <= hi else None


def canonical_text(card: dict) -> str | None:
    """The exact text for a card, or None if it cannot be written in the grammar's language."""
    plan = _clean(card.get("plan", ""), 20, 600)
    if plan is None:
        return None
    if card.get("decline") is not None:
        reason = _clean(card["decline"], 1, 120)
        return None if reason is None else f'{{"plan":"{plan}","decline":"{reason}","title":"","vars":[],"outputs":[]}}'
    title = _clean(card.get("title", ""), 1, 60)
    if title is None:
        return None
    vs = []
    for v in card["vars"]:
        label, unit = _clean(v["label"], 1, 60), _clean(v.get("unit", ""), 0, 14) if v.get("unit", "") else ""
        if label is None or unit is None:
            return None
        vs.append(f'{{"id":"{v["id"]}","label":"{label}","unit":"{unit}","min":{fmt_num(v["min"])},"max":{fmt_num(v["max"])},'
                  f'"step":{fmt_num(v["step"])},"start":{fmt_num(v["start"])},"from":"{v["from"]}"}}')
    os_ = []
    for o in card["outputs"]:
        label, unit, f = _clean(o["label"], 1, 60), _clean(o.get("unit", ""), 0, 14) if o.get("unit", "") else "", canon_formula(o["formula"])
        if label is None or unit is None or f is None:
            return None
        os_.append(f'{{"id":"{o["id"]}","label":"{label}","unit":"{unit}","formula":"{f}"}}')
    return f'{{"plan":"{plan}","decline":null,"title":"{title}","vars":[{",".join(vs)}],"outputs":[{",".join(os_)}]}}'


def formula_in_grammar(f: str) -> bool:
    """A strict recogniser for the grammar's `expr` rule (mirrors grammar() exactly)."""
    pos = [0]
    n = len(f)

    def lit(s):
        if f.startswith(s, pos[0]):
            pos[0] += len(s)
            return True
        return False

    def num():
        m = re.compile(r"-?[0-9]+(\.[0-9]+)?").match(f, pos[0])
        if m:
            pos[0] = m.end()
            return True
        return False

    def name():
        m = re.compile(r"[a-zA-Z][a-zA-Z0-9_]{0,14}").match(f, pos[0])
        if m:
            pos[0] = m.end()
            return True
        return False

    def term():
        save = pos[0]
        for fn in FUNCS:                      # call ::= fname "(" expr (", " expr)* ")"
            if f.startswith(fn + "(", save):
                pos[0] = save + len(fn) + 1
                if expr():
                    while lit(", "):
                        if not expr():
                            break
                    else:
                        pass
                    if lit(")"):
                        return True
                pos[0] = save
        if num():
            return True
        if lit("-") and term():
            return True
        pos[0] = save
        if f.startswith("(", save):
            pos[0] = save + 1
            if expr() and lit(")"):
                return True
            pos[0] = save
        if name():
            return True
        pos[0] = save
        return False

    def expr():
        if not term():
            return False
        while True:
            save = pos[0]
            lit(" ")
            if pos[0] < n and f[pos[0]] in "+-*/^":
                pos[0] += 1
                lit(" ")
                if term():
                    continue
            pos[0] = save
            return True

    return expr() and pos[0] == n


def in_grammar(text: str) -> bool:
    """True when `text` is exactly what the grammar allows for a card."""
    try:
        card = json.loads(text)
    except ValueError:
        return False
    if canonical_text(card) != text:
        return False
    return all(formula_in_grammar(o["formula"]) for o in card["outputs"])


# ---- command line ----------------------------------------------------------------------------

def _check_file(path: str) -> int:
    total = valid = right = 0
    for line in open(path):
        if not line.strip():
            continue
        row = json.loads(line)
        total += 1
        spec = repair(row["spec"]) if isinstance(row.get("spec"), dict) and row["spec"].get("decline") is None else row.get("spec")
        probs = problems(spec, row.get("ask"))
        valid += not probs
        if not probs and "reference" in row and spec.get("decline") is None:
            right += matches(spec, row["reference"], env=row.get("env"))
        if probs:
            print(f"{row.get('id', total)}: {probs[0]}")
    print(f"{valid}/{total} valid" + (f", {right} match their reference" if right else ""))
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "check":
        sys.exit(_check_file(sys.argv[2]))
    if len(sys.argv) == 2 and sys.argv[1] == "grammar":
        print(grammar())
        sys.exit(0)
    print(__doc__)


# ---- unit-aware format switch --------------------------------------------------------------------
# TOOL_FORMAT=units makes run / answer / problems evaluate cards with toolunits (the code converts units) instead of
# the formulas-carry-their-own-constants evaluator above. Everything that grades or trains imports this module, so one
# environment variable switches the whole pipeline; the default is unchanged.
import os as _os  # noqa: E402

if _os.environ.get("TOOL_FORMAT") == "units":
    import toolunits as _tu  # noqa: E402

    _old_run, _old_answer = run, answer

    def run(spec, env=None):  # noqa: F811
        return _tu.run(spec, env)

    def answer(spec, env=None):  # noqa: F811
        return _tu.answer(spec, env)

    _old_problems = problems

    def problems(spec, ask=None):  # noqa: F811
        return _tu.shape_problems(spec, ask)

    _old_repair, _old_grammar = repair, grammar

    def repair(spec):  # noqa: F811
        return _tu.repair_units(_old_repair(spec))

    def grammar():  # noqa: F811
        import re as _re
        g = _old_grammar()
        return _re.sub(r'^unit ::= .*$', lambda m: _tu.unit_rule().rstrip("\n"), g, count=1, flags=_re.M)
