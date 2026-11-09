"""Builds ../pilot.ipynb from worker.py + concepts_pilot.json (both are inlined so the notebook is self-contained on Kaggle).

Run: python3 tools/panel_data/scripts/build_notebook.py
"""
import json
import pathlib

here = pathlib.Path(__file__).resolve().parent
root = here.parent
worker_src = (here / "worker.py").read_text()
concepts_src = (here / "concepts_pilot.json").read_text()


def md(s):
    return {"cell_type": "markdown", "metadata": {}, "source": s.splitlines(keepends=True)}


def code(s):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)}


cells = []
cells.append(md("""# Panel-data pilot: FLUX.2 klein 4B on Kaggle T4

Pilot for a 2-4 panel software-concept image generator. Questions: (1) does klein 4B run stably in fp16 on a T4,
(2) real images/hour at 512x512 and 4 steps per T4 and with both, (3) does passing panel 1 as a reference keep panels 2-4 consistent.
Needs: GPU T4 x2 and Internet on. Outputs land in /kaggle/working/out (PNGs, contact_sheet.html, results.json, panels.zip)."""))

cells.append(code("""
import subprocess, sys
print(subprocess.run("pip install -q -U git+https://github.com/huggingface/diffusers transformers accelerate sentencepiece huggingface_hub 2>&1 | tail -3", shell=True, capture_output=True, text=True).stdout)
import diffusers, transformers, torch
print("diffusers", diffusers.__version__, "transformers", transformers.__version__, "torch", torch.__version__)
"""))

cells.append(code("""
import subprocess, torch
print(subprocess.run("nvidia-smi", shell=True, capture_output=True, text=True).stdout)
N_GPU = torch.cuda.device_count()
GPU_INFO = []
for i in range(N_GPU):
    p = torch.cuda.get_device_properties(i)
    GPU_INFO.append({"index": i, "name": p.name, "total_gb": round(p.total_memory / 1e9, 2), "capability": f"{p.major}.{p.minor}", "bf16_native": torch.cuda.is_bf16_supported(including_emulation=False) if i == 0 else None})
    print(GPU_INFO[-1])
import os
os.makedirs("/kaggle/working/out", exist_ok=True)
print("RAM:", subprocess.run("free -g | head -2", shell=True, capture_output=True, text=True).stdout)
print("disk:", subprocess.run("df -h /kaggle/working /root | tail -2", shell=True, capture_output=True, text=True).stdout)
"""))

cells.append(code("# Concept scripts (same content as scripts/concepts_pilot.json)\nCONCEPTS_JSON = r'''" + concepts_src + "'''\n"
                   "import json\nspec = json.loads(CONCEPTS_JSON)\nprint(len(spec['concepts']), 'concepts,', len(spec['style_tests']), 'style tests')"))

cells.append(code("""
# Download weights once (so the two workers do not race on the cache) and time it.
import os, time
from huggingface_hub import snapshot_download
t0 = time.time()
try:
    path = snapshot_download(spec["model"])
except Exception as e:
    print("DOWNLOAD FAILED:", repr(e))
    raise
DOWNLOAD_S = round(time.time() - t0, 1)
print("downloaded to", path, "in", DOWNLOAD_S, "s")
print(subprocess.run(f"du -sh {path}/*", shell=True, capture_output=True, text=True).stdout)
"""))

cells.append(code("%%writefile /kaggle/working/worker.py\n" + worker_src))

cells.append(code("""
# Build the job list and launch one worker per GPU (CUDA_VISIBLE_DEVICES pins each). Workers run concurrently.
import json, os, signal, subprocess, sys, time
OUT = "/kaggle/working/out"
STYLE, REFI = spec["style_prefix"], spec["reference_instruction"]
mode_a = set(spec["mode_a_concepts"])
n_workers = max(1, N_GPU)
worker_jobs = [[] for _ in range(n_workers)]
for ci, c in enumerate(spec["concepts"]):
    js = worker_jobs[ci % n_workers]
    cid, seed = c["id"], c["seed"]
    js.append(dict(concept=cid, mode="b", panel=1, seed=seed, prompt=f"{STYLE} {c['panels'][0]}", file=f"{cid}_b_1.png"))
    if cid in mode_a:
        js.append(dict(concept=cid, mode="a", panel=1, seed=seed, prompt=js[-1]["prompt"], file=f"{cid}_a_1.png", copy_from=[cid, "b", 1]))
    for p in range(2, 5):
        js.append(dict(concept=cid, mode="b", panel=p, seed=seed, prompt=f"{STYLE} {REFI} {c['panels'][p-1]}", file=f"{cid}_b_{p}.png", ref=[cid, "b", 1]))
    if cid in mode_a:
        for p in range(2, 5):
            js.append(dict(concept=cid, mode="a", panel=p, seed=seed, prompt=f"{STYLE} {c['panels'][p-1]}", file=f"{cid}_a_{p}.png"))
for si, s in enumerate(spec["style_tests"]):
    worker_jobs[si % n_workers].append(dict(concept=s["id"], mode="single", panel=1, seed=s["seed"], prompt=f"{STYLE} {s['prompt']}", file=f"{s['id']}_single_1.png"))
print("jobs per worker:", [sum(1 for j in w if not j.get('copy_from')) for w in worker_jobs], "(generated images; copies of panel 1 excluded)")

procs = []
t_launch = time.time()
for w in range(n_workers):
    sp = {k: spec[k] for k in ("model", "width", "height", "steps")}
    sp.update(worker=w, jobs=worker_jobs[w])
    json.dump(sp, open(f"/kaggle/working/spec_w{w}.json", "w"))
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(w) if N_GPU else "")
    log = open(f"/kaggle/working/worker_{w}.log", "w")
    procs.append(subprocess.Popen([sys.executable, "/kaggle/working/worker.py", f"/kaggle/working/spec_w{w}.json", OUT, f"/kaggle/working/result_w{w}.json"],
                                  stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True))
    print("launched worker", w, "pid", procs[-1].pid)

def kill_all():
    for p in procs:
        if p.poll() is None:
            try: os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError: pass
    time.sleep(3)
    for p in procs:
        if p.poll() is None:
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass

seen = [0] * n_workers
try:
    while any(p.poll() is None for p in procs):
        time.sleep(10)
        for w in range(n_workers):
            lines = open(f"/kaggle/working/worker_{w}.log").read().splitlines()
            for l in lines[seen[w]:]:
                print(l[:300])
            seen[w] = len(lines)
        if time.time() - t_launch > 4 * 3600:
            print("TIMEOUT"); break
finally:
    kill_all()
WALL_S = round(time.time() - t_launch, 1)
for w in range(n_workers):
    for l in open(f"/kaggle/working/worker_{w}.log").read().splitlines()[seen[w]:]:
        print(l[:300])
print("worker exit codes:", [p.returncode for p in procs], "wall", WALL_S, "s")
"""))

cells.append(code("""
# results.json
import json, os, statistics
workers = []
for w in range(n_workers):
    f = f"/kaggle/working/result_w{w}.json"
    if os.path.exists(f):
        workers.append(json.load(open(f)))
per_gpu = []
all_imgs = []
for r in workers:
    imgs = [i for i in r["images"] if i.get("counted")]
    all_imgs += imgs
    steady = [i["seconds"] for i in imgs if not i.get("first_image")]
    def stats(sel):
        s = [i["seconds"] for i in imgs if sel(i) and not i.get("first_image")]
        return {"n": len(s), "mean_s": round(statistics.mean(s), 2) if s else None}
    tot = sum(i["seconds"] for i in imgs)
    per_gpu.append({
        "worker": r["worker"], "gpu": r["gpu"], "images": len(imgs), "final_dtype": r.get("final_dtype"),
        "load": r["load"], "events": r["events"], "done": r.get("done", False),
        "peak_vram_allocated_gb": r.get("peak_vram_gb"), "peak_vram_reserved_gb": r.get("peak_reserved_gb"),
        "sec_per_image_all": round(tot / len(imgs), 2) if imgs else None,
        "sec_per_image_steady": round(statistics.mean(steady), 2) if steady else None,
        "images_per_hour_steady": round(3600 / statistics.mean(steady), 1) if steady else None,
        "text_only": stats(lambda i: not i.get("ref")), "with_reference": stats(lambda i: i.get("ref")),
        "first_image_s": next((i["seconds"] for i in imgs if i.get("first_image")), None),
    })
failures_first_try = sum(1 for i in all_imgs if i["attempts"][0]["bad"])
failures_final = sum(1 for i in all_imgs if i["bad"])
results = {
    "gpus": GPU_INFO, "n_gpu": N_GPU, "model": spec["model"], "resolution": f"{spec['width']}x{spec['height']}", "steps": spec["steps"],
    "download_s": DOWNLOAD_S, "wall_generation_s": WALL_S, "images_generated": len(all_imgs),
    "images_per_hour_per_gpu": [g["images_per_hour_steady"] for g in per_gpu],
    "images_per_hour_combined_steady": round(sum(g["images_per_hour_steady"] or 0 for g in per_gpu), 1),
    "images_per_hour_combined_wall_incl_loads": round(len(all_imgs) / WALL_S * 3600, 1) if WALL_S else None,
    "black_or_nan_first_try": failures_first_try, "black_or_nan_final": failures_final,
    "peak_vram_gb": max([g["peak_vram_allocated_gb"] or 0 for g in per_gpu] or [0]),
    "per_gpu": per_gpu,
}
json.dump(results, open(f"{OUT}/results.json", "w"), indent=1)
print(json.dumps({k: v for k, v in results.items() if k != "per_gpu"}, indent=1))
for g in per_gpu:
    print(json.dumps(g, indent=1))
"""))

cells.append(code("""
# contact sheet (self-contained HTML, white background, thumbnails embedded) + zip
import base64, html, io
from PIL import Image
byfile = {i["file"]: i for r in workers for i in r["images"]}
def thumb(fn):
    p = f"{OUT}/{fn}"
    if not os.path.exists(p): return None
    im = Image.open(p).convert("RGB"); im.thumbnail((300, 300))
    b = io.BytesIO(); im.save(b, "JPEG", quality=88)
    return base64.b64encode(b.getvalue()).decode()
def cell(fn):
    t = thumb(fn)
    info = byfile.get(fn)
    if t is None: return "<div class=c><div class=ph>not run</div></div>"
    cap = "copy of b panel 1" if info and info.get("copied_from") else (f"{info['seconds']:.2f}s {info['dtype']}" + (" ref" if info.get('ref') else "") + (" BAD" if info['bad'] else "") if info else "")
    return f"<div class=c><img src='data:image/jpeg;base64,{t}'><div class=t>{html.escape(fn)}<br>{cap}</div></div>"
rows = []
for c in spec["concepts"]:
    a = "".join(cell(f"{c['id']}_a_{p}.png") for p in range(1, 5)) if c["id"] in mode_a else "<div class=c><div class=ph>mode a not run for this concept</div></div>"
    b = "".join(cell(f"{c['id']}_b_{p}.png") for p in range(1, 5))
    rows.append(f"<h3>{html.escape(c['title'])}</h3><div class=row><div class=blk><h4>(a) text only, fixed seed {c['seed']}</h4><div class=ims>{a}</div></div><div class=blk><h4>(b) panels 2-4 conditioned on panel 1</h4><div class=ims>{b}</div></div></div>")
rows.append("<h3>Single-image style tests</h3><div class=ims>" + "".join(cell(f"{s['id']}_single_1.png") for s in spec["style_tests"]) + "</div>")
page = ("<!doctype html><meta charset=utf-8><title>Panel pilot contact sheet</title><style>body{background:#fff;color:#111;font:14px system-ui;margin:24px}"
        "h3{margin:28px 0 6px}h4{margin:0 0 4px;font-weight:600;color:#444}.row{display:flex;gap:28px;flex-wrap:wrap}.ims{display:flex;gap:6px}"
        ".c{width:150px}.c img{width:150px;height:150px;border:1px solid #ddd}.t{font-size:10px;color:#555}.ph{width:150px;height:150px;border:1px dashed #bbb;color:#999;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px}</style>"
        "<h2>FLUX.2 klein 4B pilot, 512x512, 4 steps</h2>" + "".join(rows))
open(f"{OUT}/contact_sheet.html", "w").write(page)
import shutil
shutil.copy("/kaggle/working/worker_0.log", f"{OUT}/worker_0.log")
if n_workers > 1: shutil.copy("/kaggle/working/worker_1.log", f"{OUT}/worker_1.log")
shutil.make_archive("/kaggle/working/panels", "zip", OUT)
print(os.listdir(OUT)[:100], len(os.listdir(OUT)))
"""))

cells.append(code("""
# Leave no stray processes behind.
print(subprocess.run("ps aux | grep -c '[w]orker.py'", shell=True, capture_output=True, text=True).stdout.strip(), "worker.py processes still running")
"""))

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
(root / "pilot.ipynb").write_text(json.dumps(nb, indent=1))
print("wrote", root / "pilot.ipynb")
