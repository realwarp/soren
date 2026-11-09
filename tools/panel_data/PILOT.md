# Pilot results: FLUX.2 klein 4B on Kaggle 2x T4

Run on 6 Nov 2026 via the Kaggle MCP (`snipedbywifi/panel-data-pilot-klein4b`, version 3, GPU T4 x2, internet on). 68 images generated: 12 concepts in mode (b), 6 of those also in mode (a) (panels 2-4; panel 1 is shared), 2 single style tests. 512x512, 4 steps, guidance 1.0, text embeddings from Qwen3 at the pipeline default of 512 tokens. Raw numbers: `out/results.json`; pictures: `out/contact_sheet.html` and the PNGs in `out/`.

Stack on Kaggle that day: diffusers 0.42.0.dev0 (git main), transformers 5.22.2, torch 2.11.0+cu130, 2x Tesla T4 (15.64 GB, compute 7.5, no native bf16), 31 GB RAM.

## Table

| dtype | GPU | s/image (steady) | images/hour, one GPU | images/hour, both GPUs | black/NaN failures | peak VRAM |
|---|---|---|---|---|---|---|
| fp16 (text encoder, transformer and VAE all fp16) | T4 #0 | 3.65 (text 2.69, reference 4.45) | 986 | 1,856 (sum of the two steady rates) | 0 of 34 | 8.59 GB allocated, 9.24 GB reserved |
| fp16 | T4 #1 | 4.14 (text 2.93, reference 5.15) | 870 | 968 measured over the whole 253 s run including model loads | 0 of 34 | 8.59 GB allocated, 9.24 GB reserved |

- Steady means the first image on each GPU (5.1 s and 6.3 s, CUDA warm-up) is left out. Both GPUs ran at the same time, one process each.
- Failures: 0 of 68 on the first try (check: mean pixel under 5 or std under 2, or any non-finite value). The fp32-VAE and bf16 fallbacks in the worker never triggered, so they are untested. The text-encoder stage in fp16 also produced finite embeddings.
- Fits without CPU offload: the text encoder runs first (8.39 GB peak) and is freed, then the transformer + VAE load (8.59 GB peak). Loading both at once would not fit a 15 GB T4.
- One-off costs per session: weights download 111 s (about 16 GB, unauthenticated), text encoder load about 38 s, text encoding 34 prompts about 10 s, transformer + VAE load about 36 s. Roughly 3.5 minutes before the first image.
- Reference conditioning costs about 1.7x a text-only image (4.45 and 5.15 s against 2.69 and 2.93 s) because the reference doubles the image tokens.

## Projection for 20,000 images

Assuming the real mix of 1 text panel to 3 reference panels (mode (b) everywhere), average about 4.3 s per image per GPU, about 1,675 images/hour with both T4s.

- 20,000 / 1,675 = about 12 GPU-session hours. At about 30 h/week of Kaggle GPU quota that is under half a week; with margin for failed runs and the 9-hour session cap, plan 3 sessions (roughly 7,000 images each) across about 1 week.
- If everything were text-only (2.8 s), about 1,800 to 1,900 images/hour combined and about 11 h. If everything used a reference, about 1,500/hour and about 13 h.
- The Kaggle quota shown at the start was 108,000 s (30 h) of GPU with 64 s used. A T4 x2 session counts its wall time once, not twice (assumption; check `get_accelerator_quota` after the pilot to confirm before the big run).
- This excludes writing the 20k prompts and any filtering. Output per image is a 512x512 PNG of about 20 to 100 KB, so 20k is a few GB and needs to be saved per session, since Kaggle output is capped at 20 GB.

## Panel consistency: mode (a) text only with a fixed seed vs mode (b) panel 1 as reference

I looked at all 18 mode-(a) panels and all 48 mode-(b) panels.

Mode (a), text only, same seed per sequence: the palette and the flat look hold (orange, blue, grey, green glow), because the style prefix and colour words do the work. Everything else drifts. Object scale and framing jump between panels (sandbox: a tiny cube, then a huge cube in a box); the same object is redrawn as a different thing (cache: the orange cube becomes a thin orange slab, the client becomes a plain circle, the database disappears; queue: robot arms change from two on a belt to four cut-out arms); layout changes (rate limit shows four different compositions). The fixed seed helps only a little: it keeps the rough placement for some concepts. Reading the four panels as one story is often hard.

Mode (b), panel 1 as reference: clearly more consistent. The same objects, scale, palette and background persist (config: the same folder and the same arched blue gate in all four; queue: same belt and cubes; depgraph: same circles; rate limit: same crowd and gate; cache: same client, cylinder and cube). It also fixed the biggest (a) failures for the cache and queue stories.

The cost: mode (b) tends to copy panel 1 too hard. The requested change is often small or missing: config b2 and b3 barely differ from b1, rate limit b2 to b3 changes only a few dots, sandbox b2 shows a lid hovering instead of closed. Some ideas are only half drawn. Plain text prompts also get taken literally (migration b2: a literal crane bird as "a blue crane"; auth b4 added a small person). So (b) is consistent but under-acts, while (a) acts but is inconsistent.

My read: (b) is the better mode for training data of sequences where the viewer must recognise the same objects, and it should be the default. Before 20k images, test two fixes: (1) a stronger change instruction ("change this, keep that"), and (2) conditioning on the previous panel instead of panel 1 for panels 3 and 4, which should lower the copy-the-first-panel effect. I did not run those. Panel counts, prompt wording and the 512 token text length are untuned, and only 12 sequences were looked at by one reader, so treat this as a first impression, not a measurement.

Text rule check: all the "no text, no letters" prompts came out without letters, except small numerals/clock-like marks (a clock face on the rate-limit gate, a coin-like mark on the logging panel 4); no readable words.

## Errors, word for word

The first Kaggle run (version 2) failed because my workers set `HF_HOME=/tmp/hf` and `HF_HUB_OFFLINE=1` after the weights had already been downloaded to the default cache. Both workers exited with code 1 after 23 s (`worker exit codes: [1, 1] wall 23.0 s`):

```
Couldn't connect to the Hub: Cannot reach https://huggingface.co/api/models/black-forest-labs/FLUX.2-klein-4B: offline mode is enabled. To disable it, please unset the `HF_HUB_OFFLINE` environment variable..
Will try to load from local cache.
...
huggingface_hub.errors.OfflineModeIsEnabled: Cannot reach https://huggingface.co/api/models/black-forest-labs/FLUX.2-klein-4B: offline mode is enabled. To disable it, please unset the `HF_HUB_OFFLINE` environment variable.
...
OSError: Cannot load model black-forest-labs/FLUX.2-klein-4B: the model is not fully cached locally (Cannot find an appropriate cached snapshot folder for the specified revision on the local disk and outgoing traffic has been disabled. To enable repo look-ups and downloads online, pass 'local_files_
```

(The log line is cut at that point in Kaggle's output.) Fix: removed both environment settings; version 3 ran clean.

Other messages seen, not failures:

- `save_notebook` with a bare slug: `Invalid slug: 'panel-data-pilot-klein4b'`. Creating the notebook without a slug gave `snipedbywifi/panel-data-pilot-klein4b`.
- pip: `ERROR: pip's dependency resolver does not currently take into account all the packages that are installed. This behaviour is the source of the following dependency conflicts.` / `datasets 4.8.5 requires huggingface-hub<2.0,>=0.25.0, but you have huggingface-hub 2.4.0 which is incompatible.` / `gradio 6.30.0 requires pillow<13.0,>=8.0, but you have pillow 13.0.0 which is incompatible.` (harmless here).
- `FutureWarning: torch_dtype is deprecated and will be removed in version 1.0.0. Please use dtype instead.` (version 3 uses `dtype`).
- `Warning: You are sending unauthenticated requests to the HF Hub. Please set a HF_TOKEN to enable higher rate limits and faster downloads.` The 4B repo is not gated; download took 111 s without a token.

No NaN, black image, OOM or crash in the final run.

## Next steps before the 20k run

1. Try the two consistency fixes above on the same 12 concepts (about 6 minutes of GPU time).
2. Check text-token length 128 vs 512 for speed and quality (512 was used here, so the speed numbers are for the slower choice).
3. Add per-session checkpointing and a zip per chunk, since sessions are capped.
