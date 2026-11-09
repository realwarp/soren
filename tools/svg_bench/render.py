#!/usr/bin/env python3
"""Deterministic renderer: scene JSON -> SVG (320x240), plus the scene validator.

Scene format (one per panel):
{
  "caption": "short step title",
  "objects": [{"id","type","label","x","y","w","h","color"}],
  "arrows":  [{"from","to","label","color"}]
}
Grid is 12 columns x 9 rows (x 0..11, y 0..8). Types: box, cylinder, file,
person, gate, cloud, zone (dashed boundary, drawn behind), icon:<lucide-name>.
Colours: ink (black, default), accent (blue), white (outline), grey.

Only the standard library is needed to render; validation uses jsonschema when
it is installed (the structural part) and always runs the cross-reference checks.
"""
import json
import math
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
ICON_DIR = HERE / "icons"

W, H = 320, 240
COLS, ROWS = 12, 9
CW = W / COLS          # 26.67 px per column
CH = 24.0              # 9 rows * 24 = 216, bottom 24 px is the caption strip
CAP_Y = ROWS * CH

INK = "#111111"
ACCENT = "#1D4ED8"
FONT = "Helvetica, Arial, sans-serif"

# colour name -> (fill, stroke, text-on-fill)
COLORS = {
    "ink": (INK, INK, "#FFFFFF"),
    "accent": (ACCENT, ACCENT, "#FFFFFF"),
    "white": ("#FFFFFF", INK, INK),
    "grey": ("#E5E7EB", INK, INK),
}
TYPES = ["box", "cylinder", "file", "person", "gate", "cloud", "zone"]
MAX_LABEL = 16
MAX_ARROW_LABEL = 12


def icon_names():
    return sorted(p.stem for p in ICON_DIR.glob("*.svg"))


SCHEMA = {
    "type": "object",
    "required": ["caption", "objects", "arrows"],
    "additionalProperties": False,
    "properties": {
        "caption": {"type": "string", "maxLength": 34},
        "objects": {
            "type": "array", "minItems": 1, "maxItems": 10,
            "items": {
                "type": "object",
                "required": ["id", "type", "x", "y", "w", "h"],
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,15}$"},
                    "type": {"type": "string", "pattern": "^(box|cylinder|file|person|gate|cloud|zone|icon:[a-z0-9-]+)$"},
                    "label": {"type": "string", "maxLength": MAX_LABEL},
                    "x": {"type": "integer", "minimum": 0, "maximum": COLS - 1},
                    "y": {"type": "integer", "minimum": 0, "maximum": ROWS - 1},
                    "w": {"type": "integer", "minimum": 1, "maximum": COLS},
                    "h": {"type": "integer", "minimum": 1, "maximum": ROWS},
                    "color": {"enum": list(COLORS)},
                },
            },
        },
        "arrows": {
            "type": "array", "maxItems": 8,
            "items": {
                "type": "object",
                "required": ["from", "to"],
                "additionalProperties": False,
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "label": {"type": "string", "maxLength": MAX_ARROW_LABEL},
                    "color": {"enum": ["ink", "accent"]},
                },
            },
        },
    },
}


def validate_scene(scene):
    """Return a list of human-readable error strings (empty list = valid)."""
    errs = []
    try:
        import jsonschema
        v = jsonschema.Draft202012Validator(SCHEMA)
        for e in sorted(v.iter_errors(scene), key=lambda e: list(map(str, e.path))):
            loc = "/".join(map(str, e.path)) or "(root)"
            errs.append(f"{loc}: {e.message[:120]}")
    except ImportError:
        if not isinstance(scene, dict):
            return ["root must be an object"]
    if errs or not isinstance(scene, dict):
        return errs or ["root must be an object"]
    ids = set()
    names = set(icon_names())
    for o in scene["objects"]:
        if o["id"] in ids:
            errs.append(f"duplicate id {o['id']}")
        ids.add(o["id"])
        if o["x"] + o["w"] > COLS:
            errs.append(f"{o['id']}: x+w={o['x'] + o['w']} exceeds {COLS}")
        if o["y"] + o["h"] > ROWS:
            errs.append(f"{o['id']}: y+h={o['y'] + o['h']} exceeds {ROWS}")
        if o["type"].startswith("icon:") and o["type"][5:] not in names:
            errs.append(f"{o['id']}: unknown icon {o['type'][5:]} (available: {', '.join(sorted(names))})")
    for i, a in enumerate(scene["arrows"]):
        for k in ("from", "to"):
            if a[k] not in ids:
                errs.append(f"arrows/{i}: {k} '{a[k]}' is not an object id")
        if a["from"] == a["to"]:
            errs.append(f"arrows/{i}: from and to are the same")
    return errs


def overlaps(scene):
    """Count pairs of non-zone objects whose grid rectangles overlap (quality warning)."""
    objs = [o for o in scene["objects"] if o["type"] != "zone"]
    n = 0
    for i in range(len(objs)):
        for j in range(i + 1, len(objs)):
            a, b = objs[i], objs[j]
            if a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and \
               a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]:
                n += 1
    return n


# ---------------------------------------------------------------- drawing helpers

def f(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


def fit_text(label, width, max_size=11.0, min_size=6.5):
    """Return (lines, size) so the label fits width, splitting on a space if needed."""
    def size_for(s):
        return min(max_size, width / (0.58 * max(1, len(s))))
    size = size_for(label)
    if size >= 8 or " " not in label:
        return [label], max(min_size, size)
    words = label.split(" ")
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        m = max(len(a), len(b))
        if best is None or m < best[0]:
            best = (m, [a, b])
    lines = best[1]
    return lines, max(min_size, min(max_size, width / (0.58 * best[0])))


def text_el(lines, size, cx, cy, fill, weight=600):
    """Centered (possibly 2-line) text with vertical centre at cy."""
    out = []
    n = len(lines)
    lh = size * 1.15
    y0 = cy - (n - 1) * lh / 2 + size * 0.34
    for i, ln in enumerate(lines):
        out.append(f'<text x="{f(cx)}" y="{f(y0 + i * lh)}" font-size="{f(size)}" font-weight="{weight}" '
                   f'text-anchor="middle" fill="{fill}" font-family="{FONT}">{escape(ln)}</text>')
    return "".join(out)


def load_icon(name):
    p = ICON_DIR / f"{name}.svg"
    if not p.exists():
        return ""
    s = p.read_text()
    s = re.sub(r"^.*?<svg[^>]*>", "", s, flags=re.S)
    s = re.sub(r"</svg>\s*$", "", s)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    return s.strip()


def obj_rect(o):
    px, py = o["x"] * CW + 2, o["y"] * CH + 2
    return px, py, o["w"] * CW - 4, o["h"] * CH - 4


def draw_object(o):
    t = o["type"]
    col = o.get("color", "ink")
    fill, stroke, tcol = COLORS[col]
    label = o.get("label", "")
    px, py, pw, ph = obj_rect(o)
    cx, cy = px + pw / 2, py + ph / 2
    s = []
    if t == "zone":
        zc = ACCENT if o.get("color", "accent") == "accent" else INK
        s.append(f'<rect x="{f(px)}" y="{f(py)}" width="{f(pw)}" height="{f(ph)}" rx="8" fill="none" '
                 f'stroke="{zc}" stroke-width="1.6" stroke-dasharray="5 3"/>')
        if label:
            s.append(f'<text x="{f(px + 7)}" y="{f(py + 12)}" font-size="9" font-weight="700" fill="{zc}" '
                     f'font-family="{FONT}">{escape(label)}</text>')
        return "".join(s)
    if t == "box":
        s.append(f'<rect x="{f(px)}" y="{f(py)}" width="{f(pw)}" height="{f(ph)}" rx="6" fill="{fill}" '
                 f'stroke="{stroke}" stroke-width="1.5"/>')
        if label:
            lines, size = fit_text(label, pw - 8)
            s.append(text_el(lines, size, cx, cy, tcol))
    elif t == "cylinder":
        e = min(ph * 0.18, 8)
        s.append(f'<path d="M{f(px)},{f(py + e)} a{f(pw / 2)},{f(e)} 0 0 1 {f(pw)},0 v{f(ph - 2 * e)} '
                 f'a{f(pw / 2)},{f(e)} 0 0 1 {f(-pw)},0 z" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        s.append(f'<path d="M{f(px)},{f(py + e)} a{f(pw / 2)},{f(e)} 0 0 0 {f(pw)},0" fill="none" '
                 f'stroke="{tcol}" stroke-width="1" opacity="0.8"/>')
        if label:
            lines, size = fit_text(label, pw - 8)
            s.append(text_el(lines, size, cx, cy + e / 2, tcol))
    elif t == "file":
        fold = min(10, pw * 0.3, ph * 0.3)
        s.append(f'<path d="M{f(px)},{f(py)} h{f(pw - fold)} l{f(fold)},{f(fold)} v{f(ph - fold)} h{f(-pw)} z" '
                 f'fill="{fill}" stroke="{stroke}" stroke-width="1.5" stroke-linejoin="round"/>')
        s.append(f'<path d="M{f(px + pw - fold)},{f(py)} v{f(fold)} h{f(fold)}" fill="none" stroke="{tcol}" '
                 f'stroke-width="1" opacity="0.8"/>')
        if label:
            lines, size = fit_text(label, pw - 8)
            s.append(text_el(lines, size, cx, cy + fold / 3, tcol))
    elif t in ("person", "gate"):
        fig_h = ph * (0.62 if label else 1.0)
        if t == "person":
            r = min(fig_h * 0.22, pw * 0.2)
            bw = min(pw * 0.36, fig_h * 0.4)
            s.append(f'<circle cx="{f(cx)}" cy="{f(py + r + 1)}" r="{f(r)}" fill="{fill}"/>')
            s.append(f'<path d="M{f(cx - bw)},{f(py + fig_h)} a{f(bw)},{f(fig_h - 2 * r - 3)} 0 0 1 {f(2 * bw)},0 z" fill="{fill}"/>')
        else:
            post = 5
            gx0, gx1 = px + pw * 0.15, px + pw * 0.85
            s.append(f'<rect x="{f(gx0 - post / 2)}" y="{f(py)}" width="{post}" height="{f(fig_h)}" rx="1.5" fill="{INK}"/>')
            s.append(f'<rect x="{f(gx1 - post / 2)}" y="{f(py)}" width="{post}" height="{f(fig_h)}" rx="1.5" fill="{INK}"/>')
            s.append(f'<rect x="{f(gx0)}" y="{f(py + fig_h * 0.4)}" width="{f(gx1 - gx0)}" height="5" rx="1.5" fill="{stroke if col != "white" else ACCENT}"/>')
        if label:
            lines, size = fit_text(label, pw + 6, max_size=9.5)
            s.append(text_el(lines, size, cx, py + ph - size * 0.8 * len(lines) / 1.2, INK))
    elif t == "cloud":
        shapes = [
            ("rect", px + .08 * pw, py + .42 * ph, .84 * pw, .52 * ph, .26 * ph),
            ("circle", px + .30 * pw, py + .52 * ph, .26 * ph),
            ("circle", px + .52 * pw, py + .40 * ph, .32 * ph),
            ("circle", px + .74 * pw, py + .56 * ph, .22 * ph),
        ]

        def draw(stroke_on):
            out = []
            for sh in shapes:
                st = f'stroke="{INK}" stroke-width="2.6"' if stroke_on else 'stroke="none"'
                if sh[0] == "rect":
                    out.append(f'<rect x="{f(sh[1])}" y="{f(sh[2])}" width="{f(sh[3])}" height="{f(sh[4])}" rx="{f(sh[5])}" fill="#FFFFFF" {st}/>')
                else:
                    out.append(f'<circle cx="{f(sh[1])}" cy="{f(sh[2])}" r="{f(sh[3])}" fill="#FFFFFF" {st}/>')
            return "".join(out)
        s.append(draw(True) + draw(False))
        if label:
            lines, size = fit_text(label, pw * 0.7, max_size=10)
            s.append(text_el(lines, size, cx, py + ph * 0.62, INK))
    elif t.startswith("icon:"):
        side = max(14, min(pw, ph - (12 if label else 0)))
        ix = cx - side / 2
        s.append(f'<rect x="{f(ix)}" y="{f(py)}" width="{f(side)}" height="{f(side)}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        sc = side * 0.6 / 24
        gx, gy = cx - 12 * sc, py + side / 2 - 12 * sc
        s.append(f'<g transform="translate({f(gx)} {f(gy)}) scale({sc:.3f})" fill="none" stroke="{tcol}" '
                 f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{load_icon(t[5:])}</g>')
        if label:
            lines, size = fit_text(label, pw + 6, max_size=9.5)
            s.append(text_el(lines, size, cx, py + side + 2 + size * 0.7, INK))
    return "".join(s)


def clip_t(hw, hh, dx, dy):
    tx = hw / abs(dx) if dx else math.inf
    ty = hh / abs(dy) if dy else math.inf
    return min(tx, ty)


def draw_arrow(a, objs, reverse_exists):
    src, dst = objs[a["from"]], objs[a["to"]]
    sx, sy, sw, sh = obj_rect(src)
    dx0, dy0, dw, dh = obj_rect(dst)
    c1 = (sx + sw / 2, sy + sh / 2)
    c2 = (dx0 + dw / 2, dy0 + dh / 2)
    dx, dy = c2[0] - c1[0], c2[1] - c1[1]
    dist = math.hypot(dx, dy)
    if dist < 1:
        return "", ""
    ux, uy = dx / dist, dy / dist
    nx, ny = -uy, ux
    off = 4.0 if reverse_exists else 0.0
    c1 = (c1[0] + nx * off, c1[1] + ny * off)
    c2 = (c2[0] + nx * off, c2[1] + ny * off)
    t1 = clip_t(sw / 2, sh / 2, ux, uy)
    t2 = clip_t(dw / 2, dh / 2, ux, uy)
    # clip against the visible figure for icons/people (smaller than the cell)
    p1 = (c1[0] + ux * t1, c1[1] + uy * t1)
    p2 = (c2[0] - ux * t2, c2[1] - uy * t2)
    if (p2[0] - p1[0]) * ux + (p2[1] - p1[1]) * uy < 4:
        return "", ""
    col = ACCENT if a.get("color") == "accent" else INK
    hl, hw = 7.0, 3.2
    base = (p2[0] - ux * hl, p2[1] - uy * hl)
    line = (f'<line x1="{f(p1[0])}" y1="{f(p1[1])}" x2="{f(base[0])}" y2="{f(base[1])}" stroke="{col}" '
            f'stroke-width="1.8" stroke-linecap="round"/>'
            f'<polygon points="{f(p2[0])},{f(p2[1])} {f(base[0] + nx * hw)},{f(base[1] + ny * hw)} '
            f'{f(base[0] - nx * hw)},{f(base[1] - ny * hw)}" fill="{col}"/>')
    lab = ""
    if a.get("label"):
        mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
        txt = a["label"]
        tw = len(txt) * 4.3 + 7
        length = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        if reverse_exists:
            mx, my = mx + nx * off * 2.6, my + ny * off * 2.6
        elif tw > 0.7 * length:
            # label would hide the arrow: lift it beside the line (up, or right if vertical)
            sgn = -1 if ny > 0 else 1
            if abs(ny) < 0.5:
                sgn = 1 if nx > 0 else -1
            mx, my = mx + nx * sgn * 9, my + ny * sgn * 9
        lab = (f'<rect x="{f(mx - tw / 2)}" y="{f(my - 6)}" width="{f(tw)}" height="12" rx="2.5" fill="#FFFFFF" '
               f'stroke="{col}" stroke-width="0.9"/>'
               f'<text x="{f(mx)}" y="{f(my + 2.8)}" font-size="7.8" font-weight="600" text-anchor="middle" '
               f'fill="{INK}" font-family="{FONT}">{escape(txt)}</text>')
    return line, lab


def render_scene(scene):
    objs = {o["id"]: o for o in scene["objects"]}
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
             f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>']
    zones = [o for o in scene["objects"] if o["type"] == "zone"]
    rest = [o for o in scene["objects"] if o["type"] != "zone"]
    for o in zones:
        parts.append(draw_object(o))
    pairs = {(a["from"], a["to"]) for a in scene["arrows"]}
    labels = []
    for a in scene["arrows"]:
        if a["from"] in objs and a["to"] in objs:
            line, lab = draw_arrow(a, objs, (a["to"], a["from"]) in pairs)
            parts.append(line)
            labels.append(lab)
    for o in rest:
        parts.append(draw_object(o))
    parts.extend(labels)
    cap = scene.get("caption", "")
    if cap:
        parts.append(f'<line x1="0" y1="{f(CAP_Y)}" x2="{W}" y2="{f(CAP_Y)}" stroke="#D1D5DB" stroke-width="1"/>')
        lines, size = fit_text(cap, W - 16, max_size=11, min_size=8)
        parts.append(f'<text x="8" y="{f(CAP_Y + 15)}" font-size="{f(size)}" font-weight="700" fill="{INK}" '
                     f'font-family="{FONT}">{escape(lines[0] if len(lines) == 1 else cap)}</text>')
    parts.append("</svg>")
    return "".join(parts)


def main():
    if len(sys.argv) < 2:
        print("usage: render.py scene.json [out.svg]")
        sys.exit(2)
    scene = json.loads(Path(sys.argv[1]).read_text())
    errs = validate_scene(scene)
    if errs:
        print("\n".join(errs))
        sys.exit(1)
    svg = render_scene(scene)
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(svg)
    else:
        print(svg)


if __name__ == "__main__":
    main()
