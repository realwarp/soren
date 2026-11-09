# Spikes — Gemini Live, before any build

Two throwaway scripts that each answer a question which can invalidate PLAN §18.
Neither touches Soren. Both speak the raw `BidiGenerateContent` WebSocket, so
whatever they prove also holds for a Rust client.

```sh
export GEMINI_API_KEY=...
python3 spikes/live_text_modality.py
python3 spikes/live_tools_under_audio.py
```

Only `websockets` is needed (already installed). The second script also uses
macOS `say` and `ffmpeg` to synthesise a spoken utterance locally.

---

## 1. `live_text_modality.py` — is there real text?

**Why it matters.** Native audio models return AUDIO only; the text arrives as
`output_audio_transcription`, an ASR re-hearing of the speech. The limitation is
scoped to *native audio* models, which leaves open whether 3.8 Live accepts
`responseModalities: ["TEXT"]`.

| Result | Meaning |
| --- | --- |
| `native text parts` non-empty | Real tokens. Text can ride on unlimited Live with no fidelity loss. Text surface solved. |
| `output transcript` only | Every word Soren shows is a re-hearing. Usable, second-class, and the text surface needs a real text model. |
| setup rejected | TEXT modality does not exist on this model. Same conclusion as above. |

## 2. `live_tools_under_audio.py` — can it dispatch agents?

**Why it matters.** The reference warns that audio in and audio out degrade
function calling, and §18.8 depends on tool calls being reliable while someone is
talking. It runs the same sentence twice, spoken and typed, so a failure points at
the microphone path rather than at the model.

| Result | Meaning |
| --- | --- |
| both call the tool | Architecture stands. Check `audio after response` — non-zero means async dispatch really is non-blocking. |
| text yes, audio no | Mic path is broken; transcribe client-side and drive turns with text. |
| neither | The orchestrator cannot dispatch agents. Fall back to the §18.3 pipeline. |

The script answers the tool call **two seconds late** on purpose. That is the test:
if audio keeps arriving in the meantime, `NON_BLOCKING` works and a background
agent can run while the model talks. If audio stops dead, the model blocked anyway
and the async story is a fiction.

---

## What these do not test

- The 15-minute session cap and whether resumption is seamless.
- Ephemeral tokens for client-to-server auth.
- Echo cancellation, so the model does not hear its own voice.
- Whether a background agent's result can re-enter a session after the call was
  cancelled by barge-in (the server discards pending calls on interruption).

Those are build problems, not existential ones. These two are existential.
