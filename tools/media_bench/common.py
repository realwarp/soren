import os
os.environ.setdefault("DYLD_FALLBACK_LIBRARY_PATH", "/opt/homebrew/lib")  # cairo; SIP strips DYLD_* set in the shell
import io, os, time
from xml.etree import ElementTree as ET


def check_svg(svg_text):
    """Return (valid_xml, renders, nonblank, error). Renders with cairosvg."""
    import cairosvg
    from PIL import Image
    try:
        root = ET.fromstring(svg_text)
        if not root.tag.endswith("svg"):
            return False, False, False, "root is not <svg>"
    except Exception as e:
        return False, False, False, f"xml: {e}"
    try:
        png = cairosvg.svg2png(bytestring=svg_text.encode(), background_color="white", output_width=256, output_height=256)
        im = Image.open(io.BytesIO(png)).convert("L")
        lo, hi = im.getextrema()
        return True, True, hi - lo > 8, ""
    except Exception as e:
        return True, False, False, f"render: {e}"


def render_png(svg_text, path, size=256):
    import cairosvg
    cairosvg.svg2png(bytestring=svg_text.encode(), write_to=path, background_color="white", output_width=size, output_height=size)


def start_mem_sampler(results, every=15):
    """Background thread: samples this process's memory footprint (top MEM, includes compressed/swapped
    and GPU-shared pages, unlike max RSS) and keeps the peak in results['peak_footprint_gb']."""
    import subprocess, threading

    def parse(s):
        s = s.strip().rstrip("+-")
        mult = {"K": 1e3, "M": 1e6, "G": 1e9, "B": 1}.get(s[-1], 1)
        return float(s[:-1] if s[-1] in "KMGB" else s) * mult

    def loop():
        while True:
            try:
                out = subprocess.run(["top", "-l", "1", "-pid", str(os.getpid()), "-stats", "mem"], capture_output=True, text=True, timeout=20).stdout
                v = parse(out.strip().splitlines()[-1]) / 1e9
                results["peak_footprint_gb"] = round(max(results.get("peak_footprint_gb", 0), v), 2)
                print(f"[mem] footprint {v:.2f} GB", flush=True)
            except Exception:
                pass
            time.sleep(every)

    threading.Thread(target=loop, daemon=True).start()
