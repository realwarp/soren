#!/usr/bin/env python3
"""End-to-end check of the running classifier server: decisions on the test set, latency, samples.

    python3 tools/cards/bench_server.py [--url http://127.0.0.1:8090/classify]
"""
import argparse
import json
import os
import statistics
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evalcore as ev


def call(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json"})
    t = time.perf_counter()
    out = json.load(urllib.request.urlopen(req, timeout=10))
    return out, (time.perf_counter() - t) * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8090/classify")
    a = ap.parse_args()
    test = ev.load("test")
    body = lambda r, **kw: {"text": r["soren"] if r["mode"] == "reply" else r["person"], "mode": r["mode"], "person": r["person"], **kw}
    for e in ("medium", "high"):
        dec = [call(a.url, body(r, eagerness=e))[0]["card"] for r in test]
        print(ev.line(f"server, test @ {e}", ev.table(test, dec, e)))
    times = [call(a.url, body(test[i % len(test)]))[1] for i in range(400)]
    times.sort()
    q = lambda p: times[min(len(times) - 1, int(p * len(times)))]
    print(f"latency over HTTP, 400 requests: p50 {q(0.5):.1f} ms  p95 {q(0.95):.1f} ms  p99 {q(0.99):.1f} ms  max {times[-1]:.1f} ms")
    print("\nsamples (medium):")
    for text, mode in [("i wanna build an AI to-do list app", "request"), ("I'd like to make an ai harness", "request"),
                       ("hey", "request"), ("whats the difference between notion and obsidian", "request"),
                       ("draft a message to my landlord about the heating", "request"), ("rank these: pricing, onboarding, search", "request"),
                       ("how do i set up a home server", "request")]:
        out, _ = call(a.url, {"text": text, "mode": mode})
        print(f"  {out['card'] or 'none':<8} {out['chance']:.2f}  {text}")


if __name__ == "__main__":
    main()
