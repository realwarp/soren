//! Behaviour settings the backend reads while it works.
//!
//! These live in `config.json` next to the provider profiles and are changed one
//! patch at a time from Settings. Every field has a default, so an older config
//! file, or none, behaves as it always did; keys from settings that no longer exist
//! are ignored when the file is read. A copy sits in a process-wide cell so deep
//! code (the provider client, the cloud pacer) can read a value without a config
//! being threaded through every call.

use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // Model routing
    /// Sampling temperature in hundredths.
    pub temperature_pct: u32,
    pub request_timeout_secs: u32,

    // Cloud model: draws and writes workflows.
    pub cloud_agent_enabled: bool,
    pub cloud_agent_model: String,
    /// Most cloud requests in a day; kept below the provider's own limit.
    pub cloud_agent_daily_cap: u32,
    /// Most in a minute.
    pub cloud_agent_per_minute: u32,
    /// Most input tokens in a minute, across every cloud request; kept below the provider's own limit.
    pub cloud_agent_tokens_per_minute: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            temperature_pct: 35,
            request_timeout_secs: 120,
            cloud_agent_enabled: true,
            cloud_agent_model: "gemini-3.5-flash-lite".into(),
            cloud_agent_daily_cap: 400,
            cloud_agent_per_minute: 12,
            cloud_agent_tokens_per_minute: 200_000,
        }
    }
}

impl Settings {
    /// Pull every value into the range the code behind it can honour.
    pub fn clamped(mut self) -> Self {
        let defaults = Settings::default();
        self.temperature_pct = self.temperature_pct.clamp(0, 100);
        self.request_timeout_secs = self.request_timeout_secs.clamp(20, 600);
        self.cloud_agent_daily_cap = self.cloud_agent_daily_cap.min(5_000);
        self.cloud_agent_per_minute = self.cloud_agent_per_minute.clamp(1, 60);
        self.cloud_agent_tokens_per_minute = self.cloud_agent_tokens_per_minute.clamp(10_000, 4_000_000);
        if self.cloud_agent_model.trim().is_empty() {
            self.cloud_agent_model = defaults.cloud_agent_model.clone();
        }
        self
    }

    pub fn temperature(&self) -> f64 {
        f64::from(self.temperature_pct) / 100.0
    }
}

static CURRENT: RwLock<Option<Settings>> = RwLock::new(None);

/// The settings now in force.
pub fn get() -> Settings {
    CURRENT
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_default()
}

/// Make `settings` the ones the rest of the backend reads.
pub fn publish(settings: &Settings) {
    *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
}

/// Lay `patch` over `current`, rejecting a key that is not a setting or a value of the wrong type.
pub fn apply_patch(current: &Settings, patch: &Map<String, Value>) -> Result<Settings, String> {
    let mut merged = match serde_json::to_value(current) {
        Ok(Value::Object(map)) => map,
        _ => return Err("Could not read the current settings.".into()),
    };
    for (key, value) in patch {
        if !merged.contains_key(key) {
            return Err(format!("{key} is not a setting."));
        }
        merged.insert(key.clone(), value.clone());
    }
    serde_json::from_value::<Settings>(Value::Object(merged))
        .map(Settings::clamped)
        .map_err(|e| format!("A setting has the wrong kind of value: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn defaults_survive_their_own_clamp() {
        assert_eq!(Settings::default().clamped(), Settings::default());
    }

    #[test]
    fn an_old_config_without_settings_reads_as_defaults() {
        let parsed: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed, Settings::default());
    }

    #[test]
    fn keys_from_removed_settings_are_ignored_when_the_file_is_read() {
        let parsed: Settings = serde_json::from_value(json!({ "cardModel": "LFM3-1.7B", "maxSteps": 6, "temperaturePct": 50 })).unwrap();
        assert_eq!(parsed.temperature_pct, 50);
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let next = apply_patch(&Settings::default(), &patch(json!({ "cloudAgentPerMinute": 6 }))).unwrap();
        assert_eq!(next.cloud_agent_per_minute, 6);
        assert_eq!(next.temperature_pct, Settings::default().temperature_pct);
    }

    #[test]
    fn out_of_range_values_are_pulled_in() {
        let next = apply_patch(&Settings::default(), &patch(json!({ "cloudAgentPerMinute": 99, "temperaturePct": 400 }))).unwrap();
        assert_eq!(next.cloud_agent_per_minute, 60);
        assert_eq!(next.temperature_pct, 100);
    }

    #[test]
    fn unknown_keys_and_wrong_types_are_refused() {
        assert!(apply_patch(&Settings::default(), &patch(json!({ "nope": 1 }))).is_err());
        assert!(apply_patch(&Settings::default(), &patch(json!({ "temperaturePct": "hot" }))).is_err());
    }
}
