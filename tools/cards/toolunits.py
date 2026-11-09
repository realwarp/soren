#!/usr/bin/env python3
"""Unit-aware tool cards (prototype): the code does the unit conversions, the model only chooses how quantities combine.

In toolspec.py a formula carries its own conversion constants (`/ 3600`, `* 1000`, `/ 1024`), and a wrong constant is the
most common wrong-but-confident answer. Here every variable declares a unit from a closed table, formulas are evaluated
on quantities (value in base units + dimension), and the result is converted to the unit the output declares.

    base units: seconds, bytes, dollars.  Sizes are binary (KB = 1024 B), bit sizes and link rates are decimal
    (1 Gb = 125,000,000 B; Gbps = Gb/s), a month is 30 days, a year is 365 days, "%" is a fraction (65 % = 0.65).

Rules a card must satisfy (all checked here, none left to the model):
  1. every var and output unit parses against the table (count words like "workers" are dimensionless and flagged `loose`
     only when they are not on the known-noun list);
  2. a formula adds and subtracts only quantities of the same dimension, takes ln of a dimensionless value, sqrt of even powers;
  3. the formula's dimension equals the dimension of the output's declared unit; the shown value is converted to that unit;
  4. no bare conversion constants (60, 24, 1000, 1024, 3600, 100, 8, ...) in formulas: the units already do that.

    python3 tools/cards/toolunits.py selftest
"""
from __future__ import annotations

import math
import re
import sys

DIM_NAMES = ("time", "data", "money", "mass", "length")
ZERO = (0, 0, 0, 0, 0)

# unit -> (dimension exponents over (seconds, bytes, dollars, kilograms, metres), factor to base units). Mass and length are
# in the dimensions but no unit uses them: adding physical units to the table (and so to the grammar) made the writer worse on
# everyday asks (1 Nov, held-out: wrong-confident 3 -> 6 of 80), so they wait for a model trained on them.
_T, _D, _M = (1, 0, 0, 0, 0), (0, 1, 0, 0, 0), (0, 0, 1, 0, 0)
UNITS: dict[str, tuple[tuple[int, int, int], float]] = {
    "us": (_T, 1e-6), "ms": (_T, 1e-3), "s": (_T, 1.0), "min": (_T, 60.0), "h": (_T, 3600.0), "day": (_T, 86400.0),
    "week": (_T, 604800.0), "month": (_T, 30 * 86400.0), "year": (_T, 365 * 86400.0),
    "B": (_D, 1.0), "KB": (_D, 1024.0), "MB": (_D, 1024.0 ** 2), "GB": (_D, 1024.0 ** 3), "TB": (_D, 1024.0 ** 4), "PB": (_D, 1024.0 ** 5),
    "bit": (_D, 0.125), "Kb": (_D, 125.0), "Mb": (_D, 125e3), "Gb": (_D, 125e6), "Tb": (_D, 125e9),
    "$": (_M, 1.0), "USD": (_M, 1.0), "cent": (_M, 0.01), "%": (ZERO, 0.01), "x": (ZERO, 1.0),
    "k": (ZERO, 1e3), "M": (ZERO, 1e6), "bn": (ZERO, 1e9),   # counts in thousands, millions, billions
}
ALIASES = {"sec": "s", "secs": "s", "seconds": "s", "second": "s", "minute": "min", "minutes": "min", "mins": "min", "hr": "h", "hrs": "h",
           "hour": "h", "hours": "h", "days": "day", "d": "day", "weeks": "week", "wk": "week", "mo": "month", "months": "month",
           "yr": "year", "years": "year", "bytes": "B", "byte": "B", "bits": "bit", "percent": "%", "pct": "%", "dollars": "$", "cents": "cent", "c": "cent", "¢": "cent",
           "Kbps": "Kb/s", "Mbps": "Mb/s", "Gbps": "Gb/s", "Tbps": "Tb/s", "rps": "req/s", "qps": "q/s", "tps": "tx/s", "wps": "w/s"}
TIME_NAMES = ("second", "minute", "hour", "day", "week", "month", "year")
ALIASES.update({"second": "s", "minute": "min", "hour": "h"})
# words that name a countable thing: dimensionless, accepted without a flag
NOUNS = set("""req request requests q query queries tx w r msg msgs message messages call calls conn conns connection connections
node nodes worker workers box boxes pod pods instance instances inst replica replicas shard shards partition partitions core cores
thread threads user users client clients job jobs item items key keys record records row rows event events line lines chunk chunks
copy copies try tries retry retries attempt attempts trip trips snap snaps person people count n unit units server servers vm vms
host hosts disk disks task tasks packet packets page pages file files object objects part parts RTT write writes read reads
batch batches session sessions token tokens epoch epochs step steps evt evts event post posts doc docs op ops reqs rec recs
sess wr att rep follower followers action actions upload uploads image images mover movers piece pieces""".split())

# bare numbers in a formula that are really unit conversions: the units do these, so a card may not
FORBIDDEN_CONSTANTS = {8, 12, 24, 30, 60, 100, 360, 365, 720, 730, 1000, 1024, 3600, 86400, 1e6, 1e9, 1048576, 1073741824}


class UnitError(ValueError):
    pass


Unit = tuple[tuple[int, ...], float, bool]   # dims, factor to base, loose (contains an unknown word)


def parse_unit(text: str) -> Unit:
    """'req/s' -> (T^-1, 1, False); 'MB/s' -> (D/T, 1024^2, False); '$/GB-mo' -> $ per (GB * month)."""
    t = (text or "").strip()
    if not t or t in ("-", "1"):
        return ZERO, 1.0, False
    t = re.sub(r"^per\s+", "/", t)
    t = re.sub(r"\s+per\s+", "/", t)
    if t in ALIASES and "/" in ALIASES[t]:
        t = ALIASES[t]
    num, _, den = t.partition("/")
    dims, factor, loose = [0] * len(ZERO), 1.0, False

    def apply(part: str, sign: int) -> None:
        nonlocal factor, loose
        for tok in re.split(r"[-*·]", part):
            tok = tok.strip()
            if not tok:
                continue
            tok = ALIASES.get(tok, tok)
            if "/" in tok:   # alias such as Gbps -> Gb/s inside a longer expression
                a, _, b = tok.partition("/")
                apply(a, sign)
                apply(b, -sign)
                continue
            if tok in UNITS:
                d, f = UNITS[tok]
                for i in range(len(dims)):
                    dims[i] += sign * d[i]
                factor *= f ** sign
            elif tok.lower() in NOUNS or tok in NOUNS:
                pass
            else:
                loose = True

    apply(num, 1)
    apply(den, -1)
    return tuple(dims), factor, loose


# ---- quantities --------------------------------------------------------------------------------

Q = tuple[float, tuple[int, ...]]


def _zero(q: Q) -> bool:
    return q[0] == 0 and q[1] == ZERO


def _same(a: Q, b: Q, what: str) -> None:
    if a[1] != b[1] and not (_zero(a) or _zero(b)):
        raise UnitError(f"{what}: cannot combine {dim_text(a[1])} with {dim_text(b[1])}")


def dim_text(d: tuple[int, ...]) -> str:
    parts = [f"{n}^{e}" if e != 1 else n for n, e in zip(DIM_NAMES, d) if e]
    return "*".join(parts) or "a plain number"


def _add(a: Q, b: Q, sign: int) -> Q:
    _same(a, b, "+/-")
    return (a[0] + sign * b[0], b[1] if _zero(a) else a[1])


def _mul(a: Q, b: Q) -> Q:
    return (a[0] * b[0], tuple(x + y for x, y in zip(a[1], b[1])))


def _div(a: Q, b: Q) -> Q:
    if b[0] == 0:
        raise UnitError("division by zero")
    return (a[0] / b[0], tuple(x - y for x, y in zip(a[1], b[1])))


def _plain(q: Q, what: str) -> float:
    if q[1] != ZERO:
        raise UnitError(f"{what} needs a plain number, got {dim_text(q[1])}")
    return q[0]


def _fn(name: str, args: list[Q]) -> Q:
    n = len(args)
    if name in ("min", "max"):
        if n < 2:
            raise UnitError(f"{name} needs two values")
        for a in args[1:]:
            _same(args[0], a, name)
        return ((min if name == "min" else max)(a[0] for a in args), next((a[1] for a in args if not _zero(a)), ZERO))
    if name in ("ceil", "floor", "abs"):
        a = args[0]
        # a ceil of a quantity rounds in base units; rounding makes sense for counts, so require a plain number
        if name != "abs":
            _plain(a, name)
        return ({"ceil": math.ceil, "floor": math.floor, "abs": abs}[name](a[0]), a[1])
    if name == "round":
        a = args[0]
        digits = int(_plain(args[1], "round digits")) if n > 1 else 0
        return (math.floor(a[0] * 10 ** digits + 0.5) / 10 ** digits, a[1])
    if name == "sqrt":
        a = args[0]
        if any(e % 2 for e in a[1]):
            raise UnitError("sqrt of an odd power of a unit")
        return (math.sqrt(a[0]), tuple(e // 2 for e in a[1]))
    if name == "ln":
        return (math.log(_plain(args[0], "ln")), ZERO)
    # percent helpers: percentages are fractions here (65 % = 0.65), no /100 anywhere
    if name == "percent_of":
        return _mul(args[0], (_plain(args[1], name), ZERO))
    if name == "add_percent":
        return (args[0][0] * (1 + _plain(args[1], name)), args[0][1])
    if name == "less_percent":
        return (args[0][0] * (1 - _plain(args[1], name)), args[0][1])
    if name == "before_percent":
        return (args[0][0] / (1 - _plain(args[1], name)), args[0][1])
    if name == "as_percent":
        _same(args[0], args[1], name)
        return (args[0][0] / args[1][0], ZERO)
    if name == "percent_change":
        _same(args[0], args[1], name)
        return ((args[1][0] - args[0][0]) / args[0][0], ZERO)
    if name == "grow":
        return (args[0][0] * (1 + _plain(args[1], name)) ** _plain(args[2], name), args[0][1])
    if name == "periods_to_reach":
        _same(args[0], args[1], name)
        return (math.log(args[1][0] / args[0][0]) / math.log(1 + _plain(args[2], name)), ZERO)
    raise UnitError(f"unknown function {name}")


_TOKEN = re.compile(r"\d+\.?\d*(?:e[+-]?\d+)?|[A-Za-z_]\w*|\S", re.I)


def evaluate(src: str, env: dict[str, Q], allow_constants: bool = False) -> Q:
    toks = _TOKEN.findall(src)
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take():
        t = peek()
        pos[0] += 1
        return t

    def expr() -> Q:
        v = term()
        while peek() in ("+", "-"):
            op = take()
            v = _add(v, term(), 1 if op == "+" else -1)
        return v

    def term() -> Q:
        v = unary()
        while peek() in ("*", "/"):
            op = take()
            r = unary()
            v = _mul(v, r) if op == "*" else _div(v, r)
        return v

    def unary() -> Q:
        if peek() == "-":
            take()
            v = unary()
            return (-v[0], v[1])
        return power()

    def power() -> Q:
        base = atom()
        if peek() == "^":
            take()
            e = unary()
            ex = _plain(e, "exponent")
            if base[1] != ZERO and ex != int(ex):
                raise UnitError("a unit raised to a fractional power")
            return (base[0] ** ex, tuple(int(x * ex) for x in base[1]))  # type: ignore[return-value]
        return base

    def atom() -> Q:
        t = take()
        if t is None:
            raise UnitError("the formula ends too early")
        if t[0].isdigit():
            v = float(t)
            if not allow_constants and v in FORBIDDEN_CONSTANTS:
                raise UnitError(f"bare conversion constant {t}: the units already convert")
            return (v, ZERO)
        if t == "(":
            v = expr()
            if take() != ")":
                raise UnitError("missing )")
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
                    raise UnitError("missing )")
                try:
                    return _fn(t, args)
                except (IndexError, TypeError):
                    # a call with the wrong number of values, such as as_percent(x): the card is invalid, not a crash
                    raise UnitError(f"{t}() was given the wrong number of values")
            if t in env:
                return env[t]
            u = ALIASES.get(t, t)
            if u in UNITS and u not in ("%", "x") and "/" not in u:
                # a unit name stands for one of that unit (`year`, `h`, `GB`): `rate * year` needs no 365, `ceil(t / h) * h` rounds up to whole hours
                return (UNITS[u][1], UNITS[u][0])
            if t in TIME_NAMES:
                return (UNITS[ALIASES.get(t, t)][1], _T)
            raise UnitError(f"unknown name {t}")
        raise UnitError(f"unexpected {t}")

    v = expr()
    if pos[0] < len(toks):
        raise UnitError(f"unexpected {toks[pos[0]]}")
    if not math.isfinite(v[0]):
        raise UnitError("not a finite number")
    return v


# ---- running a card ----------------------------------------------------------------------------

def run(spec: dict, values: dict[str, float] | None = None) -> dict[str, float]:
    """Shown value of every output, each in the unit it declares. `values` overrides slider values (in each var's unit)."""
    env: dict[str, Q] = {}
    shown: dict[str, float] = {}
    for v in spec["vars"]:
        dims, factor, _ = parse_unit(v.get("unit", ""))
        x = (values or {}).get(v["id"], v["start"])
        env[v["id"]] = (x * factor, dims)
        shown[v["id"]] = x
    for o in spec["outputs"]:
        dims, factor, _ = parse_unit(o.get("unit", ""))
        q = evaluate(o["formula"], env)
        if q[1] != dims:
            raise UnitError(f"{o['id']}: the formula gives {dim_text(q[1])} but the output says '{o.get('unit', '')}' ({dim_text(dims)})")
        env[o["id"]] = q
        shown[o["id"]] = q[0] / factor
    return shown


def answer(spec: dict, values: dict[str, float] | None = None) -> float:
    return run(spec, values)[spec["outputs"][0]["id"]]


def problems(spec: dict) -> list[str]:
    """Unit-level faults that make a card unusable, empty when the card is clean."""
    out = []
    for kind in ("vars", "outputs"):
        for item in spec.get(kind, []):
            if parse_unit(item.get("unit", ""))[2]:
                out.append(f"unknown unit '{item.get('unit')}' on {item['id']}")
    try:
        run(spec)
    except UnitError as e:
        out.append(str(e))
    except (KeyError, ZeroDivisionError, OverflowError, ValueError) as e:
        out.append(f"cannot evaluate: {e}")
    return out



# ---- repairs code can make for certain: a unit label that does not match what the formula measures ----------------

_TIME_UNITS = ["s", "min", "h", "day", "month", "year"]


def _pool(dim_index: int) -> list[str]:
    """Display units for one base dimension, smallest first."""
    out = [(f, u) for u, (d, f) in UNITS.items() if d[dim_index] == 1 and sum(map(abs, d)) == 1 and u not in ("USD", "cent", "bit", "Kb", "Mb", "Gb", "Tb", "us", "ms", "week")]
    return [u for _, u in sorted(out)]


def candidate_units(dims: tuple[int, ...]) -> list[tuple[str, float]]:
    """Unit strings that measure `dims` (each base dimension to the power 1 or -1), with their factor to base units."""
    if dims == ZERO:
        return [("", 1.0)]
    if any(dims[3:]) or any(abs(e) > 1 for e in dims):
        return []
    num = [_pool(i) for i in range(3) if dims[i] == 1]
    den = [_pool(i) for i in range(3) if dims[i] == -1]
    combos: list[list[str]] = [[]]
    out: list[tuple[str, float]] = []

    def build(pools: list[list[str]]) -> list[list[str]]:
        acc: list[list[str]] = [[]]
        for pool in pools:
            acc = [a + [u] for a in acc for u in pool]
        return acc

    for n in build(num):
        for d in build(den):
            text = "*".join(n) + ("/" + "-".join(d) if d else "")
            if not n:
                text = "/" + "-".join(d)
            _, factor, loose = parse_unit(text)
            if not loose:
                out.append((text, factor))
    return out


def repair_units(spec: dict, relabel: bool = False) -> dict:
    """Make unit labels honest where that is certain: unknown words become plain counts. With relabel=True an output whose unit
    does not match its formula is also relabelled; held-out tests showed that turns invalid cards into confident wrong ones
    (4 of 8), so it stays off."""
    import json as _json
    s = _json.loads(_json.dumps(spec))
    if not isinstance(s, dict) or not isinstance(s.get("vars"), list) or not isinstance(s.get("outputs"), list):
        return s
    for item in s["vars"] + s["outputs"]:
        if not isinstance(item, dict):
            continue
        u = str(item.get("unit", "") or "")
        if parse_unit(u)[2]:
            keep = [t for t in re.split(r"[\s/\-*·]+", u) if t and (ALIASES.get(t, t) in UNITS)]
            item["unit"] = keep[0] if len(keep) == 1 and "/" not in u else ""
    if not relabel:
        return s
    try:
        env: dict[str, Q] = {}
        for v in s["vars"]:
            dims, factor, _ = parse_unit(v.get("unit", ""))
            env[v["id"]] = (v["start"] * factor, dims)
        for o in s["outputs"]:
            dims, factor, _ = parse_unit(o.get("unit", ""))
            q = evaluate(o["formula"], env)
            if q[1] != dims:
                fixed = None
                if q[1] == ZERO and len(dims) == len(ZERO) and o.get("unit", "") in UNITS:
                    # a plain number under a unit label: the number is meant to be in that unit
                    o["formula"] = f"({o['formula']}) * {o['unit']}"
                    q = evaluate(o["formula"], env)
                    fixed = True
                else:
                    cands = candidate_units(q[1])
                    if cands:
                        v0 = abs(q[0]) or 1.0
                        best = min(cands, key=lambda c: abs(math.log10(max(v0 / c[1], 1e-12)) - 1.5))
                        o["unit"] = best[0]
                        fixed = True
                if fixed is None:
                    return s
            env[o["id"]] = q
    except (UnitError, KeyError, ZeroDivisionError, OverflowError, ValueError, TypeError):
        return s
    return s


def unit_rule() -> str:
    """GBNF rule for the unit text: only words the unit table or the count nouns know, joined by / - *."""
    words = sorted(set(UNITS) | set(ALIASES) | NOUNS | {"mo"}, key=lambda w: (-len(w), w))
    alt = " | ".join('"' + w.replace('"', '') + '"' for w in words)
    return ('unit ::= "\\"" (uterm (usep uterm){0,3})? "\\"" | "\\"/" uterm (usep uterm){0,2} "\\""\n'
            'usep ::= "/" | "-" | "*"\n'
            f"uterm ::= {alt}\n")


def shape_problems(spec: dict, ask: str | None = None) -> list[str]:
    """Everything toolspec.problems checks, with formulas evaluated by this module instead of the old evaluator."""
    import random
    import toolspec as ts
    if not isinstance(spec, dict) or spec.get("decline") is not None or not spec.get("outputs"):
        return getattr(ts, "_old_problems", ts.problems)(spec, ask)
    ids = [v["id"] for v in spec.get("vars", []) if isinstance(v, dict) and "id" in v]
    stub = dict(spec, outputs=[dict(o, formula=" + ".join(ids) or "0") for o in spec["outputs"]])   # formula-free structure checks
    # the structure checks run on the stub with the old evaluator (they only need numbers, not units)
    swapped = (ts.run, ts.answer)
    if hasattr(ts, "_old_run"):
        ts.run, ts.answer = ts._old_run, ts._old_answer
    try:
        found = getattr(ts, "_old_problems", ts.problems)(stub, ask)
    finally:
        ts.run, ts.answer = swapped
    out = [m for m in found if "changes nothing" not in m and "repeats an input" not in m]
    if out:
        return out
    out += problems(spec)
    if out:
        return out
    try:
        base = {v["id"]: v["start"] for v in spec["vars"]}
        ref = run(spec, base)
        for v in spec["vars"]:
            # a slider matters if moving it anywhere in its range (ends, or half and one and a half times the start) changes an output
            tries = [v["min"], v["max"], max(v["min"], min(v["max"], v["start"] * 0.5)), max(v["min"], min(v["max"], v["start"] * 1.5))]
            moved = False
            for x in tries:
                try:
                    r = run(spec, dict(base, **{v["id"]: x}))
                except (UnitError, ZeroDivisionError, OverflowError, ValueError):
                    continue
                if any(abs(r[o["id"]] - ref[o["id"]]) >= 1e-9 for o in spec["outputs"]):
                    moved = True
                    break
            if not moved:
                out.append(f"{v['id']} changes nothing")
        rng = random.Random(1)
        for _ in range(6):
            run(spec, {v["id"]: rng.uniform(v["min"], v["max"]) for v in spec["vars"]})
    except (UnitError, ZeroDivisionError, OverflowError, ValueError) as e:
        out.append(f"formula: {e}")
    if spec["outputs"][0]["formula"].strip() in base:
        out.append("the answer just repeats an input")
    return out


# ---- self test ---------------------------------------------------------------------------------

def _card(vars_: list[tuple], outs: list[tuple]) -> dict:
    return {"vars": [{"id": i, "unit": u, "start": s, "label": i, "min": 0, "max": 1e9, "step": 1, "from": "message"} for i, u, s in vars_],
            "outputs": [{"id": i, "unit": u, "formula": f, "label": i} for i, u, f in outs]}


def selftest() -> int:
    fails = 0

    def check(name: str, got, want, tol: float = 1e-9) -> None:
        nonlocal fails
        ok = (got == want) if isinstance(want, str) else abs(got - want) <= tol * max(1, abs(want))
        if not ok:
            fails += 1
        print(("ok   " if ok else "FAIL ") + name, "" if ok else f"got {got!r} want {want!r}")

    # worker pool: 1350 jobs an hour, 9500 ms each, 65 % busy -> 6 workers, no conversion constant anywhere
    c = _card([("jobs", "/h", 1350), ("job", "ms", 9500), ("busy", "%", 65)], [("w", "workers", "ceil(jobs * job / busy)")])
    check("worker pool", answer(c), 6)
    # per-minute vs per-second: 120 req/min * 250 ms in flight = 0.5
    c = _card([("rate", "req/min", 120), ("t", "ms", 250)], [("n", "req", "rate * t")])
    check("little's law", answer(c), 0.5)
    # storage: 2 TB at 45 MB/s -> hours
    c = _card([("size", "TB", 2), ("bw", "MB/s", 45)], [("t", "h", "size / bw")])
    check("transfer time", answer(c), 2 * 1024 ** 2 / 45 / 3600)
    # bits vs bytes: 500 GB over a 1 Gbps link, binary size, decimal rate
    c = _card([("size", "GB", 500), ("link", "Gbps", 1)], [("t", "min", "size / link")])
    check("bits vs bytes", answer(c), 500 * 1024 ** 3 / 125e6 / 60)
    # cost: 3.5 TB egress at $0.09 per GB, per month
    c = _card([("egress", "TB", 3.5), ("price", "$/GB", 0.09)], [("cost", "$", "egress * price")])
    check("tiered-free price", answer(c), 3.5 * 1024 * 0.09)
    # availability: 99.9 % over a month -> allowed downtime in minutes
    c = _card([("avail", "%", 99.9)], [("d", "min", "(1 - avail) * 30 * 24 * 60")])
    c2 = _card([("avail", "%", 99.9), ("period", "month", 1)], [("d", "min", "(1 - avail) * period")])
    check("downtime with a constant is rejected", len(problems(c)), 1)
    check("downtime by units", answer(c2), 0.001 * 30 * 24 * 60)
    # a wrong output unit is caught: bytes asked as hours
    bad = _card([("size", "GB", 10), ("bw", "MB/s", 100)], [("t", "GB", "size / bw")])
    check("dimension mismatch is caught", len(problems(bad)), 1)
    # adding a time to a size is caught
    bad = _card([("size", "GB", 10), ("t", "s", 3)], [("x", "GB", "size + t")])
    check("mixed addition is caught", len(problems(bad)), 1)
    # unknown unit word is flagged
    bad = _card([("size", "gigz", 10)], [("x", "gigz", "size * 2")])
    check("unknown unit flagged on var and output", len(problems(bad)), 2)
    # a floor at zero works on any unit; `year` is one year
    c = _card([("budget", "$", 1000), ("spent", "$", 1500)], [("left", "$", "max(0, budget - spent)")])
    check("max(0, quantity)", answer(c), 0)
    c = _card([("rate", "GB/day", 10)], [("y", "TB", "rate * year")])
    check("rate times a year", answer(c), 10 * 365 / 1024)
    c = _card([("p", "cents", 4), ("n", "GB", 100)], [("c", "$", "p * n / GB_ONE")]) if False else _card([("p", "cent/GB", 4), ("n", "GB", 100)], [("c", "$", "p * n")])
    check("cents", answer(c), 4.0)
    # unit names as quantities, ^, and the full shape check
    c = _card([("t", "h", 1.2)], [("h", "h", "ceil(t / h) * h")])
    check("ceil in whole hours", answer(c), 2)
    c = _card([("a", "%", 99.9), ("n", "boxes", 3)], [("down", "%", "1 - (1 - a) ^ n")])
    check("power of a fraction", answer(c), 100 * (1 - (0.001) ** 3) * 1, 1e-6) if False else check("power of a fraction", answer(c), (1 - 0.001 ** 3) * 100, 1e-6)
    print("failures:", fails)
    return fails


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        sys.exit(1 if selftest() else 0)
    print(__doc__)
