"""StarVector-1B benchmark: 1a image-to-SVG sanity, 1b text-to-SVG probe.
Run via run.sh so max RSS and swap are recorded. Local only.

The base LLM (bigcode/starcoderbase-1b) is a gated HF repo this account cannot read. StarVector's own
weights already hold every LLM weight, so (see patch_gated) we build the same GPTBigCode architecture from a
hand-written config and the tokenizer shipped inside the StarVector repo. No gated file is used.
"""
import json, os, sys, time, traceback
from common import check_svg, render_png, start_mem_sampler  # sets DYLD path before cairo loads
import torch
from PIL import Image, ImageDraw, ImageFont
from huggingface_hub import snapshot_download

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "starvector")
os.makedirs(OUT, exist_ok=True)
MODEL = "starvector/starvector-1b-im2svg"
MAXLEN = int(os.environ.get("SV_MAXLEN", "1500"))
PROMPTS = [
    "Base setup: directory layout and build configuration files",
    "Sandbox: isolation and security boundary around running code",
    "Config module: YAML/JSON loader and schema validator",
    "Logging module: centralized logging and metrics collector",
]
results = {"device": None, "events": []}


def log(*a):
    print(*a, flush=True)


def sync(dev):
    if dev == "mps":
        torch.mps.synchronize()


def make_diagram(path):
    im = Image.new("RGB", (448, 224), "white")
    d = ImageDraw.Draw(im)
    boxes = [(20, 80, 120, 144, "Input"), (174, 80, 274, 144, "Model"), (328, 80, 428, 144, "Output")]
    for x0, y0, x1, y1, t in boxes:
        d.rectangle((x0, y0, x1, y1), outline="black", width=4)
        d.text((x0 + 30, y0 + 25), t, fill="black")
    for x in (120, 274):
        d.line((x, 112, x + 54, 112), fill="black", width=4)
        d.polygon([(x + 54, 102), (x + 54, 122), (x + 66, 112)], fill="black")
    im.save(path)


def patch_gated(snapshot):
    """Swap the gated starcoderbase-1b lookups for a local config + the tokenizer inside the StarVector repo."""
    import starvector.model.llm.starcoder as sc
    from transformers import AutoModelForCausalLM, AutoTokenizer, GPTBigCodeConfig

    def cfg(name, **kw):
        return GPTBigCodeConfig(vocab_size=49152, n_positions=8192, n_embd=2048, n_layer=24, n_head=16, n_inner=8192,
                                multi_query=True, activation_function="gelu_pytorch_tanh", layer_norm_epsilon=1e-5,
                                attention_softmax_in_fp32=True, scale_attention_softmax_in_fp32=True)

    class _Cfg:
        from_pretrained = staticmethod(cfg)

    class _Tok:
        @staticmethod
        def from_pretrained(name, **kw):
            return AutoTokenizer.from_pretrained(snapshot, **kw)

    class _Lm:
        @staticmethod
        def from_pretrained(name, config=None, torch_dtype=None, **kw):
            return AutoModelForCausalLM.from_config(config, torch_dtype=torch_dtype)

    sc.AutoConfig, sc.AutoTokenizer, sc.AutoModelForCausalLM = _Cfg, _Tok, _Lm


def load(device):
    from transformers import AutoModelForCausalLM
    dtype = torch.float16 if device == "mps" else torch.float32
    t0 = time.time()
    m = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=dtype, trust_remote_code=True, model_precision=dtype)
    m.to(device).eval()
    if device == "cpu":
        m.float()  # image-encoder weights stay fp16 after load otherwise (conv2d dtype error)
    sync(device)
    return m, time.time() - t0


def main():
    start_mem_sampler(results)
    snapshot = snapshot_download(MODEL)
    from starvector.data.util import process_and_rasterize_svg  # noqa (proves the repo package imports)
    from transformers import AutoModelForCausalLM

    # 0. unpatched load, to record the exact gated-repo error
    try:
        AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, trust_remote_code=True)
        results["unpatched_load"] = "ok"
        patched = False
    except Exception as e:
        results["unpatched_load"] = f"{type(e).__name__}: {e}"
        log("UNPATCHED LOAD FAILED:", results["unpatched_load"][:2000])
        patch_gated(snapshot)
        patched = True
    results["gated_workaround"] = patched

    # 1. load: mps/fp16 first, then cpu/fp32
    model = None
    for device in os.environ.get("SV_DEVICES", "mps,cpu").split(","):
        try:
            model, load_s = load(device)
            results["device"], results["load_s"] = device, round(load_s, 1)
            log(f"loaded on {device} in {load_s:.1f}s")
            results["mps_alloc_gb_after_load"] = round(torch.mps.current_allocated_memory() / 1e9, 2) if device == "mps" else None
            log("mps allocated GB after load:", results["mps_alloc_gb_after_load"])
            break
        except Exception:
            err = traceback.format_exc()
            results["events"].append({"stage": f"load_{device}", "error": err[-1500:]})
            log(f"LOAD {device} FAILED:\n{err}")
            model = None
    if model is None:
        finish(); return
    device = results["device"]
    sv = model.model
    processor, tokenizer = sv.processor, sv.svg_transformer.tokenizer

    # 1a image -> SVG
    png = os.path.join(OUT, "1a_input.png"); make_diagram(png)
    try:
        img = Image.open(png)
        pix = processor(img, return_tensors="pt")["pixel_values"]
        if pix.dim() == 4 and pix.shape[0] != 1:
            pix = pix.squeeze(0)
        if pix.dim() == 3:
            pix = pix.unsqueeze(0)
        batch = {"image": pix.to(device)}
        torch.manual_seed(0)
        t0 = time.time()
        with torch.no_grad():
            raw = model.generate_im2svg(batch, max_length=MAXLEN)[0]
        sync(device); dt = time.time() - t0
        ntok = len(tokenizer(raw)["input_ids"])
        open(os.path.join(OUT, "1a.svg"), "w").write(raw)
        v, r, nb, e = check_svg(raw)
        if r: render_png(raw, os.path.join(OUT, "1a.png"))
        results["1a"] = dict(seconds=round(dt, 1), tokens=ntok, s_per_token=round(dt / max(ntok, 1), 3), mps_alloc_gb=round(torch.mps.current_allocated_memory() / 1e9, 2) if device == "mps" else None, valid_xml=v, renders=r, nonblank=nb, error=e)
        log("1a", results["1a"])
    except Exception:
        err = traceback.format_exc(); results["1a"] = {"error": err[-1500:]}; log("1a FAILED", err)

    # 1b text -> SVG, as shipped
    batch = {"image": torch.zeros(1, 3, 224, 224, device=device, dtype=sv.model_precision), "caption": [PROMPTS[0]]}
    has_method = hasattr(sv, "generate_text2svg")
    wrapper_exposes = hasattr(model, "generate_text2svg")
    results["text2svg_method_in_base_class"] = has_method
    results["text2svg_exposed_on_released_model"] = wrapper_exposes
    asis = None
    if has_method:
        try:
            sv.generate_text2svg(batch, max_length=64)
            asis = "ok"
        except Exception as e:
            asis = f"{type(e).__name__}: {e}"
    results["text2svg_as_shipped"] = asis
    log("text2svg as shipped:", asis)

    # 1b': same call with the one-argument signature bug worked around (not a new path, just the existing method)
    results["1b"] = []
    if has_method and asis != "ok":
        orig = sv._get_generation_kwargs
        sv._get_generation_kwargs = lambda base, *_ignored: orig(base)
    if has_method:
        for i, p in enumerate(PROMPTS, 1):
            rec = {"prompt": p}
            try:
                b = {"image": batch["image"], "caption": [p]}
                torch.manual_seed(0)
                t0 = time.time()
                with torch.no_grad():
                    out = sv.generate_text2svg(b, max_length=MAXLEN)
                sync(device); dt = time.time() - t0
                text = tokenizer.batch_decode(out, skip_special_tokens=True)[0]
                rec.update(seconds=round(dt, 1), tokens=int(out.shape[-1]), raw_head=text[:300])
                s = text.find("<svg")
                svg = text[s:] if s >= 0 else text
                e_ = svg.rfind("</svg>")
                if e_ >= 0: svg = svg[: e_ + 6]
                open(os.path.join(OUT, f"1b_{i}.svg"), "w").write(svg)
                v, r, nb, er = check_svg(svg)
                if r: render_png(svg, os.path.join(OUT, f"1b_{i}.png"))
                rec.update(valid_xml=v, renders=r, nonblank=nb, error=er)
            except Exception:
                err = traceback.format_exc(); rec["error"] = err[-1500:]
            log("1b", i, rec)
            results["1b"].append(rec)
    finish()


def finish():
    json.dump(results, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    log("DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        results["fatal"] = traceback.format_exc(); log(results["fatal"]); finish()
