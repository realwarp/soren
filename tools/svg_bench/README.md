# svg_bench: can a small local text model draw 4-panel explainers?

Local, free test (7 Nov 2026, M2 Pro 16 GB). Image models drew blobs, so this tries text models that write
code: pictures are crisp and can hold exact shapes, arrows and short labels. Nothing here touches the app.

Models (Prism ML "Ternary Bonsai 2", Apache-2.0, derived from Qwen3.5): `prism-ml/Ternary-Bonsai-2-{2B,4B,9B}-gguf`.
Run as the `Q2_0` GGUF (0.55 / 1.21 / 2.56 GB) on stock Homebrew `llama-server` (build 11669; upstream runs `Q2_0`
from b11556 on; the faster PQ2_0/PTQ1_0 packs need the PrismML fork and were not used).

Two approaches on the same 6 concepts x 4 panels:

- **A. Raw SVG**: the model writes a complete 320x240 SVG per panel (flat shapes, at most 3 `<text>`).
- **B. Scene JSON + code**: the model writes a small JSON scene (objects on a 12x9 grid, arrows between ids);
  `render.py` draws it (black boxes, white text, labelled arrows, one accent colour, Lucide icons).

Each panel is a chat turn: system prompt, one hand-written example sequence (a cache in front of a database)
as earlier turns, then the real panels generated so far, so panels 2-4 see panel 1. One retry feeds the
error back to the model. Fixed seed 7, temperature 0.3, top-p 0.95, top-k 40, 180 s cap per panel.

## Files

| File | What |
|---|---|
| `render.py` | deterministic scene JSON to SVG renderer plus the JSON schema and validator (`python render.py scene.json out.svg`) |
| `run_bench.py` | starts a `llama-server` for one model, runs the 6 concepts, records per-generation metrics, stops the server |
| `run_all.sh` | runs 2B, 4B, 9B in that order |
| `build_index.py` | builds `out/index.html` (contact sheet), `out/stats.json`, and a markdown stats table (`--png` writes PNG strips for viewing) |
| `concepts.json` | the 6 concepts and their 4 panel scripts |
| `prompts/` | system prompts for A and B and the hand-written few-shot sequence for each (`example_a_p*.svg`, `example_b_p*.json`) |
| `icons/` | the Lucide icons the renderer can use (`icon:<name>`), ISC licence in `icons/LICENSE` |
| `RESULTS.md` | numbers and the judgement after looking at the panels |
| `out/` | outputs, gitignored; open `out/index.html` |

## Run it

```sh
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python jsonschema cairosvg pillow huggingface_hub
for s in 2B 4B 9B; do .venv/bin/hf download prism-ml/Ternary-Bonsai-2-$s-gguf Ternary-Bonsai-2-$s-Q2_0.gguf --local-dir models/bonsai2-$s; done
sh run_all.sh
.venv/bin/python build_index.py --png    # needs DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib for cairo
open out/index.html
```

## Scene JSON (approach B)

```json
{"caption": "2. Cache is empty: a miss",
 "objects": [{"id": "app", "type": "box", "label": "App", "x": 0, "y": 3, "w": 2, "h": 2, "color": "ink"}],
 "arrows":  [{"from": "app", "to": "cache", "label": "get user 7", "color": "accent"}]}
```

Types: `box cylinder file person gate cloud zone icon:<name>`. `zone` (a dashed boundary drawn behind other
objects) is an addition to the list in the brief, needed for the sandbox concept. Colours: `ink white grey accent`.
Validation: JSON schema (`render.SCHEMA`) plus checks for unique ids, grid bounds, known icons and that arrows
point at existing ids. The icon list is injected into the prompt.

## Measuring

- valid (A) = parses with `xml.etree`, root is `<svg>`, no script/image/use/foreignObject/on* attributes.
  valid (B) = passes the schema and the cross-checks. Soft quality flags are recorded but do not affect validity:
  A `<text>` count above 3; B overlapping objects.
- Peak memory = peak RSS of the `llama-server` process (sampled every 0.5 s) and macOS `footprint` peak
  (`phys_footprint_peak`, which includes GPU-mapped buffers). Swap = `sysctl vm.swapusage` before the model loads,
  after the run, and the maximum sampled during it. The machine was already swapping before the test (other apps),
  so only the change counts.
- Servers are started in their own process group and killed on exit; the run prints any leftover pids.
