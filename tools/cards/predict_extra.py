#!/usr/bin/env python3
"""Add logits for the curated `anchor` split to a trained run's logits.npz.

    python3 tools/cards/predict_extra.py RUN MODEL_ID [RUN MODEL_ID ...]

The anchors are human-labelled and were never trained on (generators saw a few as style
examples). They give eval.py a second human calibration set beside the 40 dev examples, so the
card threshold is not fitted only to synthetic validation data.
"""
import os
import sys

import numpy as np
import torch
from transformers import AutoTokenizer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evalcore as ev
import train as T


def main():
    args = sys.argv[1:]
    anchors = ev.load("anchor")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    for run, model_id in zip(args[0::2], args[1::2]):
        path = os.path.join(ev.ROOT, "data", "cards", "runs", run)
        tok = AutoTokenizer.from_pretrained(os.path.join(path, "tokenizer"))
        model = T.Net(model_id)
        model.load_state_dict(torch.load(os.path.join(path, "weights.pt"), map_location="cpu"))
        model.to(device)
        k, lv = T.predict(model, tok, anchors, device)
        old = dict(np.load(os.path.join(path, "logits.npz")))
        old["anchor_kind"], old["anchor_level"] = k, lv
        np.savez(os.path.join(path, "logits.npz"), **old)
        print(run, "anchor logits added", k.shape)
        del model
        if device == "mps":
            torch.mps.empty_cache()


if __name__ == "__main__":
    main()
