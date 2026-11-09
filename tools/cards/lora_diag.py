#!/usr/bin/env python3
"""Staged memory check for LFM3-1.7B LoRA on this Mac, with a watchdog.

    python3 -I tools/cards/lora_diag.py [--limit-gb 11]

Prints memory after each stage (load on CPU, move to MPS, forward, backward) and kills itself
if this process passes the limit, so a runaway allocation cannot push the machine into swap.
"""
import argparse
import os
import subprocess
import sys
import threading
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("USE_HUB_KERNELS", "0")

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM

MODEL = "/Users/varun/Documents/soren/models/lfm3-1.7b"
ap = argparse.ArgumentParser()
ap.add_argument("--limit-gb", type=float, default=11.0)
ap.add_argument("--gc", action="store_true", help="gradient checkpointing")
ap.add_argument("--targets", choices=["attn", "all"], default="attn")
ap.add_argument("--train", default="1x128,2x256,4x512", help="batch x length stages, comma separated")
ap.add_argument("--skip-forward", action="store_true")
ap.add_argument("--dtype", choices=["bf16", "fp16", "fp32"], default="bf16")
args = ap.parse_args()
DTYPE = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[args.dtype]


def rss_gb():
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(os.getpid())], capture_output=True, text=True).stdout.strip()
    return int(out) / 1e6 if out else 0.0


def watchdog():
    while True:
        if rss_gb() > args.limit_gb:
            print(f"WATCHDOG: process passed {args.limit_gb} GB, exiting", flush=True)
            os._exit(3)
        time.sleep(0.4)


threading.Thread(target=watchdog, daemon=True).start()
swap = lambda: subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout.split("used = ")[1].split()[0]


def report(stage):
    gpu = torch.mps.driver_allocated_memory() / 1e9 if torch.backends.mps.is_available() else 0
    print(f"{stage:<34} rss {rss_gb():5.2f} GB   mps driver {gpu:5.2f} GB   swap used {swap()}", flush=True)


report("start")
t = time.time()
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=DTYPE, trust_remote_code=True, local_files_only=True)
print("param dtype:", next(model.parameters()).dtype, f" load {time.time() - t:.1f}s")
report("loaded on cpu")
model.to("mps")
torch.mps.synchronize()
report("moved to mps")

with torch.no_grad():
  if not args.skip_forward:
      ids = torch.randint(1000, 5000, (1, 128), device="mps")
      t = time.time()
      out = model(input_ids=ids)
      torch.mps.synchronize()
      print(f"forward bs1 x128: {time.time() - t:.1f}s logits {tuple(out.logits.shape)} {out.logits.dtype}")
      report("after forward bs1 x128")
      ids = torch.randint(1000, 5000, (4, 512), device="mps")
      t = time.time()
      out = model(input_ids=ids)
      torch.mps.synchronize()
      print(f"forward bs4 x512: {time.time() - t:.1f}s")
      report("after forward bs4 x512")
      del out

targets = ["q_proj", "k_proj", "v_proj", "o_proj"] + (["in_proj", "out_proj", "w1", "w2", "w3"] if args.targets == "all" else [])
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, target_modules=targets, task_type="CAUSAL_LM"))
if args.gc:
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
model.train()
print("gradient checkpointing:", args.gc, " targets:", args.targets, flush=True)
for bs, seq in [tuple(int(x) for x in c.split("x")) for c in args.train.split(",")]:
    ids = torch.randint(1000, 5000, (bs, seq), device="mps")
    t = time.time()
    loss = model(input_ids=ids, labels=ids).loss
    torch.mps.synchronize()
    f = time.time() - t
    report(f"train forward bs{bs} x{seq}")
    loss.backward()
    torch.mps.synchronize()
    total = time.time() - t
    print(f"  forward {f:.1f}s, backward {total - f:.1f}s, loss {loss.item():.2f}, {bs * seq / total:.0f} tokens/s", flush=True)
    report(f"train backward bs{bs} x{seq}")
    model.zero_grad(set_to_none=True)
    del loss
print("DONE")
