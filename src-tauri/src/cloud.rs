//! The cloud model (Gemini flash-lite) that draws and writes workflows.
//!
//! Every request waits for its place under a per-minute, per-token and per-day cap, counted on this device and
//! kept across restarts, so a big batch queues instead of failing.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::types::ProviderConfig;
use crate::{provider, settings, store};

const DAY_MS: i64 = 86_400_000;
const MINUTE_MS: i64 = 60_000;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Usage {
    /// Whole days since the epoch (UTC) that `count` belongs to.
    day: i64,
    count: u32,
    recent: VecDeque<i64>,
    /// Input tokens sent in the last minute, with when each request went.
    tokens: VecDeque<(i64, u64)>,
    /// Gemini said "too many requests": nothing goes before this time, whatever the local count says.
    held_until: i64,
}

/// What `Usage::place` decided for one request.
#[derive(Debug, PartialEq)]
pub enum Place {
    Granted,
    /// Not yet: the milliseconds until a minute-window has room.
    Wait(i64),
    /// Today's requests are used up. Waiting will not help.
    DayFull,
}

impl Usage {
    /// Like `permit`, and also keeps the last minute's input tokens under `token_cap`. A full
    /// minute-window answers with how long to wait rather than a refusal, so a batch of requests
    /// can be sent together and spread themselves out. A request bigger than the whole cap is
    /// treated as exactly the cap, so it goes alone instead of never.
    pub fn place(&mut self, now_ms: i64, daily_cap: u32, per_minute: u32, tokens: u64, token_cap: u64) -> Place {
        let day = now_ms.div_euclid(DAY_MS);
        if day != self.day {
            self.day = day;
            self.count = 0;
        }
        while self.recent.front().is_some_and(|at| now_ms - at >= MINUTE_MS) {
            self.recent.pop_front();
        }
        while self.tokens.front().is_some_and(|(at, _)| now_ms - at >= MINUTE_MS) {
            self.tokens.pop_front();
        }
        if self.count >= daily_cap {
            return Place::DayFull;
        }
        let mut wait = (self.held_until - now_ms).max(0);
        let limit = (per_minute as usize).max(1);
        if self.recent.len() >= limit {
            // The request that has to age out before there is room for one more.
            wait = wait.max(self.recent[self.recent.len() - limit] + MINUTE_MS - now_ms);
        }
        let tokens = tokens.min(token_cap);
        let used: u64 = self.tokens.iter().map(|(_, n)| n).sum();
        if used + tokens > token_cap {
            let need = used + tokens - token_cap;
            let mut freed = 0;
            for &(at, n) in &self.tokens {
                freed += n;
                if freed >= need {
                    wait = wait.max(at + MINUTE_MS - now_ms);
                    break;
                }
            }
        }
        if wait > 0 {
            return Place::Wait(wait);
        }
        self.count += 1;
        self.recent.push_back(now_ms);
        self.tokens.push_back((now_ms, tokens));
        Place::Granted
    }

    /// Gemini refused a request for its per-minute limit: hold every request until `until_ms`. The refused
    /// request is not counted against today, since Gemini did not serve it.
    pub fn hold(&mut self, until_ms: i64) {
        self.held_until = self.held_until.max(until_ms);
        self.count = self.count.saturating_sub(1);
    }
}

static USAGE: Mutex<Option<Usage>> = Mutex::new(None);

fn usage_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("cloud-usage.json"))
}

/// Run `f` on this device's usage, loading the day's count from disk the first time, and save the
/// day's count afterwards when `f` says it spent a request. The one lock is shared by every
/// cloud request, so they draw from the same daily allowance.
fn with_usage<T>(app: &AppHandle, f: impl FnOnce(&mut Usage) -> (T, bool)) -> T {
    let mut guard = USAGE.lock().unwrap_or_else(|e| e.into_inner());
    let usage = guard.get_or_insert_with(|| {
        let saved = usage_path(app)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        Usage {
            day: saved.as_ref().and_then(|v| v["day"].as_i64()).unwrap_or(0),
            count: saved.as_ref().and_then(|v| v["count"].as_u64()).unwrap_or(0) as u32,
            recent: VecDeque::new(),
            tokens: VecDeque::new(),
            held_until: 0,
        }
    });
    let (out, spent) = f(usage);
    if spent {
        if let Some(path) = usage_path(app) {
            let _ = std::fs::write(path, json!({ "day": usage.day, "count": usage.count }).to_string());
        }
    }
    out
}

/// The Gemini config for a background request, before any place under the caps is taken.
fn ready_config(app: &AppHandle) -> Result<ProviderConfig, String> {
    let limits = settings::get();
    if !limits.cloud_agent_enabled {
        return Err("The cloud agent is off.".into());
    }
    let mut config = store::read_config(app)?;
    if config.gemini.all_keys().is_empty() {
        return Err("No Gemini key for the cloud agent.".into());
    }
    config.mode = "gemini".into();
    config.gemini.model = limits.cloud_agent_model.clone();
    Ok(config)
}

/// The longest one request waits for room in the minute before giving up. A big batch queues many
/// requests at once (15 a minute on the free tier), so this is long: waiting always works, only the day's cap is final.
const MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// Like `agent_config`, but waits out a full minute-window instead of refusing: the request
/// counts `tokens` of input against the tokens-per-minute cap as well as the requests-per-minute
/// one. Only the day's cap is final.
pub async fn paced_config(app: &AppHandle, tokens: u64) -> Result<ProviderConfig, String> {
    let config = ready_config(app)?;
    let started = std::time::Instant::now();
    loop {
        let limits = settings::get();
        let token_cap = u64::from(limits.cloud_agent_tokens_per_minute);
        let verdict = with_usage(app, |usage| {
            let verdict = usage.place(
                crate::types::now_ms(),
                limits.cloud_agent_daily_cap,
                limits.cloud_agent_per_minute,
                tokens,
                token_cap,
            );
            let spent = verdict == Place::Granted;
            (verdict, spent)
        });
        match verdict {
            Place::Granted => return Ok(config),
            Place::DayFull => return Err("The cloud agent has used its requests for today.".into()),
            Place::Wait(ms) => {
                if started.elapsed() > MAX_WAIT {
                    return Err("The cloud agent is busy; try again in a minute.".into());
                }
                // Long waits are shown, so a queued request does not look stuck.
                if ms > 3_000 {
                    let _ = app.emit("cloud-wait", json!({ "seconds": (ms + 999) / 1000 }));
                }
                tokio::time::sleep(std::time::Duration::from_millis(ms as u64 + 50)).await;
            }
        }
    }
}

/// The most one completion may write. Flash-lite class models allow more; this keeps one reply
/// inside the request timeout.
const MAX_COMPLETION_TOKENS: u32 = 32_000;

/// How many times one request waits out a "too many requests" from Gemini before giving up.
const MAX_RATE_RETRIES: u32 = 4;

/// Gemini is busy ("503 ... high demand"). A request is tried again this many times, this far apart, before the error is shown.
pub const BUSY_RETRIES: u32 = 5;
pub const BUSY_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether an error is Gemini being busy, as opposed to something a retry cannot fix.
pub fn overloaded(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    error.contains("503") || lower.contains("unavailable") || lower.contains("overloaded") || lower.contains("high demand")
}

/// Whether an error is Gemini's daily allowance running out, which waiting a minute does not fix.
fn is_day_limit(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    (error.contains("429") || lower.contains("resource_exhausted")) && (lower.contains("perday") || lower.contains("per day"))
}

/// For a per-minute "too many requests", how long to wait: Gemini's own `retryDelay` when the error
/// still carries it, otherwise a full minute. `None` for any other error, and for the daily limit.
fn rate_limited(error: &str) -> Option<i64> {
    let lower = error.to_ascii_lowercase();
    let limited = error.contains("429") || lower.contains("resource_exhausted") || lower.contains("rate limit");
    if !limited || is_day_limit(error) {
        return None;
    }
    let delay = lower
        .find("retrydelay")
        .and_then(|at| {
            let rest = &lower[at..];
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            digits.parse::<i64>().ok()
        })
        .map(|seconds| seconds.clamp(1, 120) * 1000 + 1000);
    Some(delay.unwrap_or(MINUTE_MS + 1000))
}

/// A rough count of tokens in text, on the high side: JSON and code run near three characters each.
fn estimate_tokens(text: &str) -> u64 {
    text.len() as u64 / 3 + 1
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub text: String,
    pub model: String,
    pub input_tokens: u64,
}

/// One paced request to the cloud model, for the workflow writer. The caller sends as many as it
/// likes at once; each waits for its place under the per-minute, per-token and per-day caps.
#[tauri::command]
pub async fn cloud_complete(
    app: AppHandle,
    system: String,
    prompt: String,
    max_tokens: u32,
) -> Result<Completion, String> {
    let input_tokens = estimate_tokens(&system) + estimate_tokens(&prompt);
    let messages = vec![json!({ "role": "user", "content": prompt })];
    let mut tries = 0;
    let mut busy_tries = 0;
    let step = loop {
        let config = paced_config(&app, input_tokens).await?;
        let result = provider::step(
            &config,
            &system,
            &messages,
            &json!([]),
            max_tokens.clamp(256, MAX_COMPLETION_TOKENS),
        )
        .await;
        match result {
            Ok(step) => break step,
            Err(error) => match rate_limited(&error) {
                // Gemini's own count can run ahead of ours (another app on the key, a restart).
                // Waiting the minute out fixes it, so wait, for every queued request, and try again.
                Some(wait_ms) if tries < MAX_RATE_RETRIES => {
                    tries += 1;
                    let until = crate::types::now_ms() + wait_ms;
                    with_usage(&app, |usage| {
                        usage.hold(until);
                        ((), true)
                    });
                    let _ = app.emit("cloud-wait", json!({ "seconds": (wait_ms + 999) / 1000 }));
                }
                _ if is_day_limit(&error) => {
                    return Err("Gemini's daily limit for the cloud model is used up; it resets tomorrow.".into())
                }
                _ if overloaded(&error) && busy_tries < BUSY_RETRIES => {
                    busy_tries += 1;
                    let _ = app.emit("canvas-retry", json!({ "attempt": busy_tries, "of": BUSY_RETRIES }));
                    tokio::time::sleep(BUSY_RETRY_AFTER).await;
                }
                _ => return Err(error),
            },
        }
    };
    if step.text.trim().is_empty() {
        return Err("The cloud model sent back nothing.".into());
    }
    let model = settings::get().cloud_agent_model;
    let _ = app.emit("cloud-used", json!({ "model": model }));
    Ok(Completion { text: step.text, model, input_tokens })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_minute_of_requests_says_when_the_oldest_ages_out() {
        let mut usage = Usage::default();
        assert_eq!(usage.place(0, 100, 2, 10, 1_000), Place::Granted);
        assert_eq!(usage.place(5_000, 100, 2, 10, 1_000), Place::Granted);
        assert_eq!(usage.place(10_000, 100, 2, 10, 1_000), Place::Wait(50_000));
        assert_eq!(usage.place(60_000, 100, 2, 10, 1_000), Place::Granted);
    }

    #[test]
    fn tokens_wait_for_exactly_enough_to_age_out() {
        let mut usage = Usage::default();
        assert_eq!(usage.place(0, 100, 15, 600, 1_000), Place::Granted);
        assert_eq!(usage.place(20_000, 100, 15, 300, 1_000), Place::Granted);
        // 900 used; 400 more needs 300 freed, and the first request's 600 covers it.
        assert_eq!(usage.place(30_000, 100, 15, 400, 1_000), Place::Wait(30_000));
    }

    #[test]
    fn a_request_bigger_than_the_cap_goes_alone() {
        let mut usage = Usage::default();
        assert_eq!(usage.place(0, 100, 15, 5_000, 1_000), Place::Granted);
        assert_eq!(usage.place(1_000, 100, 15, 1, 1_000), Place::Wait(59_000));
    }

    #[test]
    fn a_hold_from_gemini_makes_everyone_wait() {
        let mut usage = Usage::default();
        assert_eq!(usage.place(0, 100, 15, 1, 1_000), Place::Granted);
        usage.hold(30_000);
        assert_eq!(usage.place(1_000, 100, 15, 1, 1_000), Place::Wait(29_000));
        assert_eq!(usage.place(30_000, 100, 15, 1, 1_000), Place::Granted);
    }

    #[test]
    fn a_minute_limit_waits_and_a_day_limit_does_not() {
        assert_eq!(rate_limited(r#"Gemini returned 429: {"retryDelay": "34s"}"#), Some(35_000));
        assert_eq!(rate_limited("Gemini returned 429 Too Many Requests"), Some(61_000));
        assert_eq!(rate_limited(r#"429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel"#), None);
        assert!(is_day_limit(r#"429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel"#));
        assert_eq!(rate_limited("Gemini returned 400: bad request"), None);
    }

    #[test]
    fn the_day_running_out_is_final_not_a_wait() {
        let mut usage = Usage::default();
        assert_eq!(usage.place(0, 1, 15, 1, 1_000), Place::Granted);
        assert_eq!(usage.place(70_000, 1, 15, 1, 1_000), Place::DayFull);
    }
}
