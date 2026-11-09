#!/usr/bin/env python3
"""Export a trained run to ONNX, quantize it to int8, and check it against PyTorch.

    python3 tools/cards/export_onnx.py RUN MODEL_ID [--out models/card-classifier]
    python3 tools/cards/export_onnx.py RUN --finalize eval.json     # write thresholds into config.json

Step 1 writes model.onnx (fp32), model.int8.onnx, tokenizer.json and a config.json without
thresholds, then runs the int8 model over val / dev / anchor / test with the production
classifier (scripts/card_classifier_server.py) and saves those logits as run `RUN-int8`, so
eval.py can calibrate the int8 model itself. Step 2 copies temperatures and thresholds from an
eval.py --json file into config.json.
"""
import argparse
import json
import os
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import evalcore as ev


def export(run, model_id, out):
    import torch
    from transformers import AutoTokenizer
    import train as T
    from onnxruntime.quantization import QuantType, quantize_dynamic

    runs = os.path.join(ROOT, "data", "cards", "runs", run)
    os.makedirs(out, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(os.path.join(runs, "tokenizer"))
    net = T.Net(model_id)
    net.load_state_dict(torch.load(os.path.join(runs, "weights.pt"), map_location="cpu"))
    net.eval()
    sample = tok(["request: should i go freelance or stay"], [""], return_tensors="pt", padding="max_length", max_length=T.MAX_LEN, truncation=True)
    names = ["input_ids", "attention_mask", "token_type_ids"]
    args = tuple(sample[n] for n in names)

    class Wrap(torch.nn.Module):
        def __init__(self, net):
            super().__init__()
            self.net = net

        def forward(self, input_ids, attention_mask, token_type_ids):
            return self.net(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids)

    fp32 = os.path.join(out, "model.onnx")
    torch.onnx.export(Wrap(net), args, fp32, input_names=names, output_names=["kind", "level"],
                      dynamic_axes={n: {0: "batch", 1: "seq"} for n in names} | {"kind": {0: "batch"}, "level": {0: "batch"}},
                      opset_version=17, dynamo=False)
    int8 = os.path.join(out, "model.int8.onnx")
    quantize_dynamic(fp32, int8, weight_type=QuantType.QInt8, per_channel=True)
    shutil.copy(os.path.join(runs, "tokenizer", "tokenizer.json"), os.path.join(out, "tokenizer.json"))
    cfg = {"kinds": ev.KINDS, "max_len": T.MAX_LEN, "onnx": "model.int8.onnx", "model": model_id, "source_run": run,
           "t_kind": 1.0, "t_level": 1.0, "tau": {"medium": 0.5, "high": 0.5}, "low_variety": ["compare", "weigh", "draft"]}
    json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=1)
    print("fp32", round(os.path.getsize(fp32) / 1e6, 1), "MB   int8", round(os.path.getsize(int8) / 1e6, 1), "MB")
    return net, tok, T


def check(run, out, net, tok, T):
    import torch
    from card_classifier_server import Classifier

    clf = Classifier(out)
    tr = {}
    for l in open(os.path.join(ROOT, "data", "cards", "train.jsonl"), encoding="utf-8"):
        r = json.loads(l)
        tr[r["source"]] = r
    old = np.load(os.path.join(ROOT, "data", "cards", "runs", run, "logits.npz"))
    splits = {"val": [tr[s] for s in old["val_ids"]], "dev": ev.load("dev"), "anchor": ev.load("anchor"), "test": ev.load("test")}
    new = {}
    for name, rows in splits.items():
        ks, ls = [], []
        for i in range(0, len(rows), 32):
            k, lv = clf.logits([(r["mode"], r["person"], r["soren"]) for r in rows[i:i + 32]])
            ks.append(k)
            ls.append(lv)
        new[f"{name}_kind"], new[f"{name}_level"] = np.concatenate(ks), np.concatenate(ls)
    new["val_ids"] = old["val_ids"]
    for name in splits:
        if f"{name}_kind" in old:
            a, b = old[f"{name}_kind"], new[f"{name}_kind"]
            agree = float((a.argmax(1) == b.argmax(1)).mean())
            print(f"{name:<7} kind argmax agreement with torch fp32: {agree:.3f}   max |logit diff| {np.abs(a - b).max():.2f}")
    dest = os.path.join(ROOT, "data", "cards", "runs", run + "-int8")
    os.makedirs(dest, exist_ok=True)
    np.savez(os.path.join(dest, "logits.npz"), **new)
    print("saved int8 logits as run", run + "-int8")


def finalize(run, out, path):
    res = json.load(open(path))[run + "-int8"]
    cfg = json.load(open(os.path.join(out, "config.json")))
    cfg["t_kind"], cfg["t_level"], cfg["tau"] = res["t_kind"], res["t_level"], res["tau"]
    json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=1)
    print("wrote", cfg["t_kind"], cfg["t_level"], cfg["tau"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("model_id", nargs="?")
    ap.add_argument("--out", default=os.path.join(ROOT, "models", "card-classifier"))
    ap.add_argument("--finalize", default=None)
    a = ap.parse_args()
    if a.finalize:
        finalize(a.run, a.out, a.finalize)
    else:
        net, tok, T = export(a.run, a.model_id, a.out)
        check(a.run, a.out, net, tok, T)
