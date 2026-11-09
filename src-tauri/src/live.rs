//! Pieces of the Gemini Live socket that the chat model (`live_text`) shares.
//!
//! The voice session that used to live here is gone; what is left is the endpoint, the tool-declaration shape Live
//! expects, the quota check and the socket read timeout.

use std::time::Duration;

use serde_json::{Value, json};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::WebSocket;

pub(crate) const ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/// Whether a refusal from the Live API means the key is out of quota.
pub(crate) fn quota_refusal(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    ["quota", "resource_exhausted", "429", "insufficient"]
        .iter()
        .any(|needle| message.contains(needle))
}

/// The same declarations for any OpenAI-shaped tool list.
pub(crate) fn declarations_for(schemas: &Value) -> Value {
    let mut found = Vec::new();
    for tool in schemas.as_array().cloned().unwrap_or_default() {
        let function = &tool["function"];
        let Some(name) = function.get("name").and_then(Value::as_str) else {
            continue;
        };
        found.push(json!({
            "name": name,
            "description": function.get("description").cloned().unwrap_or(Value::Null),
            "parameters": live_schema(&function["parameters"]),
            // No `behavior` and no thought signature here: this model rejects
            // both in the setup frame. Calls are blocking by default, and the API
            // asks for signatures only on function-call parts in history.
        }));
    }
    json!([{ "functionDeclarations": found }])
}

fn live_schema(schema: &Value) -> Value {
    let Some(object) = schema.as_object() else {
        return schema.clone();
    };
    let mut out = serde_json::Map::new();
    for (key, value) in object {
        match key.as_str() {
            "type" => {
                if let Some(name) = value.as_str() {
                    out.insert("type".into(), json!(name.to_uppercase()));
                }
            }
            "properties" => {
                if let Some(properties) = value.as_object() {
                    let mut converted = serde_json::Map::new();
                    for (name, property) in properties {
                        converted.insert(name.clone(), live_schema(property));
                    }
                    out.insert("properties".into(), Value::Object(converted));
                }
            }
            "items" => {
                out.insert("items".into(), live_schema(value));
            }
            _ => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

pub(crate) fn set_read_timeout(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    timeout: Option<Duration>,
) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(timeout);
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream.sock.set_read_timeout(timeout);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_are_converted_to_the_live_shape() {
        let converted = live_schema(&json!({
            "type": "object",
            "properties": {
                "text": { "type": "string" },
                "dependsOn": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["text"]
        }));

        // Live's schema types are an enum, and the enum is upper case. Sending
        // "string" closes the socket with a 1007, so this is not cosmetic.
        assert_eq!(converted["type"], "OBJECT");
        assert_eq!(converted["properties"]["text"]["type"], "STRING");
        assert_eq!(converted["properties"]["dependsOn"]["items"]["type"], "STRING");
        assert_eq!(converted["required"][0], "text");
    }
}
