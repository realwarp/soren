//! The agent you talk to from the workflow canvas.
//!
//! The words come from the chat model (Gemini Live), one short step. When the person asks for a change to the
//! workflow, that model calls the `change_workflow` tool; only then does the app use the cloud model (flash-lite) to
//! draw the change. This command returns the model's words and the instruction it gave the tool, if any. The cloud
//! model is not touched here.

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::cloud::{overloaded, BUSY_RETRIES, BUSY_RETRY_AFTER};
use crate::{provider, store};

/// More than a one-line note needs, since a thinking model spends some of it before writing.
const MAX_TOKENS: u32 = 1_200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasReply {
    /// What the model said. May be empty when it only called the tool.
    pub text: String,
    /// The instruction it gave `change_workflow`, when it asked for a change.
    pub change: Option<String>,
    /// Major decisions the model wants the person to settle before the change is drawn (question + short options).
    pub decisions: Vec<Decision>,
}

#[derive(Serialize)]
pub struct Decision {
    pub question: String,
    pub options: Vec<String>,
}

fn change_tool() -> serde_json::Value {
    json!([{
        "type": "function",
        "function": {
            "name": "change_workflow",
            "description": "Change the workflow on the canvas: add, remove or reword steps, or rewire what waits for what. A cloud agent (gemini-3.5-flash-lite) draws the change and the person looks it over before it is kept. Call it when they asked for a change or to build something. A goal such as \"build an AI harness\" is turned into all the steps it takes, so pass the whole goal with every detail they gave. Do not call it for questions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "instruction": {
                        "type": "string",
                        "description": "The change, precise enough for an editor that sees only the graph: which steps by id, what to add or remove, what waits for what."
                    },
                    "decisions": {
                        "type": "array",
                        "description": "Only major decisions that change the graph's shape (adding, splitting, removing or reordering steps, or choosing between structurally different approaches) that the person has not settled. At most 4. Leave out when nothing major is open; never ask about wording or small details.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": { "type": "string" },
                                "options": { "type": "array", "items": { "type": "string" }, "description": "2 to 4 short options." }
                            },
                            "required": ["question", "options"]
                        }
                    }
                },
                "required": ["instruction"]
            }
        }
    }])
}

#[tauri::command]
pub async fn canvas_agent(app: AppHandle, system: String, prompt: String) -> Result<CanvasReply, String> {
    let config = store::read_config(&app)?;
    let messages = vec![json!({ "role": "user", "content": prompt })];
    let mut tries = 0;
    let step = loop {
        match provider::step(&config, &system, &messages, &change_tool(), MAX_TOKENS).await {
            Ok(step) => break step,
            Err(error) if overloaded(&error) && tries < BUSY_RETRIES => {
                tries += 1;
                let _ = app.emit("canvas-retry", json!({ "attempt": tries, "of": BUSY_RETRIES }));
                tokio::time::sleep(BUSY_RETRY_AFTER).await;
            }
            Err(error) => return Err(error),
        }
    };
    let change = step
        .calls
        .iter()
        .find(|call| call.name == "change_workflow")
        .and_then(|call| call.arguments.get("instruction"))
        .and_then(|value| value.as_str())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    if step.text.trim().is_empty() && change.is_none() {
        return Err("The chat model sent back nothing.".into());
    }
    let decisions = if change.is_some() { read_decisions(&step) } else { Vec::new() };
    Ok(CanvasReply { text: step.text, change, decisions })
}

/// The questions the model passed along with `change_workflow`. Anything malformed is dropped, not guessed at.
fn read_decisions(step: &provider::Step) -> Vec<Decision> {
    let Some(list) = step
        .calls
        .iter()
        .find(|call| call.name == "change_workflow")
        .and_then(|call| call.arguments.get("decisions"))
        .and_then(|value| value.as_array())
    else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            let question = item.get("question")?.as_str()?.trim().to_string();
            let options: Vec<String> = item
                .get("options")?
                .as_array()?
                .iter()
                .filter_map(|o| o.as_str())
                .map(|o| o.trim().to_string())
                .filter(|o| !o.is_empty())
                .take(4)
                .collect();
            (!question.is_empty() && options.len() >= 2).then_some(Decision { question, options })
        })
        .take(4)
        .collect()
}
