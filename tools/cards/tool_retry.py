#!/usr/bin/env python3
"""Evaluate a card writer with retries: a card that fails the checks is sent back to the model with the reason, up to twice.

    TOOL_FORMAT=units python3 tools/cards/tool_retry.py <run> <ckpt> [--set holdout] [--retries 2] [--port 8092]

Serves the adapter with llama-server, scores every ask like tooleval.py, and for each invalid card (it did not parse, or
failed toolspec.problems) appends the card and "it was rejected because <reason>" to the conversation and asks again.
Only invalid cards are retried: a card that is valid but wrong looks the same to the code as a right one.
Writes runs/<run>/retry_<ckpt>.json and prints the status counts after each attempt.
"""
from __future__ import annotations

import argparse
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

RETRY = ("That card was rejected by the checker: {why}\n"
         "Write the corrected card for the same question. Follow the same format and fix only what the checker named.")


def chat(url: str, messages: list[dict], grammar: str, max_tokens: int = 900) -> str:
    body = {"model": "x", "stream": False, "max_tokens": max_tokens, "temperature": 0.0,
            "chat_template_kwargs": {"enable_thinking": False}, "messages": messages, "grammar": grammar}
    req = urllib.request.Request(url.rstrip("/") + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=300))
    return r["choices"][0]["message"]["content"] or ""


def reason(row: dict, text: str, res: dict) -> str:
    if res.get("problem"):
        return str(res["problem"])
    try:
        json.loads(text)
    except ValueError:
        return "the output was not valid JSON"
    return "the card did not pass the checks"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("ckpt")
    ap.add_argument("--set", default="holdout")
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--port", type=int, default=8092)
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(td.DATA / a.set / "pass1_ok.jsonl") if l.strip()]
    adapter = ck.convert(ck.RUNS / a.run / "ckpt" / a.ckpt)
    server = subprocess.Popen([str(ck.LLAMA / "build/bin/llama-server"), "-m", ck.BASE, "--lora", str(adapter), "--port", str(a.port),
                               "-ngl", "99", "-fa", "on", "--cache-ram", "0"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://localhost:{a.port}"
    try:
        for _ in range(120):
            try:
                if b"ok" in urllib.request.urlopen(url + "/health", timeout=1).read():
                    break
            except Exception:  # noqa: BLE001
                time.sleep(2)
        grammar, out, t0 = ts.grammar(), [], time.time()
        for i, row in enumerate(rows):
            msgs = [{"role": "system", "content": ts.SYSTEM_PROMPT}, {"role": "user", "content": row["ask"]}]
            history = []
            text = chat(url, msgs, grammar)
            res = te.judge(row, text)
            history.append({"attempt": 0, "status": res["status"], "problem": res.get("problem"), "text": text})
            for n in range(1, a.retries + 1):
                if res["status"] != "invalid":
                    break
                msgs = msgs + [{"role": "assistant", "content": text}, {"role": "user", "content": RETRY.format(why=reason(row, text, res))}]
                text = chat(url, msgs, grammar)
                res = te.judge(row, text)
                history.append({"attempt": n, "status": res["status"], "problem": res.get("problem"), "text": text})
            out.append({"id": row["id"], "kind": row["kind"], "ask": row["ask"], "final": res, "history": history})
            if (i + 1) % 20 == 0:
                print(f"{i + 1}/{len(rows)} asks, {(time.time() - t0) / 60:.1f} min", flush=True)
    finally:
        server.terminate()
        server.wait()
    (ck.RUNS / a.run / f"retry_{a.ckpt}.json").write_text(json.dumps(out, indent=1))
    # status after each attempt: an ask that was already valid keeps its status
    for n in range(a.retries + 1):
        sts = [h["history"][min(n, len(h["history"]) - 1)]["status"] for h in out]
        res_list = [{"kind": h["kind"], "status": s, "held_out": False} for h, s in zip(out, sts)]
        ans = [r for r in res_list if r["kind"] == "answerable"]
        und = [r for r in res_list if r["kind"] == "underspecified"]
        calc = ans + und
        right = sum(r["status"] == "right" for r in ans)
        wrong = sum(r["status"] == "wrong_confident" for r in calc)
        soft = sum(r["status"] == "soft_right" for r in und)
        inval = sum(r["status"] == "invalid" for r in calc)
        print(f"after attempt {n}: answerable right {right}/{len(ans)}, assumption asks soft-right {soft}/{len(und)}, "
              f"wrong-confident {wrong}/{len(calc)} calculations, invalid {inval}")
    retried = [h for h in out if len(h["history"]) > 1]
    fixed = [h for h in retried if h["final"]["status"] != "invalid"]
    print(f"retried {len(retried)} cards, {len(fixed)} came back valid; of those: " +
          json.dumps({s: sum(h["final"]["status"] == s for h in fixed) for s in sorted({h['final']['status'] for h in fixed})}))


if __name__ == "__main__":
    main()
