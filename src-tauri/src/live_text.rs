//! Typed chat for Live-only models.
//!
//! `gemini-3.8-live-extended-thinking` refuses `generateContent` and the
//! OpenAI-compatible endpoint; it only answers on the Live WebSocket, and only
//! with audio. This module gives the text path a `Step` anyway: one short-lived
//! socket per step, the conversation sent as typed turns, the audio discarded,
//! and the model's *transcription* read back as the reply.
//!
//! The socket is stateless between steps. Earlier tool calls and their results
//! are replayed to the model as plain text rather than as function parts, since
//! a fresh Live session has no thought signatures to attach to them.

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tungstenite::Message;

use crate::live;
use crate::provider::{Call, Step};

/// A step that runs longer than this is a hung socket, not a slow thinker.
const DEADLINE: Duration = Duration::from_secs(180);

/// Whether a model name can only be reached over the Live socket.
pub fn is_live_model(model: &str) -> bool {
    model.contains("live")
}

pub async fn step(
    keys: &[String],
    model: &str,
    effort: &str,
    system: &str,
    messages: &[Value],
    tools: &Value,
) -> Result<Step, String> {
    step_streaming(keys, model, effort, system, messages, tools, |_| {}, |_| {}, || {}, || false).await
}

/// Like [`step`], calling `on_delta` with the reply so far each time the model
/// transcribes another piece of it.
///
/// `on_generation_done` is called once when the model says it has finished writing the reply, which is before the
/// last of the audio has arrived: the words are whole while the voice is still going.
///
/// `should_skip_voice` is asked after each message once the reply is written: when it says yes the rest of the audio is
/// dropped and the step ends with the words it has.
///
/// `on_audio` receives each base64 chunk of the spoken reply as it arrives. When the
/// current key is out of quota the next is tried once, as everywhere else.
pub async fn step_streaming(
    keys: &[String],
    model: &str,
    effort: &str,
    system: &str,
    messages: &[Value],
    tools: &Value,
    on_delta: impl Fn(String) + Send + 'static,
    on_audio: impl Fn(String) + Send + 'static,
    on_generation_done: impl Fn() + Send + 'static,
    should_skip_voice: impl Fn() -> bool + Send + 'static,
) -> Result<Step, String> {
    let keys = keys.to_vec();
    if keys.is_empty() {
        return Err("Add a Gemini API key in Settings first.".into());
    }
    let model = if model.starts_with("models/") {
        model.to_string()
    } else {
        format!("models/{model}")
    };
    // The Live model refuses a session with no level, so "auto" is medium here.
    let level = match effort {
        "low" | "high" => effort,
        _ => "medium",
    };
    let mut generation = json!({ "responseModalities": ["AUDIO"] });
    // Only the thinking variant takes a level; the plain Live model refuses one.
    if model.contains("thinking") {
        generation["thinkingConfig"] = json!({ "thinkingLevel": level });
    }
    let mut setup = json!({
        "setup": {
            "model": model,
            "generationConfig": generation,
            "outputAudioTranscription": {},
            "systemInstruction": { "parts": [{ "text": system }] },
        }
    });
    // A step with no tools to offer, such as a follow-up note, sends none: an empty
    // declaration list is not a valid setup.
    if tools.as_array().is_some_and(|tools| !tools.is_empty()) {
        setup["setup"]["tools"] = live::declarations_for(tools);
    }
    let turns = turns(messages);

    tokio::task::spawn_blocking(move || {
        let ring = "live-text:gemini";
        let mut index = crate::provider::active_key(ring, keys.len());
        let mut outcome = run(&keys[index], &setup, &turns, &on_delta, &on_audio, &on_generation_done, &should_skip_voice);
        if keys.len() > 1
            && matches!(&outcome, Err(message) if live::quota_refusal(message))
        {
            index = (index + 1) % keys.len();
            crate::provider::remember_key(ring, index);
            outcome = run(&keys[index], &setup, &turns, &on_delta, &on_audio, &on_generation_done, &should_skip_voice);
        }
        outcome
    })
        .await
        .map_err(|error| format!("The Live text step failed: {error}"))?
}

/// OpenAI-shaped messages as Live turns.
fn turns(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |role: &str, text: String| {
        if text.trim().is_empty() {
            return;
        }
        match out.last_mut() {
            Some((last, body)) if last == role => {
                body.push_str("\n\n");
                body.push_str(&text);
            }
            _ => out.push((role.to_string(), text)),
        }
    };

    for message in messages {
        let text = match &message["content"] {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        match message["role"].as_str().unwrap_or("user") {
            "assistant" => {
                let mut body = text;
                for call in message["tool_calls"].as_array().into_iter().flatten() {
                    body.push_str(&format!(
                        "\n[called {} with {}]",
                        call["function"]["name"].as_str().unwrap_or("a tool"),
                        call["function"]["arguments"].as_str().unwrap_or("{}"),
                    ));
                }
                push("model", body);
            }
            "tool" => push("user", format!("[tool result: {text}]")),
            // The system prompt travels in the setup frame.
            "system" => {}
            _ => push("user", text),
        }
    }

    out.into_iter()
        .map(|(role, text)| json!({ "role": role, "parts": [{ "text": text }] }))
        .collect()
}

/// What an empty turn is reported as. A turn that ends with neither words nor a call is
/// usually a call the server rejected as malformed, and a second try usually succeeds.
const EMPTY_TURN: &str = "The Live model returned no text";

fn run(
    key: &str,
    setup: &Value,
    turns: &[Value],
    on_delta: &impl Fn(String),
    on_audio: &impl Fn(String),
    on_generation_done: &impl Fn(),
    should_skip_voice: &impl Fn() -> bool,
) -> Result<Step, String> {
    let empty = |outcome: &Result<Step, String>| {
        matches!(outcome, Err(message) if message.starts_with(EMPTY_TURN))
    };
    let mut outcome = run_once(key, setup, turns, on_delta, on_audio, on_generation_done, should_skip_voice);
    if empty(&outcome) {
        outcome = run_once(key, setup, turns, on_delta, on_audio, on_generation_done, should_skip_voice);
    }
    if empty(&outcome) {
        // Twice thinking and then saying nothing: the model is failing to form a call.
        // Answer in words rather than not at all, with the tools left out of this step.
        let mut bare = setup.clone();
        if let Some(object) = bare["setup"].as_object_mut() {
            object.remove("tools");
        }
        let words = run_once(key, &bare, turns, on_delta, on_audio, on_generation_done, should_skip_voice);
        if words.is_ok() {
            return words;
        }
    }
    outcome
}

fn run_once(
    key: &str,
    setup: &Value,
    turns: &[Value],
    on_delta: &impl Fn(String),
    on_audio: &impl Fn(String),
    on_generation_done: &impl Fn(),
    should_skip_voice: &impl Fn() -> bool,
) -> Result<Step, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let (mut socket, _) = tungstenite::connect(format!("{}?key={key}", live::ENDPOINT))
        .map_err(|error| format!("Could not reach the Live API: {error}"))?;
    live::set_read_timeout(&mut socket, Some(Duration::from_secs(30)));

    let send = |socket: &mut tungstenite::WebSocket<_>, frame: Value| {
        socket
            .send(Message::text(frame.to_string()))
            .map_err(|error| format!("Could not write to the Live API: {error}"))
    };
    send(&mut socket, setup.clone())?;

    let started = Instant::now();
    let mut sent = false;
    let mut text = String::new();
    let mut generation_signalled = false;
    let mut calls: Vec<Call> = Vec::new();
    // What the server sent, by name, so an empty turn can say why it was empty.
    let mut seen: Vec<String> = Vec::new();

    loop {
        if started.elapsed() > DEADLINE {
            return Err("The Live model took too long to answer.".into());
        }
        let raw = match socket.read() {
            Ok(Message::Text(raw)) => raw.to_string(),
            Ok(Message::Binary(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            Ok(Message::Close(frame)) => {
                let reason = frame.map(|f| f.reason.to_string()).unwrap_or_default();
                return Err(format!("The Live API closed the connection: {reason}"));
            }
            Ok(_) => continue,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(error) => return Err(format!("The Live connection dropped: {error}")),
        };
        let Ok(message) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(object) = message.as_object() {
            for (name, value) in object {
                let note = match value.as_object() {
                    Some(inner) => {
                        let mut names: Vec<String> = inner
                            .iter()
                            .map(|(key, value)| match key.as_str() {
                                // The parts, by kind: this is where a reply with no
                                // transcription, or a rejected call, would show.
                                "modelTurn" => format!(
                                    "modelTurn({})",
                                    value["parts"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .map(|part| {
                                            part.as_object()
                                                .map(|o| o.keys().cloned().collect::<Vec<_>>().join("+"))
                                                .unwrap_or_default()
                                        })
                                        .collect::<Vec<_>>()
                                        .join(",")
                                ),
                                "interactionStatus" => format!("interactionStatus={value}"),
                                _ => key.clone(),
                            })
                            .collect();
                        names.sort_unstable();
                        format!("{name}[{}]", names.join(","))
                    }
                    None => name.clone(),
                };
                if seen.last() != Some(&note) && seen.len() < 12 {
                    seen.push(note);
                }
            }
        }
        // A call the model made as a content part rather than as a toolCall frame.
        for part in message["serverContent"]["modelTurn"]["parts"].as_array().into_iter().flatten() {
            if let Some(call) = part.get("functionCall") {
                calls.push(Call {
                    id: call["id"].as_str().unwrap_or("call").to_string(),
                    name: call["name"].as_str().unwrap_or_default().to_string(),
                    arguments: call["args"].clone(),
                });
            }
        }

        if message.get("setupComplete").is_some() && !sent {
            sent = true;
            send(
                &mut socket,
                json!({ "clientContent": { "turns": turns, "turnComplete": true } }),
            )?;
            continue;
        }

        if let Some(found) = message["toolCall"]["functionCalls"].as_array() {
            for call in found {
                calls.push(Call {
                    id: call["id"].as_str().unwrap_or("call").to_string(),
                    name: call["name"].as_str().unwrap_or_default().to_string(),
                    arguments: call["args"].clone(),
                });
            }
            break;
        }

        for part in message["serverContent"]["modelTurn"]["parts"].as_array().into_iter().flatten() {
            if let Some(data) = part["inlineData"]["data"].as_str() {
                on_audio(data.to_string());
            }
        }
        if let Some(piece) = message["serverContent"]["outputTranscription"]["text"].as_str() {
            text.push_str(piece);
            on_delta(text.trim_start().to_string());
        }
        if message["serverContent"]["generationComplete"].as_bool() == Some(true) && !generation_signalled {
            generation_signalled = true;
            on_generation_done();
        }
        if message["serverContent"]["turnComplete"].as_bool() == Some(true) || !calls.is_empty() {
            break;
        }
        // The words are whole and the person has gone on, so the rest of the voice is not waited for.
        if generation_signalled && should_skip_voice() {
            break;
        }
    }
    let _ = socket.close(None);

    let text = text.trim().to_string();
    if text.is_empty() && calls.is_empty() {
        return Err(format!("{EMPTY_TURN} (server sent: {}).", seen.join(" → ")));
    }

    let tool_calls: Vec<Value> = calls
        .iter()
        .map(|call| {
            json!({
                "id": call.id,
                "type": "function",
                "function": { "name": call.name, "arguments": call.arguments.to_string() },
            })
        })
        .collect();
    let message = if calls.is_empty() {
        json!({ "role": "assistant", "content": text })
    } else {
        json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { Value::String(text.clone()) },
            "tool_calls": tool_calls,
        })
    };
    Ok(Step { text, calls, message, variant: 0 })
}
