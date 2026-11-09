#!/usr/bin/env python3
"""Score bake-off runs written by `cargo test bakeoff -- --ignored` (src-tauri/src/bakeoff.rs).

    python3 tools/cards/bakeoff_score.py data/cards/bakeoff/runs/*.jsonl [--show 5]

Each ask has a prior turn on a different topic (a stale-context trap) and a few `want` stems that
a card about the ask should mention. A card counts as good when it
  - was produced and is well formed (root defined, every statement used, the kind's component
    present, steps lists 2 to 6 items, and with local content the content parsed),
  - mentions at least one `want` stem from the ask (it answers what was asked), and
  - mentions none of the prior turn's topic words (it did not follow the stale context).
"""
import argparse
import collections
import json
import os
import re
import statistics

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MAIN = {"compare": ("Comparison(", "Compare("), "steps": ("Steps(",), "rank": ("Rank(",), "place": ("Quadrant(",),
        "weigh": ("Weighing(",), "draft": ("Draft(",)}
CONTENT_KINDS = {"compare", "rank", "place", "weigh", "draft"}
STR = re.compile(r'"((?:[^"\\]|\\.)*)"')


def asks(path):
    return {a["id"]: a for a in map(json.loads, open(path, encoding="utf-8")) if a}


def strings(program):
    """Every string literal, with the embedded JSON `data` string opened up."""
    out = []
    for lit in STR.findall(program):
        try:
            text = json.loads('"' + lit + '"')
        except json.JSONDecodeError:
            text = lit
        out.append(text)
        if text.startswith("{"):
            try:
                out.extend(json.dumps(json.loads(text), ensure_ascii=False).split('"'))
            except json.JSONDecodeError:
                pass
    return " ".join(out).lower()


def well_formed(kind, program, content_mode, record):
    lines = [l for l in program.splitlines() if re.match(r"^\w+\s*=", l)]
    names = [re.match(r"^(\w+)\s*=", l).group(1) for l in lines]
    if "root" not in names:
        return "no root"
    body = "\n".join(lines)
    # A reference to a statement that was never written leaves a hole in the card. A statement
    # nothing refers to is harmless (the renderer ignores it; see ui.rs), so it is not a failure.
    defined = set(names)
    for line in lines:
        rhs = STR.sub('""', line.split("=", 1)[1])
        for ref in re.findall(r"\b([A-Za-z_]\w*)\b(?!\s*\()", rhs):
            if ref not in defined and ref not in ("true", "false", "null"):
                return f"unresolved {ref}"
    if not any(tok in program for tok in MAIN[kind]):
        return "kind component missing"
    if kind == "steps":
        m = re.search(r"Steps\(\[(.*?)\]\)", program, re.S)
        n = len(STR.findall(m.group(1))) if m else 0
        if not 2 <= n <= 6:
            return f"{n} steps"
    if content_mode == "local" and kind in CONTENT_KINDS:
        if "content_error" in record:
            return "content: " + str(record["content_error"])[:60]
        if "data" not in program:
            return "no data"
    return None


def judge(record, ask):
    kind = record["kind"]
    if "program" not in record:
        return "no program" if "error" not in record else str(record["error"])[:40]
    problem = well_formed(kind, record["program"], record.get("content", "none"), record)
    if problem:
        return problem
    text = strings(record["program"])
    ask_words = ask["ask"].lower()
    # With labels only, a card that takes its words from content (rank, place...) cannot name the ask's things.
    labels_only = record.get("content", "none") == "none" and kind in CONTENT_KINDS and kind in ("rank", "place")
    if not labels_only and not any(w in text for w in ask["want"]):
        return "off topic"
    stale = [w for w in ask["avoid"] if w in text and w not in ask_words]
    if stale:
        return "stale: " + stale[0]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--asks", default=os.path.join(ROOT, "data", "cards", "bakeoff", "asks.jsonl"))
    ap.add_argument("--show", type=int, default=0, help="print this many failures per run")
    a = ap.parse_args()
    table = asks(a.asks)
    kinds = ["steps", "compare", "rank", "place", "weigh", "draft"]
    print(f"{'run':<42}" + "".join(f"{k:>9}" for k in kinds) + f"{'all':>8}{'p50 s':>8}")
    for path in a.runs:
        records = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
        good, total, why = collections.Counter(), collections.Counter(), collections.defaultdict(list)
        for r in records:
            verdict = judge(r, table[r["id"]])
            total[r["kind"]] += 1
            if verdict is None:
                good[r["kind"]] += 1
            else:
                why[r["kind"]].append((r["id"], verdict))
        cells = "".join(f"{good[k]:>4}/{total[k]:<4}" if total[k] else f"{'-':>9}" for k in kinds)
        times = [(r.get("writer_ms", 0) + r.get("content_ms", 0)) / 1000 for r in records]
        name = os.path.basename(path)[:-6]
        print(f"{name:<42}{cells}{sum(good.values()):>4}/{sum(total.values()):<3}{statistics.median(times) if times else 0:>8.1f}")
        if a.show:
            for k in kinds:
                for ident, verdict in why[k][:a.show]:
                    print(f"    {k:<8}{ident}  {verdict}")


if __name__ == "__main__":
    main()
