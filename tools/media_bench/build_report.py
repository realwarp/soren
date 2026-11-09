"""Builds out/index.html (white contact sheet) from out/*/results.json and out/*.meta.json."""
import html, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
E = html.escape


def load(p):
    try:
        return json.load(open(os.path.join(OUT, p)))
    except Exception:
        return None


def run_line(meta, res):
    if not meta:
        return "no run recorded"
    return (f"device {E(str(res.get('device')))} | load {res.get('load_s')} s | peak RSS {meta['peak_rss_gb']} GB | "
            f"swap {meta['swap_change_mb']:+.0f} MB ({E(meta['swap_before'].split('used = ')[1].split(' ')[0])} to "
            f"{E(meta['swap_after'].split('used = ')[1].split(' ')[0])})")


parts = ["""<!doctype html><html><head><meta charset="utf-8"><title>Soren media bench</title>
<style>body{background:#fff;color:#111;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;margin:24px}
h1{font-size:22px}h2{font-size:18px;margin-top:36px;border-top:2px solid #111;padding-top:12px}h3{font-size:15px;margin:20px 0 6px}
.row{display:flex;flex-wrap:wrap;gap:12px}.c{width:256px;font-size:12px;color:#444}.c img{width:256px;height:256px;border:1px solid #ccc;background:#fff;display:block;image-rendering:auto}
.note{color:#555;font-size:12px}.err{color:#a00;font-family:monospace;font-size:12px;white-space:pre-wrap}code{background:#f3f3f3;padding:1px 4px}</style></head><body>
<h1>Soren media bench: StarVector-1B and Pinhole S/M/L</h1>
<p class="note">Apple M2 Pro, 16 GB. Local only. One seed each (torch seed 0 / Pinhole seed 0). Timings are wall clock including MPS sync.</p>"""]

# ---- StarVector (FAIL; owner stopped it). Numbers come from the logs of the aborted runs.
import ast
parts.append("<h2>StarVector-1B (starvector/starvector-1b-im2svg): FAIL on this Mac</h2>")
parts.append("""<ul>
<li><b>MPS fp16:</b> loads in 11-26 s (2.94 GB on the device) but the 1a image-to-SVG generation grew the process to 28-29 GB (8 GB compressed) and pushed system swap from about 16.6 GB to 27.4 GB. Killed after 4:59 with no output. Does not fit 16 GB.</li>
<li><b>CPU fp32:</b> loads in 5.7 s, no output after about 30 min (stopped). Three earlier StarVector processes (PIDs 71329, 71817, 72370) leaked as orphans and were using CPU the whole time, so the CPU number is pessimistic.</li>
<li><b>Text to SVG:</b> a generate_text2svg method exists in the repo's base class but is not exposed on the released model class and raises a TypeError as shipped. With that one argument bug worked around (80-token probe on MPS) the output is noise, not SVG.</li></ul>""")
parts.append("<div class='row'><div class='c'><img src='starvector/1a_input.png'>1a input PNG (never vectorised)</div></div>")
parts.append("<h3>Text-to-SVG probe (80 tokens each, MPS, bug worked around)</h3><div class='row'>")
try:
    for line in open(os.path.join(OUT, "sv_diag.log")):
        if line.startswith("1b "):
            r = ast.literal_eval(line.split(" ", 2)[2])
            parts.append(f"<div class='c'><div style='height:256px;border:1px solid #ccc;display:flex;align-items:center;justify-content:center'>no valid SVG</div><b>{E(r['prompt'])}</b><br>{r['seconds']} s, {r['tokens']} tokens<br><span class='note'>{E(r['error'])}</span><br><code>{E(r['raw_head'][:90])}</code></div>")
except Exception as e:
    parts.append(f"<p class='err'>{E(repr(e))}</p>")
parts.append("</div>")

# ---- Pinhole
parts.append("<h2>Pinhole S / M / L (256x256, 4 images per prompt, 20 steps, cfg 4.0, seed 0)</h2>")
data = {}
for s in "sml":
    data[s] = (load(f"pinhole-{s}/results.json"), load(f"pinhole-{s}.meta.json"))
for s in "sml":
    res, meta = data[s]
    parts.append(f"<h3>pinhole-{s}</h3>")
    if not res:
        parts.append("<p class='err'>not run</p>"); continue
    parts.append(f"<p>{run_line(meta, res)}</p>")
    for ev in res.get("events", []):
        parts.append(f"<p class='err'>{E(ev['stage'])}: {E(ev['error'][-600:])}</p>")
    for i, p in enumerate(res.get("prompts", []), 1):
        parts.append(f"<p><b>{E(p['prompt'])}</b> <span class='note'>{p['seconds']} s for 4 images ({p['per_image']} s/image)</span></p><div class='row'>")
        for f in p["files"]:
            parts.append(f"<div class='c'><img src='pinhole-{s}/{f}'>{p['per_image']} s/image</div>")
        parts.append("</div>")
parts.append("</body></html>")
open(os.path.join(OUT, "index.html"), "w").write("\n".join(parts))
print("wrote", os.path.join(OUT, "index.html"))
