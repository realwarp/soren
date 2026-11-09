#!/usr/bin/env python3
"""Prepare the records for the Training Monitor page and print the database writes to send.

    python3 tools/cards/tool_push.py [--wait SECONDS] [--no-mark]

Each call writes small JSON files under data/cards/tool/push/ and prints one JSON list of writes
({"op", "collection", "doc_id", "file_path"}) for the ArtifactData batch action: one fresh status record
(the page shows the newest) plus a record for every dev score not yet sent. It remembers what it has sent
in push/pushed.json. The last line is `RUN_ENDED_AND_PUSHED` once the run has ended and everything is sent,
so a loop knows when to stop.
"""
import datetime
import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tooleval as te  # noqa: E402
from tool_status import RUNS, rows  # noqa: E402

PUSH = RUNS.parent / "push"
iso = lambda ts: datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()  # noqa: E731


def main() -> None:
    if "--wait" in sys.argv:   # sleep first, so one command per cycle does the waiting too
        time.sleep(float(sys.argv[sys.argv.index("--wait") + 1]))
    PUSH.mkdir(parents=True, exist_ok=True)
    sent_file = PUSH / "pushed.json"
    sent = set(json.loads(sent_file.read_text())) if sent_file.exists() else set()
    writes = []

    runs = sorted((d for d in RUNS.iterdir() if (d / "manifest.json").exists()), key=lambda d: (d / "manifest.json").stat().st_mtime)
    files = [("base", 0, RUNS / "baseline_lfm3_dev.json")] if (RUNS / "baseline_lfm3_dev.json").exists() else []
    for r in runs:
        for f in sorted(r.glob("dev_step_*.json"), key=lambda p: int(p.stem.split("_")[2])):
            files.append((r.name, int(f.stem.split("_")[2]), f))
    for run, step, f in files:
        doc_id = f"{run}_{step:05d}"
        if doc_id in sent:
            continue
        s = te.rejudge(str(f), "dev")
        val = None
        if run != "base":
            for e in rows(RUNS / run / "evals.jsonl"):
                if e["step"] == step:
                    val = e["val_loss"]
        doc = {"run": run, "step": step, "t_iso": iso(f.stat().st_mtime), "n": s["n"], "valid": s["valid"], "right": s["right"], "answerable": s["answerable"],
               "right_rate": s["right_rate"], "wrong_confident": s["wrong_confident"], "wrong_rate": s["wrong_confident_rate"],
               "declined_right": s["declined_right"], "declines": s["declines"]}
        if val is not None:
            doc["val_loss"] = val
        p = PUSH / f"dev_{doc_id}.json"
        p.write_text(json.dumps(doc))
        writes.append({"op": "set", "collection": "dev", "doc_id": doc_id, "file_path": str(p)})
        sent.add(doc_id)

    cur = runs[-1] if runs else None
    ended = False
    if cur:
        log = rows(cur / "log.jsonl")
        end = json.loads((cur / "ended.json").read_text()) if (cur / "ended.json").exists() else None
        alive = subprocess.run(["pgrep", "-f", f"tooltrain.py --run {cur.name}"], capture_output=True).returncode == 0
        ended = bool(end) and not alive
        state = "Paused" if (cur / "PAUSE").exists() else ("Ended" if end else ("Running" if alive else "Stopped"))
        last = log[-1] if log else {"step": 0, "of": 0, "epoch": 0, "loss": 0, "tok_s": 0, "gpu_gb": 0, "swap_gb": 0, "eta_min": None}
        seq = int(time.time())
        recent = [r for r in log[-12:] if "t" in r]
        if len(recent) >= 3 and last["of"]:   # time left from the real step rate over the last few log lines
            tt = lambda r: (lambda x: x.tm_hour * 3600 + x.tm_min * 60 + x.tm_sec)(time.strptime(r["t"], "%H:%M:%S"))  # noqa: E731
            dt = (tt(recent[-1]) - tt(recent[0])) % 86400
            ds = recent[-1]["step"] - recent[0]["step"]
            if dt > 0 and ds > 0:
                last = {**last, "eta_min": round((last["of"] - last["step"]) / (ds / dt) / 60, 1)}
        doc = {"seq": seq, "run": cur.name, "state": state, "step": last["step"], "of": last["of"], "epoch": last["epoch"], "loss": last["loss"],
               "tok_s": last["tok_s"], "gpu": last["gpu_gb"], "swap": last["swap_gb"], "eta_min": last.get("eta_min"), "updated": iso(time.time())}
        if end:
            doc["note"] = end["reason"]
        p = PUSH / f"status_{seq}.json"
        p.write_text(json.dumps(doc))
        writes.append({"op": "set", "collection": "status", "doc_id": f"s{seq}", "file_path": str(p)})
        for old in sorted(PUSH.glob("status_*.json"))[:-3]:   # keep the folder tidy
            old.unlink()

    if "--no-mark" not in sys.argv:
        sent_file.write_text(json.dumps(sorted(sent)))
    print(json.dumps(writes))
    if ended and not [w for w in writes if w["collection"] == "dev"]:
        print("RUN_ENDED_AND_PUSHED")


if __name__ == "__main__":
    main()
