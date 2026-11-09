#!/usr/bin/env python3
"""One-screen view of a training run, for a terminal tab that redraws every 5 seconds.

    while true; do clear; python3 tools/cards/tool_status.py <run>; sleep 5; done

Reads data/cards/tool/runs/<run>/: log.jsonl, evals.jsonl, devevals.jsonl, latest.json, ended.json.
"""
import json
import pathlib
import subprocess
import sys
import time

RUNS = pathlib.Path(__file__).resolve().parents[2] / "data" / "cards" / "tool" / "runs"


def rows(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def bar(frac, width=30):
    n = int(max(0.0, min(1.0, frac)) * width)
    return "[" + "#" * n + "-" * (width - n) + f"] {100 * frac:.0f}%"


def main():
    name = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "latest" else None
    if name is None:   # follow the most recently started run
        runs = [d for d in RUNS.iterdir() if (d / "manifest.json").exists()] if RUNS.exists() else []
        name = max(runs, key=lambda d: (d / "manifest.json").stat().st_mtime).name if runs else "dry1"
    run = RUNS / name
    now = time.strftime("%H:%M:%S")
    print(f"TOOL CARD TRAINING   run: {name}   {now}   (refreshes every 5 s)")
    print("=" * 92)
    if not run.exists():
        print("not started yet: waiting for", run)
        return
    log, evals, dev = rows(run / "log.jsonl"), rows(run / "evals.jsonl"), rows(run / "devevals.jsonl")
    ended = json.loads((run / "ended.json").read_text()) if (run / "ended.json").exists() else None
    alive = subprocess.run(["pgrep", "-f", f"tooltrain.py --run {name}"], capture_output=True).returncode == 0
    last = log[-1] if log else None
    age = None
    if log:
        t = time.strptime(last["t"], "%H:%M:%S")
        age = (time.time() - time.mktime(time.localtime()[:3] + (t.tm_hour, t.tm_min, t.tm_sec, 0, 0, -1)))
        age = age % 86400
    if (run / "PAUSE").exists():
        state = "PAUSED (create RESUME to continue)"
    elif ended:
        state = f"ENDED: {ended['reason']} at step {ended['step']}"
    elif alive:
        state = "RUNNING" if (age is None or age < 180) else f"RUNNING but quiet for {age / 60:.0f} min"
    else:
        state = "NOT RUNNING (stopped without a final note)"
    print(f"state: {state}")
    if last:
        print(f"step {last['step']}/{last['of']}   epoch {last['epoch']}   loss {last['loss']}   {last['tok_s']} tok/s   "
              f"gpu {last['gpu_gb']} GB   swap {last['swap_gb']} GB   ETA {last['eta_min']} min   (updated {age:.0f} s ago)")
        print(bar(last["step"] / max(1, last["of"])))
        if last.get("slow"):
            print("warning: throughput is more than 30% below its usual level")
    print()
    print("CHECKPOINTS (teacher-forced, on held-out training examples)")
    print(f"{'step':>5} {'time':>9} {'epoch':>6} {'val loss':>9} {'formula tokens':>15} {'all tokens':>11}  tag")
    for e in evals[-8:]:
        print(f"{e['step']:>5} {e['t']:>9} {e['epoch']:>6} {e['val_loss']:>9.3f} {100 * e['formula_acc']:>14.0f}% {100 * e['token_acc']:>10.0f}%  {e['tag']}")
    if len(evals) >= 2:
        d = evals[-1]["val_loss"] - evals[-2]["val_loss"]
        print(f"trend: validation loss {'down' if d < 0 else 'UP'} {abs(d):.3f} since the previous checkpoint")
    print()
    print("DEV SET (the model writes cards; scored against references)")
    if dev:
        print(f"{'step':>5} {'valid':>6} {'right':>12} {'wrong+confident':>16} {'declines':>9} {'p50':>6}")
        for d in dev[-6:]:
            print(f"{d['step']:>5} {100 * d['valid_rate']:>5.0f}% {d['right']:>4}/{d['answerable']:<3} ({100 * d['right_rate']:>3.0f}%) "
                  f"{d['wrong_confident']:>6} ({100 * d['wrong_confident_rate']:>3.0f}%) {d['declined_right']:>4}/{d['declines']:<3} {d['p50_s']:>5.1f}s")
        print("ceiling: wrong but confident must stay at or under 5% of calculations")
    else:
        print("no dev evaluation yet (runs after checkpoints)")
    print()
    print(f"controls: touch {run}/STOP  |  PAUSE  |  RESUME")
    if subprocess.run(["pgrep", "-f", "run_exp.sh"], capture_output=True).returncode == 0:
        done = [n for n in ("exp_old", "exp_units") if (RUNS / n / "ended.json").exists()]
        print(f"queued: old-vs-unit-aware experiment (exp_old, then exp_units) starts after r5; finished so far: {', '.join(done) or 'none'}")
    print()
    print(f"LOG since the start, newest first ({len(log)} lines)")
    for r in reversed(log):
        print(f"  {r['t']}  step {r['step']:>4}/{r['of']}  loss {r['loss']:<7} {r['tok_s']:>4} tok/s  gpu {r['gpu_gb']} GB  swap {r['swap_gb']} GB  ETA {r['eta_min']} min")


if __name__ == "__main__":
    main()
