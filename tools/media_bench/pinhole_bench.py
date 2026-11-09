"""Pinhole S/M/L benchmark. Usage: pinhole_bench.py <s|m|l>   (run via run.sh). mps first, then cpu."""
import json, os, sys, time, traceback
import torch
from common import start_mem_sampler
from huggingface_hub import snapshot_download

size = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", f"pinhole-{size}")
os.makedirs(OUT, exist_ok=True)
PROMPTS = [
    "flat icon of a folder tree with a gear",
    "flat icon of a shield around a code window",
    "flat icon of a document with a checkmark",
    "flat icon of a log file with a bar chart",
]
res = {"size": size, "events": [], "prompts": []}
start_mem_sampler(res, every=10)


def sync(d):
    if d == "mps":
        torch.mps.synchronize()


path = snapshot_download(f"nuhmanpk/pinhole-{size}")
sys.path.insert(0, path)
from pinhole import Pinhole  # reviewed: pure inference code

for device in ("mps", "cpu"):
    try:
        t0 = time.time()
        pipe = Pinhole.from_pretrained(path, device=device)  # float32 on mps/cpu (card default for non-cuda)
        sync(device)
        res["load_s"] = round(time.time() - t0, 1)
        res["device"] = device
        print(f"loaded on {device} in {res['load_s']}s", flush=True)
        prompts = []
        for i, p in enumerate(PROMPTS, 1):
            t0 = time.time()
            imgs = pipe(p, n=4, steps=20, cfg=4.0, seed=0)
            sync(device)
            dt = time.time() - t0
            files = []
            for j, im in enumerate(imgs):
                f = f"p{i}_{j}.png"; im.save(os.path.join(OUT, f)); files.append(f)
            prompts.append(dict(prompt=p, seconds=round(dt, 2), per_image=round(dt / len(imgs), 2), files=files))
            print(prompts[-1], flush=True)
        res["prompts"] = prompts
        break
    except Exception:
        err = traceback.format_exc()
        res["events"].append({"stage": f"run_{device}", "error": err[-2000:]})
        print(f"{device} FAILED:\n{err}", flush=True)
        res["prompts"] = []
        if device == "mps":
            try: del pipe
            except NameError: pass
json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
print("DONE")
