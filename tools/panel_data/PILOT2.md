# Pilot 2: fixing "mode (b) copies panel 1 too hard"

Run on 6 Nov 2026 as version 4 of `snipedbywifi/panel-data-pilot-klein4b` (same setup as pilot 1: 2x T4, FLUX.2 klein 4B, fp16, 512x512, 4 steps, guidance 1.0). Notebook `pilot2.ipynb` (built by `scripts/build_notebook2.py` from `scripts/concepts_pilot2.json`), contact sheet `out2/contact_sheet2.html` (built locally by `scripts/contact_sheet2.py`, columns b | c | d | e, timings under each image), raw numbers `out2/results2.json`. Pilot 1's (b) images were reused from `out/`, not regenerated.

Concepts: the 3 where (b) under-acted worst (config, ratelimit, auth) and 3 that worked (queue, ci, merge). Seeds are the same as pilot 1 (1002, 1009, 1007, 1006, 1010, 1012). Panel 1 is generated once per concept (same seed and prompt as pilot 1) and shared by all modes.

Modes:

- (b) pilot 1: panel 1 as reference for panels 2-4, the original prompts.
- (c) previous panel as reference, same prompts as (b).
- (d) previous panel as reference plus a prompt that starts with "Edit the reference image: keep exactly the same objects, colours, style and position of everything that is not mentioned below. What changes:" and then says what is different from the previous panel in concrete visual terms. Objects are named the same way in every panel; no words a model takes literally.
- (e) extra, not asked for: panel 1 as reference plus the (d) wording. It separates the effect of the wording from the effect of chaining.

Reference strength knob: none. `Flux2KleinPipeline.__call__` has no strength or reference-weight parameter, and `guidance_scale` is ignored for the step-distilled klein (diffusers logs this). So the "lower strength" test was skipped and no extra 8 images were made.

## Table

| mode | images (panels 2-4) | s/image (steady) | black/NaN failures | clear change per panel, my count by eye (of 18) |
|---|---|---|---|---|
| (b) panel 1 reference, old prompts (pilot 1) | 18 | 4.45 and 5.15 s (pilot 1, both T4s) | 0 | 15, but weak on config and auth |
| (c) previous panel reference, old prompts | 18 | 4.73 | 0 | 13 |
| (d) previous panel reference + change wording | 18 | 4.76 | 0 | 16 |
| (e) panel 1 reference + change wording | 18 | 4.78 | 0 | 15 |
| shared panel 1 (text only) | 6 | 2.86 | 0 | n/a |

- 60 images generated in 263 s wall; 0 of 60 black/NaN; peak VRAM 8.59 GB on both GPUs, as in pilot 1. About 780 images/hour per T4 on this reference-heavy mix.
- The wording costs no speed. All reference modes are about 4.7 s, because the prompt length is fixed at 512 tokens anyway.
- "Clear change" is my own count from looking at every panel: a panel counts if what the script says changed is visibly different from the previous panel. It is one reader and a coarse count, not a measurement.

## What the pictures show

I looked at all 18 panels 2-4 in each of (b), (c), (d) and (e).

Changing the reference alone does not fix it. (c) is no better than (b) and slightly worse: config in (c) still shows folder and gate almost unchanged in all four panels, with a tiny red tick on the gate and a green glow; rate limit in (c) keeps the same grey bar in panels 3 and 4. Chaining from the previous panel mostly copies the previous panel instead.

The wording is what fixes it. Examples where (d) clearly beats (b) and (c):

1. Config (worst in pilot 1). (b) and (c): the same folder beside the same gate in all four panels, only a faint red mark and a glow. (d): panel 2 draws a blue file-shaped outline on the gate with the orange file moving in, panel 3 shows the file overlapping the outline with a bright red dot on its corner, panel 4 shows a green glow around it. Same folder and same arched gate throughout.
2. Rate limit. (d) panel 2: the crowd of dots bunched with only three dots getting through the gate. Panel 3: a thick grey bar across the gate with all dots piled up against it. Panel 4: the bar lifted above the gate and a thin line of dots passing through. (c) never lifts the bar.
3. Auth. (d) shows the key turning orange, then a grey cylinder appearing behind the gate, then the gate swung open. (b) and (c) only recolour the key and add the cylinder.

Where (d) is worse or no better:

- Merge: panel 3 does not show the blue bar replacing the orange one (the stacks look unchanged), and panel 4 is a blurry green blob. (b) and (c) were clearer here (the arrow picture).
- CI: panel 4 turns the whole pipe green and keeps the orange cube at the left, rather than a grey pipe with a green cube at the right. (b) was cleaner.
- Queue: the robot arms get redrawn as thinner dark-blue arms in the middle of the belt instead of at the right end; the picture changes style a little. (c) was the best-looking queue sequence.
- Auth panel 4 is cluttered (a gate panel swung out, two cylinders), and the "token" still looks like a key in every mode.
- (e) (panel 1 as reference with the same wording) is nearly as good as (d) on config and rate limit, but worse on queue (arms broken into stubs in panel 4). So chaining from the previous panel helps a little once the wording is strong, but the wording does about 90% of the work.

Objects stay the same in all four modes (same folder, gate, cubes, belt, bars, circle). I did not see any literal-word surprise like the pilot 1 bird, and no letters appeared. A mode (d) rule that drifts: when the prompt says "now glows" for one part, the glow sometimes spreads to a larger part (the whole CI pipe, the merged stack).

## Verdict

Best mode: (d), previous panel as reference plus change wording. It keeps the same objects (as every reference mode does) and it shows a clear change in about 16 of 18 panels, against about 15 for (b) and 13 for (c), with the big gain on the concepts that failed before (config 1 clear change of 3 in (b), 3 of 3 in (d); rate limit and auth also improve). It is not a clean win: on concepts where (b) already worked (merge, CI, queue) (d) is equal or a bit worse, because over-specific change text sometimes produces blurry glows or redrawn objects. Chaining on its own (c) is not worth it.

For the 20k run: use the (d) style of prompt, written per panel as "what changes" with fixed object names and no verbs a model takes literally, and keep a per-sequence check for a panel that looks the same as its predecessor (a cheap pixel-difference test) so the weak sequences can be re-rolled with a different seed. Next test, not run: (d) wording with 2 or 3 seeds per sequence plus that pixel-difference check, to see how many sequences need a re-roll.
