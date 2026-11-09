#!/usr/bin/env python3
"""Spike 2 — can Gemini 3.8 Live call tools while audio is flowing?

PLAN §18.9 test two. The Live API reference warns that "audio inputs and audio
outputs negatively impact the model's ability to use function calling." The whole
architecture in §18.8 depends on the opposite, so this measures it.

Two trials with the same tool and the same words, differing only in how the turn
arrives:

  audio-in  — spoken PCM, the real voice path
  text-in   — the same sentence as text, the control

If audio-in fails and text-in works, the defect is the microphone path and can be
worked around. If both fail, tool calling under audio output is the problem. If
both work, the architecture stands.

    GEMINI_API_KEY=... python3 spikes/live_tools_under_audio.py

Requires macOS `say` and `ffmpeg` to synthesise the utterance. No pip installs.
"""

import asyncio
import base64
import json
import os
import ssl
import subprocess
import sys
import tempfile
import time

from websockets.asyncio.client import connect

try:
    import certifi
except ImportError:  # pragma: no cover
    certifi = None


def tls_context() -> ssl.SSLContext:
    """macOS's framework Python ships without a usable CA bundle."""
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()

ENDPOINT = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
MODEL = "models/gemini-3.8-live"

UTTERANCE = (
    "We are shipping by March, and we cannot hire anyone before then. "
    "Record that as a goal and a constraint."
)

SYSTEM = (
    "You keep a brief. When the person states something load-bearing, call "
    "add_item to record it. Then reply in one short sentence."
)

TOOL = {
    "functionDeclarations": [
        {
            "name": "add_item",
            "description": "Record one load-bearing item in the brief.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "type": {
                        "type": "STRING",
                        "enum": ["goal", "constraint", "decision", "option", "assumption", "question"],
                    },
                    "text": {"type": "STRING"},
                },
                "required": ["type", "text"],
            },
        }
    ]
}


def spoken_pcm(text: str) -> bytes:
    """Render `text` to 16kHz mono signed-16 little-endian PCM."""
    with tempfile.TemporaryDirectory() as directory:
        aiff = os.path.join(directory, "speech.aiff")
        pcm = os.path.join(directory, "speech.pcm")
        subprocess.run(["say", "-o", aiff, text], check=True)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", aiff,
             "-f", "s16le", "-ac", "1", "-ar", "16000", pcm],
            check=True,
        )
        with open(pcm, "rb") as handle:
            return handle.read()


async def trial(key: str, sentence: str, audio: bytes | None, label: str,
                timeout: float = 40.0) -> dict:
    found = {
        "label": label,
        "reached_api": False,
        "tool_calls": [],
        "tool_accepted_non_blocking": None,
        "audio_bytes_after_call": 0,
        "audio_bytes_total": 0,
        "reply_text": [],
        "error": None,
        "ms_to_tool_call": None,
    }

    setup = {
        "setup": {
            "model": MODEL,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
            },
            # Top-level setup field, not a generationConfig member.
            "outputAudioTranscription": {},
            "systemInstruction": {"parts": [{"text": SYSTEM}]},
            "tools": [TOOL],
        }
    }

    try:
        async with connect(
            f"{ENDPOINT}?key={key}", max_size=None, open_timeout=20, ssl=tls_context()
        ) as socket:
            await socket.send(json.dumps(setup))
            first = json.loads(await asyncio.wait_for(socket.recv(), timeout=timeout))
            if "setupComplete" not in first:
                found["error"] = f"setup rejected: {json.dumps(first)[:400]}"
                return found
            found["reached_api"] = True

            started = time.monotonic()

            if audio is not None:
                # 100 ms frames, paced, so VAD sees a plausible utterance.
                frame = 3200
                for offset in range(0, len(audio), frame):
                    await socket.send(json.dumps({
                        "realtimeInput": {
                            "audio": {
                                "data": base64.b64encode(audio[offset:offset + frame]).decode(),
                                "mimeType": "audio/pcm;rate=16000",
                            }
                        }
                    }))
                    await asyncio.sleep(0.1)
                await socket.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
            else:
                await socket.send(json.dumps({
                    "clientContent": {
                        "turns": [{"role": "user", "parts": [{"text": sentence}]}],
                        "turnComplete": True,
                    }
                }))

            loop = asyncio.get_running_loop()
            deadline = loop.time() + timeout
            responded = False

            while loop.time() < deadline:
                try:
                    raw = await asyncio.wait_for(socket.recv(), timeout=deadline - loop.time())
                except asyncio.TimeoutError:
                    break

                message = json.loads(raw)

                call = message.get("toolCall")
                if call:
                    found["ms_to_tool_call"] = int((time.monotonic() - started) * 1000)
                    found["tool_calls"].extend(call.get("functionCalls", []))
                    # Answering late is the point: NON_BLOCKING means the model
                    # should keep talking while we work.
                    await asyncio.sleep(2.0)
                    responses = [
                        {"id": item.get("id"), "name": item.get("name"),
                         "response": {"result": "staged"}}
                        for item in call.get("functionCalls", [])
                    ]
                    await socket.send(json.dumps({"toolResponse": {"functionResponses": responses}}))
                    found["tool_accepted_non_blocking"] = True
                    responded = True
                    continue

                content = message.get("serverContent")
                if not content:
                    continue

                for part in (content.get("modelTurn") or {}).get("parts", []):
                    if part.get("inlineData"):
                        size = len(base64.b64decode(part["inlineData"]["data"]))
                        found["audio_bytes_total"] += size
                        if responded:
                            found["audio_bytes_after_call"] += size

                if content.get("outputTranscription"):
                    found["reply_text"].append(content["outputTranscription"].get("text", ""))

                if content.get("turnComplete"):
                    # `turnComplete` is NOT "the session is idle". After a tool
                    # call the model closes its turn, waits for the function
                    # response, then opens a new turn to speak the result. Breaking
                    # on the first one silently discards the spoken answer.
                    if not responded or found["audio_bytes_after_call"]:
                        break
                    continue

    except Exception as error:  # noqa: BLE001
        found["error"] = f"{type(error).__name__}: {error}"

    return found


def report(found: dict) -> None:
    print(f"\n=== {found['label']} ===")
    if found["error"]:
        print(f"  ERROR: {found['error']}")
        return

    print(f"  tool calls:            {len(found['tool_calls'])}")
    for call in found["tool_calls"]:
        print(f"    - {call.get('name')} {json.dumps(call.get('args'))}")
    print(f"  ms to first tool call: {found['ms_to_tool_call']}")
    print(f"  audio total:           {found['audio_bytes_total']} bytes")
    print(f"  audio after response:  {found['audio_bytes_after_call']} bytes")
    print(f"  transcript:            {''.join(found['reply_text']).strip()!r}")


async def main() -> int:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        print("Set GEMINI_API_KEY first.", file=sys.stderr)
        return 2

    print("Rendering the utterance with `say` + ffmpeg ...")
    audio = spoken_pcm(UTTERANCE)
    print(f"  {len(audio)} bytes of 16kHz PCM ({len(audio) / 32000:.1f}s)")

    audio_trial = await trial(key, UTTERANCE, audio, "audio-in (voice path)")
    report(audio_trial)

    text_trial = await trial(key, UTTERANCE, None, "text-in (control)")
    report(text_trial)

    print("\n--- summary ---")
    audio_ok = bool(audio_trial["tool_calls"])
    text_ok = bool(text_trial["tool_calls"])

    if not (audio_trial["reached_api"] or text_trial["reached_api"]):
        print("INCONCLUSIVE: neither trial reached the API.")
        print("This says nothing about tool calling. Fix the connection and re-run.")
        return 0

    if audio_ok and text_ok:
        print("Tool calling survives both paths. §18.8 architecture stands.")
        if audio_trial["audio_bytes_after_call"]:
            print("Audio continued after the tool call: async dispatch confirmed.")
        else:
            print("No audio after the tool call: the model blocked despite NON_BLOCKING.")
    elif text_ok and not audio_ok:
        print("Tools work with text in, not audio in: the mic path is the problem.")
        print("Workaround: transcribe in the client, drive the turn with text.")
    elif audio_ok and not text_ok:
        print("Tools work with audio in, not text in. Unusual; treat as a flake and re-run.")
    else:
        print("No tool calls on either path. The orchestrator cannot dispatch agents.")
        print("PLAN §18.3 pipeline is the fallback: STT -> text model -> TTS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
