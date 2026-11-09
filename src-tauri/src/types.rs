use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
pub const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// Where `llama-server` listens by default. The port is editable because it is
/// the one thing about a local server that people routinely change.
pub const LOCAL_BASE_URL: &str = "http://127.0.0.1:8080/v1";
/// `llama-server` serves one model and ignores the name, so this is a label.
pub const LOCAL_DEFAULT_MODEL: &str = "local";
pub const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/openai";
pub const NVIDIA_BASE_URL: &str = "https://integrate.api.nvidia.com/v1";
pub const OPENCODE_BASE_URL: &str = "https://opencode.ai/inference/openai/v1";

pub const OPENAI_DEFAULT_MODEL: &str = "gpt-4.1-mini";
pub const GEMINI_DEFAULT_MODEL: &str = "gemini-3.8-live";
pub const NVIDIA_DEFAULT_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";
pub const OPENCODE_DEFAULT_MODEL: &str = "kimi-k2.6";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    #[serde(default)]
    pub api_key: String,
    /// Keys to fall back to, in order, when `api_key` runs out of quota.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_keys: Vec<String>,
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base_url: String,
    // Gemini-specific live/delegation models
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub live_model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub delegate_model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thinking_model: String,
}

impl ProviderProfile {
    /// Every key that is set, primary first.
    pub fn all_keys(&self) -> Vec<String> {
        std::iter::once(&self.api_key)
            .chain(self.extra_keys.iter())
            .map(|key| key.trim())
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// Replace the key list; the first becomes the primary.
    pub fn set_keys(&mut self, keys: Vec<String>) {
        let mut keys = keys.into_iter();
        self.api_key = keys.next().unwrap_or_default();
        self.extra_keys = keys.collect();
    }
}

/// What a saved key looks like in the interface: enough to tell keys apart, never enough
/// to use one.
pub fn key_hint(key: &str) -> String {
    let key = key.trim();
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    if key.chars().count() <= 8 { "…".into() } else { format!("…{tail}") }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProviderProfile {
    pub key_set: bool,
    /// One hint per saved key, in the order they are tried.
    pub key_hints: Vec<String>,
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub live_model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub delegate_model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thinking_model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProviderConfig {
    pub mode: String,
    pub effort: String,
    pub settings: crate::settings::Settings,
    pub local: PublicProviderProfile,
    pub openai: PublicProviderProfile,
    pub gemini: PublicProviderProfile,
    pub nvidia: PublicProviderProfile,
    pub opencode: PublicProviderProfile,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileUpdate {
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_key: bool,
    /// Positions in the saved key list to delete, applied before `add_keys`.
    #[serde(default)]
    pub remove_keys: Vec<usize>,
    #[serde(default)]
    pub add_keys: Vec<String>,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    // Gemini-specific live/delegation models
    #[serde(default)]
    pub live_model: Option<String>,
    #[serde(default)]
    pub delegate_model: Option<String>,
    #[serde(default)]
    pub thinking_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigUpdate {
    pub mode: String,
    pub local: ProviderProfileUpdate,
    pub openai: ProviderProfileUpdate,
    pub gemini: ProviderProfileUpdate,
    pub nvidia: ProviderProfileUpdate,
    pub opencode: ProviderProfileUpdate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default = "default_mode")]
    pub mode: String,
    /// How hard the model thinks: auto, low, medium or high.
    #[serde(default = "default_effort")]
    pub effort: String,
    /// Behaviour the backend reads while it works; see `settings`.
    #[serde(default)]
    pub settings: crate::settings::Settings,
    #[serde(default = "default_local")]
    pub local: ProviderProfile,
    #[serde(default = "default_openai")]
    pub openai: ProviderProfile,
    #[serde(default = "default_gemini")]
    pub gemini: ProviderProfile,
    #[serde(default = "default_nvidia")]
    pub nvidia: ProviderProfile,
    #[serde(default = "default_opencode")]
    pub opencode: ProviderProfile,
}

fn default_effort() -> String {
    "auto".into()
}

fn default_mode() -> String {
    "demo".into()
}

/// The local preset carries no key at all, and never will: it talks to a process
/// on this machine.
fn default_local() -> ProviderProfile {
    ProviderProfile {
        api_key: String::new(),
        extra_keys: Vec::new(),
        model: LOCAL_DEFAULT_MODEL.into(),
        base_url: LOCAL_BASE_URL.into(),
        live_model: String::new(),
        delegate_model: String::new(),
        thinking_model: String::new(),
    }
}

fn default_openai() -> ProviderProfile {
    ProviderProfile {
        api_key: String::new(),
        extra_keys: Vec::new(),
        model: OPENAI_DEFAULT_MODEL.into(),
        base_url: OPENAI_DEFAULT_BASE_URL.into(),
        live_model: String::new(),
        delegate_model: String::new(),
        thinking_model: String::new(),
    }
}

fn default_gemini() -> ProviderProfile {
    ProviderProfile {
        api_key: String::new(),
        extra_keys: Vec::new(),
        model: GEMINI_DEFAULT_MODEL.into(),
        base_url: String::new(),
        live_model: "gemini-3.8-live".into(),
        delegate_model: "gemini-3.5-flash-lite".into(),
        thinking_model: "gemini-3.8-live-extended-thinking".into(),
    }
}

fn default_nvidia() -> ProviderProfile {
    ProviderProfile {
        api_key: String::new(),
        extra_keys: Vec::new(),
        model: NVIDIA_DEFAULT_MODEL.into(),
        base_url: String::new(),
        live_model: String::new(),
        delegate_model: String::new(),
        thinking_model: String::new(),
    }
}

fn default_opencode() -> ProviderProfile {
    ProviderProfile {
        api_key: String::new(),
        extra_keys: Vec::new(),
        model: OPENCODE_DEFAULT_MODEL.into(),
        base_url: String::new(),
        live_model: String::new(),
        delegate_model: String::new(),
        thinking_model: String::new(),
    }
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            effort: default_effort(),
            settings: crate::settings::Settings::default(),
            local: default_local(),
            openai: default_openai(),
            gemini: default_gemini(),
            nvidia: default_nvidia(),
            opencode: default_opencode(),
        }
    }
}

fn public_profile(profile: &ProviderProfile) -> PublicProviderProfile {
    PublicProviderProfile {
        key_set: !profile.all_keys().is_empty(),
        key_hints: profile.all_keys().iter().map(|key| key_hint(key)).collect(),
        model: profile.model.clone(),
        base_url: profile.base_url.clone(),
        live_model: profile.live_model.clone(),
        delegate_model: profile.delegate_model.clone(),
        thinking_model: profile.thinking_model.clone(),
    }
}

impl ProviderConfig {
    pub fn public(&self) -> PublicProviderConfig {
        PublicProviderConfig {
            mode: self.mode.clone(),
            effort: self.effort.clone(),
            settings: self.settings.clone(),
            local: public_profile(&self.local),
            openai: public_profile(&self.openai),
            gemini: public_profile(&self.gemini),
            nvidia: public_profile(&self.nvidia),
            opencode: public_profile(&self.opencode),
        }
    }
}

