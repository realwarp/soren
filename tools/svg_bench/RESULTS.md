# SVG panel bench: results (7 Nov 2026)

Question: can a small local text model draw clear 2-4 panel explainer pictures, either as raw SVG (A) or as a
scene JSON that a code renderer draws (B)? Contact sheet: `out/index.html` (gitignored; regenerate with
`build_index.py`). Machine: M2 Pro, 16 GB, already swapping before the test because of other apps.

## Models

The owner named "Bonsai 2 2B, 4B and 9B". Official repos (Prism ML, derived from Qwen3.5), licence read from each model card:

| Size | Repo | Licence | File used |
|---|---|---|---|
| 2B | `prism-ml/Ternary-Bonsai-2-2B-gguf` | Apache-2.0 (base Qwen/Qwen3.5-2B) | `Q2_0`, 0.55 GB |
| 4B | `prism-ml/Ternary-Bonsai-2-4B-gguf` | Apache-2.0 (base Qwen/Qwen3.5-4B) | `Q2_0`, 1.21 GB |
| 9B | `prism-ml/Ternary-Bonsai-2-9B-gguf` | Apache-2.0 (base Qwen/Qwen3.5-9B) | `Q2_0`, 2.56 GB |

The name was slightly ambiguous. Other things called Bonsai that I did not use: `prism-ml/Ternary-Bonsai-2-27B-gguf`
(too big for the 10 GB budget; a copy is already in LM Studio), the first generation `Ternary-Bonsai-1.7B/8B`,
`Bonsai-8B` (1-bit), and many third-party derivatives (abliterated, uncensored, LoRA, llamafile, MLC, ONNX
re-uploads). "Bonsai 2" with sizes 2B/4B/9B matches only the official `Ternary-Bonsai-2-*` family. These are ternary
(about 2-bit) models, so they are tiny on disk; there is no 4-bit variant. The faster `PQ2_0`/`PTQ1_0` packs need
the PrismML llama.cpp fork, so I ran `Q2_0`, which stock llama.cpp (Homebrew `llama-server` build 11669, needs b11556+)
runs directly. Speed with the fork's kernels would likely be higher; output quality should be the same weights.

An earlier pick (Qwen3.5-9B via MLX, Gemma) was dropped on instruction. Its aborted download was deleted and no
server for it was ever started.

## Numbers

Per panel; 24 panels per model and approach (6 concepts x 4 panels). Seed 7, temperature 0.3, top-p 0.95, one retry with
the error fed back. `valid` = after the retry; `1st try` = valid with no retry. Seconds include prompt processing and any retry.

| Model | Approach | s/panel | s per 4-panel sequence | valid % | 1st-try % | tok/s | peak GB (footprint / RSS) | swap change MB (end / max) |
|---|---|---|---|---|---|---|---|---|
| Bonsai 2 2B | A raw SVG | 13.5 | 54.0 | 62.5 | 58.3 | 94.7 | 1.69 / 1.40 | +166 / +486 |
| Bonsai 2 2B | B JSON | 3.2 | 12.8 | 66.7 | 58.3 | 91.4 | same run | same run |
| Bonsai 2 4B | A raw SVG | 11.0 | 44.2 | 100 | 100 | 50.2 | 3.57 / 3.12 | +3125 / +3015 (see note) |
| Bonsai 2 4B | B JSON | 4.3 | 17.0 | 79.2 | 66.7 | 51.6 | same run | same run |
| Bonsai 2 9B | A raw SVG | 19.3 | 77.2 | 100 | 100 | 30.6 | 4.52 / 3.73 | +227 / +280 |
| Bonsai 2 9B | B JSON | 7.5 | 29.9 | 95.8 | 79.2 | 32.3 | same run | same run |

Memory and swap are per model run (both approaches ran in one server). Footprint is macOS `phys_footprint_peak`,
which includes GPU-mapped buffers; RSS is from `ps`. Slowest single panel: 34.9 s (9B, A); nothing hit the 180 s cap
and no generation timed out. Server load time 1-2.5 s. No leftover `llama-server` processes after any run.

**Swap note.** Swap was 7.6 GB used before the first run and the system total grew from 7 to 12 GB during the session,
driven by other apps (Chrome, Discord, Roblox). The 4B run shows +3.1 GB, which by the literal rule (more than 1 GB)
would mark it "does not fit". I do not think that is the model: it is 1.2 GB on disk and 3.6 GB peak, the 9B run right
after (more than twice the footprint) shows only +0.2 GB, and swap fell by about 3 GB in the minutes after the run
with the model stopped. All three models fit; 9B peaks at 4.5 GB, well under the 10 GB budget.

Other quality flags (soft, they do not affect `valid`): A panels with at most 3 `<text>` elements: 42 / 71 / 50 %
(2B/4B/9B). B panels with no overlapping objects: 50 / 75 / 96 %. Objects reused between consecutive panels
(share of the earlier panel's ids, or for A its label set, that survive): B 100 / 96 / 96 %, A 96 / 89 / 85 %.
Failure causes: A is nearly all XML errors on 2B (8 of 9; one cut off at the token limit); B fails on schema rules the
model ignores: grid overflow (x+w above 12), labels over 16 characters, invented types (`server`, `folder`, `icon`),
and now and then broken JSON.

## Judgement from looking at the rendered panels

Strips were rendered to PNG and looked at, then checked in the HTML at 400 px width (2x2 wrap works, no sideways scroll).
Validity is not understanding: 4B-A is 100 % valid and still says nothing.

Is each concept understandable in 4 panels? Best case, 9B with B:

| Concept | 9B + B | 9B + A | 4B + B | 2B + B |
|---|---|---|---|---|
| Sandbox | partly: zone, gate and a "blocked" arrow appear in order, but the Files sit inside the zone and the gate is clipped at the right edge | no | no: the zone is empty, only the caption tells the story | no, 3 of 4 invalid |
| Config + schema | mostly: read file, check against Schema, error vs valid; arrows cut through the Config box | no | no, 2 of 4 invalid | no |
| Rate limiting | weak: clients, limiter and API are squeezed into one row, labels overlap; the 429 is only in the caption | partly: clients, limiter, then a 429 box | no: overlapping Clients | no, 2 of 4 invalid |
| Retry + backoff | yes for panels 2-4 (fail/retry arrows, success); the 1 s / 2 s timing is only in captions; panel 1 invalid | partly: "1s", "2s/4s", "Success" as loose text | no: same picture four times, only an arrow label changes | partly: simple, a Success box overlaps Server |
| Queue + workers | yes: queue zone, job files, workers as people, "take job", results arrows | partly: queue with blue bars, worker turns blue | partly, panel 4 invalid | no |
| DB migration | yes: DB v1, script and backup, run script, DB v2 and "New App" | no: overlapping text and shapes | no, 2 of 4 invalid | no |

Roughly: 9B + B makes 3 of 6 concepts clear (retry, queue, migration), config mostly and sandbox partly clear, rate limiting not; 9B + A makes 1-2 partly clear; 4B and 2B do not reach
a usable level, mostly copying the example's App/Cache/Database skeleton.

Same object kept across panels? Yes with B on 9B and 4B: the ids, positions and labels stay put and only arrows,
colours and a few objects change (96 % reuse). The renderer makes that visible; with A the model redraws shapes each
time and they drift or collide (4B-A sandbox: the "Sandbox" label ends up hidden behind "Untrusted").
When a panel is invalid it is dropped from the history, so the next panel has no predecessor to copy ids from
(9B retry: panel 1 invalid, panel 2 needed a retry).

Labels readable? B: yes at 400 px for box labels (the renderer fits text), arrow labels are small (about 8 px at
phone width) and overlap when objects are too close; captions are the clearest text. A: font sizes are fine, but text
often overlaps shapes or is clipped at the edge ("Old Schema", "Sche", "Migrati").

Concrete examples:
- Good: 9B + B, DB migration. DB v1 with `app`/`db` kept, then "write script" and "backup" objects appear, then "run script"
  and the cylinder relabelled DB v2, then "New App" reads "run on v2". Four panels, same ids, one change per step.
- Good: 9B + B, queue with workers. A dashed Queue zone, job file icons, two person figures as workers, a "take job" arrow
  then "result" arrows. Only flaw: the two worker labels overlap.
- Bad: 9B + B, rate limiting. Three clients, the limiter and the API are laid out in a line with labels on top of
  each other; the 429 never appears as a picture.
- Bad: 4B + A, sandbox. All four panels are almost identical: boxes labelled Sandbox, Code, Untrusted, Gate placed beside
  and over one another; nothing is inside a boundary and nothing is blocked.
- Bad: 2B (both approaches). The model copies the few-shot example: retry, queue and migration panels all show
  App, Cache/Queue/DB boxes with arrows between them.

## Bottom line

- Best: Bonsai 2 9B with approach B (scene JSON + renderer): about 30 s per 4-panel sequence, 95.8 % valid after one
  retry (79 % first try), 4.5 GB peak, no real swap growth. Approach A on 9B is 100 % valid but 2.6x slower and much less clear.
- Text-written pictures are crisp and consistent, and the renderer fixes arrowheads, fonts and colours so they always
  look like the owner's diagram style. They are understandable when the idea is a short left-to-right flow with 3-5 things
  (queue, migration, retry). They are not when the idea is spatial: "inside a boundary", "many clients into one gate".
- Main weakness: layout. The models cannot reliably place objects (overlaps, objects past the grid edge, objects that should
  be inside a zone but are not) and rely on the caption for the message. They also copy the few-shot example.
- Cheap fixes worth trying before judging further: a lenient JSON repair (clamp x/y to the grid, truncate labels, map unknown
  types to `box`), which would lift validity to near 100 %; an automatic layout pass in `render.py` that spreads overlapping
  objects and puts zone members inside; and two or three few-shot examples of different shapes (a fan-in, a boundary) instead of one.
- Not tested: larger models, the PrismML fork's faster kernels, and a second try with the same prompts on a different seed.
  One seed and one prompt per concept means individual panels are noisy; the ranking between sizes is clear but the exact percentages are not precise.

## Deviations from the brief

- Models: Bonsai 2 2B/4B/9B only, as instructed later; the MLX/Gemma/Qwen plan was dropped.
- `zone` object type added (dashed boundary), needed for the sandbox concept. B also draws the model's `caption` under the panel
  (about 34 characters); A has no caption and is limited to 3 text elements, so B carries more words than A.
- Prompt format: the example sequence is given as earlier chat turns and earlier generated panels stay in the history, so panels
  can see their predecessors. If a panel stays invalid after the retry it is left out of the history.
- Tokens/s is the server's own decode speed (`timings.predicted_per_second`), averaged over generations.
