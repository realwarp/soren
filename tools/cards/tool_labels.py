#!/usr/bin/env python3
"""Labelled cards for the checker adapter: sample cards from a trained adapter on asks it never trained on, judge each one
against the verified reference, and keep the card text together with the verdict.

    python3 tools/cards/tool_labels.py <run> --ckpt step_733 --out labels [--k 6] [--temp 0.8] [--parallel 3]

Asks used (all have a verified reference answer; none is in dev or test):
  - every verified ask of waves c1 and c2 (R2 was never trained on them)
  - the verified asks of pilot, a1, a2, a3 whose Haiku card failed (R2 never saw those either)
Output: data/cards/tool/<out>/samples.jsonl, one line per sampled card: id, wave, kind, area, ask, card_text, status, right.
Local model only; no usage is billed. Safe to stop and rerun (finished asks are skipped).
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
import tool_consistency as tc  # noqa: E402
import tool_rs as rs  # noqa: E402
import tooldata as td  # noqa: E402
import tooleval as te  # noqa: E402
import toolspec as ts  # noqa: E402

RIGHT = ("right", "soft_right", "declined_right")


def asks() -> list[dict]:
    rows = [r for r in rs.pool() if r["haiku_card"] is None]
    for w in ("c1", "c2"):
        rows += [dict(json.loads(l), wave=w) for l in open(td.DATA / w / "pass1_ok.jsonl") if l.strip()]
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--k", type=int, default=6)
    ap.add_argument("--temp", type=float, default=0.8)
    ap.add_argument("--parallel", type=int, default=3)
    a = ap.parse_args()
    out = td.DATA / a.out
    out.mkdir(parents=True, exist_ok=True)
    path = out / "samples.jsonl"
    done = {json.loads(l)["id"] for l in open(path) if l.strip()} if path.exists() else set()
    rows = [r for r in asks() if r["id"] not in done]
    print(f"{len(rows)} asks to sample, K={a.k}, T={a.temp}, {a.parallel} at a time", flush=True)

    adapter = ck.convert(ck.RUNS / a.run / "ckpt" / a.ckpt)
    cmd = [str(ck.LLAMA / "build/bin/llama-server"), "-m", ck.BASE, "--lora", str(adapter), "--port", str(tc.PORT),
           "-c", str(2048 * a.parallel), "-np", str(a.parallel), "-ngl", "99", "-fa", "on", "--cache-ram", "0"]
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
        with open(path, "a") as f:
            for i, row in enumerate(rows):
                with cf.ThreadPoolExecutor(a.parallel) as ex:
                    texts = list(ex.map(lambda _: tc.sample(url, row["ask"], grammar, a.temp), range(a.k)))
                for n, t in enumerate(texts):
                    j = te.judge(row, t)
                    f.write(json.dumps({"id": f"{row['id']}#{n}", "ask_id": row["id"], "wave": row["wave"], "kind": row["kind"],
                                        "area": row["area"], "ask": row["ask"], "card_text": t, "status": j["status"],
                                        "right": j["status"] in RIGHT}) + "\n")
                f.flush()
                if (i + 1) % 10 == 0:
                    el = time.time() - t0
                    print(f"{i + 1}/{len(rows)} asks, {el / 60:.1f} min, {el / (i + 1) * (len(rows) - i - 1) / 60:.0f} min left", flush=True)
    finally:
        server.terminate()
        server.wait()
    print("done", flush=True)


if __name__ == "__main__":
    main()
