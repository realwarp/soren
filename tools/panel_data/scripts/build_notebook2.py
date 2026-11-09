"""Builds ../pilot2.ipynb (pilot 2: previous-panel reference and stronger change wording).

Run: python3 tools/panel_data/scripts/build_notebook2.py
"""
import json
import pathlib

here = pathlib.Path(__file__).resolve().parent
root = here.parent
old = json.loads((root / "pilot.ipynb").read_text())["cells"]
concepts_src = (here / "concepts_pilot2.json").read_text()


def code(s):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)}


cells = [
    {"cell_type": "markdown", "metadata": {}, "source": ["# Panel-data pilot 2: FLUX.2 klein 4B, previous-panel reference and stronger change wording\n", "\n", "Modes: c = previous panel as reference, same prompts as pilot 1 mode b. d = previous panel as reference plus prompts that say what changes. e = panel 1 as reference plus the d prompts (isolates the wording effect). Same seeds as pilot 1. Needs GPU T4 x2 and Internet on."]},
    old[1], old[2],
    code("# Concept scripts (same content as scripts/concepts_pilot2.json)\nCONCEPTS_JSON = r'''" + concepts_src + "'''\nimport json\nspec = json.loads(CONCEPTS_JSON)\nprint(len(spec['concepts']), 'concepts')"),
    old[4], old[5],
]
cells.append(code("""
import json, os, signal, subprocess, sys, time
OUT = "/kaggle/working/out2"
os.makedirs(OUT, exist_ok=True)
STYLE, REFI, CHG = spec["style_prefix"], spec["reference_instruction"], spec["change_instruction"]
n_workers = max(1, N_GPU)
worker_jobs = [[] for _ in range(n_workers)]
for ci, c in enumerate(spec["concepts"]):
    js = worker_jobs[ci % n_workers]
    cid, seed = c["id"], c["seed"]
    js.append(dict(concept=cid, mode="p1", panel=1, seed=seed, prompt=f"{STYLE} {c['panels'][0]}", file=f"{cid}_p1_1.png"))
    for m in ("c", "d", "e"):
        js.append(dict(concept=cid, mode=m, panel=1, seed=seed, prompt=js[0]["prompt"], file=f"{cid}_{m}_1.png", copy_from=[cid, "p1", 1]))
    for p in range(2, 5):
        js.append(dict(concept=cid, mode="c", panel=p, seed=seed, prompt=f"{STYLE} {REFI} {c['panels'][p-1]}", file=f"{cid}_c_{p}.png", ref=[cid, "c", p-1]))
        dp = f"{STYLE} {CHG} {c['change_panels'][p-2]}"
        js.append(dict(concept=cid, mode="d", panel=p, seed=seed, prompt=dp, file=f"{cid}_d_{p}.png", ref=[cid, "d", p-1]))
        js.append(dict(concept=cid, mode="e", panel=p, seed=seed, prompt=dp, file=f"{cid}_e_{p}.png", ref=[cid, "p1", 1]))
print("jobs per worker:", [sum(1 for j in w if not j.get('copy_from')) for w in worker_jobs], "(generated images; copies of panel 1 excluded)")

procs = []
t_launch = time.time()
for w in range(n_workers):
    sp = {k: spec[k] for k in ("model", "width", "height", "steps")}
    sp.update(worker=w, jobs=worker_jobs[w])
    json.dump(sp, open(f"/kaggle/working/spec_w{w}.json", "w"))
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(w) if N_GPU else "")
    logf = open(f"/kaggle/working/worker_{w}.log", "w")
    procs.append(subprocess.Popen([sys.executable, "/kaggle/working/worker.py", f"/kaggle/working/spec_w{w}.json", OUT, f"/kaggle/working/result_w{w}.json"],
                                  stdout=logf, stderr=subprocess.STDOUT, env=env, start_new_session=True))
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
                if "Loading" not in l: print(l[:300])
            seen[w] = len(lines)
        if time.time() - t_launch > 3 * 3600:
            print("TIMEOUT"); break
finally:
    kill_all()
WALL_S = round(time.time() - t_launch, 1)
for w in range(n_workers):
    for l in open(f"/kaggle/working/worker_{w}.log").read().splitlines()[seen[w]:]:
        if "Loading" not in l: print(l[:300])
print("worker exit codes:", [p.returncode for p in procs], "wall", WALL_S, "s")
"""))
cells.append(code("""
import json, os, statistics
workers = [json.load(open(f"/kaggle/working/result_w{w}.json")) for w in range(n_workers) if os.path.exists(f"/kaggle/working/result_w{w}.json")]
imgs = [i for r in workers for i in r["images"] if i.get("counted")]
def mstat(mode):
    s = [i["seconds"] for i in imgs if i["mode"] == mode and not i.get("first_image")]
    return {"n": len([i for i in imgs if i["mode"] == mode]), "mean_s": round(statistics.mean(s), 2) if s else None}
per_gpu = []
for r in workers:
    gi = [i for i in r["images"] if i.get("counted")]
    st = [i["seconds"] for i in gi if not i.get("first_image")]
    per_gpu.append({"worker": r["worker"], "gpu": r["gpu"], "images": len(gi), "final_dtype": r.get("final_dtype"), "load": r["load"], "events": r["events"], "done": r.get("done", False),
                    "peak_vram_allocated_gb": r.get("peak_vram_gb"), "peak_vram_reserved_gb": r.get("peak_reserved_gb"),
                    "sec_per_image_steady": round(statistics.mean(st), 2) if st else None,
                    "images_per_hour_steady": round(3600 / statistics.mean(st), 1) if st else None})
results2 = {"gpus": GPU_INFO, "model": spec["model"], "resolution": "512x512", "steps": spec["steps"], "wall_generation_s": WALL_S,
            "images_generated": len(imgs), "by_mode": {m: mstat(m) for m in ("p1", "c", "d", "e")},
            "black_or_nan_first_try": sum(1 for i in imgs if i["attempts"][0]["bad"]), "black_or_nan_final": sum(1 for i in imgs if i["bad"]),
            "reference_strength_knob": "none: Flux2KleinPipeline.__call__ has no strength parameter and guidance_scale is ignored for the step-distilled klein",
            "per_gpu": per_gpu, "images": imgs}
json.dump(results2, open(f"{OUT}/results2.json", "w"), indent=1)
print(json.dumps({k: v for k, v in results2.items() if k not in ("per_gpu", "images")}, indent=1))
import shutil
for w in range(n_workers): shutil.copy(f"/kaggle/working/worker_{w}.log", f"{OUT}/worker_{w}.log")
shutil.make_archive("/kaggle/working/panels2", "zip", OUT)
print(len(os.listdir(OUT)), "files in out2")
print(subprocess.run("ps aux | grep -c '[w]orker.py'", shell=True, capture_output=True, text=True).stdout.strip(), "worker.py processes still running")
"""))
nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
(root / "pilot2.ipynb").write_text(json.dumps(nb, indent=1))
print("wrote", root / "pilot2.ipynb")
