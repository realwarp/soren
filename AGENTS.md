# Agent notes

## Model roles

- **Opus 5.5 agents only plan.** They never implement: no code changes, no running builds, training or data generation. When the person asks an Opus agent for any implementation, it writes a ready-to-paste prompt for another agent instead of doing the work.
- **Sonnet 5.5 agents** work as normal, implementation included.
- **Haiku at medium effort** does research (reading the codebase, docs, the web).
- **Haiku at high effort** does large dataset creation and any other subagent work where reasoning matters.
- When spawning subagents, set the model and effort to match these roles.

## Asking questions

- Every question is multi-select in behaviour, even when only one answer is truly correct. Set `multiple: true` so the person can pick an option and add their own words in the same answer.
- When a question genuinely allows more than one answer, say so explicitly in the question text, e.g. "Select all that apply."
- Never make the person choose between picking an option and explaining themselves. A typed answer must be able to accompany any selection.
- End every questionnaire with an "Additional notes" question. Offer three radical, mutually different directions for the topic (also multi-select), plus room for anything unrelated.
- **Ask one or two questions at a time, never a long questionnaire.** Later questions often rest on assumptions the person has not picked, so wait for the answer before asking the next ones. (Changed 5 Nov: this replaces the old "Part 1 / Part 2" batches.)
- **Put the options in the question text itself, before the choices**, in a few plain words each, so the person can read the whole question and its options in one place and clarify their idea. The option buttons repeat them.
- Aim the question at clarifying the person's idea, not at collecting a decision from a menu. Never build a question on something they have not chosen yet; if you need to assume, ask about that assumption first.
- The "Additional notes" question is asked on its own at the end of a topic, not appended to every one-or-two-question round.
- Reflect the person's prior answers in later questions. Do not re-ask what they have already settled.

## Long-running work

- At the end of every turn, check that something will wake you to continue: a background command or monitor that exits when the work finishes, a subagent whose completion notification arrives, or a scheduled wake-up. If the work is unfinished and nothing is set to wake you, set one up before ending the turn. Ending a turn with unfinished work and nothing to wake you stalls everything until the person returns (this cost a whole night once).
- Name what will wake you in the last line of the turn so the person can see it.
- When the person says not to send updates, do not send them. Keep the plan going and write progress into `data/cards/tool/STATE.md` instead.

## Terminal dashboards

When the person asks for live data in a terminal (training, sampling, a queue), build it like `tools/cards/tool_status.py` and open it with `run_in_terminal` in its own titled tab:

- One read-only script that prints a single snapshot and exits; the tab runs `while true; do clear; python3 <script> latest; sleep 5; done`. Refresh every 5 seconds unless told otherwise. Reading files only: never start, stop or change what it watches.
- Put the summary first and the long log last: state, step, progress bar, loss, speed, memory, ETA, then checkpoints and scores, then controls and queued jobs, then the log. The log is **newest first**, from the start of the run, so the latest line is always right under the summary and the header never scrolls away.
- Follow the newest run automatically (`latest`), so it keeps working when the next run starts. Say plainly when a run is stopped, quiet or ended; never show stale numbers as live.
- Keep one tab per dashboard, reuse it (`tab_id`) when changing the script, and stop or close it when the work is over. Tell the person the tab link and how to stop it (Ctrl-C).
- Print only what the file can prove. If a watcher or scorer is failing (a line like "evaluation failed" in its log), fix it before reporting the dashboard as healthy.

