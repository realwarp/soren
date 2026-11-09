#!/usr/bin/env python3
"""The checker: a second adapter on the same base model that reads a question and a finished card and says yes or no.

A card is "yes" when its first output answers the question the way the verified reference does (same judge as the dev
scorer), "no" otherwise. Training rows come from tool_labels.py (sampled cards with their verdicts). In the app the checker
would run after the writer and before the card is shown: no => say "not sure" instead of showing the card.

    python3 tools/cards/tool_checker.py stats [labels_dir]       # counts of right and wrong sampled cards by wave and kind
    tooltrain.py --task checker --data data/cards/tool/labels/samples.jsonl ...   # trains the adapter (see tooltrain.py)
"""
from __future__ import annotations

import json
import pathlib
import random
import sys
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tooldata as td  # noqa: E402
import toolspec as ts  # noqa: E402

SYSTEM = ("You check calculator cards. Reply yes if the card's first output correctly answers the question, with units, "
          "scale and any assumed numbers handled sensibly, or if it rightly declines a question that is not a calculation. "
          "Reply no otherwise.")


def user_prompt(ask: str, card_text: str) -> str:
    """What the checker sees: the question, the card, and the card's first answer at its start values."""
    answer = ""
    try:
        card = json.loads(card_text)
        if card.get("decline") is not None:
            answer = "The card declines: " + str(card["decline"])
        else:
            card = ts.repair(card)
            out = card["outputs"][0]
            answer = f"At the start values the first output ({out['label']}) is {ts.fmt_num(ts.answer(card))} {out.get('unit', '')}".rstrip()
    except Exception:  # noqa: BLE001
        answer = "The card could not be evaluated."
    return f"Question: {ask}\n\nCard: {card_text}\n\n{answer}.\n\nDoes the first output correctly answer the question?"


def balanced(rows: list[dict], seed: int = 7) -> list[dict]:
    """Equal numbers of right and wrong cards, so the checker cannot win by always answering the majority."""
    yes, no = [r for r in rows if r["right"]], [r for r in rows if not r["right"]]
    n = min(len(yes), len(no))
    rng = random.Random(seed)
    rng.shuffle(yes)
    rng.shuffle(no)
    return yes[:n] + no[:n]


def stats(path: pathlib.Path) -> None:
    rows = [json.loads(l) for l in open(path / "samples.jsonl") if l.strip()]
    print(f"{len(rows)} sampled cards from {len({r['ask_id'] for r in rows})} asks")
    for key in ("wave", "kind", "status"):
        c = Counter((r[key], r["right"]) for r in rows)
        print(f"by {key}:", {k: f"{c[(k, True)]} right / {c[(k, False)]} wrong" for k in sorted({k for k, _ in c})})
    print(f"balanced training set would hold {len(balanced(rows))} cards")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "stats":
        stats(pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else td.DATA / "labels")
    else:
        print(__doc__)
