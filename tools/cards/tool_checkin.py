#!/usr/bin/env python3
"""Score training checkpoints on the sealed dev set while training goes on.

    python3 tools/cards/tool_checkin.py <run> [--watch] [--set dev]

For the newest checkpoint of data/cards/tool/runs/<run>/ that has not been scored:
  1. turn the LoRA adapter into a GGUF adapter (llama.cpp's converter, run in the training venv)
  2. start llama-server on the plain Q4_K_M base with that adapter applied at load
  3. have the model write a card for every dev ask (under the grammar) and score them (tooleval.py)
  4. append one line to devevals.jsonl, which the live view (tool_status.py) shows

--watch keeps going until the run has ended and its last checkpoint is scored. Checkpoints that arrive while
an evaluation is running are skipped in favour of the newest, so evaluation never falls behind.

Paths default to this machine's session folders; override with the environment variables below.
  LLAMA_CPP_DIR  a llama.cpp checkout with a build (needs LFM3 support: build 11960 or newer)
  TRAIN_PY       the Python with torch/transformers used for training (the converter runs in it)
  BASE_GGUF      LFM3-1.7B-Q4_K_M.gguf
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tooleval as te  # noqa: E402
import tooldata as td  # noqa: E402
import toolspec as ts  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRATCH = "/private/tmp/claude-501/-Users-varun-Documents-soren/0c02c11e-be8e-4b87-b2ef-54312a216f2a/scratchpad"
PERMANENT = pathlib.Path.home() / "soren-tooling"   # copy of the training venv and the llama.cpp build that survives a restart
LLAMA = pathlib.Path(os.environ.get("LLAMA_CPP_DIR", str(PERMANENT / "llamacpp/src") if (PERMANENT / "llamacpp/src").exists() else f"{SCRATCH}/llamacpp/src"))
PY = os.environ.get("TRAIN_PY", str(PERMANENT / "lorav/bin/python") if (PERMANENT / "lorav/bin/python").exists() else f"{SCRATCH}/lorav/bin/python")
BASE = os.environ.get("BASE_GGUF", str(pathlib.Path.home() / "Library/Application Support/com.soren.desktop/models/LFM3-1.7B-Q4_K_M.gguf"))
HF_MODEL = str(ROOT / "models" / "lfm3-1.7b")
RUNS = ROOT / "data" / "cards" / "tool" / "runs"
PORT = 8089


def convert(ckpt: pathlib.Path) -> pathlib.Path:
    out = ckpt / "adapter.gguf"
    if not out.exists():
        r = subprocess.run([PY, str(LLAMA / "convert_lora_to_gguf.py"), "--base", HF_MODEL, "--outfile", str(out), str(ckpt)],
                           capture_output=True, text=True, env={**os.environ, "HF_HUB_OFFLINE": "1"}, cwd=LLAMA)
        if r.returncode != 0 or not out.exists():
            raise RuntimeError("adapter conversion failed: " + r.stderr[-400:])
    return out


def serve(adapter: pathlib.Path | None) -> subprocess.Popen:
    cmd = [str(LLAMA / "build/bin/llama-server"), "-m", BASE, "--port", str(PORT), "-c", "4096", "-np", "1", "-ngl", "99", "-fa", "on", "--cache-ram", "0"]
    if adapter:
        cmd += ["--lora", str(adapter)]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(90):
        try:
            if b"ok" in urllib.request.urlopen(f"http://localhost:{PORT}/health", timeout=1).read():
                return p
        except Exception:  # noqa: BLE001
            time.sleep(2)
    p.terminate()
    raise RuntimeError("llama-server did not start")


def evaluate(run: pathlib.Path, ckpt: pathlib.Path, which: str) -> dict:
    step = int(ckpt.name.split("_")[1])
    adapter = convert(ckpt)
    server = serve(adapter)
    try:
        rows = [json.loads(l) for l in open(td.DATA / which / "pass1_ok.jsonl") if l.strip()]
        grammar, results, lats, toks, raw = ts.grammar(), [], [], [], []
        for row in rows:
            try:
                text, dt, n = te.generate(f"http://localhost:{PORT}", row["ask"], grammar)
            except Exception:  # noqa: BLE001
                text, dt, n = "", 0.0, 0
            res = te.judge(row, text)
            results.append(res)
            if dt:
                lats.append(dt); toks.append(n)
            raw.append({"ask": row["ask"], "output": text, **res})
        s = te.summarise(results, lats, toks)
        (run / f"dev_step_{step}.json").write_text(json.dumps({"summary": s, "rows": raw}, indent=1))
        line = {"t": time.strftime("%H:%M:%S"), "step": step, "set": which, **{k: v for k, v in s.items() if not isinstance(v, (dict, tuple))}}
        with open(run / "devevals.jsonl", "a") as f:
            f.write(json.dumps(line) + "\n")
        print(f"step {step}: valid {s['valid']}/{s['n']}, right {s['right']}/{s['answerable']}, wrong-confident {s['wrong_confident']}, "
              f"declines {s['declined_right']}/{s['declines']}, p50 {s['p50_s']:.1f}s", flush=True)
        return s
    finally:
        server.terminate()
        server.wait()


def newest_unscored(run: pathlib.Path):
    done = set()
    if (run / "devevals.jsonl").exists():
        done = {json.loads(l)["step"] for l in open(run / "devevals.jsonl") if l.strip()}
    cks = [p for p in (run / "ckpt").glob("step_*") if (p / "DONE").exists()]
    cks.sort(key=lambda p: int(p.name.split("_")[1]))
    todo = [p for p in cks if int(p.name.split("_")[1]) not in done]
    return todo[-1] if todo else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--set", default="dev", choices=["dev", "test"])
    a = ap.parse_args()
    run = RUNS / a.run
    while True:
        ck = newest_unscored(run)
        if ck:
            try:
                evaluate(run, ck, a.set)
            except Exception as e:  # noqa: BLE001
                print(f"evaluation of {ck.name} failed: {e}", flush=True)
                time.sleep(20)
        elif not a.watch or (run / "ended.json").exists():
            break
        else:
            time.sleep(20)


if __name__ == "__main__":
    main()
