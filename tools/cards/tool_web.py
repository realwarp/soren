#!/usr/bin/env python3
"""A phone-friendly status page for the training run. Reads the run's log files; costs no model usage.

    python3 tools/cards/tool_web.py            # this Mac only (http://localhost:8765/<key>)
    python3 tools/cards/tool_web.py --lan      # also reachable from a phone on the same Wi-Fi

With --lan it prints a link like http://192.168.1.20:8765/<key>. Open it on a phone on the same Wi-Fi. The page reloads
itself every 20 seconds and follows the newest run. The random key in the address is the only access check,
so treat the link as private. Nothing here can change the run (read only).
"""
import argparse
import html
import json
import pathlib
import secrets
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from tool_status import RUNS, rows  # noqa: E402

TOKEN_FILE = RUNS.parent / "web_token.txt"


def newest_run():
    runs = [d for d in RUNS.iterdir() if (d / "manifest.json").exists()] if RUNS.exists() else []
    return max(runs, key=lambda d: (d / "manifest.json").stat().st_mtime) if runs else None


def render() -> str:
    run = newest_run()
    now = time.strftime("%H:%M:%S")
    if run is None:
        body = "<p>No run yet.</p>"
        return page(body, now)
    name = run.name
    log, evals, dev = rows(run / "log.jsonl"), rows(run / "evals.jsonl"), rows(run / "devevals.jsonl")
    ended = json.loads((run / "ended.json").read_text()) if (run / "ended.json").exists() else None
    alive = subprocess.run(["pgrep", "-f", f"tooltrain.py --run {name}"], capture_output=True).returncode == 0
    last = log[-1] if log else None
    if (run / "PAUSE").exists():
        state, cls = "Paused", "warn"
    elif ended:
        state, cls = f"Ended: {ended['reason']} at step {ended['step']}", "warn"
    elif alive:
        state, cls = "Running", "ok"
    else:
        state, cls = "Not running", "bad"
    parts = [f"<h1>Run {html.escape(name)}</h1><p class='state {cls}'>{html.escape(state)}</p>"]
    if last:
        frac = last["step"] / max(1, last["of"])
        parts.append(f"<div class='bar'><i style='width:{100 * frac:.0f}%'></i></div>")
        parts.append(
            f"<p>Step <b>{last['step']}</b> of {last['of']} · epoch {last['epoch']}<br>"
            f"loss <b>{last['loss']}</b> · {last['tok_s']} tokens/s<br>"
            f"GPU {last['gpu_gb']} GB · swap {last['swap_gb']} GB<br>"
            f"about <b>{last['eta_min']:.0f} min</b> left</p>")
    parts.append("<h2>Dev set scores</h2>")
    if dev:
        parts.append("<table><tr><th>step</th><th>valid</th><th>right</th><th>wrong+sure</th><th>declines</th></tr>")
        for d in dev[-8:]:
            parts.append(f"<tr><td>{d['step']}</td><td>{100 * d['valid_rate']:.0f}%</td><td>{d['right']}/{d['answerable']} ({100 * d['right_rate']:.0f}%)</td>"
                         f"<td>{100 * d['wrong_confident_rate']:.0f}%</td><td>{d['declined_right']}/{d['declines']}</td></tr>")
        parts.append("</table><p class='note'>Goal: wrong+sure at or under 5%.</p>")
        best = max(dev, key=lambda d: d["right_rate"])
        parts.append(f"<p>Best so far: {best['right']}/{best['answerable']} right at step {best['step']}.</p>")
    else:
        parts.append("<p>None yet.</p>")
    parts.append("<h2>Checkpoints</h2>")
    if evals:
        parts.append("<table><tr><th>step</th><th>time</th><th>val loss</th><th>formula</th></tr>")
        for e in evals[-6:]:
            parts.append(f"<tr><td>{e['step']}</td><td>{e['t']}</td><td>{e['val_loss']:.3f}</td><td>{100 * e['formula_acc']:.0f}%</td></tr>")
        parts.append("</table>")
    else:
        parts.append("<p>None yet.</p>")
    return page("".join(parts), now)


def page(body: str, now: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20">
<title>Training</title><style>
:root{{--bg:#f5f1e8;--fg:#1b1915;--mut:#6b6254;--line:#ded4c2;--ok:#1f5c56;--warn:#a8651c;--bad:#8b3a30;--card:#fbf8f1}}
@media(prefers-color-scheme:dark){{:root{{--bg:#16140f;--fg:#efe8d8;--mut:#a39a87;--line:#34302a;--ok:#63b9ad;--warn:#dca45f;--bad:#e09284;--card:#1e1b15}}}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif}}
h1{{font:600 22px Georgia,serif;margin:0 0 4px}}h2{{font:600 13px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:22px 0 6px}}
.state{{margin:0 0 10px;font-weight:600}}.ok{{color:var(--ok)}}.warn{{color:var(--warn)}}.bad{{color:var(--bad)}}
.bar{{height:10px;background:var(--line);border-radius:5px;overflow:hidden}}.bar i{{display:block;height:100%;background:var(--ok)}}
table{{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}}th,td{{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}}th{{color:var(--mut);font-weight:600}}
.note{{color:var(--mut);font-size:13px}}footer{{margin-top:24px;color:var(--mut);font-size:12px}}
</style></head><body>{body}<footer>Updated {now} · reloads every 20 s</footer></body></html>"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true", help="listen on the local network instead of only this Mac")
    a = ap.parse_args()
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text().strip()
    else:
        token = secrets.token_urlsafe(12)
        TOKEN_FILE.write_text(token)

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.rstrip("/") != "/" + token:
                self.send_response(404); self.end_headers(); return
            data = render().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    ip = next((subprocess.run(["ipconfig", "getifaddr", i], capture_output=True, text=True).stdout.strip() for i in ("en0", "en1")
               if subprocess.run(["ipconfig", "getifaddr", i], capture_output=True, text=True).stdout.strip()), socket.gethostname())
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    print(("open on your phone (same Wi-Fi): " if a.lan else "this Mac only: ") + f"http://{ip if a.lan else 'localhost'}:{a.port}/{token}", flush=True)
    ThreadingHTTPServer((host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
