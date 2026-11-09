# Media bench: StarVector-1B and Pinhole S/M/L

Apple M2 Pro, 16 GB, local only, one seed each. Prompts come from the "AI Evaluation Harness" plan.
Scripts: `run.sh` (max RSS via `/usr/bin/time -l`, swap via `sysctl vm.swapusage`), `starvector_bench.py`, `pinhole_bench.py`, `build_report.py`.
Contact sheet (not committed): `out/index.html`.

| Model | Device | Load s | s/output | Peak GB | Swap change | Valid outputs | Verdict |
|---|---|---|---|---|---|---|---|
| StarVector-1B (fp16) | MPS | 11 to 26 | no output in 4:59 (killed) | about 29 (footprint; max RSS only 4.5) | about +11 GB (16.6 to 27.4 GB) | 0 of 1 image-to-SVG | Does not fit 16 GB. |
| StarVector-1B (fp32) | CPU | 5.7 | no output in about 30 min (stopped; slowed by leaked processes, see below) | about 3 (max RSS) | not meaningful (see below) | 0 of 1 image-to-SVG | Fail. |
| StarVector-1B text-to-SVG | MPS, 80 tokens only | same load | 6.6 to 10.9 per 80 tokens | 4.5 (max RSS) | n/a | 0 of 4 | Fail, output is noise. |
| Pinhole-S (13M) | MPS fp32 | 50.7 (first run, includes file reads) | 0.24 steady (0.53 incl. 5.6 s first-prompt warm-up) | 1.7 | -0.7 GB | 16 of 16 images | Fits easily and is fastest, but the pictures are blobs. |
| Pinhole-M (34M) | MPS fp32 | 6.5 | 0.43 steady (0.57 overall) | 1.9 | +0.1 GB | 16 of 16 images | Fits, blobs, slightly more shape than S. |
| Pinhole-L (71M) | MPS fp32 | 6.7 | 0.57 steady (0.60 overall) | 2.0 | +0.2 GB | 16 of 16 images | Fits, crispest of the three, still not recognisable subjects. |

"Peak GB" for Pinhole is the process footprint sampled with `top` every 10 s (max RSS was 0.45 to 0.56 GB because MPS memory is not counted in RSS). Swap on this Mac moves by several GB on its own (Chrome, Roblox, Premiere Pro were open), so Pinhole swap changes of a few hundred MB are noise; no run grew swap by more than 1 GB except StarVector on MPS.

## StarVector text-to-SVG: exists in the repo code, broken as shipped, output is noise

- `StarVectorBase.generate_text2svg` exists in the star-vector repo (`starvector/model/models/starvector_base.py`), but the released `StarVectorForCausalLM` class does not expose it, and the released model is the image-to-SVG checkpoint.
- Called as shipped (`model.model.generate_text2svg(...)`) it fails with:
  `TypeError: StarVectorBase._get_generation_kwargs() takes 2 positional arguments but 3 were given`
- With that one argument bug worked around (not a new path), an 80-token probe on MPS gave noise for all four prompts, for example `ar" xmlns" xmlns" version2="1212121212121212...`. 0 of 4 are valid SVG. A full-length run was not done because the owner stopped StarVector.

## Errors, word for word

- Loading as the card says (the base model `bigcode/starcoderbase-1b` is gated and this account has no access):
  `OSError: You are trying to access a gated repo. Make sure to have access to it at https://huggingface.co/bigcode/starcoderbase-1b. 403 Client Error. ... Access to model bigcode/starcoderbase-1b is restricted and you are not in the authorized list. Visit https://huggingface.co/bigcode/starcoderbase-1b to ask for access.`
  Workaround used in the script: build the same GPTBigCode architecture from a hand-written config and use the tokenizer shipped inside the StarVector repo (all LLM weights come from StarVector's own files; no gated file used).
- Image-to-SVG with `max_length` 100 on MPS (probe run): `ValueError: Input length of input_ids is 0, but `max_length` is set to -159. This can lead to unexpected behavior. You should consider increasing `max_length`, or better yet, setting `max_new_tokens`.` (max_length counts the 257 image tokens.)
- CPU fp32, first try: `RuntimeError: expected scalar type Float but found Half` (image-encoder weights stay fp16 after load; fixed with `model.float()`).
- Sanity check 1a never produced an SVG on either device, so the image-to-SVG question is also unanswered.

## Leaked processes

Three earlier StarVector runs (PIDs 71329, 71817, 72370) survived my `pkill` (it killed the wrapper, not the Python child), were orphaned (parent PID 1) and ran at roughly 180 to 270% CPU each for 35 to 40+ min. They slowed the CPU run and were still running during the Pinhole runs, so the CPU StarVector numbers and possibly the Pinhole timings (MPS work, but the CPU side of the pipeline shared the machine) are pessimistic. The owner is dealing with them. The stopped short CPU run (PID 82892) was killed on request.

## Code review

Read before running: StarVector `starvector_arch.py`, `processing_starvector.py` (hub copies match the snapshot), the repo's `starvector_v1.py`, `starvector_base.py`, `starcoder.py`, `adapter.py`, `image_encoder.py`, `clip_model.py`, `data/util.py`, `util.py` (repo commit 0e083c1). Only inference; `util.py` has `subprocess` helpers that are never called. Pinhole `pinhole.py` is identical in S, M and L and is pure inference (it also downloads `openai/clip-vit-base-patch32` and `madebyollin/taesd`).

## Verdict

- StarVector: FAIL on this Mac (MPS too big, CPU too slow, text-to-SVG not usable).
- Pinhole: runs fast on MPS and fits, but across 4 prompts x 4 images x 3 sizes the pictures are colourful blobs, not recognisable folder trees, shields or documents. L is the crispest, S the fastest.
