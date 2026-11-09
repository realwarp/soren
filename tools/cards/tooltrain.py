#!/usr/bin/env python3
"""LoRA training of LFM3-1.7B on tool cards, built to be watched: rounds, checkpoints, controls, guards.

    PY=<venv with torch, peft, transformers>   (see PLAN section 21; the audited model files are used offline)
    $PY tools/cards/tooltrain.py --run dry1 --data data/cards/tool/pilot/train_ready.jsonl --epochs 4

Everything the run writes lives in data/cards/tool/runs/<run>/ (git-ignored):

    log.jsonl      one line every --log-secs: step, epoch, loss, tokens/s, memory, swap, ETA
    ckpt/step_N/   an adapter every --ckpt-minutes (the last 5 kept) plus optimizer state, so a run can resume
    evals.jsonl    one line per checkpoint with validation loss and formula-token accuracy
    latest.json    the newest checkpoint and its numbers (what the status page and the check-ins read)
    final/         the adapter when the run completes
    manifest.json  arguments, data hash, git commit, library versions

Controls (create an empty file in the run folder; it is checked every step):  STOP  PAUSE  RESUME
Automatic stops: NaN, loss over 3x its recent mean, memory over --limit-gb, swap growing over --max-swap-gb,
free disk under 10 GB. Every stop except NaN saves a checkpoint first.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("USE_HUB_KERNELS", "0")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import toolspec as ts  # noqa: E402

import torch  # noqa: E402
from peft import LoraConfig, PeftModel, get_peft_model  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODEL = str(ROOT / "models" / "lfm3-1.7b")
RUNS = ROOT / "data" / "cards" / "tool" / "runs"
TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "in_proj", "out_proj", "w1", "w2", "w3"]


def swap_gb() -> float:
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    m = re.search(r"used = ([\d.]+)([MG])", out)
    return float(m.group(1)) / (1024 if m.group(2) == "M" else 1) if m else 0.0


def disk_free_gb(path: pathlib.Path) -> float:
    return shutil.disk_usage(path).free / 1e9


def mps_gb() -> float:
    return torch.mps.driver_allocated_memory() / 1e9 if torch.backends.mps.is_available() else 0.0


def encode(tok, ask: str, text: str, max_seq: int, system: str | None = None):
    """Token ids, labels (prompt masked) and a mask of the tokens that sit inside formulas."""
    msgs = [{"role": "system", "content": system or ts.SYSTEM_PROMPT}, {"role": "user", "content": ask}]
    prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    p = tok(prompt, add_special_tokens=False)["input_ids"]
    enc = tok(text + "<|im_end|>", add_special_tokens=False, return_offsets_mapping=True)
    t, offs = enc["input_ids"], enc["offset_mapping"]
    assert t[-1] == tok.eos_token_id, "the target must end with the end-of-turn token"
    if len(p) + len(t) > max_seq:
        return None
    spans = [(m.start(1), m.end(1)) for m in re.finditer(r'"formula":"([^"]*)"', text)]
    fmask = [any(s <= a and b <= e for s, e in spans) for a, b in offs]
    ids = p + t
    labels = [-100] * len(p) + t
    return {"ids": ids, "labels": labels, "formula": [False] * len(p) + fmask}


def load_checker_examples(tok, files, max_seq):
    """Checker task: the prompt is a question plus a finished card, the target is "yes" or "no" (balanced classes)."""
    import tool_checker as chk
    raw = [json.loads(l) for f in files for l in open(f) if l.strip()]
    rows, skipped = [], 0
    for r in chk.balanced(raw):
        text = "yes" if r["right"] else "no"
        enc = encode(tok, chk.user_prompt(r["ask"], r["card_text"]), text, max_seq, system=chk.SYSTEM)
        if enc is None:
            skipped += 1
            continue
        rows.append({"id": r["id"], "text": text, **enc})
    return rows, skipped


def load_examples(tok, files, max_seq, task="card"):
    if task == "checker":
        return load_checker_examples(tok, files, max_seq)
    rows, skipped = [], 0
    for f in files:
        for line in open(f):
            if not line.strip():
                continue
            r = json.loads(line)
            text = ts.canonical_text(r["card"])
            enc = encode(tok, r["ask"], text, max_seq) if text else None
            if enc is None or not ts.in_grammar(text):
                skipped += 1
                continue
            rows.append({"id": r["id"], "text": text, **enc})
    return rows, skipped


def batch_tensors(ex, device, pad_id=0, bucket=128):
    """One example, right-padded to a multiple of `bucket` tokens. The model is causal, so padding after the
    last real token cannot change anything before it, and padded positions carry no label. Few distinct
    shapes keep the MPS allocator from growing."""
    n = len(ex["ids"])
    width = -(-n // bucket) * bucket
    ids = torch.tensor([ex["ids"] + [pad_id] * (width - n)], device=device)
    labels = torch.tensor([ex["labels"] + [-100] * (width - n)], device=device)
    return ids, labels


@torch.no_grad()
def validate(model, examples, device):
    model.eval()
    tot_loss = tot_n = f_ok = f_n = a_ok = a_n = 0
    for ex in examples:
        ids, labels = batch_tensors(ex, device, 0)
        logits = model(input_ids=ids).logits[0, :-1].float()
        tgt = labels[0, 1:]
        mask = tgt != -100
        loss = torch.nn.functional.cross_entropy(logits[mask], tgt[mask], reduction="sum")
        pred = logits.argmax(-1)
        hit = (pred == tgt) & mask
        fm = torch.tensor(ex["formula"] + [False] * (labels.shape[1] - len(ex["formula"])), device=device)[1:] & mask
        tot_loss += loss.item(); tot_n += mask.sum().item()
        a_ok += hit.sum().item(); a_n += mask.sum().item()
        f_ok += (hit & fm).sum().item(); f_n += fm.sum().item()
    model.train()
    torch.mps.empty_cache()
    return {"val_loss": tot_loss / max(1, tot_n), "token_acc": a_ok / max(1, a_n), "formula_acc": f_ok / max(1, f_n), "val_examples": len(examples)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--data", nargs="+", required=True)
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--max-seq", type=int, default=1024)
    ap.add_argument("--val", type=int, default=8, help="examples held out for validation loss")
    ap.add_argument("--round-minutes", type=float, default=25)
    ap.add_argument("--ckpt-minutes", type=float, default=10)
    ap.add_argument("--log-secs", type=float, default=60)
    ap.add_argument("--limit-gb", type=float, default=11.5, help="stop above this much GPU memory")
    ap.add_argument("--max-swap-gb", type=float, default=3.0, help="stop if swap grows by this much")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--task", choices=["card", "checker"], default="card", help="card: write cards; checker: say yes or no to a finished card")
    ap.add_argument("--dropout", type=float, default=0.0, help="LoRA dropout")
    ap.add_argument("--wd", type=float, default=0.0, help="AdamW weight decay")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--init-adapter", default="", help="start from this saved adapter instead of a fresh one")
    ap.add_argument("--pause-each-round", action="store_true")
    a = ap.parse_args()

    run = RUNS / a.run
    (run / "ckpt").mkdir(parents=True, exist_ok=True)
    for f in ("STOP", "PAUSE", "RESUME"):
        (run / f).unlink(missing_ok=True)
    if disk_free_gb(run) < 15:
        sys.exit(f"refusing to start: only {disk_free_gb(run):.0f} GB free, need 15")

    tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
    examples, skipped = load_examples(tok, a.data, a.max_seq, a.task)
    examples.sort(key=lambda e: hashlib.sha1(e["id"].encode()).hexdigest())
    val, train = examples[: a.val], examples[a.val:]
    tokens_per_epoch = sum(len(e["ids"]) for e in train)
    total_micro = int(a.epochs * len(train))
    total_steps = max(1, math.ceil(total_micro / a.accum))
    data_hash = hashlib.sha1("".join(e["text"] for e in examples).encode()).hexdigest()[:12]
    print(f"{len(train)} train + {len(val)} validation examples ({skipped} skipped), {tokens_per_epoch} tokens per epoch, "
          f"{total_steps} optimizer steps, data {data_hash}", flush=True)

    device = "mps"
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, trust_remote_code=True, local_files_only=True).to(device)
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()

    state = {"micro": 0, "step": 0}
    last = run / "ckpt" / "last"
    if a.resume and last.exists():
        ck = pathlib.Path((last / "path").read_text().strip())
        model = PeftModel.from_pretrained(model, str(ck), is_trainable=True)
        state = torch.load(ck / "state.pt", map_location="cpu", weights_only=False)["progress"]
        print(f"resumed from {ck.name} at step {state['step']}", flush=True)
    elif a.init_adapter:
        model = PeftModel.from_pretrained(model, a.init_adapter, is_trainable=True)
        print(f"starting from adapter {a.init_adapter}", flush=True)
    else:
        model = get_peft_model(model, LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=a.dropout, target_modules=TARGETS, task_type="CAUSAL_LM"))
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=a.wd)
    if a.resume and last.exists():
        opt.load_state_dict(torch.load(ck / "state.pt", map_location="cpu", weights_only=False)["opt"])
    model.train()

    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    (run / "manifest.json").write_text(json.dumps({"args": vars(a), "data_hash": data_hash, "train": len(train), "val": len(val),
        "git": commit, "torch": torch.__version__, "started": time.strftime("%Y-%m-%d %H:%M:%S")}, indent=1))

    def order(micro: int):
        """The example for a micro-step: epochs reshuffled deterministically from the seed."""
        e, i = divmod(micro, len(train))
        idx = list(range(len(train)))
        random.Random(a.seed + e).shuffle(idx)
        return train[idx[i]]

    def lr_at(step: int) -> float:
        if step < 5:
            return a.lr * (step + 1) / 5
        prog = (step - 5) / max(1, total_steps - 5)
        return a.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, prog))))

    def checkpoint(tag: str) -> pathlib.Path:
        d = run / "ckpt" / f"step_{state['step']}"
        model.save_pretrained(str(d))
        torch.save({"opt": opt.state_dict(), "progress": dict(state)}, d / "state.pt")
        (last).mkdir(exist_ok=True)
        (last / "path").write_text(str(d))
        (d / "DONE").write_text(tag)
        kept = sorted((p for p in (run / "ckpt").glob("step_*")), key=lambda p: int(p.name.split("_")[1]))
        for old in kept[:-5]:
            shutil.rmtree(old, ignore_errors=True)
        v = validate(model, val, device)
        line = {"t": time.strftime("%H:%M:%S"), "step": state["step"], "epoch": round(state["micro"] / len(train), 2), "ckpt": str(d), "tag": tag, **v}
        with open(run / "evals.jsonl", "a") as f:
            f.write(json.dumps(line) + "\n")
        (run / "latest.json").write_text(json.dumps(line, indent=1))
        print(f"  checkpoint {d.name}: val loss {v['val_loss']:.3f}, formula-token accuracy {100 * v['formula_acc']:.0f}%, token accuracy {100 * v['token_acc']:.0f}%", flush=True)
        return d

    swap0, t_start, micro0 = swap_gb(), time.time(), state["micro"]
    t_log = t_ckpt = t_round = time.time()
    window_tokens, recent, rates, stop_reason = 0, [], [], None
    accum_loss, accum_n = 0.0, 0
    print(f"starting; swap at start {swap0:.1f} GB, GPU memory {mps_gb():.1f} GB", flush=True)

    while state["micro"] < total_micro and stop_reason is None:
        ex = order(state["micro"])
        ids, labels = batch_tensors(ex, device, tok.pad_token_id)
        out = model(input_ids=ids, labels=labels)
        loss = out.loss
        if not torch.isfinite(loss):
            stop_reason = "NaN or infinite loss (no checkpoint written)"
            break
        (loss / a.accum).backward()
        accum_loss += loss.item(); accum_n += 1
        window_tokens += len(ex["ids"])
        del out, loss
        torch.mps.empty_cache()
        state["micro"] += 1
        if accum_n == a.accum or state["micro"] == total_micro:
            for g in opt.param_groups:
                g["lr"] = lr_at(state["step"])
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step(); opt.zero_grad(set_to_none=True)
            torch.mps.empty_cache()
            state["step"] += 1
            mean = accum_loss / accum_n
            if len(recent) >= 20 and mean > 3 * (sum(recent[-20:]) / 20):
                stop_reason = f"loss spike ({mean:.2f} against a recent mean of {sum(recent[-20:]) / 20:.2f})"
            recent.append(mean); accum_loss, accum_n = 0.0, 0
        now = time.time()
        if mps_gb() > a.limit_gb:
            stop_reason = f"GPU memory {mps_gb():.1f} GB over the {a.limit_gb} GB limit"
        elif swap_gb() - swap0 > a.max_swap_gb:
            stop_reason = f"swap grew by {swap_gb() - swap0:.1f} GB"
        elif disk_free_gb(run) < 10:
            stop_reason = "free disk under 10 GB"
        if (run / "STOP").exists():
            stop_reason = "STOP file"
        if now - t_log >= a.log_secs:
            rate = window_tokens / (now - t_log)
            rates.append(rate)
            slow = len(rates) > 4 and rate < 0.7 * sorted(rates)[len(rates) // 2]
            did = max(state["micro"] - micro0, 1)
            eta = (now - t_start) / did * (total_micro - state["micro"]) / 60
            rec = {"t": time.strftime("%H:%M:%S"), "step": state["step"], "of": total_steps, "epoch": round(state["micro"] / len(train), 2),
                   "loss": round(sum(recent[-5:]) / max(1, len(recent[-5:])), 4), "tok_s": round(rate), "gpu_gb": round(mps_gb(), 1),
                   "swap_gb": round(swap_gb(), 1), "eta_min": round(eta, 1), "slow": slow}
            with open(run / "log.jsonl", "a") as f:
                f.write(json.dumps(rec) + "\n")
            print(f"step {rec['step']}/{total_steps} epoch {rec['epoch']} loss {rec['loss']} | {rec['tok_s']} tok/s | gpu {rec['gpu_gb']} GB swap {rec['swap_gb']} GB | ETA {rec['eta_min']} min" + ("  SLOW" if slow else ""), flush=True)
            t_log, window_tokens = now, 0
        if now - t_ckpt >= a.ckpt_minutes * 60:
            checkpoint("interval"); t_ckpt = time.time()
        if (run / "PAUSE").exists():
            checkpoint("pause"); print("paused: create RESUME to continue or STOP to end", flush=True)
            while not (run / "RESUME").exists() and not (run / "STOP").exists():
                time.sleep(3)
            (run / "PAUSE").unlink(missing_ok=True); (run / "RESUME").unlink(missing_ok=True)
            t_log = t_ckpt = t_round = time.time(); window_tokens = 0
        if now - t_round >= a.round_minutes * 60:
            d = checkpoint("round")
            print(f"== round finished at step {state['step']} ({d.name}) ==", flush=True)
            t_round = time.time(); t_ckpt = time.time()
            if a.pause_each_round:
                (run / "PAUSE").write_text("")

    if stop_reason and "NaN" not in stop_reason:
        print(f"STOPPING: {stop_reason}", flush=True)
        checkpoint("stop")
    elif stop_reason:
        print(f"STOPPING: {stop_reason}", flush=True)
    else:
        d = checkpoint("end")
        model.save_pretrained(str(run / "final"))
        print(f"finished: {state['step']} steps, final adapter in {run / 'final'}", flush=True)
    (run / "ended.json").write_text(json.dumps({"reason": stop_reason or "complete", "step": state["step"], "t": time.strftime("%H:%M:%S")}))


if __name__ == "__main__":
    main()
