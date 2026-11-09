#!/usr/bin/env python3
"""Fine-tune one small encoder to predict card kind (7-way) and level (1-3) for an exchange.

    python3 tools/cards/train.py --model BAAI/bge-small-en-v1.5 --name bge-small [--epochs 4]

Reads data/cards/train.jsonl. 10% of it (stratified by kind) is held out as `val` for early
stopping and calibration; the curated dev split is a second, human-labelled check; the sealed
test split is only scored at the very end (its logits are saved so eval.py can read them, but
nothing here selects on it). Writes data/cards/runs/<name>/{logits.npz, model/, log.json}.
"""
import argparse
import json
import os
import random
import sys
import time

import numpy as np
import torch
import torch.nn as nn
from transformers import AutoModel, AutoTokenizer, get_linear_schedule_with_warmup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evalcore as ev

KINDS = ev.KINDS
MAX_LEN = 96  # p99 of the data is 82 tokens, the longest 130; a fixed shape keeps the MPS allocator from growing


def text_pair(r):
    return f"{r['mode']}: {r['person']}", (r["soren"] or "")


def encode(tok, rows):
    a, b = zip(*(text_pair(r) for r in rows))
    kw = dict(truncation="longest_first", max_length=MAX_LEN, padding="max_length", return_tensors="pt")
    return tok(list(a), list(b), **kw)


class Net(nn.Module):
    def __init__(self, name):
        super().__init__()
        self.enc = AutoModel.from_pretrained(name, dtype=torch.float32)
        h = self.enc.config.hidden_size
        self.drop = nn.Dropout(0.1)
        self.kind = nn.Linear(h, len(KINDS))
        self.level = nn.Linear(h, 3)

    def forward(self, **batch):
        out = self.enc(**batch).last_hidden_state
        m = batch["attention_mask"].unsqueeze(-1).to(out.dtype)
        pooled = self.drop((out * m).sum(1) / m.sum(1).clamp(min=1))
        return self.kind(pooled), self.level(pooled)


def batches(rows, size, shuffle, rnd):
    idx = list(range(len(rows)))
    if shuffle:
        rnd.shuffle(idx)
    for i in range(0, len(idx), size):
        yield [rows[j] for j in idx[i:i + size]]


def targets(rows, device):
    k = torch.tensor([KINDS.index(r["kind"]) for r in rows], device=device)
    lv = torch.tensor([max(r["level"], 1) - 1 for r in rows], device=device)
    w = torch.tensor([r.get("weight", 1.0) for r in rows], device=device, dtype=torch.float32)
    card = torch.tensor([r["kind"] != "none" for r in rows], device=device)
    return k, lv, w, card


@torch.no_grad()
def predict(model, tok, rows, device, size=64):
    model.eval()
    ks, ls = [], []
    for chunk in batches(rows, size, False, None):
        enc = {k: v.to(device) for k, v in encode(tok, chunk).items()}
        k, lv = model(**enc)
        ks.append(k.float().cpu().numpy())
        ls.append(lv.float().cpu().numpy())
    return np.concatenate(ks), np.concatenate(ls)


def quick_acc(rows, k, lv):
    kind = np.array([KINDS.index(r["kind"]) for r in rows])
    return float((k.argmax(1) == kind).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=4e-5)
    ap.add_argument("--bs", type=int, default=32)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--limit", type=int, default=0, help="train on this many examples only (timing pilot)")
    args = ap.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = os.environ.get("CARD_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")

    train_all = [json.loads(l) for l in open(os.path.join(ev.ROOT, "data", "cards", "train.jsonl"), encoding="utf-8")]
    rnd = random.Random(args.seed)
    by_kind = {}
    for r in train_all:
        by_kind.setdefault(r["kind"], []).append(r)
    train, val = [], []
    for rs in by_kind.values():
        rnd.shuffle(rs)
        cut = max(1, len(rs) // 10)
        val += rs[:cut]
        train += rs[cut:]
    rnd.shuffle(train)
    if args.limit:
        train = train[:args.limit]
    dev, test = ev.load("dev"), ev.load("test")
    print(f"train {len(train)}  val {len(val)}  dev {len(dev)}  test {len(test)}  device {device}", flush=True)

    tok = AutoTokenizer.from_pretrained(args.model)
    model = Net(args.model).to(device)
    n_params = sum(p.numel() for p in model.parameters()) / 1e6
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * ((len(train) + args.bs - 1) // args.bs)
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    ce = nn.CrossEntropyLoss(reduction="none")
    log = {"model": args.model, "params_m": round(n_params, 1), "epochs": []}
    best, best_state = -1.0, None
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for chunk in batches(train, args.bs, True, rnd):
            enc = {k: v.to(device) for k, v in encode(tok, chunk).items()}
            k, lv, w, card = targets(chunk, device)
            lk, ll = model(**enc)
            loss = (ce(lk, k) * w).mean()
            if card.any():
                loss = loss + 0.5 * (ce(ll[card], lv[card]) * w[card]).mean()
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            if device == "mps":
                torch.mps.empty_cache()
            total += loss.item() * len(chunk)
        vk, vl = predict(model, tok, val, device)
        dk, dl = predict(model, tok, dev, device)
        v_acc, d_acc = quick_acc(val, vk, vl), quick_acc(dev, dk, dl)
        entry = {"epoch": epoch + 1, "loss": round(total / len(train), 4), "val_kind_acc": round(v_acc, 4),
                 "dev_kind_acc": round(d_acc, 4), "seconds": round(time.time() - t0)}
        log["epochs"].append(entry)
        print(entry, flush=True)
        # Early stopping looks at val only; dev stays a clean outside check.
        if v_acc > best:
            best = v_acc
            best_state = {k_: v_.detach().cpu().clone() for k_, v_ in model.state_dict().items()}
    model.load_state_dict(best_state)

    out = os.path.join(ev.ROOT, "data", "cards", "runs", args.name)
    os.makedirs(out, exist_ok=True)
    arrays = {}
    for name, rows in (("val", val), ("dev", dev), ("test", test)):
        k, lv = predict(model, tok, rows, device)
        arrays[f"{name}_kind"], arrays[f"{name}_level"] = k, lv
    arrays["val_ids"] = np.array([r["source"] for r in val])
    np.savez(os.path.join(out, "logits.npz"), **arrays)

    # Latency for one exchange on this machine, CPU torch (a rough guide; the ONNX int8 number is what ships).
    model.to("cpu").eval()
    one = encode(tok, [test[0]])
    with torch.no_grad():
        for _ in range(3):
            model(**one)
        t = time.time()
        for _ in range(20):
            model(**one)
    log["cpu_ms_per_exchange"] = round((time.time() - t) / 20 * 1000, 1)
    log["train_seconds"] = round(time.time() - t0)
    json.dump(log, open(os.path.join(out, "log.json"), "w"), indent=1)
    torch.save(model.state_dict(), os.path.join(out, "weights.pt"))
    tok.save_pretrained(os.path.join(out, "tokenizer"))
    print(json.dumps({k: v for k, v in log.items() if k != "epochs"}))


if __name__ == "__main__":
    main()
