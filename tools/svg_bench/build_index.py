#!/usr/bin/env python3
"""Build out/index.html (phone-friendly contact sheet), out/stats.json and a markdown stats table.

usage: build_index.py [--png]   (--png also writes out/png/<model>_<concept>_<approach>.png strips for viewing)
"""
import argparse
import html
import json
import re
import statistics as st
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
MODEL_ORDER = ["bonsai2-2B", "bonsai2-4B", "bonsai2-9B"]
NICE = {"bonsai2-2B": "Bonsai 2 2B", "bonsai2-4B": "Bonsai 2 4B", "bonsai2-9B": "Bonsai 2 9B"}
APPROACH_NAME = {"A": "A raw SVG", "B": "B scene JSON + renderer"}


def load():
    models = {}
    for m in MODEL_ORDER:
        d = OUT / m
        if not (d / "results.jsonl").exists():
            continue
        recs = [json.loads(x) for x in (d / "results.jsonl").read_text().splitlines() if x.strip()]
        meta = json.loads((d / "meta.json").read_text()) if (d / "meta.json").exists() else {}
        models[m] = {"recs": recs, "meta": meta, "dir": d}
    return models


def inline_svg(path):
    s = path.read_text()
    s = re.sub(r"^\s*<\?xml.*?\?>", "", s)
    s = re.sub(r"<!DOCTYPE[^>]*>", "", s)
    m = re.search(r"<svg\b[^>]*>", s)
    if not m:
        return None
    tag = m.group(0)
    new = re.sub(r'\s(width|height)="[^"]*"', "", tag)
    if "viewBox" not in new:
        new = new[:-1] + ' viewBox="0 0 320 240">'
    return s.replace(tag, new, 1)


def ids_of(path, approach):
    if approach == "B":
        j = path.with_suffix(".json")
        if not j.exists():
            return None
        return {o["id"] for o in json.loads(j.read_text())["objects"]}
    try:
        root = ET.fromstring(path.read_text())
    except Exception:
        return None
    return {("".join(el.itertext())).strip().lower() for el in root.iter() if el.tag.split("}")[-1] == "text" and "".join(el.itertext()).strip()}


def stats(models):
    rows = []
    for m, d in models.items():
        for ap in "AB":
            r = [x for x in d["recs"] if x["approach"] == ap]
            if not r:
                continue
            n = len(r)
            valid = [x for x in r if x["valid"]]
            # reuse of objects between consecutive valid panels
            reuse = []
            for c in {x["concept"] for x in r}:
                prev = None
                for k in range(1, 5):
                    p = d["dir"] / f"{c}_{ap}_p{k}.svg"
                    cur = ids_of(p, ap) if p.exists() else None
                    if prev and cur:
                        reuse.append(len(prev & cur) / len(prev))
                    prev = cur if cur else prev
            seqs = {}
            for x in r:
                seqs.setdefault(x["concept"], 0.0)
                seqs[x["concept"]] += x["seconds"]
            row = {
                "model": m, "approach": ap, "panels": n,
                "valid_pct": round(100 * len(valid) / n, 1),
                "first_try_pct": round(100 * sum(1 for x in r if x["valid_first_try"]) / n, 1),
                "retries": sum(x["retries"] for x in r),
                "s_per_panel": round(st.mean(x["seconds"] for x in r), 1),
                "s_per_sequence": round(st.mean(seqs.values()), 1),
                "tok_per_s": round(st.mean(x["tok_per_s"] for x in r if x["tok_per_s"]), 1),
                "gen_tokens": round(st.mean(x["gen_tokens"] for x in r)),
                "max_s": max(x["seconds"] for x in r),
                "timeouts": sum(1 for x in r if x["finish"] == "timeout"),
                "reuse_pct": round(100 * st.mean(reuse), 1) if reuse else None,
            }
            if ap == "A":
                row["text_ok_pct"] = round(100 * sum(1 for x in valid if (x.get("texts") or 0) <= 3) / n, 1)
            else:
                row["overlap_free_pct"] = round(100 * sum(1 for x in valid if not x.get("overlaps")) / n, 1)
            mt = d["meta"]
            row.update({k: mt.get(k) for k in ("file_gb", "peak_rss_gb", "peak_footprint_gb", "swap_change_mb",
                                               "swap_max_change_mb", "load_seconds")})
            rows.append(row)
    return rows


CSS = """
:root{--ink:#111;--mut:#555;--line:#d1d5db;--acc:#1d4ed8;--bad:#b91c1c}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;padding:12px 12px 40px;max-width:1100px;margin:0 auto}
h1{font-size:20px;margin:6px 0}h2{font-size:17px;margin:28px 0 4px;border-top:2px solid var(--ink);padding-top:10px}
.sub{color:var(--mut);font-size:12px;margin:0 0 8px}
.row{margin:10px 0 18px}.rh{font-weight:700;font-size:13px;margin:0 0 4px}
.rh small{font-weight:400;color:var(--mut)}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}}
.p{border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff}
.p svg{display:block;width:100%;height:auto}
.p .bad{aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;color:var(--bad);padding:8px;background:#fef2f2}
.t{font-size:11px;color:var(--mut);padding:4px 6px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
.t b{color:var(--ink)}.t .rt{color:var(--bad)}
.script{font-size:12px;color:var(--mut);margin:2px 0 6px}
table{border-collapse:collapse;font-size:12px;width:100%;margin:8px 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:3px 6px;text-align:right;white-space:nowrap}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
th{background:#f3f4f6}
"""


def build(models, rows):
    concepts = json.loads((HERE / "concepts.json").read_text())
    p = ["<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
         "<title>SVG panel bench</title><style>" + CSS + "</style></head><body>",
         "<h1>Local text models drawing 4-panel explainers</h1>",
         "<p class=sub>A = model writes raw SVG. B = model writes scene JSON, code renders it. Per panel: seconds (including any retry), "
         "generated tokens, tokens/s. Fixed seed, temperature 0.3. All inline SVG.</p>"]
    hdr = ["model", "appr", "valid %", "1st try %", "s/panel", "s/seq", "tok/s", "peak GB", "swap MB", "reuse %"]
    p.append("<table><tr>" + "".join(f"<th>{h}</th>" for h in hdr) + "</tr>")
    for r in rows:
        swap = r["swap_max_change_mb"]
        p.append("<tr>" + "".join(f"<td>{v}</td>" for v in [
            NICE[r["model"]], r["approach"], r["valid_pct"], r["first_try_pct"], r["s_per_panel"], r["s_per_sequence"],
            r["tok_per_s"], r.get("peak_footprint_gb") or r.get("peak_rss_gb"), swap if swap is not None else "", r["reuse_pct"]]) + "</tr>")
    p.append("</table>")
    for c in concepts:
        p.append(f"<h2>{html.escape(c['name'])}</h2>")
        p.append("<p class=script>" + " &rarr; ".join(f"{i}. {html.escape(t)}" for i, t in enumerate(c["panels"], 1)) + "</p>")
        for ap in "AB":
            for m, d in models.items():
                recs = {x["panel"]: x for x in d["recs"] if x["concept"] == c["id"] and x["approach"] == ap}
                if not recs:
                    continue
                tot = sum(x["seconds"] for x in recs.values())
                ok = sum(1 for x in recs.values() if x["valid"])
                p.append(f"<div class=row><p class=rh>{NICE[m]} &middot; {APPROACH_NAME[ap]} <small>{ok}/4 valid &middot; {tot:.0f} s total</small></p><div class=grid>")
                for k in range(1, 5):
                    x = recs.get(k)
                    if not x:
                        p.append("<div class=p><div class=bad>not run</div></div>")
                        continue
                    sv = d["dir"] / f"{c['id']}_{ap}_p{k}.svg"
                    body = inline_svg(sv) if x["valid"] and sv.exists() else None
                    if body is None:
                        err = html.escape((x["errors"][0] if x["errors"] else x["finish"] or "invalid")[:90])
                        body = f"<div class=bad>invalid: {err}</div>"
                    rt = f" <span class=rt>retry {x['retries']}</span>" if x["retries"] else ""
                    p.append(f"<div class=p>{body}<div class=t>p{k} &middot; <b>{x['seconds']:.1f} s</b> &middot; {x['gen_tokens']} tok &middot; "
                             f"{x['tok_per_s']:.0f} t/s{rt}</div></div>")
                p.append("</div></div>")
    p.append("</body></html>")
    (OUT / "index.html").write_text("".join(p))


def md_table(rows):
    out = ["| model | approach | s/panel | s/4-panel | valid % | 1st-try % | tok/s | peak GB (footprint / RSS) | swap change MB (end / max) |",
           "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        out.append(f"| {NICE[r['model']]} | {r['approach']} | {r['s_per_panel']} | {r['s_per_sequence']} | {r['valid_pct']} | "
                   f"{r['first_try_pct']} | {r['tok_per_s']} | {r.get('peak_footprint_gb')} / {r.get('peak_rss_gb')} | "
                   f"{r.get('swap_change_mb')} / {r.get('swap_max_change_mb')} |")
    return "\n".join(out)


def pngs(models):
    import os
    os.environ.setdefault("DYLD_FALLBACK_LIBRARY_PATH", "/opt/homebrew/lib")
    import cairosvg
    from PIL import Image
    (OUT / "png").mkdir(exist_ok=True)
    for c in json.loads((HERE / "concepts.json").read_text()):
        for ap in "AB":
            for m, d in models.items():
                ims = []
                for k in range(1, 5):
                    sv = d["dir"] / f"{c['id']}_{ap}_p{k}.svg"
                    if sv.exists():
                        try:
                            cairosvg.svg2png(url=str(sv), write_to=str(OUT / "png/_t.png"), output_width=400, output_height=300,
                                             background_color="white")
                            ims.append(Image.open(OUT / "png/_t.png").convert("RGB").copy())
                            continue
                        except Exception:
                            pass
                    ims.append(Image.new("RGB", (400, 300), "#fecaca"))
                sheet = Image.new("RGB", (4 * 404, 300), "#888")
                for i, im in enumerate(ims):
                    sheet.paste(im, (i * 404, 0))
                sheet.save(OUT / f"png/{m}_{c['id']}_{ap}.png")
    (OUT / "png/_t.png").unlink(missing_ok=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", action="store_true")
    a = ap.parse_args()
    models = load()
    rows = stats(models)
    (OUT / "stats.json").write_text(json.dumps(rows, indent=1))
    build(models, rows)
    print(md_table(rows))
    for r in rows:
        print(r["model"], r["approach"], "reuse%", r["reuse_pct"], "text<=3 %", r.get("text_ok_pct"), "overlap-free %",
              r.get("overlap_free_pct"), "max s", r["max_s"], "timeouts", r["timeouts"], "gen tok", r["gen_tokens"])
    if a.png:
        pngs(models)
