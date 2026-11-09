#!/usr/bin/env python3
"""Diagnostic — why did Live return no audio?

Spike 2 proved tool calls work under both audio and text input, but no audio was
returned in either trial. Two explanations fit the same evidence:

  (a) the model simply does not speak while it holds a pending tool call, or
  (b) the harness dropped the audio — a malformed toolResponse, an error frame
      that wasn't read, or a turn that ended early.

This separates them by logging every frame the server sends, and by running a
baseline turn that declares the same tools but asks for no tool use.

    GEMINI_API_KEY=... python3 spikes/live_after_tool_diagnostic.py
"""

import asyncio
import base64
import json
import os
import ssl
import time

from websockets.asyncio.client import connect

try:
    import certifi
except ImportError:  # pragma: no cover
    certifi = None

ENDPOINT = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
MODEL = "models/gemini-3.8-live"

TOOL = {
    "functionDeclarations": [
        {
            "name": "add_item",
            "description": "Record one load-bearing item in the brief.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "type": {"type": "STRING"},
                    "text": {"type": "STRING"},
                },
                "required": ["type", "text"],
            },
        }
    ]
}


def tls_context() -> ssl.SSLContext:
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()


class Session:
    """A Live session that records every frame instead of guessing."""

    def __init__(self, key: str, with_tools: bool):
        self.key = key
        self.with_tools = with_tools
        self.audio_bytes = 0
        self.transcript = []
        self.frames = []          # (kind, detail)
        self.tool_calls = []
        self.errors = []

    def setup(self) -> dict:
        setup = {
            "model": MODEL,
            "generationConfig": {"responseModalities": ["AUDIO"]},
            "outputAudioTranscription": {},
            "systemInstruction": {
                "parts": [{"text": "You keep a brief. Be extremely brief."}]
            },
        }
        if self.with_tools:
            setup["tools"] = [TOOL]
        return {"setup": setup}

    def note(self, message: dict) -> None:
        """Classify one server frame."""
        if "setupComplete" in message:
            self.frames.append(("setupComplete", ""))
        elif "toolCall" in message:
            calls = message["toolCall"].get("functionCalls", [])
            self.tool_calls.extend(calls)
            self.frames.append(("toolCall", [c.get("name") for c in calls]))
        elif "toolCallCancellation" in message:
            self.frames.append(("toolCallCancellation",
                                message["toolCallCancellation"].get("ids")))
        elif "error" in message:
            self.errors.append(json.dumps(message["error"])[:300])
            self.frames.append(("error", self.errors[-1]))
        elif "usageMetadata" in message and "serverContent" not in message:
            usage = message["usageMetadata"]
            self.frames.append(("usage", usage.get("totalTokenCount")))
        elif "serverContent" in message:
            content = message["serverContent"]
            parts = (content.get("modelTurn") or {}).get("parts", [])
            audio = sum(
                len(base64.b64decode(p["inlineData"]["data"]))
                for p in parts
                if p.get("inlineData")
            )
            self.audio_bytes += audio
            text = "".join(p.get("text", "") for p in parts if p.get("text"))
            if content.get("outputTranscription"):
                self.transcript.append(content["outputTranscription"].get("text", ""))
            detail = []
            if audio:
                detail.append(f"audio={audio}B")
            if text:
                detail.append(f"text={text!r}")
            if content.get("outputTranscription"):
                detail.append("transcript")
            if content.get("turnComplete"):
                detail.append("turnComplete")
            if content.get("generationComplete"):
                detail.append("generationComplete")
            if content.get("interrupted"):
                detail.append("INTERRUPTED")
            self.frames.append(("serverContent", ", ".join(detail) or "(empty)"))
        else:
            self.frames.append(("other", list(message.keys())))

    def report(self, label: str) -> None:
        print(f"\n=== {label} ===")
        for kind, detail in self.frames:
            print(f"  {kind:<22} {detail}")
        print(f"  -> audio {self.audio_bytes}B, transcript {''.join(self.transcript).strip()!r},"
              f" tool calls {len(self.tool_calls)}, errors {len(self.errors)}")


async def baseline(key: str) -> Session:
    """Tools declared, but nothing to call them with. Does it still speak?"""
    session = Session(key, with_tools=True)
    async with connect(f"{ENDPOINT}?key={key}", max_size=None, ssl=tls_context()) as socket:
        await socket.send(json.dumps(session.setup()))
        session.note(json.loads(await socket.recv()))
        await socket.send(json.dumps({
            "clientContent": {
                "turns": [{"role": "user", "parts": [{"text": "Say hello in three words."}]}],
                "turnComplete": True,
            }
        }))
        await drain(socket, session, seconds=12)
    session.report("baseline: tools declared, no tool use expected")
    return session


async def after_tool(key: str) -> Session:
    """Trigger a tool, answer it, then watch what arrives next."""
    session = Session(key, with_tools=True)
    async with connect(f"{ENDPOINT}?key={key}", max_size=None, ssl=tls_context()) as socket:
        await socket.send(json.dumps(session.setup()))
        session.note(json.loads(await socket.recv()))
        await socket.send(json.dumps({
            "clientContent": {
                "turns": [{"role": "user",
                           "parts": [{"text": "We ship in March and cannot hire before then. Record both."}]}],
                "turnComplete": True,
            }
        }))

        loop = asyncio.get_running_loop()
        deadline = loop.time() + 25
        answered = False
        while loop.time() < deadline:
            try:
                raw = await asyncio.wait_for(socket.recv(), timeout=deadline - loop.time())
            except asyncio.TimeoutError:
                break
            message = json.loads(raw)
            session.note(message)

            if "toolCall" in message and not answered:
                answered = True
                calls = message["toolCall"].get("functionCalls", [])
                print("  answering tool call; ids:",
                      [c.get("id") for c in calls])
                await asyncio.sleep(2.0)
                await socket.send(json.dumps({
                    "toolResponse": {
                        "functionResponses": [
                            {"id": c.get("id"), "name": c.get("name"),
                             "response": {"result": "staged"}}
                            for c in calls
                        ]
                    }
                }))
                continue

            if "serverContent" in message and message["serverContent"].get("turnComplete"):
                # Keep reading briefly: a second turn may follow the tool response.
                await drain(socket, session, seconds=8)
                break

    session.report("after tool: trigger, answer, then wait")
    return session


async def drain(socket, session: Session, seconds: float) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while loop.time() < deadline:
        try:
            raw = await asyncio.wait_for(socket.recv(), timeout=deadline - loop.time())
        except asyncio.TimeoutError:
            return
        session.note(json.loads(raw))


async def main() -> int:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        print("Set GEMINI_API_KEY first.")
        return 2

    base = await baseline(key)
    tool = await after_tool(key)

    print("\n--- diagnosis ---")
    if base.audio_bytes > 0:
        print("Audio works with tools declared. The model can speak while holding tools.")
    else:
        print("NO audio even with no tool use: audio output is not reaching this client.")
        print("Check for an error frame above; that is the likely cause.")

    if tool.tool_calls and tool.audio_bytes > 0:
        print("Audio also arrives after a tool response: async orchestration is viable.")
    elif tool.tool_calls and tool.audio_bytes == 0:
        print("Tool call happens, then silence. Either the model waits for a turn")
        print("nudge, or the toolResponse shape is wrong — see the frames above.")
    elif not tool.tool_calls:
        print("No tool call this run; treat as a flake and re-run before concluding.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
