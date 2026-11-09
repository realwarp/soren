# Panel data pilot (FLUX.2 klein 4B on Kaggle)

A 50-to-68 image pilot before the full ~20k image run. Generator: `black-forest-labs/FLUX.2-klein-4B` (Apache-2.0; not the 9B, which is non-commercial). It answers: does klein 4B run in fp16 on a T4, what is the real images/hour, and does passing panel 1 as a reference keep panels 2-4 consistent.

## Files

- `pilot.ipynb`: the Kaggle notebook. Self-contained (concepts and worker script are inlined).
- `scripts/concepts_pilot.json`: 12 concepts x 4 panel prompts, the fixed style prefix, 2 single-image style tests.
- `scripts/worker.py`: one worker per GPU (source of the inlined `%%writefile` cell).
- `scripts/build_notebook.py`: rebuilds `pilot.ipynb` after you edit the JSON or the worker.
- `PILOT.md`: results and the honest read.
- `out/` (gitignored): downloaded outputs.

## What it generates

- Mode (b), all 12 concepts: panel 1 from text, panels 2-4 from text plus panel 1 as a reference image (klein multi-reference editing). 48 images.
- Mode (a), 6 concepts (sandbox, config, cache, queue, ratelimit, depgraph): text only, the same fixed seed for all four panels. Panel 1 is identical to mode (b) panel 1, so only panels 2-4 are generated (18 images).
- 2 single-image style tests. Total 68 generated images. 512x512, 4 steps, guidance 1.0.
- Files are named `concept_mode_panel.png`, plus `contact_sheet.html`, `results.json`, `worker_N.log`, and `panels.zip` (everything in `out/`).

Each GPU gets its own process: the text encoder runs first (fp16) and is freed, then the 4B transformer and VAE load, so a 15 GB T4 needs no CPU offload. If an image is black/NaN (mean pixel under 5 or std under 2) the worker escalates: fp16 -> fp16 with fp32 VAE -> bf16 with fp32 VAE, and logs the event.

## How to run it on Kaggle

1. Kaggle, New Notebook, File, Import Notebook, upload `tools/panel_data/pilot.ipynb`.
2. Settings: Accelerator = GPU T4 x2, Internet = On. The GPU needs a phone-verified Kaggle account (Settings, Phone verification).
3. Run All. About 17 GB of weights download, then roughly an hour at most for generation. Nothing needs a token: the 4B repo is Apache-2.0 and not gated. If the download cell reports 401, accept the licence on the model page and add an `HF_TOKEN` Kaggle secret (never put tokens in files).
4. Download `/kaggle/working/out/` (or `panels.zip`) into `tools/panel_data/out/`. Open `contact_sheet.html` (one row per sequence, mode (a) and (b) side by side, timings under each image).

## Driven by Claude over the Kaggle MCP

The pilot ran end to end on 6 Nov 2026 (see `PILOT.md`). The notebook was pushed with `save_notebook` (T4, internet on, private) as `snipedbywifi/panel-data-pilot-klein4b`, then polled with `get_notebook_session_status` and fetched with `download_notebook_output`. See `PILOT.md` for what happened.
