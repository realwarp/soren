"""Builds out2/contact_sheet2.html: one block per concept, columns b | c | d | e, four panels each, timings under every image.

b comes from pilot 1 (out/, timings parsed from out/worker_*.log); c, d, e come from pilot 2 (out2/, timings from out2/results2.json).
Needs Pillow. Run: python3 tools/panel_data/scripts/contact_sheet2.py
"""
import base64
import html
import io
import json
import pathlib
import re

from PIL import Image

root = pathlib.Path(__file__).resolve().parent.parent
out1, out2 = root / "out", root / "out2"
spec = json.loads((root / "scripts" / "concepts_pilot2.json").read_text())

t1 = {}
for log in out1.glob("worker_*.log"):
    for m in re.finditer(r"^\[w\d\] (\S+\.png) ([\d.]+)s (\S+) bad=(\w+)", log.read_text(), re.M):
        t1[m.group(1)] = (float(m.group(2)), m.group(4) == "True")
r2 = json.loads((out2 / "results2.json").read_text())
t2 = {i["file"]: (i["seconds"], i["bad"]) for i in r2["images"]}
MODES = [("b", "(b) panel 1 as reference, same prompts (pilot 1)", out1, t1),
         ("c", "(c) previous panel as reference, same prompts", out2, t2),
         ("d", "(d) previous panel as reference + change wording", out2, t2),
         ("e", "(e) panel 1 as reference + change wording", out2, t2)]


def cell(d, tm, fn, panel):
    p = d / fn
    if not p.exists():
        return "<div class=c><div class=ph>missing</div></div>"
    im = Image.open(p).convert("RGB")
    im.thumbnail((256, 256))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=88)
    cap = "panel 1 (shared text-only start)" if panel == 1 else (f"{tm[fn][0]:.2f}s" + (" BAD" if tm[fn][1] else "") if fn in tm else "")
    return f"<div class=c><img src='data:image/jpeg;base64,{base64.b64encode(b.getvalue()).decode()}'><div class=t>{html.escape(fn)}<br>{cap}</div></div>"


rows = []
for c in spec["concepts"]:
    blocks = []
    for m, label, d, tm in MODES:
        ims = "".join(cell(d, tm, f"{c['id']}_{m}_{p}.png", p) for p in range(1, 5))
        blocks.append(f"<div class=blk><h4>{html.escape(label)}</h4><div class=ims>{ims}</div></div>")
    rows.append(f"<h3>{html.escape(c['title'])} <span class=g>({c['group']}, seed {c['seed']})</span></h3><div class=row>{''.join(blocks)}</div>")

page = ("<!doctype html><meta charset=utf-8><title>Panel pilot 2 contact sheet</title><style>body{background:#fff;color:#111;font:14px system-ui;margin:24px}"
        "h3{margin:28px 0 6px}.g{font-weight:400;color:#777;font-size:12px}h4{margin:0 0 4px;font-weight:600;color:#444;font-size:12px}"
        ".row{display:flex;gap:20px;flex-wrap:wrap}.ims{display:flex;gap:4px}.c{width:120px}.c img{width:120px;height:120px;border:1px solid #ddd}"
        ".t{font-size:9px;color:#555}.ph{width:120px;height:120px;border:1px dashed #bbb;color:#999;display:flex;align-items:center;justify-content:center}</style>"
        "<h2>FLUX.2 klein 4B pilot 2, 512x512, 4 steps</h2>" + "".join(rows))
(out2 / "contact_sheet2.html").write_text(page)
print("wrote", out2 / "contact_sheet2.html")
