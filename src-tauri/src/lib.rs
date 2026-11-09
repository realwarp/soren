mod canvas;
mod cloud;
mod live;
mod live_text;
mod provider;
mod settings;
mod store;
mod types;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            cloud::cloud_complete,
            canvas::canvas_agent,
            store::get_config,
            store::save_config,
            store::set_effort,
            store::set_settings,
            store::reset_settings,
            store::open_data_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
