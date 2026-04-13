#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod process_mgr;

use config::AppConfig;
use process_mgr::ProcessManager;
use commands::ChatHistory;
use std::io::Write;
use log::info;
use tauri::Manager;

// Removed SystemTray import as it's not valid in Tauri 2 core
#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|buf, record| {
            writeln!(
                buf,
                "[{} {}] {}",
                record.level(),
                record.target(),
                record.args()
            )
        })
        .init();

    info!("Starting OpenClaude GUI");
    let ctx = tauri::generate_context!();

    let app_config = std::sync::Arc::new(tokio::sync::RwLock::new(AppConfig::default()));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ProcessManager::new(5000))
        .manage(app_config)
        .manage(ChatHistory(std::sync::Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            commands::start_process,
            commands::stop_process,
            commands::restart_process,
            commands::send_command,
            commands::chat_stream,
            commands::clear_chat_history,
            commands::get_status,
            commands::get_logs,
            commands::clear_logs,
            commands::get_config,
            commands::save_config,
            commands::open_logs_folder,
            commands::test_connection,
            commands::list_sessions,
            commands::save_session,
            commands::load_session,
            commands::delete_session,
            commands::check_requirements,
            commands::install_openclaude,
            commands::save_api_config,
        ]);

    /* #[cfg(not(target_os = "android"))]
    {
        let system_tray = SystemTray::new().with_menu(
            SystemTrayMenu::new()
                .add_item(SystemTrayMenuItem::BrandSeparator)
                .add_item(SystemTrayMenuItem::new("Iniciar OpenClaude").with_id("start"))
                .add_item(SystemTrayMenuItem::new("Parar").with_id("stop"))
                .add_item(SystemTrayMenuItem::new("Reiniciar").with_id("restart"))
                .add_item(SystemTrayMenuItem::BrandSeparator)
                .add_item(SystemTrayMenuItem::new("Abrir Logs").with_id("open_logs"))
                .add_item(SystemTrayMenuItem::BrandSeparator)
                .add_item(SystemTrayMenuItem::new("Sair").with_id("exit")),
        );
        builder = builder.system_tray(system_tray);
    } */

    builder.setup(|app| {
        let process_mgr = app.state::<ProcessManager>();
        let app_handle = app.handle().clone();
        
        // Spawn a task to bridge logs to the frontend
        let mut rx = process_mgr.subscribe_logs();
        tauri::async_runtime::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                // msg is JSON: { "source": "stdout"|"stderr"|"system", "message": "..." }
                // Try to parse and forward as-is; fallback to plain stdout
                let payload = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&msg) {
                    parsed
                } else {
                    serde_json::json!({ "source": "stdout", "message": msg })
                };
                let _ = tauri::Emitter::emit(&app_handle, "log-update", payload);
            }
        });
        
        Ok(())
    })
    .run(ctx).expect("error while running tauri application");
}
