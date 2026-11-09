"""One FLUX.2 klein 4B worker, pinned to one GPU by CUDA_VISIBLE_DEVICES.

Usage: python worker.py <spec.json> <out_dir> <result.json>

Stage 1 loads only the text encoder, encodes every prompt this worker needs, then frees it.
Stage 2 loads only the transformer + VAE. This keeps a T4 (15 GB) inside memory without CPU offload.
Dtype ladder if an image comes out black/NaN: fp16 -> fp16 + fp32 VAE -> bf16 + fp32 VAE.
"""
import gc
import json
import os
import shutil
import sys
import time

import numpy as np
import torch
from PIL import Image

spec = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
RESULT = sys.argv[3]
M = spec["model"]
W, H, STEPS = spec["width"], spec["height"], spec["steps"]
jobs = spec["jobs"]
LADDER = [("fp16", torch.float16, False), ("fp16+vae32", torch.float16, True), ("bf16+vae32", torch.bfloat16, True)]

from diffusers import Flux2KleinPipeline  # noqa: E402

res = {"gpu": torch.cuda.get_device_name(0), "gpu_total_gb": round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2),
       "worker": spec["worker"], "load": {}, "images": [], "events": []}


def log(*a):
    print(f"[w{spec['worker']}]", *a, flush=True)


def save_result():
    json.dump(res, open(RESULT, "w"), indent=1)


def gb(x):
    return round(x / 1e9, 2)


def free():
    gc.collect()
    torch.cuda.empty_cache()


def bad(img):
    a = np.asarray(img).astype(np.float32)
    if not np.isfinite(a).all():
        return True
    return bool(a.mean() < 5 or a.std() < 2)


# ---- stage 1: text embeddings (computed once per unique prompt)
prompts = []
for j in jobs:
    if j["prompt"] not in prompts:
        prompts.append(j["prompt"])


def encode_all(dtype):
    t0 = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained(M, transformer=None, vae=None, dtype=dtype)
    pipe.text_encoder.to("cuda")
    torch.cuda.synchronize()
    res["load"]["text_encoder_load_s"] = round(time.perf_counter() - t0, 1)
    torch.cuda.reset_peak_memory_stats()
    t1 = time.perf_counter()
    embeds = {}
    with torch.no_grad():
        for p in prompts:
            e, _ = pipe.encode_prompt(prompt=p, device="cuda")
            embeds[p] = e.cpu()
    torch.cuda.synchronize()
    res["load"]["text_encode_s"] = round(time.perf_counter() - t1, 1)
    res["load"]["text_encode_n_prompts"] = len(prompts)
    res["load"]["text_stage_peak_gb"] = gb(torch.cuda.max_memory_allocated())
    res["load"]["text_dtype"] = str(dtype)
    del pipe
    free()
    return embeds


embeds = encode_all(torch.float16)
if any((not torch.isfinite(e).all()) for e in embeds.values()):
    res["events"].append("fp16 text embeddings contained NaN/inf; re-encoding text in bf16")
    log(res["events"][-1])
    embeds = encode_all(torch.bfloat16)
log("text stage done", res["load"])


# ---- stage 2: transformer + VAE
def load_pipe(level):
    name, dtype, vae32 = LADDER[level]
    t0 = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained(M, text_encoder=None, tokenizer=None, dtype=dtype)
    pipe.to("cuda")
    if vae32:
        pipe.vae.to(torch.float32)
    pipe.set_progress_bar_config(disable=True)
    torch.cuda.synchronize()
    res["load"][f"diffusion_load_s_{name}"] = round(time.perf_counter() - t0, 1)
    log("loaded", name, res["load"][f"diffusion_load_s_{name}"], "s; vram", gb(torch.cuda.memory_allocated()))
    return pipe


def generate(pipe, level, job, ref):
    name, dtype, vae32 = LADDER[level]
    g = torch.Generator(device="cuda").manual_seed(job["seed"])
    emb = embeds[job["prompt"]].to("cuda", dtype=dtype)
    kw = dict(prompt=None, prompt_embeds=emb, height=H, width=W, num_inference_steps=STEPS, guidance_scale=1.0, generator=g)
    if ref is not None:
        kw["image"] = ref
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    with torch.no_grad():
        if vae32:
            lat = pipe(output_type="latent", **kw).images
            x = pipe.vae.decode(lat.to(torch.float32), return_dict=False)[0]
            img = pipe.image_processor.postprocess(x, output_type="pil")[0]
        else:
            img = pipe(**kw).images[0]
    torch.cuda.synchronize()
    return img, time.perf_counter() - t0


level = 0
pipe = load_pipe(level)
torch.cuda.reset_peak_memory_stats()
made = {}  # (concept, mode, panel) -> PIL
first = True
for job in jobs:
    key = (job["concept"], job["mode"], job["panel"])
    if job.get("copy_from"):
        src = tuple(job["copy_from"])
        made[key] = made[src]
        made[key].save(os.path.join(OUT, job["file"]))
        res["images"].append({"file": job["file"], "concept": job["concept"], "mode": job["mode"], "panel": job["panel"],
                              "copied_from": "_".join(map(str, src)), "seconds": 0.0, "counted": False})
        continue
    ref = made[tuple(job["ref"])] if job.get("ref") else None
    attempts = []
    while True:
        try:
            img, secs = generate(pipe, level, job, ref)
        except torch.cuda.OutOfMemoryError as e:
            res["events"].append(f"OOM on {job['file']}: {e}")
            log(res["events"][-1])
            raise
        isbad = bad(img)
        a = np.asarray(img).astype(np.float32)
        attempts.append({"dtype": LADDER[level][0], "seconds": round(secs, 3), "bad": isbad, "mean": round(float(a.mean()), 2), "std": round(float(a.std()), 2)})
        if not isbad or level == len(LADDER) - 1:
            break
        res["events"].append(f"{job['file']} was black/NaN in {LADDER[level][0]} (mean {a.mean():.2f}, std {a.std():.2f}); escalating")
        log(res["events"][-1])
        level += 1
        del pipe
        free()
        pipe = load_pipe(level)
    img.save(os.path.join(OUT, job["file"]))
    made[key] = img
    last = attempts[-1]
    res["images"].append({"file": job["file"], "concept": job["concept"], "mode": job["mode"], "panel": job["panel"],
                          "ref": bool(ref is not None), "dtype": last["dtype"], "seconds": last["seconds"], "bad": last["bad"],
                          "mean": last["mean"], "std": last["std"], "attempts": attempts, "first_image": first,
                          "counted": True, "peak_vram_gb": gb(torch.cuda.max_memory_allocated()),
                          "peak_reserved_gb": gb(torch.cuda.max_memory_reserved())})
    first = False
    log(f"{job['file']} {last['seconds']:.2f}s {last['dtype']} bad={last['bad']} mean={last['mean']}")
    save_result()

res["peak_vram_gb"] = gb(torch.cuda.max_memory_allocated())
res["peak_reserved_gb"] = gb(torch.cuda.max_memory_reserved())
res["final_dtype"] = LADDER[level][0]
res["done"] = True
save_result()
log("done")
