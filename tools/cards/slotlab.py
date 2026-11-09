#!/usr/bin/env python3
"""Slot lab: build each card from a reply with code, the model filling only short slots.

    python3 tools/cards/slotlab.py run   --url http://127.0.0.1:8083/v1 --name lfm3 [--modes ask,natural,primed]
    python3 tools/cards/slotlab.py score data/cards/bakeoff/runs/slots-*.jsonl [--show 3]

The model is asked for one small JSON object whose exact shape a per-request grammar enforces
(a comparison's rows have exactly one cell per column; a ranking has 3 to 5 items; ...). Code
turns it into the OpenLang program in the forms the app already renders. Sources per mode:
  ask      only what the person said (the model must know the facts itself),
  natural  the person's message and a normal reply,
  primed   the person's message and a reply written so its substance is stated plainly.
A grounding check then asks whether every slot string is supported by the source text; a card that
fails is dropped (the reply stands alone). Prototype for the Rust port; the held-out asks and
replies live in data/cards/bakeoff/.
"""
import argparse
import collections
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BAKE = os.path.join(ROOT, "data", "cards", "bakeoff")

# ---- grammar -------------------------------------------------------------------------------

COMMON = r'''
ws ::= " "?
str ::= "\"" [^"\\\n]{1,90} "\""
cell ::= "\"" [^"\\\n]{1,70} "\""
text ::= "\"" [^"\\\n]{1,700} "\""
digit ::= [1-5]
'''


def commas(n, item):
    return " \", \" ".join([item] * n)


def grammar(kind, weigh="neutral"):
    if kind == "compare":
        alts, defs = [], []
        for k in (2, 3, 4):
            alts.append(f"c{k}")
            defs.append(f'c{k} ::= "{{\\"title\\": " str ", \\"columns\\": [" {commas(k, "str")} "], \\"rows\\": [" r{k} (", " r{k}){{1,4}} "]}}"')
            defs.append(f'r{k} ::= "[" {commas(k + 1, "cell")} "]"')
        return "root ::= " + " | ".join(alts) + "\n" + "\n".join(defs) + COMMON
    if kind == "steps":
        return 'root ::= "{\\"title\\": " str ", \\"items\\": [" str (", " str){1,5} "]}"\n' + COMMON
    if kind == "rank":
        return 'root ::= "{\\"label\\": " str ", \\"items\\": [" str (", " str){2,4} "]}"\n' + COMMON
    if kind == "place":
        return 'root ::= "{\\"title\\": " str ", \\"xLabel\\": " str ", \\"yLabel\\": " str ", \\"items\\": [" str (", " str){2,5} "]}"\n' + COMMON
    if kind == "weigh":
        alts, defs = [], []
        for o in (2, 3, 4):
            for c in (3, 4, 5):
                name = f"w{o}{c}"
                alts.append(name)
                if weigh == "judged":
                    crit = commas(c, "crit")
                    row = f'"[" {commas(c, "digit")} "]"'
                    defs.append(f'{name} ::= "{{\\"title\\": " str ", \\"options\\": [" {commas(o, "str")} "], \\"criteria\\": [" {crit} "], \\"ratings\\": [" {" \", \" ".join([f"row{c}"] * o)} "]}}"')
                    defs.append(f'row{c} ::= {row}')
                else:
                    defs.append(f'{name} ::= "{{\\"title\\": " str ", \\"options\\": [" {commas(o, "str")} "], \\"criteria\\": [" {commas(c, "str")} "]}}"')
        extra = '\ncrit ::= "{\\"name\\": " str ", \\"weight\\": " digit "}"' if weigh == "judged" else ""
        return "root ::= " + " | ".join(alts) + "\n" + "\n".join(sorted(set(defs))) + extra + COMMON
    if kind == "draft":
        return 'root ::= "{\\"draftKind\\": " dk ", \\"label\\": " str ", \\"text\\": " text "}"\ndk ::= "\\"message\\"" | "\\"summary\\""\n' + COMMON
    raise ValueError(kind)


# ---- prompts -------------------------------------------------------------------------------

SHAPES = {
    "compare": 'Reply {"title": short title, "columns": [the 2 to 4 THINGS being compared, one name each], "rows": [2 to 5 rows; each row is [what they are compared on, then one short cell (under 8 words) for EACH column]]}. Use only the options and facts in the text. Example for "tea or coffee": {"title": "Tea vs coffee", "columns": ["Tea", "Coffee"], "rows": [["Caffeine", "Lower", "Higher"], ["Taste", "Mild", "Strong"]]}',
    "steps": 'Reply {"title": what the steps achieve, "items": [2 to 6 steps in order, each under 10 words]}. Use the steps in the text. Example: {"title": "Bake bread", "items": ["Mix flour, water and yeast", "Let the dough rise", "Bake until golden"]}',
    "rank": 'Reply {"label": a short question such as "What matters most?", "items": [the 3 to 5 items the person listed, copied exactly as they wrote them]}.',
    "place": 'Reply {"title": short title, "xLabel": first dimension, "yLabel": second dimension, "items": [the 3 to 6 items the person listed, copied exactly as they wrote them]}.',
    "weigh": 'Reply {"title": short title, "options": [the 2 to 4 options the person named, copied exactly], "criteria": [3 to 5 things the person said they care about, each a short phrase]}.',
    "draft": 'Reply {"draftKind": "message" or "summary", "label": who or what it is for, in a few words, "text": the draft itself, written as the person, one paragraph, no placeholders}.',
}
SYSTEM = "You fill in the data for one card. Reply with one JSON object only. Use only what the text says; never add a fact, an option or a step that is not in it. Keep phrases short."


# What the person listed or cares about is in their own message; only steps, the cells of a table and a
# judged weighing need the reply.
FROM_ASK = {"rank", "place"}


def prompt(kind, ask, reply, weigh):
    if kind in FROM_ASK or (kind == "weigh" and weigh == "neutral"):
        reply = None
    shape = SHAPES[kind]
    if kind == "weigh" and weigh == "judged":
        shape = shape.replace("each a short phrase]}", 'each {"name": phrase, "weight": 1-5}], "ratings": [for each option, one 1-5 number per criterion]}')
    src = f"The person said:\n{ask}\n" + (f"\nSoren replied:\n{reply}\n" if reply else "")
    return SYSTEM, f"{src}\n{shape}"


def things_grammar():
    return 'root ::= "{\\"title\\": " str ", \\"things\\": [" cell ", " cell (", " cell){0,2} "]}"\n' + COMMON


def rows_grammar(things):
    keys = " \", \" ".join(f'"\\"{t}\\": " cell'.replace('\\"' + t + '\\"', '\\"' + t.replace("\\", "").replace('"', "") + '\\"') for t in things)
    row = '"{\\"aspect\\": " cell ", " ' + keys.replace('" cell', '" cell') + ' "}"'
    return 'root ::= "{\\"rows\\": [" row (", " row){1,3} "]}"\nrow ::= ' + row + "\n" + COMMON


def fill_compare(url, ask, reply, sampling):
    src = f"The person said:\n{ask}\n" + (f"\nSoren replied:\n{reply}\n" if reply else "")
    first = f"The person said:\n{ask}\n"
    t1, ms1 = call(url, SYSTEM, first + '\nName the 2 to 4 things the person wants compared, exactly as they named them, and a short title, one short name each, and a short title. Reply {"title": ..., "things": [...]}. Example: {"title": "Tea vs coffee", "things": ["Tea", "Coffee"]}', things_grammar(), sampling, 120)
    head = json.loads(t1)
    things = [t.strip() for t in head["things"]]
    t2, ms2 = call(url, SYSTEM, src + f'\nThe things are {json.dumps(things)}. Give 2 to 4 aspects the text compares them on. Each row names the aspect and gives one short cell (under 8 words) for each thing, using only facts from the text. Reply {{"rows": [{{"aspect": ..., "{things[0]}": ..., "{things[1]}": ...}}]}}', rows_grammar(things), sampling, 400)
    rows = json.loads(t2)["rows"]
    d = {"title": head["title"], "columns": things, "rows": [[r["aspect"]] + [r[t] for t in things] for r in rows]}
    return d, t1 + "\n" + t2, ms1 + ms2


# ---- assembly ------------------------------------------------------------------------------

def esc(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')


def lit(value):
    return esc(json.dumps(value, ensure_ascii=False))


def assemble(kind, d, weigh):
    q = lambda s: '"' + esc(s) + '"'
    if kind == "steps":
        return f'root = Stack([t, st])\nt = TextContent({q(d["title"])}, "large-heavy")\nst = Steps([{", ".join(q(i) for i in d["items"])}])'
    if kind == "compare":
        data = {"columns": d["columns"], "rows": d["rows"]}
        return f'root = Stack([c])\nc = Comparison({q(d["title"])}, data)\ndata = "{lit(data)}"'
    if kind == "rank":
        return f'root = Stack([r])\nr = Rank("order", {q(d["label"])}, data)\ndata = "{lit({"items": d["items"]})}"'
    if kind == "place":
        return f'root = Stack([p])\np = Quadrant("place", {q(d["title"])}, {q(d["xLabel"])}, {q(d["yLabel"])}, data)\ndata = "{lit({"items": d["items"]})}"'
    if kind == "weigh":
        if weigh == "judged":
            data = {"options": d["options"], "criteria": d["criteria"], "ratings": d["ratings"]}
        else:
            data = {"options": d["options"], "criteria": [{"name": c, "weight": 3} for c in d["criteria"]],
                    "ratings": [[3] * len(d["criteria"]) for _ in d["options"]]}
        return f'root = Stack([w])\nw = Weighing({q(d["title"])}, data)\ndata = "{lit(data)}"'
    if kind == "draft":
        return f'root = Stack([d])\nd = Draft({q(d["draftKind"])}, {q(d["label"])}, data)\ndata = "{lit({"text": d["text"], "itemId": ""})}"'


# ---- grounding ------------------------------------------------------------------------------

STOP = set("the a an and or of to in on for with is are was were be it its this that these those as at by from your you my we our i me they them their his her not no but if then than so do does did can will would should about into over per vs versus more most less least very just also have has had how what which who when where why one two three four five first next last each any some".split())


def stem(w):
    for suf in ("ing", "ed", "es", "s", "ly"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: -len(suf)]
    return w


def toks(text):
    return [stem(w) for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP and len(w) >= 3]


def content_slots(kind, d):
    """The strings that carry facts: not titles, labels or axis names, which are the model's own words."""
    if kind == "compare":
        return [c for c in d["columns"] if isinstance(c, str)] + [c for row in d["rows"] for c in row if isinstance(c, str)]
    if kind in ("steps", "rank", "place"):
        return [i for i in d["items"] if isinstance(i, str)]
    if kind == "weigh":
        crit = [c if isinstance(c, str) else c.get("name", "") for c in d["criteria"]]
        return [o for o in d["options"] if isinstance(o, str)] + crit
    return []


def label_slots(kind, d):
    return [v for k, v in d.items() if isinstance(v, str) and k not in ("text", "draftKind")]


def ungrounded(kind, d, source, ratio=0.5):
    """Content strings whose words are mostly absent from the source (a shared five-letter start counts as present)."""
    have = set(toks(source))
    prefixes = {w[:5] for w in have if len(w) >= 5}
    bad = []
    for s in content_slots(kind, d):
        t = toks(s)
        if t and sum(w in have or (len(w) >= 5 and w[:5] in prefixes) for w in t) / len(t) < ratio:
            bad.append(s)
    return bad


# ---- run -----------------------------------------------------------------------------------

def call(url, system, user, gram, sampling, max_tokens):
    body = {"model": "local", "stream": False, "max_tokens": max_tokens, "grammar": gram,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], **sampling}
    req = urllib.request.Request(url + "/chat/completions", json.dumps(body).encode(), {"content-type": "application/json"})
    t = time.time()
    out = json.load(urllib.request.urlopen(req, timeout=300))
    return out["choices"][0]["message"]["content"], time.time() - t


def run(a):
    asks = [json.loads(l) for l in open(os.path.join(BAKE, "asks.jsonl"), encoding="utf-8")]
    replies = collections.defaultdict(dict)
    rp = os.path.join(BAKE, "replies.jsonl")
    if os.path.exists(rp):
        for l in open(rp, encoding="utf-8"):
            if l.strip():
                r = json.loads(l)
                replies[r["id"]][r["style"]] = r["reply"]
    sampling = {"temperature": 0.1, "top_k": 50, "repeat_penalty": 1.1} if a.sampling == "lfm3" else {"temperature": 0.3, "top_p": 0.8, "top_k": 20}
    os.makedirs(os.path.join(BAKE, "runs"), exist_ok=True)
    out = open(os.path.join(BAKE, "runs", f"slots-{a.name}-{a.weigh}-{a.compare}.jsonl"), "w", encoding="utf-8")
    for ask in asks:
        kind = ask["kind"]
        if a.kinds and kind not in a.kinds.split(","):
            continue
        for mode in a.modes.split(","):
            reply = None if mode == "ask" else replies[ask["id"]].get(mode)
            if mode != "ask" and reply is None:
                continue
            system, user = prompt(kind, ask["ask"], reply, a.weigh)
            rec = {"id": ask["id"], "kind": kind, "mode": mode, "model": a.name}
            try:
                if kind == "compare" and a.compare == "two":
                    rec["json"], rec["raw"], secs = fill_compare(a.url, ask["ask"], reply, sampling)
                    rec["ms"] = round(secs * 1000)
                else:
                    text, secs = call(a.url, system, user, grammar(kind, a.weigh), sampling, 600 if kind == "draft" else 400)
                    rec["ms"] = round(secs * 1000)
                    rec["raw"] = text
                    rec["json"] = json.loads(text)
                rec["program"] = assemble(kind, rec["json"], a.weigh)
            except Exception as e:  # noqa: BLE001
                rec["error"] = str(e)[:120]
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
        print(ask["id"], kind, flush=True)
    print("wrote", out.name)


# ---- score ---------------------------------------------------------------------------------

def shape_problem(kind, d):
    n = lambda x: len(x) if isinstance(x, list) else -1
    if kind == "compare":
        k = n(d["columns"])
        if not 2 <= k <= 4 or not 2 <= n(d["rows"]) <= 5 or any(n(r) != k + 1 for r in d["rows"]):
            return "compare shape"
    elif kind == "steps" and not 2 <= n(d["items"]) <= 6:
        return "steps count"
    elif kind == "rank" and not 3 <= n(d["items"]) <= 5:
        return "rank count"
    elif kind == "place" and not 3 <= n(d["items"]) <= 6:
        return "place count"
    elif kind == "weigh" and not (2 <= n(d["options"]) <= 4 and 2 <= n(d["criteria"]) <= 5):
        return "weigh count"
    return None


def verdict(rec, ask, replies):
    if "error" in rec:
        return "error", rec["error"]
    d, kind = rec["json"], rec["kind"]
    bad = shape_problem(kind, d)
    if bad:
        return "shape", bad
    source = ask["ask"] + " " + (replies.get(rec["mode"], "") if rec["mode"] != "ask" else "")
    text = " ".join(content_slots(kind, d) + label_slots(kind, d) + ([d["text"]] if kind == "draft" else [])).lower()
    stale = [w for w in ask["avoid"] if w in text and w not in ask["ask"].lower()]
    if stale:
        return "stale", stale[0]
    # The options of a table, ranking, map or weighing are what the person named: they must be in the ask itself.
    named = {"compare": d.get("columns"), "weigh": d.get("options"), "rank": d.get("items"), "place": d.get("items")}.get(kind)
    if named:
        have = set(toks(ask["ask"]))
        prefixes = {w[:5] for w in have if len(w) >= 5}
        off = [n for n in named if isinstance(n, str) and toks(n) and sum(w in have or (len(w) >= 5 and w[:5] in prefixes) for w in toks(n)) / len(toks(n)) < 0.5]
        if off:
            return "wrong options", off[0][:40]
    if kind != "draft":
        bad = ungrounded(kind, d, source)
        if bad:
            return "dropped", bad[0][:40]
    if not any(w in text for w in ask["want"]):
        return "off topic", ""
    return "ok", ""


def score(a):
    asks = {x["id"]: x for x in map(json.loads, open(os.path.join(BAKE, "asks.jsonl"), encoding="utf-8"))}
    replies = collections.defaultdict(dict)
    for l in open(os.path.join(BAKE, "replies.jsonl"), encoding="utf-8"):
        if l.strip():
            r = json.loads(l)
            replies[r["id"]][r["style"]] = r["reply"]
    kinds = ["steps", "compare", "rank", "place", "weigh", "draft"]
    print(f"{'run / source':<34}" + "".join(f"{k:>9}" for k in kinds) + f"{'ok':>8}{'dropped':>9}{'median s':>10}")
    for path in a.runs:
        recs = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
        for mode in ("ask", "natural", "primed"):
            rs = [r for r in recs if r["mode"] == mode]
            if not rs:
                continue
            ok, per, total, why = collections.Counter(), collections.Counter(), collections.Counter(), collections.defaultdict(list)
            for r in rs:
                v, detail = verdict(r, asks[r["id"]], replies[r["id"]])
                total[r["kind"]] += 1
                per[v] += 1
                if v == "ok":
                    ok[r["kind"]] += 1
                else:
                    why[r["kind"]].append((r["id"], v, detail))
            cells = "".join(f"{ok[k]:>4}/{total[k]:<4}" if total[k] else f"{'-':>9}" for k in kinds)
            ms = sorted(r.get("ms", 0) for r in rs)
            name = os.path.basename(path)[6:-6] + " / " + mode
            print(f"{name:<34}{cells}{sum(ok.values()):>4}/{sum(total.values()):<3}{per['dropped']:>9}{ms[len(ms) // 2] / 1000:>10.1f}   other: {dict((k, v) for k, v in per.items() if k not in ('ok', 'dropped'))}")
            if a.show:
                for k in kinds:
                    for ident, v, detail in why[k][: a.show]:
                        print(f"      {k:<8}{ident} {v}: {detail}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--url", required=True)
    r.add_argument("--name", required=True)
    r.add_argument("--modes", default="ask,natural,primed")
    r.add_argument("--sampling", choices=["lfm3", "bonsai"], default="lfm3")
    r.add_argument("--weigh", choices=["neutral", "judged"], default="neutral")
    r.add_argument("--kinds", default="")
    r.add_argument("--compare", choices=["one", "two"], default="two")
    s = sub.add_parser("score")
    s.add_argument("runs", nargs="+")
    s.add_argument("--show", type=int, default=0)
    args = ap.parse_args()
    run(args) if args.cmd == "run" else score(args)
