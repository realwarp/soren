#!/usr/bin/env python3
"""Pilot LoRA run for LFM3-1.7B on this Mac: how much memory, how fast. Not a quality experiment.

    python3 -I tools/cards/lora_pilot.py --targets attn --seq 512 --bs 4 [--gc] [--steps 12]

Runs offline (no network) against models/lfm3-1.7b with the audited model files beside it.
The data is throwaway: exchanges from the classifier training set (never the bake-off asks)
with a template card as the target, padded to a fixed length, only so that real forward and
backward passes of a realistic size run. Prints one JSON line.
"""
import argparse
import json
import os
import random
import resource
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("USE_HUB_KERNELS", "0")

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = "/Users/varun/Documents/soren"
MODEL = os.path.join(ROOT, "models", "lfm3-1.7b")
TARGETS = {
    "attn": ["q_proj", "k_proj", "v_proj", "o_proj"],
    "all": ["q_proj", "k_proj", "v_proj", "o_proj", "in_proj", "out_proj", "w1", "w2", "w3"],
}


def mps_gb():
    return torch.mps.driver_allocated_memory() / 1e9, torch.mps.current_allocated_memory() / 1e9


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", choices=TARGETS, default="attn")
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--seq", type=int, default=512)
    ap.add_argument("--bs", type=int, default=4)
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--gc", action="store_true", help="gradient checkpointing")
    ap.add_argument("--lr", type=float, default=2e-4)
    a = ap.parse_args()

    torch.manual_seed(0)
    random.seed(0)
    tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
    rows = [json.loads(l) for l in open(os.path.join(ROOT, "data", "cards", "train.jsonl"), encoding="utf-8")]
    random.shuffle(rows)

    def example(r):
        prompt = f"{r['person']}\n{r['soren'] or ''}\nWrite a card.\n"
        target = f'root = Stack([t])\nt = TextContent("{r["person"][:48]}")\n'
        p, t = tok(prompt, add_special_tokens=False)["input_ids"], tok(target, add_special_tokens=False)["input_ids"]
        ids = ([tok.bos_token_id] + p + t + [tok.eos_token_id])[: a.seq]
        labels = ([-100] * (1 + len(p)) + t + [tok.eos_token_id])[: a.seq]
        pad = a.seq - len(ids)
        mask = [1] * len(ids) + [0] * pad
        # Stretch to the target length with repeated context so the pass is a realistic size.
        return ids + [tok.pad_token_id] * pad, labels + [-100] * pad, mask

    t0 = time.time()
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, trust_remote_code=True, local_files_only=True)
    load_s = time.time() - t0
    model = get_peft_model(model, LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.05, target_modules=TARGETS[a.targets], task_type="CAUSAL_LM"))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    if a.gc:
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    model.to("mps")
    model.train()
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    driver0, _ = mps_gb()

    times, losses, peak = [], [], 0.0
    cursor = 0
    for step in range(a.steps):
        batch = [example(rows[(cursor + i) % len(rows)]) for i in range(a.bs)]
        cursor += a.bs
        ids = torch.tensor([b[0] for b in batch], device="mps")
        labels = torch.tensor([b[1] for b in batch], device="mps")
        mask = torch.tensor([b[2] for b in batch], device="mps")
        s = time.time()
        out = model(input_ids=ids, attention_mask=mask, labels=labels)
        out.loss.backward()
        opt.step()
        opt.zero_grad(set_to_none=True)
        torch.mps.synchronize()
        dt = time.time() - s
        peak = max(peak, mps_gb()[0])
        losses.append(round(out.loss.item(), 3))
        if step >= 2:
            times.append(dt)
    step_s = sum(times) / len(times)
    print(json.dumps({
        "targets": a.targets, "rank": a.rank, "seq": a.seq, "bs": a.bs, "grad_ckpt": a.gc,
        "trainable_m": round(trainable / 1e6, 1), "load_s": round(load_s, 1), "step_s": round(step_s, 2),
        "tokens_per_s": round(a.bs * a.seq / step_s), "gpu_gb_peak": round(peak, 2),
        "gpu_gb_after_load": round(driver0, 2), "rss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9, 2),
        "loss_first": losses[0], "loss_last": losses[-1], "losses": losses,
    }))


if __name__ == "__main__":
    main()
