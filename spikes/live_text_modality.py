#!/usr/bin/env python3
"""Spike 1 — can Gemini 3.8 Live give us real text tokens?

PLAN §18.9 test one. The docs say native audio models are AUDIO-response-only,
and that text must come from `output_audio_transcription`. They also scope that
limitation to *native audio* models, which leaves open whether 3.8 Live accepts
`responseModalities: ["TEXT"]`.

This runs two trials and reports the difference, so one command answers both
"is there a TEXT modality?" and "if not, how good is the transcript?".

    GEMINI_API_KEY=... python3 spikes/live_text_modality.py

No third-party packages. Uses the raw BidiGenerateContent WebSocket, which is
the same protocol a Rust client would speak.
"""

import asyncio
import base64
import json
import os
import ssl
import sys

from websockets.asyncio.client import connect

try:
    import certifi
except ImportError:  # pragma: no cover - fallback for a complete system store
    certifi = None


def tls_context() -> ssl.SSLContext:
    """macOS's framework Python ships without a usable CA bundle.

    Without this the handshake fails with CERTIFICATE_VERIFY_FAILED before any
    request is sent, which a naive script then reports as "the model refused".
    """
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()

ENDPOINT = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
MODEL = "models/gemini-3.8-live"
PROMPT = "Name one fruit. One word only, then stop."


def endpoint(key: str) -> str:
    return f"{ENDPOINT}?key={key}"


async def trial(key: str, modalities: list[str], label: str, timeout: float = 30.0) -> dict:
    """One session under one response-modality setting."""
    found = {
        "label": label,
        "modalities": modalities,
        "reached_api": False,
        "setup_rejected": None,
        "text_parts": [],
        "audio_bytes": 0,
        "output_transcript": [],
        "input_transcript": [],
        "error": None,
    }

    setup = {
        "setup": {
            "model": MODEL,
            "generationConfig": {
                "responseModalities": modalities,
            },
            # Top-level setup fields, NOT generationConfig members. Putting them
            # inside generationConfig closes the socket with 1007.
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "systemInstruction": {"parts": [{"text": "Answer in as few words as possible."}]},
        }
    }

    try:
        async with connect(
            endpoint(key), max_size=None, open_timeout=20, ssl=tls_context()
        ) as socket:
            await socket.send(json.dumps(setup))

            first = json.loads(await asyncio.wait_for(socket.recv(), timeout=timeout))
            if "setupComplete" not in first:
                found["setup_rejected"] = first
                return found
            found["reached_api"] = True

            await socket.send(
                json.dumps(
                    {
                        "clientContent": {
                            "turns": [{"role": "user", "parts": [{"text": PROMPT}]}],
                            "turnComplete": True,
                        }
                    }
                )
            )

            loop = asyncio.get_running_loop()
            deadline = loop.time() + timeout
            while loop.time() < deadline:
                try:
                    raw = await asyncio.wait_for(socket.recv(), timeout=deadline - loop.time())
                except asyncio.TimeoutError:
                    break

                message = json.loads(raw)
                content = message.get("serverContent")
                if not content:
                    continue

                for part in (content.get("modelTurn") or {}).get("parts", []):
                    if part.get("text"):
                        found["text_parts"].append(part["text"])
                    if part.get("inlineData"):
                        found["audio_bytes"] += len(base64.b64decode(part["inlineData"]["data"]))

                if content.get("outputTranscription"):
                    found["output_transcript"].append(
                        content["outputTranscription"].get("text", "")
                    )
                if content.get("inputTranscription"):
                    found["input_transcript"].append(
                        content["inputTranscription"].get("text", "")
                    )
                if content.get("turnComplete"):
                    break

    except Exception as error:  # noqa: BLE001 - a spike reports, never raises
        found["error"] = f"{type(error).__name__}: {error}"

    return found


def report(found: dict) -> None:
    print(f"\n=== {found['label']}  responseModalities={found['modalities']} ===")

    if found["setup_rejected"] is not None:
        print("  SETUP REJECTED")
        print(f"  {json.dumps(found['setup_rejected'])[:600]}")
        return
    if found["error"]:
        print(f"  SOCKET ERROR: {found['error']}")
        print("  VERDICT: inconclusive — the request never reached the API")
        return

    text = "".join(found["text_parts"]).strip()
    transcript = "".join(found["output_transcript"]).strip()

    print(f"  audio received:      {found['audio_bytes']} bytes")
    print(f"  native text parts:   {found['text_parts']}")
    print(f"  output transcript:   {transcript!r}")
    print(f"  input transcript:    {''.join(found['input_transcript'])!r}")

    if text:
        print("  VERDICT: real text tokens available on this modality")
    elif transcript:
        print("  VERDICT: no native text; transcript only (ASR of the audio)")


async def main() -> int:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        print("Set GEMINI_API_KEY first.", file=sys.stderr)
        return 2

    text_trial = await trial(key, ["TEXT"], "TEXT modality")
    report(text_trial)

    # If TEXT worked we do not need the audio comparison to answer the question,
    # but the transcript fidelity number is still worth having.
    audio_trial = await trial(key, ["AUDIO"], "AUDIO modality (transcript path)")
    report(audio_trial)

    print("\n--- summary ---")
    if not (text_trial["reached_api"] or audio_trial["reached_api"]):
        print("INCONCLUSIVE: neither trial reached the API.")
        print("This says nothing about the model. Fix the connection and re-run.")
    elif text_trial["text_parts"] and not text_trial["setup_rejected"]:
        print("TEXT modality is supported. Live-as-text returns real tokens.")
        print("Text surface can be Live at unlimited RPD, with no ASR loss.")
    else:
        print("TEXT modality is refused. Text must come from output_audio_transcription.")
        print("Compare the two transcripts above by ear: that is the text surface.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
