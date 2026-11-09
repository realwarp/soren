use crate::types::{
    ProviderConfig, ProviderConfigUpdate, ProviderProfile, ProviderProfileUpdate, PublicProviderConfig,
};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate app data directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create app data directory: {e}"))?;
    Ok(dir)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not locate app config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create app config directory: {e}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("config.json"))
}

fn normalize_config(mut config: ProviderConfig) -> ProviderConfig {
    if !matches!(
        config.mode.as_str(),
        "demo" | "local" | "openai" | "gemini" | "nvidia" | "opencode"
    ) {
        config.mode = "demo".into();
    }
    if config.openai.base_url.trim().is_empty() {
        config.openai.base_url = crate::types::OPENAI_DEFAULT_BASE_URL.into();
    }
    if config.local.base_url.trim().is_empty() {
        config.local.base_url = crate::types::LOCAL_BASE_URL.into();
    }
    if config.local.model.trim().is_empty() {
        config.local.model = crate::types::LOCAL_DEFAULT_MODEL.into();
    }
    // A local server has no key to store. Clearing it here means a config written
    // by hand, or by an older build, cannot start sending one.
    config.local.api_key.clear();
    config
}

/// Whether an endpoint on this machine needs a key. It does not: `llama-server`
/// has no authentication, and neither do most local runners.
fn loopback(base_url: &str) -> bool {
    let url = base_url.to_ascii_lowercase();
    url.contains("127.0.0.1") || url.contains("localhost") || url.contains("[::1]")
}

fn migrate_legacy_config(value: serde_json::Value) -> ProviderConfig {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyConfig {
        #[serde(default)]
        mode: String,
        #[serde(default)]
        base_url: String,
        #[serde(default)]
        model: String,
        #[serde(default)]
        api_key: String,
    }

    let Ok(legacy) = serde_json::from_value::<LegacyConfig>(value) else {
        return ProviderConfig::default();
    };
    let mut config = ProviderConfig::default();
    if legacy.mode == "demo" || legacy.mode == "openai" {
        config.mode = legacy.mode;
    }
    if !legacy.base_url.trim().is_empty() {
        config.openai.base_url = legacy.base_url.trim().to_string();
    }
    if !legacy.model.trim().is_empty() {
        config.openai.model = legacy.model.trim().to_string();
    }
    config.openai.api_key = legacy.api_key;
    normalize_config(config)
}

fn parse_config(raw: &str) -> ProviderConfig {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return ProviderConfig::default();
    };
    if value.get("openai").is_some() {
        return serde_json::from_value::<ProviderConfig>(value)
            .map(normalize_config)
            .unwrap_or_default();
    }
    migrate_legacy_config(value)
}

pub fn read_config(app: &AppHandle) -> Result<ProviderConfig, String> {
    let path = config_path(app)?;
    let config = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("Could not read settings: {e}"))?;
        parse_config(&raw)
    } else {
        ProviderConfig::default()
    };
    // Whatever was just read is what the rest of the backend should act on.
    crate::settings::publish(&config.settings);
    Ok(config)
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> Result<PublicProviderConfig, String> {
    Ok(read_config(&app)?.public())
}

fn apply_profile(
    target: &mut ProviderProfile,
    update: ProviderProfileUpdate,
    allow_base_url: bool,
) {
    if update.clear_key {
        target.set_keys(Vec::new());
    } else if let Some(api_key) = update.api_key {
        let api_key = api_key.trim();
        if !api_key.is_empty() {
            target.api_key = api_key.to_string();
        }
    }
    if !update.remove_keys.is_empty() || !update.add_keys.is_empty() {
        let mut keys = target.all_keys();
        let mut positions = update.remove_keys.clone();
        positions.sort_unstable_by(|a, b| b.cmp(a));
        positions.dedup();
        for position in positions {
            if position < keys.len() {
                keys.remove(position);
            }
        }
        for added in update.add_keys {
            let added = added.trim();
            if !added.is_empty() && !keys.iter().any(|key| key == added) {
                keys.push(added.to_string());
            }
        }
        target.set_keys(keys);
    }

    let model = update.model.trim();
    if !model.is_empty() {
        target.model = model.to_string();
    }

    if allow_base_url && let Some(base_url) = update.base_url {
        let base_url = base_url.trim();
        target.base_url = if base_url.is_empty() {
            crate::types::OPENAI_DEFAULT_BASE_URL.into()
        } else {
            base_url.to_string()
        };
    }

    // Gemini-specific live/delegation models
    if let Some(live_model) = update.live_model {
        let live_model = live_model.trim();
        if !live_model.is_empty() {
            target.live_model = live_model.to_string();
        }
    }
    if let Some(delegate_model) = update.delegate_model {
        let delegate_model = delegate_model.trim();
        if !delegate_model.is_empty() {
            target.delegate_model = delegate_model.to_string();
        }
    }
    if let Some(thinking_model) = update.thinking_model {
        let thinking_model = thinking_model.trim();
        if !thinking_model.is_empty() {
            target.thinking_model = thinking_model.to_string();
        }
    }
}

fn apply_config_update(
    mut config: ProviderConfig,
    update: ProviderConfigUpdate,
) -> Result<ProviderConfig, String> {
    if !matches!(
        update.mode.as_str(),
        "demo" | "local" | "openai" | "gemini" | "nvidia" | "opencode"
    ) {
        return Err("Choose a model source from the available providers.".into());
    }

    config.mode = update.mode;
    apply_profile(&mut config.local, update.local, true);
    apply_profile(&mut config.openai, update.openai, true);
    apply_profile(&mut config.gemini, update.gemini, false);
    apply_profile(&mut config.nvidia, update.nvidia, false);
    apply_profile(&mut config.opencode, update.opencode, false);
    let config = normalize_config(config);

    let active = match config.mode.as_str() {
        "local" => Some(&config.local),
        "openai" => Some(&config.openai),
        "gemini" => Some(&config.gemini),
        "nvidia" => Some(&config.nvidia),
        "opencode" => Some(&config.opencode),
        _ => None,
    };
    if let Some(active) = active {
        if active.model.trim().is_empty() {
            return Err("Enter a model for the selected provider.".into());
        }
        // A server on this machine has no key to give. The rule is about the
        // endpoint, not the preset, so pointing the OpenAI-compatible provider at
        // localhost is keyless too.
        if active.api_key.trim().is_empty() && !loopback(&active.base_url) {
            return Err("Enter an API key for the selected provider.".into());
        }
    }
    if config.mode == "openai" && config.openai.base_url.trim().is_empty() {
        return Err("Enter a base URL for the OpenAI-compatible endpoint.".into());
    }
    if config.mode == "local" && config.local.base_url.trim().is_empty() {
        return Err("Enter the address of the local model server.".into());
    }

    Ok(config)
}

fn write_private_file(path: &Path, contents: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("Could not write settings: {e}"))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("Could not write settings: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Could not finish writing settings: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents).map_err(|e| format!("Could not write settings: {e}"))?;
    }
    Ok(())
}

fn write_config(app: &AppHandle, config: &ProviderConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Could not encode settings: {e}"))?;
    write_private_file(&temporary, &raw)?;
    fs::rename(&temporary, &path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("Could not finish writing settings: {e}")
    })?;
    crate::settings::publish(&config.settings);
    Ok(())
}

#[tauri::command]
pub fn save_config(
    app: AppHandle,
    update: ProviderConfigUpdate,
) -> Result<PublicProviderConfig, String> {
    let next = apply_config_update(read_config(&app)?, update)?;
    write_config(&app, &next)?;
    Ok(next.public())
}

/// Change some behaviour settings. `patch` names only the keys that change.
#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<PublicProviderConfig, String> {
    let mut config = read_config(&app)?;
    config.settings = crate::settings::apply_patch(&config.settings, &patch)?;
    write_config(&app, &config)?;
    Ok(config.public())
}

/// Put every behaviour setting back to its default. Providers and keys are untouched.
#[tauri::command]
pub fn reset_settings(app: AppHandle) -> Result<PublicProviderConfig, String> {
    let mut config = read_config(&app)?;
    config.settings = crate::settings::Settings::default();
    write_config(&app, &config)?;
    Ok(config.public())
}

/// Show the folder that holds the settings and data. Returns its path.
#[tauri::command]
pub fn open_data_folder(app: AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Could not open the folder: {e}"))?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn set_effort(app: AppHandle, effort: String) -> Result<PublicProviderConfig, String> {
    if !matches!(effort.as_str(), "auto" | "low" | "medium" | "high") {
        return Err("Effort is auto, low, medium or high.".into());
    }
    let mut config = read_config(&app)?;
    config.effort = effort;
    write_config(&app, &config)?;
    Ok(config.public())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("soren-test-{}.sqlite3", uuid::Uuid::new_v4()))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
    }

    #[test]
    fn migrates_the_old_flat_openai_config() {
        let config = parse_config(
            r#"{"mode":"openai","baseUrl":"https://example.com/v1","model":"custom-model","apiKey":"secret"}"#,
        );

        assert_eq!(config.mode, "openai");
        assert_eq!(config.openai.base_url, "https://example.com/v1");
        assert_eq!(config.openai.model, "custom-model");
        assert_eq!(config.openai.api_key, "secret");
    }

    #[test]
    fn keeps_each_provider_profile() {
        let config = parse_config(
            r#"{
                "mode":"gemini",
                "openai":{"apiKey":"openai-key","model":"openai-model","baseUrl":"https://api.openai.com/v1"},
                "gemini":{"apiKey":"gemini-key","model":"gemini-model"},
                "nvidia":{"apiKey":"nvidia-key","model":"nvidia-model"},
                "opencode":{"apiKey":"opencode-key","model":"opencode-model"}
            }"#,
        );

        assert_eq!(config.mode, "gemini");
        assert_eq!(config.openai.api_key, "openai-key");
        assert_eq!(config.gemini.api_key, "gemini-key");
        assert_eq!(config.nvidia.model, "nvidia-model");
        assert_eq!(config.opencode.api_key, "opencode-key");
    }

    #[test]
    fn falls_back_to_demo_for_an_unknown_mode() {
        let config = parse_config(
            r#"{"mode":"unknown","openai":{"apiKey":"","model":"gpt","baseUrl":"https://api.openai.com/v1"}}"#,
        );
        assert_eq!(config.mode, "demo");
    }

    #[test]
    fn serializes_the_camel_case_config_shape() {
        let mut config = ProviderConfig::default();
        config.mode = "gemini".into();
        config.gemini.api_key = "gemini-key".into();
        config.gemini.model = "gemini-model".into();

        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["mode"], "gemini");
        assert_eq!(value["gemini"]["apiKey"], "gemini-key");
        assert_eq!(value["gemini"]["model"], "gemini-model");
        assert!(value["gemini"].get("baseUrl").is_none());
        assert_eq!(value["openai"]["baseUrl"], "https://api.openai.com/v1");
    }

    fn profile_update(model: &str) -> ProviderProfileUpdate {
        ProviderProfileUpdate {
            api_key: None,
            clear_key: false,
            remove_keys: Vec::new(),
            add_keys: Vec::new(),
            model: model.into(),
            base_url: None,
            live_model: None,
            delegate_model: None,
            thinking_model: None,
        }
    }

    fn config_update(mode: &str) -> ProviderConfigUpdate {
        ProviderConfigUpdate {
            mode: mode.into(),
            local: ProviderProfileUpdate {
                base_url: Some(crate::types::LOCAL_BASE_URL.into()),
                ..profile_update(crate::types::LOCAL_DEFAULT_MODEL)
            },
            openai: ProviderProfileUpdate {
                base_url: Some("https://api.openai.com/v1".into()),
                ..profile_update(crate::types::OPENAI_DEFAULT_MODEL)
            },
            gemini: profile_update(crate::types::GEMINI_DEFAULT_MODEL),
            nvidia: profile_update(crate::types::NVIDIA_DEFAULT_MODEL),
            opencode: profile_update(crate::types::OPENCODE_DEFAULT_MODEL),
        }
    }

    #[test]
    fn private_config_writes_are_owner_only() {
        let path = temp_path().with_extension("json");
        write_private_file(&path, r#"{"apiKey":"a-private-value"}"#).unwrap();

        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("a-private-value")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        cleanup(&path);
    }

    #[test]
    fn public_config_reports_keys_without_exposing_them() {
        let mut config = ProviderConfig::default();
        config.gemini.api_key = "gemini-secret".into();

        let public = config.public();
        let encoded = serde_json::to_string(&public).unwrap();

        assert!(public.gemini.key_set);
        assert!(!public.openai.key_set);
        assert!(!encoded.contains("gemini-secret"));
        assert!(!encoded.contains("apiKey"));
        assert!(encoded.contains("\"keySet\":true"));
    }

    #[test]
    fn config_updates_keep_replaced_keys_and_can_clear_them() {
        let mut current = ProviderConfig::default();
        current.openai.api_key = "saved-openai".into();
        current.gemini.api_key = "saved-gemini".into();

        let next = apply_config_update(current, config_update("demo")).unwrap();
        assert_eq!(next.openai.api_key, "saved-openai");
        assert_eq!(next.gemini.api_key, "saved-gemini");

        let mut clear = config_update("demo");
        clear.openai.clear_key = true;
        let next = apply_config_update(next, clear).unwrap();
        assert!(next.openai.api_key.is_empty());
        assert_eq!(next.gemini.api_key, "saved-gemini");

        let mut replace = config_update("openai");
        replace.openai.api_key = Some("replacement".into());
        let next = apply_config_update(next, replace).unwrap();
        assert_eq!(next.openai.api_key, "replacement");
        assert_eq!(next.gemini.api_key, "saved-gemini");
    }

    #[test]
    fn keys_can_be_added_and_removed_by_position() {
        let mut current = ProviderConfig::default();
        current.gemini.api_key = "first".into();

        let mut add = config_update("gemini");
        add.gemini.add_keys = vec!["second".into(), "third".into(), "second".into()];
        let next = apply_config_update(current, add).unwrap();
        assert_eq!(next.gemini.all_keys(), ["first", "second", "third"]);

        let mut remove = config_update("gemini");
        remove.gemini.remove_keys = vec![0];
        let next = apply_config_update(next, remove).unwrap();
        assert_eq!(next.gemini.api_key, "second");
        assert_eq!(next.gemini.all_keys(), ["second", "third"]);
        assert_eq!(next.public().gemini.key_hints.len(), 2);
    }

    #[test]
    fn a_local_model_is_saved_without_a_key() {
        // The point of the preset: llama-server has no key, and refusing to save
        // without one is what made the local path a manual workaround.
        let next = apply_config_update(ProviderConfig::default(), config_update("local"))
            .expect("a local server needs no key");
        assert_eq!(next.mode, "local");
        assert!(next.local.api_key.is_empty());
        assert_eq!(next.local.base_url, crate::types::LOCAL_BASE_URL);
    }

    #[test]
    fn a_loopback_endpoint_needs_no_key_either() {
        // The rule follows the address, not the preset name.
        let mut update = config_update("openai");
        update.openai.base_url = Some("http://127.0.0.1:8080/v1".into());
        let next = apply_config_update(ProviderConfig::default(), update)
            .expect("localhost needs no key");
        assert_eq!(next.mode, "openai");

        let mut remote = config_update("openai");
        remote.openai.base_url = Some("https://example.com/v1".into());
        let error = apply_config_update(ProviderConfig::default(), remote).unwrap_err();
        assert!(error.contains("API key"));
    }

    #[test]
    fn live_modes_require_a_key_and_unknown_modes_are_rejected() {
        let current = ProviderConfig::default();
        let error = apply_config_update(current, config_update("gemini")).unwrap_err();
        assert!(error.contains("API key"));

        let error =
            apply_config_update(ProviderConfig::default(), config_update("other")).unwrap_err();
        assert!(error.contains("model source"));
    }
}
