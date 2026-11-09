#!/usr/bin/env python3
"""Does agreement between several sampled cards tell us when the model can be trusted?

    python3 tools/cards/tool_consistency.py <run> [--ckpt step_N | --adapter path.gguf] [--k 5] [--set dev]

For every ask the model writes K cards (sampled, under the grammar). If most of them decline, we decline. Otherwise
the answers at the cards' start values are grouped (within 2 percent) and the biggest group's agreement count is the
confidence. An ask is *accepted* when that count reaches a threshold; otherwise the system says it is not sure
(which counts as a decline, never as a wrong answer). The report shows, for each threshold, how many answerable
questions are accepted, how many accepted answers are right, and the wrong-but-confident rate (ceiling 5%).

No model usage is billed; it runs the local model only.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tool_checkin as ck  # noqa: E402
import tooldata as td  # noqa: E402
import tooleval as te  # noqa: E402
import toolspec as ts  # noqa: E402

PORT = 8091


def sample(url: str, ask: str, grammar: str, temp: float) -> str:
    body = {"model": "x", "stream": False, "max_tokens": 900, "temperature": temp, "top_p": 0.95,
            "chat_template_kwargs": {"enable_thinking": False}, "grammar": grammar,
            "messages": [{"role": "system", "content": ts.SYSTEM_PROMPT}, {"role": "user", "content": ask}]}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]["content"] or ""


def group(answers: list[float], rtol: float = 0.02) -> list[list[float]]:
    groups: list[list[float]] = []
    for a in sorted(answers):
        for g in groups:
            if abs(a - g[0]) <= rtol * max(abs(g[0]), 1e-9):
                g.append(a)
                break
        else:
            groups.append([a])
    return sorted(groups, key=len, reverse=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--ckpt", default="")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--temp", type=float, default=0.5)
    ap.add_argument("--set", default="dev")
    ap.add_argument("--parallel", type=int, default=0, help="cards sampled at once (default K); lower is gentler on the machine and slower")
    a = ap.parse_args()
    run = ck.RUNS / a.run
    par = a.parallel or a.k
    ckpt = run / "ckpt" / a.ckpt if a.ckpt else pathlib.Path((run / "ckpt" / "last" / "path").read_text().strip())
    adapter = ck.convert(ckpt)
    cmd = [str(ck.LLAMA / "build/bin/llama-server"), "-m", ck.BASE, "--lora", str(adapter), "--port", str(PORT), "-c", str(2048 * par), "-np", str(par),
           "-ngl", "99", "-fa", "on", "--cache-ram", "0"]
    server = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://localhost:{PORT}"
    for _ in range(90):
        try:
            if b"ok" in urllib.request.urlopen(url + "/health", timeout=1).read():
                break
        except Exception:  # noqa: BLE001
            time.sleep(2)
    rows = [json.loads(l) for l in open(td.DATA / a.set / "pass1_ok.jsonl") if l.strip()]
    grammar, per_ask = ts.grammar(), []
    try:
        for i, row in enumerate(rows):
            with cf.ThreadPoolExecutor(par) as ex:
                texts = list(ex.map(lambda _: sample(url, row["ask"], grammar, a.temp), range(a.k)))
            cards, declines = [], 0
            for t in texts:
                try:
                    c = json.loads(t)
                except ValueError:
                    continue
                if c.get("decline") is not None:
                    declines += 1
                    continue
                c = ts.repair(c)
                try:
                    problem = ts.problems(c, row["ask"])
                except Exception:  # noqa: BLE001 - a card that breaks the checker is an invalid card, never a crash
                    problem = ["the checker could not read this card"]
                if not problem:
                    try:
                        cards.append((ts.answer(c), t, c))
                    except Exception:  # noqa: BLE001
                        pass
            groups = group([x[0] for x in cards])
            best = groups[0] if groups else []
            rep = None
            if best:
                med = best[len(best) // 2]
                rep = next(t for ans, t, _ in cards if abs(ans - med) <= 1e-9 * max(1, abs(med)))
            per_ask.append({"id": row["id"], "kind": row["kind"], "decline_votes": declines, "agree": len(best), "k": a.k,
                            "judged": te.judge(row, rep)["status"] if rep else "none", "row": row})
            print(f"{i + 1}/{len(rows)} {row['id']} agree {len(best)}/{a.k} declines {declines}", flush=True)
    finally:
        server.terminate()
        server.wait()
    out = run / f"consistency_{a.ckpt or 'last'}.json"
    out.write_text(json.dumps([{k: v for k, v in p.items() if k != "row"} for p in per_ask], indent=1))

    calc = [p for p in per_ask if p["kind"] != "decline"]
    decl = [p for p in per_ask if p["kind"] == "decline"]
    print(f"\n{'accept at':>10} {'accepted':>9} {'right':>7} {'wrong+sure':>11} {'wrong rate':>11}   (calculation asks: {len(calc)}; ceiling 5%)")
    for t in range(1, a.k + 1):
        acc = [p for p in calc if p["decline_votes"] <= a.k // 2 and p["agree"] >= t]
        right = sum(1 for p in acc if p["judged"] in ("right", "soft_right"))
        wrong = len(acc) - right
        dr = sum(1 for p in decl if not (p["decline_votes"] <= a.k // 2 and p["agree"] >= t))
        print(f"{'>= ' + str(t) + ' of ' + str(a.k):>10} {len(acc):>9} {right:>7} {wrong:>11} {100 * wrong / max(1, len(calc)):>10.0f}%   declines kept right: {dr}/{len(decl)}")
    print("saved", out)


if __name__ == "__main__":
    main()
