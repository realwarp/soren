#!/usr/bin/env python3
"""Rejection sampling: let a trained adapter write several cards per verified ask, keep the ones that are right.

    python3 tools/cards/tool_rs.py <run> --ckpt step_733 --out rs1 [--k 6] [--temp 0.8] [--only unkept|all] [--limit N]

Every verified ask in the data pool (waves pilot, a1, a2, a3; never dev or test) has a reference answer. The model samples K
cards under the grammar; each is judged against the reference exactly as the dev scorer does. Output, under
data/cards/tool/<out>/:

    samples.jsonl   one line per ask: id, wave, kind, how many of K were right, whether Haiku's card was kept before
    kept.jsonl      training rows (id, ask, card, ...): up to --keep distinct correct cards for asks that were NOT in the
                    Haiku-kept set (new coverage), plus, for asks that were, only cards whose formula differs from Haiku's

Runs the local model only; no usage is billed.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import pathlib
import random
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tool_checkin as ck  # noqa: E402
import tool_consistency as tc  # noqa: E402
import tooldata as td  # noqa: E402
import tooleval as te  # noqa: E402
import toolspec as ts  # noqa: E402

WAVES = ["pilot", "a1", "a2", "a3"]


def pool() -> list[dict]:
    rows = []
    for w in WAVES:
        base = td.DATA / w
        kept_file = base / ("train_ready.jsonl" if w == "pilot" else "kept.jsonl")
        kept = {}
        for l in open(kept_file):
            if l.strip():
                r = json.loads(l)
                kept[r["id"]] = r["card"]
        for l in open(base / "pass1_ok.jsonl"):
            if l.strip():
                r = json.loads(l)
                r["wave"], r["haiku_card"] = w, kept.get(r["id"])
                rows.append(r)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--k", type=int, default=6)
    ap.add_argument("--temp", type=float, default=0.8)
    ap.add_argument("--keep", type=int, default=2)
    ap.add_argument("--only", choices=["unkept", "all"], default="unkept")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--seed", type=int, default=3)
    a = ap.parse_args()
    out = td.DATA / a.out
    out.mkdir(parents=True, exist_ok=True)
    adapter = ck.convert(ck.RUNS / a.run / "ckpt" / a.ckpt)
    rows = pool()
    if a.only == "unkept":
        rows = [r for r in rows if r["haiku_card"] is None]
    random.Random(a.seed).shuffle(rows)
    if a.limit:
        rows = rows[: a.limit]
    done = set()
    if (out / "samples.jsonl").exists():
        done = {json.loads(l)["id"] for l in open(out / "samples.jsonl") if l.strip()}
    rows = [r for r in rows if r["id"] not in done]
    print(f"{len(rows)} asks to sample, K={a.k}, T={a.temp}", flush=True)

    cmd = [str(ck.LLAMA / "build/bin/llama-server"), "-m", ck.BASE, "--lora", str(adapter), "--port", str(tc.PORT), "-c", str(2048 * a.k),
           "-np", str(a.k), "-ngl", "99", "-fa", "on", "--cache-ram", "0"]
    server = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://localhost:{tc.PORT}"
    for _ in range(90):
        try:
            if b"ok" in urllib.request.urlopen(url + "/health", timeout=1).read():
                break
        except Exception:  # noqa: BLE001
            time.sleep(2)
    grammar, t0 = ts.grammar(), time.time()
    try:
        with open(out / "samples.jsonl", "a") as fs, open(out / "kept.jsonl", "a") as fk:
            for i, row in enumerate(rows):
                with cf.ThreadPoolExecutor(a.k) as ex:
                    texts = list(ex.map(lambda _: tc.sample(url, row["ask"], grammar, a.temp), range(a.k)))
                good, seen = [], set()
                haiku_formula = row["haiku_card"]["outputs"][0]["formula"] if row["haiku_card"] else None
                for t in texts:
                    j = te.judge(row, t)
                    if j["status"] not in ("right", "soft_right", "declined_right"):
                        continue
                    card = ts.repair(json.loads(t))
                    sig = "decline" if card.get("decline") is not None else card["outputs"][0]["formula"]
                    if sig in seen or (haiku_formula is not None and sig == haiku_formula):
                        continue
                    seen.add(sig)
                    good.append(card)
                n_right = sum(1 for t in texts if te.judge(row, t)["status"] in ("right", "soft_right", "declined_right"))
                fs.write(json.dumps({"id": row["id"], "wave": row["wave"], "kind": row["kind"], "area": row["area"], "cell": row.get("cell"),
                                     "right": n_right, "k": a.k, "had_haiku_card": row["haiku_card"] is not None}) + "\n")
                for n, card in enumerate(good[: a.keep]):
                    fk.write(json.dumps({"id": f"RS_{row['id']}_{n}", "ask": row["ask"], "kind": row["kind"], "area": row["area"], "card": card}) + "\n")
                fs.flush(); fk.flush()
                if (i + 1) % 10 == 0:
                    el = time.time() - t0
                    print(f"{i + 1}/{len(rows)} asks, {el / 60:.1f} min, {el / (i + 1) * (len(rows) - i - 1) / 60:.0f} min left", flush=True)
    finally:
        server.terminate()
        server.wait()
    print("done", flush=True)


if __name__ == "__main__":
    main()
