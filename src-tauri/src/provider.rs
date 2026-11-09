use crate::types::{
    GEMINI_BASE_URL, NVIDIA_BASE_URL, OPENCODE_BASE_URL, ProviderConfig,
    ProviderProfile,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// One client for the whole process.
///
/// Building a client per request threw away the connection pool, so every step
/// paid a fresh TLS handshake — about 0.6s against a real endpoint, on a turn
/// that already makes several requests.
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Could not prepare the model request: {e}"))?;
    Ok(CLIENT.get_or_init(|| built))
}

pub fn truncate(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

pub fn base_body(
    profile: &ProviderProfile,
    system: &str,
    messages: &[Value],
    max_tokens: u32,
) -> Value {
    let mut all = Vec::with_capacity(messages.len() + 1);
    all.push(json!({ "role": "system", "content": system }));
    all.extend(messages.iter().cloned());
    let mut body = json!({
        "model": profile.model,
        "temperature": crate::settings::get().temperature(),
        "max_tokens": max_tokens,
        "messages": all
    });
    // The local server runs the model with its chat template, where thinking is
    // the default for a reasoning model. It is turned off here because the turn
    // is bounded prose plus a tool call, and the trace costs 20x the words the
    // person reads (measured below). Remote providers never receive the field.
    if is_local(profile) {
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }
    body
}

/// True when the profile points at a server on this machine.
pub(crate) fn is_local(profile: &ProviderProfile) -> bool {
    let url = profile.base_url.to_ascii_lowercase();
    url.contains("127.0.0.1") || url.contains("localhost") || url.contains("[::1]")
}

/// Every request shape worth trying, best first, with duplicates removed.
///
/// The order encodes what a turn actually is. A turn is prose plus tool calls:
/// the reply is text, and the brief changes through `add_item` and its siblings.
/// So `tools` without a forced JSON mode goes first. `response_format: json_object`
/// goes second because it is still the workflow turn's shape, and because some
/// endpoints accept no other way of getting structured output.
///
/// This used to be the other way round, from when the reply itself was a JSON
/// envelope. Forcing JSON mode onto a prose turn is an active harm: it constrains
/// the reply to an object nobody asked for, and on providers that cannot combine
/// the two grammars it suppresses the tool calls the turn depends on.
///
/// A request with no tools is a caller asking for a document (a plan), so JSON
/// goes first there.
///
/// Deduplicating matters: with tools always offered, a naive fallback list sent
/// the identical body twice and paid for a request that could not succeed.
pub fn body_variants(
    profile: &ProviderProfile,
    system: &str,
    messages: &[Value],
    tools: &Value,
    max_tokens: u32,
) -> Vec<Value> {
    let offers_tools = tools.as_array().is_some_and(|tools| !tools.is_empty());
    let mut variants: Vec<Value> = Vec::new();
    let mut add = |body: Value| {
        if !variants.contains(&body) {
            variants.push(body);
        }
    };
    let make = |json_only: bool, with_tools: bool| {
        let mut body = base_body(profile, system, messages, max_tokens);
        if json_only {
            body["response_format"] = json!({ "type": "json_object" });
        }
        if with_tools && offers_tools {
            body["tools"] = tools.clone();
        }
        body
    };

    if offers_tools {
        add(make(false, true));
        add(make(true, true));
        add(make(false, false));
        add(make(true, false));
    } else {
        add(make(true, false));
        add(make(false, false));
    }
    variants
}

/// Providers that have refused a body asking for JSON mode *and* tools at once.
///
/// llama.cpp is one: its grammar runtime cannot combine the reply grammar with
/// the tool-call grammar, so that shape is a guaranteed 400 on every step. One
/// 400 per process is a fact worth remembering; one per step is a round trip.
static REFUSED_TOGETHER: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn refused_together() -> &'static Mutex<HashSet<String>> {
    REFUSED_TOGETHER.get_or_init(|| Mutex::new(HashSet::new()))
}

fn provider_key(mode: &str, base_url: &str, model: &str) -> String {
    format!("{mode}|{base_url}|{model}")
}

fn asks_for_both(body: &Value) -> bool {
    body.get("response_format").is_some() && body.get("tools").is_some()
}

/// Remember that this endpoint refused `response_format` together with `tools`.
pub fn note_refusal(mode: &str, base_url: &str, model: &str, body: &Value) {
    if !asks_for_both(body) {
        return;
    }
    if let Ok(mut refused) = refused_together().lock() {
        refused.insert(provider_key(mode, base_url, model));
    }
}

fn refuses_together(mode: &str, base_url: &str, model: &str) -> bool {
    refused_together()
        .lock()
        .map(|refused| refused.contains(&provider_key(mode, base_url, model)))
        .unwrap_or(false)
}

/// The request shapes worth trying for this provider, in order.
///
/// Same list as `body_variants`, minus the combination this endpoint has already
/// told us it cannot parse.
pub fn shapes(
    config: &ProviderConfig,
    base_url: &str,
    profile: &ProviderProfile,
    system: &str,
    messages: &[Value],
    tools: &Value,
    max_tokens: u32,
) -> Vec<Value> {
    let mut variants = body_variants(profile, system, messages, tools, max_tokens);
    if refuses_together(&config.mode, base_url, &profile.model) {
        variants.retain(|body| !asks_for_both(body));
    }
    // Only endpoints known to take `reasoning_effort` get it; the rest may 400
    // on an unknown field.
    if matches!(config.mode.as_str(), "openai" | "gemini")
        && matches!(config.effort.as_str(), "low" | "medium" | "high")
    {
        for body in &mut variants {
            body["reasoning_effort"] = json!(config.effort);
        }
    }
    variants
}

pub fn active_profile(config: &ProviderConfig) -> Result<(&str, &ProviderProfile), String> {
    match config.mode.as_str() {
        "local" => {
            let base_url = config.local.base_url.trim();
            if base_url.is_empty() {
                return Err("Set the address of the local model server in Settings.".into());
            }
            Ok((base_url, &config.local))
        }
        "openai" => {
            let base_url = config.openai.base_url.trim();
            if base_url.is_empty() {
                return Err(
                    "Add a base URL for the OpenAI-compatible provider in Settings.".into(),
                );
            }
            Ok((base_url, &config.openai))
        }
        "gemini" => Ok((GEMINI_BASE_URL, &config.gemini)),
        "nvidia" => Ok((NVIDIA_BASE_URL, &config.nvidia)),
        "opencode" => Ok((OPENCODE_BASE_URL, &config.opencode)),
        "demo" => Err("Demo mode does not use a model provider.".into()),
        other => Err(format!(
            "Unknown model provider \"{other}\". Choose a provider in Settings."
        )),
    }
}

pub fn provider_label(mode: &str) -> &'static str {
    match mode {
        "local" => "the local model",
        "openai" => "the OpenAI-compatible endpoint",
        "gemini" => "Gemini",
        "nvidia" => "NVIDIA",
        "opencode" => "OpenCode",
        _ => "the model provider",
    }
}

/// Send one chat-completions request with the shared client.
pub(crate) async fn post(
    label: &str,
    base_url: &str,
    api_key: &str,
    body: &Value,
) -> Result<reqwest::Response, String> {
    let client = client()?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    client
        .post(url)
        .timeout(Duration::from_secs(u64::from(crate::settings::get().request_timeout_secs)))
        .bearer_auth(api_key.trim())
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Could not reach {label}: {e}"))
}

/// Which key each endpoint is currently using, so a key that ran out stays skipped.
static ACTIVE_KEY: std::sync::Mutex<Vec<(String, usize)>> = std::sync::Mutex::new(Vec::new());

pub(crate) fn active_key(base_url: &str, count: usize) -> usize {
    let table = ACTIVE_KEY.lock().unwrap_or_else(|e| e.into_inner());
    table
        .iter()
        .find(|(url, _)| url == base_url)
        .map(|(_, index)| *index % count.max(1))
        .unwrap_or(0)
}

pub(crate) fn remember_key(base_url: &str, index: usize) {
    let mut table = ACTIVE_KEY.lock().unwrap_or_else(|e| e.into_inner());
    match table.iter_mut().find(|(url, _)| url == base_url) {
        Some(entry) => entry.1 = index,
        None => table.push((base_url.to_string(), index)),
    }
}

/// Whether a refusal means this key has no quota left, as opposed to a bad request.
pub(crate) fn is_quota_exceeded(status: u16, body: &str) -> bool {
    if !matches!(status, 402 | 403 | 429) {
        return false;
    }
    let body = body.to_ascii_lowercase();
    body.contains("quota") || body.contains("resource_exhausted") || body.contains("insufficient")
}

/// Like [`post`], with the profile's keys behind it. When the current key is out of
/// quota the next one is tried once; whatever that attempt returns stands.
pub(crate) async fn post_keyed(
    label: &str,
    base_url: &str,
    profile: &ProviderProfile,
    body: &Value,
) -> Result<reqwest::Response, String> {
    let keys = profile.all_keys();
    if keys.len() < 2 {
        let key = keys.first().map(String::as_str).unwrap_or("");
        return post(label, base_url, key, body).await;
    }

    let current = active_key(base_url, keys.len());
    let response = post(label, base_url, &keys[current], body).await?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !is_quota_exceeded(status.as_u16(), &text) {
        // The body was read to look at it; hand the caller an equivalent response.
        let rebuilt = http::Response::builder()
            .status(status)
            .body(text)
            .map_err(|e| format!("Could not read the {label} reply: {e}"))?;
        return Ok(reqwest::Response::from(rebuilt));
    }

    let next = (current + 1) % keys.len();
    remember_key(base_url, next);
    post(label, base_url, &keys[next], body).await
}

/// Return the text of the model's reply from a chat-completions response.
///
/// The reply may arrive as:
/// - a JSON string (`content` is a string), which is the shape `response_format`
///   forces when the endpoint supports it;
/// - a parsed JSON object (`content` is an object), which some endpoints return
///   instead of a string even when `response_format` was requested;
/// - an array of parts, each with a `text` string (multi-content responses).
///
/// A missing, null, or whitespace-only `content` with no `tool_calls` is treated as
/// "no text" by the caller.
pub fn extract_content(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(parts) = content.as_array() {
        let mut out = String::new();
        for part in parts {
            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                out.push_str(text);
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    // Some endpoints return the JSON object as a parsed value rather than a string.
    // In that case the object is the model's reply; serialize it back to text.
    if let Some(_obj) = content.as_object() {
        if let Ok(text) = serde_json::to_string(&content) {
            return Some(text);
        }
    }
    None
}

/// One tool call the model asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub id: String,
    pub name: String,
    /// The arguments as the model wrote them. Not an object means the call is unusable,
    /// and the tool will say so to the model rather than to the person.
    pub arguments: Value,
}

/// One trip to the model: what it said, and what it asked for.
///
/// `message` and `variant` are kept for the request-shape fallback and for tests; nothing reads them in the app now.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Step {
    /// Empty when the model only asked for tool calls.
    pub text: String,
    /// The calls it asked for, in the order it asked.
    pub calls: Vec<Call>,
    /// The assistant message, to put back in the conversation before the results.
    pub message: Value,
    /// Which request shape produced this step: 0 is prose plus tools. A turn that
    /// keeps landing on a later shape is telling you the endpoint refuses
    /// something, and the trace is the only place that shows.
    pub variant: usize,
}

pub fn extract_calls(message: &Value) -> Vec<Call> {
    let Some(calls) = message.get("tool_calls").and_then(|value| value.as_array()) else {
        return vec![];
    };
    calls
        .iter()
        .filter_map(|call| {
            let id = call.get("id")?.as_str()?.to_string();
            let function = call.get("function")?;
            let name = function.get("name")?.as_str()?.to_string();
            // Arguments arrive as a JSON string. A provider that sends them already
            // parsed is handled too, and anything unreadable is left for the tool to
            // refuse with a reason the model can act on.
            let arguments = match function.get("arguments") {
                Some(Value::String(raw)) => {
                    serde_json::from_str::<Value>(raw.trim()).unwrap_or(Value::Null)
                }
                Some(value) => value.clone(),
                None => Value::Null,
            };
            Some(Call {
                id,
                name,
                arguments,
            })
        })
        .collect()
}

/// Ask the model for one step, with the tools it may call.
///
/// The conversation is sent as it stands; a step that asks for tools comes back with the
/// calls and no prose, and the caller runs them and asks again. Nothing here decides what
/// a turn means — that is `run_turn`.
pub async fn step(
    config: &ProviderConfig,
    system: &str,
    messages: &[Value],
    tools: &Value,
    max_tokens: u32,
) -> Result<Step, String> {
    let (base_url, profile) = active_profile(config)?;
    if profile.all_keys().is_empty() && !is_local(profile) {
        return Err(
            "Add an API key for the selected provider in Settings, or switch to Demo mode.".into(),
        );
    }

    if config.mode == "gemini" && crate::live_text::is_live_model(&profile.model) {
        return crate::live_text::step(
            &profile.all_keys(),
            &profile.model,
            &config.effort,
            system,
            messages,
            tools,
        )
        .await;
    }

    let label = provider_label(&config.mode);
    let variants = shapes(
        config,
        base_url,
        profile,
        system,
        messages,
        tools,
        max_tokens,
    );

    // Walk the variants only while the endpoint rejects the shape. Every
    // candidate differs from the one before it, so this is a real fallback
    // rather than the duplicate request the old list could send.
    let mut index = 0;
    let mut response = post_keyed(label, base_url, profile, &variants[index]).await?;
    while !response.status().is_success()
        && matches!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNPROCESSABLE_ENTITY
        )
        && index + 1 < variants.len()
    {
        note_refusal(&config.mode, base_url, &profile.model, &variants[index]);
        index += 1;
        response = post_keyed(label, base_url, profile, &variants[index]).await?;
    }

    // A 5xx from an LLM provider is usually transient. One retry with the same
    // body is cheap; dropping to the plain body would silently take the tools
    // away mid-turn, which is how a question turn loses its options.
    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() >= 500 {
            match post_keyed(label, base_url, profile, &variants[index]).await {
                Ok(ok) if ok.status().is_success() => {
                    response = ok;
                }
                _ => {
                    // Capacity overload on the primary model: fall back to
                    // gemini-3.8-live if this is the Gemini provider.
                    if matches!(
                        status,
                        reqwest::StatusCode::TOO_MANY_REQUESTS
                            | reqwest::StatusCode::SERVICE_UNAVAILABLE
                    ) && config.mode == "gemini"
                    {
                        if let Ok(fallback) = try_fallback(
                            label,
                            base_url,
                            profile,
                            system,
                            messages,
                            tools,
                            max_tokens,
                        )
                        .await
                        {
                            response = fallback;
                        } else {
                            let text = response.text().await.unwrap_or_default();
                            return Err(format!(
                                "{label} returned {status} (primary overloaded; fallback also failed): {}",
                                truncate(&text, 400)
                            ));
                        }
                    } else {
                        let text = response.text().await.unwrap_or_default();
                        return Err(format!(
                            "{label} returned {status}: {}",
                            truncate(&text, 400)
                        ));
                    }
                }
            }
        } else if matches!(
            status,
            reqwest::StatusCode::TOO_MANY_REQUESTS | reqwest::StatusCode::SERVICE_UNAVAILABLE
        ) && config.mode == "gemini"
        {
            if let Ok(fallback) = try_fallback(
                label,
                base_url,
                profile,
                system,
                messages,
                tools,
                max_tokens,
            )
            .await
            {
                response = fallback;
            } else {
                let text = response.text().await.unwrap_or_default();
                return Err(format!(
                    "{label} returned {status} (primary overloaded; fallback also failed): {}",
                    truncate(&text, 400)
                ));
            }
        } else {
            let text = response.text().await.unwrap_or_default();
            // Live-only models (e.g. gemini-3.8-live-extended-thinking) cannot be
            // used via generateContent / chat completions. They work through the
            // Live WebSocket API instead — open the voice panel, type instead of
            // speaking, and you'll get audio back from Extended Thinking.
            if config.mode == "gemini"
                && status == reqwest::StatusCode::BAD_REQUEST
                && text.contains("Live API")
            {
                return Err(format!(
                    "{label} returned {status}: this model is Live-only and cannot be used for text chat. \
                     Open the voice panel to send text and receive audio from Extended Thinking, \
                     or switch to a text model in Settings."
                ));
            } else {
                return Err(format!(
                    "{label} returned {status}: {}",
                    truncate(&text, 400)
                ));
            }
        }
    }

    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("{label} returned an unreadable response: {e}"))?;

    let message = value
        .pointer("/choices/0/message")
        .ok_or_else(|| format!("{label} returned no message."))?;
    let text = extract_content(&value).unwrap_or_default();
    let calls = extract_calls(message);

    // A 200 response that carries no text and no tool call is often a provider
    // that does not honour `response_format: json_object` and answered with an
    // empty content block instead of rejecting the request. Retry once with the
    // first shape that drops the JSON constraint but keeps the tools: the point
    // of the retry is to recover a real answer, and dropping the tools would
    // recover an answer that cannot ask its question.
    if text.trim().is_empty() && calls.is_empty() {
        let retry_shapes = shapes(
            config,
            base_url,
            profile,
            system,
            messages,
            tools,
            max_tokens,
        );
        let rescue = retry_shapes
            .iter()
            .find(|body| body.get("response_format").is_none())
            .cloned()
            .unwrap_or_else(|| base_body(profile, system, messages, max_tokens));
        // Which shape that was, so the trace can say the endpoint refused JSON
        // mode rather than leaving it to be inferred from the timings.
        let rescue_variant = retry_shapes
            .iter()
            .position(|body| body.get("response_format").is_none())
            .unwrap_or(0);
        match post_keyed(label, base_url, profile, &rescue).await {
            Ok(last_rescue) if last_rescue.status().is_success() => {
                let value: Value = match last_rescue.json().await {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(format!(
                            "{label} returned an unreadable response on retry: {e}"
                        ));
                    }
                };
                let text = extract_content(&value).unwrap_or_default();
                let calls = extract_calls(&value);
                if !text.trim().is_empty() || !calls.is_empty() {
                    let message = value
                        .pointer("/choices/0/message")
                        .cloned()
                        .unwrap_or_default();
                    let echo = echo_message(&text, &calls, &message);
                    return Ok(Step {
                        text,
                        calls,
                        message: echo,
                        variant: rescue_variant,
                    });
                }
                return Err(format!("{label} returned no text."));
            }
            Ok(_) => return Err(format!("{label} returned no text.")),
            Err(e) => {
                return Err(format!(
                    "Could not reach {label} on a retry after an empty response: {e}"
                ));
            }
        }
    }

    let echo = echo_message(&text, &calls, message);

    Ok(Step {
        text,
        calls,
        message: echo,
        variant: index,
    })
}

/// Try gemini-3.8-live as a fallback when the primary Gemini model is overloaded.
///
/// Builds the same request shape with the fallback model and walks the variants
/// until one succeeds. Returns Ok(response) on success, Err if all variants fail.
async fn try_fallback(
    label: &str,
    base_url: &str,
    profile: &ProviderProfile,
    system: &str,
    messages: &[Value],
    tools: &Value,
    max_tokens: u32,
) -> Result<reqwest::Response, String> {
    let fallback_profile = ProviderProfile {
        model: "gemini-3.8-live".into(),
        base_url: base_url.to_string(),
        live_model: String::new(),
        delegate_model: String::new(),
        thinking_model: String::new(),
        ..profile.clone()
    };

    let variants = body_variants(&fallback_profile, system, messages, tools, max_tokens);
    let mut index = 0;
    let mut response = post_keyed(label, base_url, &fallback_profile, &variants[index]).await?;
    while !response.status().is_success()
        && matches!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNPROCESSABLE_ENTITY
        )
        && index + 1 < variants.len()
    {
        index += 1;
        response = post_keyed(label, base_url, &fallback_profile, &variants[index]).await?;
    }

    if response.status().is_success() {
        Ok(response)
    } else {
        Err(format!(
            "Fallback gemini-3.8-live returned {}",
            response.status()
        ))
    }
}

/// The assistant message to put back in the conversation before tool results.
fn echo_message(text: &str, calls: &[Call], message: &Value) -> Value {
    if calls.is_empty() {
        json!({ "role": "assistant", "content": text })
    } else {
        json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { Value::String(text.to_string()) },
            "tool_calls": message.get("tool_calls").cloned().unwrap_or_else(|| json!([])),
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_quota_refusals_move_to_the_next_key() {
        assert!(is_quota_exceeded(429, r#"{"error":{"status":"RESOURCE_EXHAUSTED"}}"#));
        assert!(is_quota_exceeded(429, "You exceeded your current quota"));
        assert!(!is_quota_exceeded(429, "slow down"));
        assert!(!is_quota_exceeded(400, "quota"));
        assert!(!is_quota_exceeded(500, "quota"));
    }

    use super::*;
    use crate::types::{GEMINI_DEFAULT_MODEL, NVIDIA_DEFAULT_MODEL, OPENCODE_DEFAULT_MODEL};

    #[test]
    fn resolves_preset_endpoints() {
        let mut config = ProviderConfig::default();

        config.mode = "gemini".into();
        let (base, profile) = active_profile(&config).unwrap();
        assert_eq!(base, GEMINI_BASE_URL);
        assert_eq!(profile.model, GEMINI_DEFAULT_MODEL);

        config.mode = "nvidia".into();
        let (base, profile) = active_profile(&config).unwrap();
        assert_eq!(base, NVIDIA_BASE_URL);
        assert_eq!(profile.model, NVIDIA_DEFAULT_MODEL);

        config.mode = "opencode".into();
        let (base, profile) = active_profile(&config).unwrap();
        assert_eq!(base, OPENCODE_BASE_URL);
        assert_eq!(profile.model, OPENCODE_DEFAULT_MODEL);
    }

    #[test]
    fn resolves_the_local_preset() {
        let mut config = ProviderConfig::default();
        config.mode = "local".into();

        let (base, profile) = active_profile(&config).unwrap();
        assert_eq!(base, crate::types::LOCAL_BASE_URL);
        assert_eq!(profile.model, crate::types::LOCAL_DEFAULT_MODEL);
        assert!(profile.api_key.is_empty(), "a local server has no key");
        assert!(is_local(profile), "so it gets thinking off and question cards");
    }

    #[test]
    fn uses_the_configured_openai_base_url() {
        let mut config = ProviderConfig::default();
        config.mode = "openai".into();
        config.openai.base_url = "https://example.com/v1/".into();

        let (base, _) = active_profile(&config).unwrap();
        assert_eq!(base, "https://example.com/v1/");
    }

    #[test]
    fn rejects_unknown_providers() {
        let mut config = ProviderConfig::default();
        config.mode = "unknown".into();
        assert!(active_profile(&config).is_err());
    }

    #[test]
    fn reads_content_when_it_is_a_json_object() {
        // Some endpoints return the model's JSON output as a parsed object rather than
        // a string. That object is the reply itself.
        let value = json!({
            "choices": [{
                "message": {
                    "content": {
                        "reply": "Short reply.",
                        "proposal": null
                    }
                }
            }]
        });
        let text = extract_content(&value).unwrap();
        assert!(text.contains("reply"));
        assert!(text.contains("Short reply."));
    }

    #[test]
    fn returns_none_for_null_content() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": null
                }
            }]
        });
        assert!(extract_content(&value).is_none());
    }

    #[test]
    fn returns_none_for_missing_content() {
        let value = json!({
            "choices": [{
                "message": {}
            }]
        });
        assert!(extract_content(&value).is_none());
    }

    fn openai_at(base_url: &str, model: &str) -> ProviderConfig {
        let mut config = ProviderConfig::default();
        config.mode = "openai".into();
        config.openai.base_url = base_url.into();
        config.openai.model = model.into();
        config
    }

    fn question_tool() -> Value {
        json!([{ "type": "function", "function": { "name": "ask_questions" } }])
    }

    #[test]
    fn a_provider_that_cannot_combine_json_and_tools_stops_being_asked() {
        // llama.cpp's grammar runtime cannot join the reply grammar to the
        // tool-call grammar, so "json + tools" is a guaranteed 400 there. One
        // refusal should be enough for the process, not one per step.
        let config = openai_at("http://127.0.0.1:9/v1", "spike-model");
        let (base, profile) = active_profile(&config).unwrap();
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let tools = question_tool();

        let before = shapes(&config, base, profile, "system", &messages, &tools, 100);
        // Prose plus tools is tried first; the combination is the second shape.
        assert!(before[0].get("response_format").is_none() && before[0]["tools"].is_array());
        assert!(before[1]["response_format"].is_object() && before[1]["tools"].is_array());

        note_refusal(&config.mode, base, &profile.model, &before[1]);

        let after = shapes(&config, base, profile, "system", &messages, &tools, 100);
        assert_eq!(after.len(), before.len() - 1);
        assert!(
            after
                .iter()
                .all(|body| !(body.get("response_format").is_some() && body.get("tools").is_some())),
            "the refused combination is not tried again"
        );
        assert!(after[0]["tools"].is_array(), "the tools are not what was dropped");
    }

    #[test]
    fn a_refusal_of_a_different_shape_is_not_remembered() {
        let config = openai_at("http://127.0.0.1:9/other", "another-model");
        let (base, profile) = active_profile(&config).unwrap();
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let tools = question_tool();

        // A plain request with no JSON mode carries no advice about the
        // combination.
        note_refusal(
            &config.mode,
            base,
            &profile.model,
            &json!({ "tools": [], "max_tokens": 10 }),
        );

        let shapes = shapes(&config, base, profile, "system", &messages, &tools, 100);
        assert!(
            shapes
                .iter()
                .any(|body| body.get("response_format").is_some() && body.get("tools").is_some()),
            "the combination is still offered"
        );
    }

    #[test]
    fn request_variants_never_repeat_a_body() {
        // With tools always offered, the old fallback list sent the identical
        // body twice, paying for a request that could not have a different
        // outcome.
        let mut config = ProviderConfig::default();
        config.mode = "nvidia".into();
        let (_, profile) = active_profile(&config).unwrap();
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let tools = json!([{ "type": "function", "function": { "name": "ask_questions" } }]);

        let variants = body_variants(profile, "system", &messages, &tools, 500);
        for (index, variant) in variants.iter().enumerate() {
            for (other_index, other) in variants.iter().enumerate() {
                if index != other_index {
                    assert_ne!(variant, other, "variant {index} repeats {other_index}");
                }
            }
        }

        // A turn is prose plus tools, so no forced JSON mode on the first shape.
        // The combination stays available for a workflow turn or an endpoint that
        // needs it, but second.
        assert!(variants[0]["tools"].is_array());
        assert!(variants[0].get("response_format").is_none());
        assert_eq!(variants[0]["max_tokens"], json!(500));
        assert!(variants[1]["response_format"].is_object());
        assert!(variants[1]["tools"].is_array());
        assert_eq!(variants.len(), 4);
    }

    #[test]
    fn a_plain_request_has_nothing_to_drop() {
        let mut config = ProviderConfig::default();
        config.mode = "nvidia".into();
        let (_, profile) = active_profile(&config).unwrap();
        let messages = vec![json!({ "role": "user", "content": "hi" })];

        let variants = body_variants(profile, "system", &messages, &json!([]), 500);
        assert_eq!(variants.len(), 2, "only the JSON and plain shapes remain");
        assert!(variants[0]["response_format"].is_object());
        assert!(variants[1].get("response_format").is_none());
    }
}
