#!/usr/bin/env python3
"""Run the SVG-panel benchmark for one model against a local llama-server.

usage: run_bench.py <2B|4B|9B> [--approach A|B|AB] [--concepts id,id] [--seed 7] [--temp 0.3]

For every concept it generates 4 panels per approach, chaining them as a chat:
system prompt + the hand-written example sequence (as earlier turns) + the real
panels generated so far. One retry (with the error fed back) when a panel is invalid.
Everything is local; the server is started here and always stopped on exit.
"""
import argparse
import atexit
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import render  # noqa: E402

MODELS = {
    "2B": HERE / "models/bonsai2-2B/Ternary-Bonsai-2-2B-Q2_0.gguf",
    "4B": HERE / "models/bonsai2-4B/Ternary-Bonsai-2-4B-Q2_0.gguf",
    "9B": HERE / "models/bonsai2-9B/Ternary-Bonsai-2-9B-Q2_0.gguf",
}
PORT = 8197
CTX = 12288
GEN_DEADLINE = 180          # seconds per panel (all attempts together)
MAX_TOKENS = {"A": 1500, "B": 800}
SERVER = "/opt/homebrew/bin/llama-server"


# ------------------------------------------------------------------ system helpers
def swap_used_mb():
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    m = re.search(r"used = ([\d.]+)M", out)
    return float(m.group(1)) if m else float("nan")


class Sampler(threading.Thread):
    """Samples RSS of the server process and system swap while it runs."""

    def __init__(self, pid):
        super().__init__(daemon=True)
        self.pid, self.stop_flag = pid, threading.Event()
        self.peak_rss_kb, self.max_swap = 0, swap_used_mb()

    def run(self):
        n = 0
        while not self.stop_flag.is_set():
            r = subprocess.run(["ps", "-o", "rss=", "-p", str(self.pid)], capture_output=True, text=True).stdout.strip()
            if r:
                self.peak_rss_kb = max(self.peak_rss_kb, int(r))
            if n % 10 == 0:
                self.max_swap = max(self.max_swap, swap_used_mb())
            n += 1
            self.stop_flag.wait(0.5)


def footprint_peak_gb(pid):
    """phys_footprint_peak from `footprint` (includes GPU-wired buffers); None if unavailable."""
    try:
        out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return None
    m = re.search(r"phys_footprint_peak:\s*([\d.]+)\s*([KMG]B)", out)
    if not m:
        return None
    v, u = float(m.group(1)), m.group(2)
    return v / {"KB": 1e6, "MB": 1e3, "GB": 1}[u]


class Server:
    def __init__(self, model_path, log_path):
        self.model_path, self.log_path, self.proc = model_path, log_path, None

    def start(self):
        log = open(self.log_path, "w")
        self.proc = subprocess.Popen(
            [SERVER, "-m", str(self.model_path), "-ngl", "99", "-fa", "on", "-c", str(CTX), "-np", "1",
             "--host", "127.0.0.1", "--port", str(PORT), "--no-webui", "--jinja"],
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        atexit.register(self.stop)
        t0 = time.time()
        while time.time() - t0 < 240:
            if self.proc.poll() is not None:
                raise RuntimeError(f"llama-server exited early ({self.proc.returncode}); see {self.log_path}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as r:
                    if r.status == 200:
                        return time.time() - t0
            except Exception:
                pass
            time.sleep(0.5)
        raise RuntimeError("llama-server did not become healthy in 240 s")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=15)
            except Exception:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                    self.proc.wait(timeout=5)
                except Exception:
                    pass
        self.proc = None


def chat_stream(messages, seed, temp, max_tokens, deadline):
    """One streamed chat completion. Returns dict(text, finish, timings, n_chunks)."""
    body = json.dumps({
        "messages": messages, "stream": True, "seed": seed, "temperature": temp, "top_p": 0.95, "top_k": 40,
        "max_tokens": max_tokens, "cache_prompt": True,
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions", body,
                                 {"Content-Type": "application/json"})
    text, finish, timings, n = [], None, {}, 0
    resp = urllib.request.urlopen(req, timeout=30)
    try:
        for line in resp:
            if time.time() > deadline:
                finish = "timeout"
                break
            line = line.decode().strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            d = json.loads(payload)
            if d.get("timings"):
                timings = d["timings"]
            for ch in d.get("choices", []):
                delta = ch.get("delta", {})
                if delta.get("content"):
                    text.append(delta["content"])
                    n += 1
                if ch.get("finish_reason"):
                    finish = ch["finish_reason"]
    finally:
        resp.close()   # closing the socket makes llama-server abort the generation
    return {"text": "".join(text), "finish": finish or "stop", "timings": timings, "chunks": n}


# ------------------------------------------------------------------ extraction / validation
def strip_think(t):
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.S)
    return re.sub(r"^.*?</think>", "", t, flags=re.S) if "</think>" in t else t


def extract_svg(t):
    t = strip_think(t)
    i = t.find("<svg")
    if i < 0:
        return None
    j = t.rfind("</svg>")
    return t[i:j + 6] if j > i else t[i:]


def extract_json(t):
    t = strip_think(t)
    i = t.find("{")
    if i < 0:
        return None
    depth, instr, esc = 0, False, False
    for k in range(i, len(t)):
        c = t[k]
        if instr:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                instr = False
        elif c == '"':
            instr = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return t[i:k + 1]
    return t[i:]


FORBIDDEN = {"script", "image", "foreignobject", "iframe", "use", "style", "animate", "set"}


def check_svg(raw):
    """Return (valid, errors, info). valid == parses with xml.etree and is a safe <svg> root."""
    svg = extract_svg(raw)
    if not svg:
        return False, ["no <svg> found in the reply"], {}
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as e:
        return False, [f"XML parse error: {e}"], {}
    local = lambda tag: tag.split("}")[-1].lower()  # noqa: E731
    if local(root.tag) != "svg":
        return False, ["root element is not <svg>"], {}
    texts, bad = 0, []
    for el in root.iter():
        tg = local(el.tag)
        if tg in FORBIDDEN:
            bad.append(f"forbidden element <{tg}>")
        if tg == "text":
            texts += 1
        for k, v in el.attrib.items():
            if k.lower().startswith("on") or (local(k) == "href" and not v.startswith("#")):
                bad.append(f"forbidden attribute {k}")
    if bad:
        return False, sorted(set(bad)), {}
    info = {"texts": texts, "viewbox_ok": root.attrib.get("viewBox", "").split() == ["0", "0", "320", "240"]}
    return True, [], {"svg": svg, **info}


def check_scene(raw):
    js = extract_json(raw)
    if not js:
        return False, ["no JSON object found in the reply"], {}
    try:
        scene = json.loads(js)
    except json.JSONDecodeError as e:
        return False, [f"JSON parse error: {e}"], {}
    errs = render.validate_scene(scene)
    if errs:
        return False, errs[:6], {}
    return True, [], {"scene": scene, "overlaps": render.overlaps(scene), "svg": render.render_scene(scene)}


# ------------------------------------------------------------------ prompts
def load_prompts(approach):
    P = HERE / "prompts"
    ex = json.loads((P / "example_script.json").read_text())
    system = (P / f"system_{approach.lower()}.txt").read_text().replace("__ICONS__", ", ".join(render.icon_names()))
    shots = []
    for i, script in enumerate(ex["panels"], 1):
        if approach == "A":
            out = (P / f"example_a_p{i}.svg").read_text().strip()
        else:
            out = json.dumps(json.loads((P / f"example_b_p{i}.json").read_text()), separators=(",", ":"))
        shots.append((i, script, out))
    return system, ex, shots


def user_turn(concept_name, k, script):
    return f"Concept: {concept_name}\nPanel {k} of 4: {script}"


def run_concept(approach, concept, system, ex, shots, args, outdir, model_tag, records, done):
    base = [{"role": "system", "content": system}]
    for i, script, out in shots:
        base += [{"role": "user", "content": user_turn(ex["concept"], i, script)}, {"role": "assistant", "content": out}]
    hist = list(base)
    last_valid_raw = None
    fmt = "SVG" if approach == "A" else "JSON"
    for k, script in enumerate(concept["panels"], 1):
        key = f"{concept['id']}|{approach}|{k}"
        stem = outdir / f"{concept['id']}_{approach}_p{k}"
        if key in done:
            rec = done[key]
            if rec.get("valid") and (stem.with_suffix(".raw.txt")).exists():
                last_valid_raw = stem.with_suffix(".raw.txt").read_text()
                hist += [{"role": "user", "content": user_turn(concept["name"], k, script)},
                         {"role": "assistant", "content": last_valid_raw}]
            continue
        msgs = hist + [{"role": "user", "content": user_turn(concept["name"], k, script)}]
        t0 = time.time()
        deadline = t0 + GEN_DEADLINE
        attempts, retries = [], 0
        ok, errs, info, raw = False, [], {}, ""
        prompt_n = pred_n = 0
        pred_ms = 0.0
        finish = None
        for attempt in range(2):
            try:
                res = chat_stream(msgs, args.seed, args.temp, MAX_TOKENS[approach], deadline)
            except Exception as e:  # server hiccup
                res = {"text": "", "finish": f"error: {e}", "timings": {}, "chunks": 0}
            raw, finish = res["text"], res["finish"]
            tm = res["timings"]
            prompt_n += tm.get("prompt_n", 0)
            pred_n += tm.get("predicted_n", res["chunks"])
            pred_ms += tm.get("predicted_ms", 0.0)
            ok, errs, info = (check_svg if approach == "A" else check_scene)(raw)
            attempts.append(raw)
            if ok or finish == "timeout" or time.time() > deadline - 20 or attempt == 1:
                break
            retries += 1
            note = "; ".join(errs)[:400]
            if finish == "length":
                note += " (the reply was cut off: make it shorter)"
            msgs = msgs + [{"role": "assistant", "content": raw},
                           {"role": "user", "content": f"That {fmt} is invalid: {note}. Output the corrected {fmt} only."}]
        secs = time.time() - t0
        stem.with_suffix(".raw.txt").write_text(attempts[-1] if not ok else attempts[-1])
        if ok:
            stem.with_suffix(".svg").write_text(info["svg"])
            if approach == "B":
                stem.with_suffix(".json").write_text(json.dumps(info["scene"], indent=1))
            last_valid_raw = attempts[-1]
            hist += [{"role": "user", "content": user_turn(concept["name"], k, script)},
                     {"role": "assistant", "content": last_valid_raw}]
        rec = {
            "model": model_tag, "concept": concept["id"], "approach": approach, "panel": k,
            "valid": ok, "valid_first_try": ok and retries == 0, "retries": retries,
            "seconds": round(secs, 2), "prompt_tokens": prompt_n, "gen_tokens": pred_n,
            "tok_per_s": round(pred_n / (pred_ms / 1000), 2) if pred_ms else (round(pred_n / secs, 2) if secs else 0),
            "finish": finish, "errors": errs,
            "texts": info.get("texts"), "viewbox_ok": info.get("viewbox_ok"), "overlaps": info.get("overlaps"),
        }
        records.write(json.dumps(rec) + "\n")
        records.flush()
        print(f"[{model_tag}] {key} valid={ok} retries={retries} {secs:.1f}s {rec['tok_per_s']} tok/s "
              f"gen={pred_n} finish={finish} {errs[:1] if not ok else ''}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=list(MODELS))
    ap.add_argument("--approach", default="AB")
    ap.add_argument("--concepts", default="")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--temp", type=float, default=0.3)
    ap.add_argument("--out", default=str(HERE / "out"))
    args = ap.parse_args()
    tag = f"bonsai2-{args.model}"
    outdir = Path(args.out) / tag
    outdir.mkdir(parents=True, exist_ok=True)
    concepts = json.loads((HERE / "concepts.json").read_text())
    if args.concepts:
        concepts = [c for c in concepts if c["id"] in args.concepts.split(",")]
    results = outdir / "results.jsonl"
    done = {}
    if results.exists():
        for ln in results.read_text().splitlines():
            r = json.loads(ln)
            done[f"{r['concept']}|{r['approach']}|{r['panel']}"] = r
    meta_path = outdir / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    swap0 = swap_used_mb()
    srv = Server(MODELS[args.model], outdir / "server.log")
    load_s = srv.start()
    sampler = Sampler(srv.proc.pid)
    sampler.start()
    swap_loaded = swap_used_mb()
    print(f"[{tag}] server up in {load_s:.1f}s; swap before={swap0:.0f}M after load={swap_loaded:.0f}M", flush=True)
    try:
        with open(results, "a") as rec_f:
            for approach in args.approach.upper():
                system, ex, shots = load_prompts(approach)
                for c in concepts:
                    run_concept(approach, c, system, ex, shots, args, outdir, tag, rec_f, done)
    finally:
        sampler.stop_flag.set()
        fp = footprint_peak_gb(srv.proc.pid) if srv.proc else None
        swap1 = swap_used_mb()
        meta.update({
            "model": tag, "file": MODELS[args.model].name, "file_gb": round(MODELS[args.model].stat().st_size / 1e9, 2),
            "load_seconds": round(load_s, 1), "seed": args.seed, "temperature": args.temp,
            "swap_before_mb": swap0, "swap_after_mb": swap1, "swap_max_mb": sampler.max_swap,
            "swap_change_mb": round(swap1 - swap0, 1), "swap_max_change_mb": round(sampler.max_swap - swap0, 1),
            "peak_rss_gb": round(sampler.peak_rss_kb / 1e6, 2), "peak_footprint_gb": round(fp, 2) if fp else None,
            "ctx": CTX,
        })
        meta_path.write_text(json.dumps(meta, indent=1))
        srv.stop()
        print(f"[{tag}] meta: {json.dumps(meta)}", flush=True)
        left = subprocess.run(["pgrep", "-f", f"llama-server.*--port {PORT}"], capture_output=True, text=True).stdout.split()
        print(f"[{tag}] leftover server pids: {left}", flush=True)


if __name__ == "__main__":
    main()
