use crate::process_mgr::{LogEntry, ProcessManager, StatusInfo};
use crate::config::AppConfig;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::Manager;
use futures_util::StreamExt;

// ── Chat history shared state ────────────────────────────────────────────────
pub struct ChatHistory(pub std::sync::Mutex<Vec<serde_json::Value>>);

/// Parse the .env file and return (base_url, api_key, model)
fn load_api_config(working_dir: &str) -> Option<(String, String, String)> {
    let env_path = std::path::Path::new(working_dir).join(".env");
    let content = std::fs::read_to_string(env_path).ok()?;
    let mut base_url = String::new();
    let mut api_key  = String::new();
    let mut model    = String::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('$') { continue; }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "OPENAI_BASE_URL" => base_url = v.trim().to_string(),
                "OPENAI_API_KEY"  => api_key  = v.trim().to_string(),
                "OPENAI_MODEL"    => model     = v.trim().to_string(),
                _ => {}
            }
        }
    }
    if base_url.is_empty() || api_key.is_empty() || model.is_empty() { return None; }
    Some((base_url, api_key, model))
}

#[tauri::command]
pub async fn chat_stream(
    app: tauri::AppHandle,
    config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
    input: String,
) -> Result<CommandResponse, String> {
    let cfg = config.read().await.clone();
    let (base_url, api_key, model) =
        load_api_config(&cfg.working_dir).ok_or("Configuração de API não encontrada no .env")?;

    // Add user message to shared history
    {
        let hist = app.state::<ChatHistory>();
        hist.0.lock().unwrap().push(serde_json::json!({ "role": "user", "content": input }));
    }

    let messages: Vec<serde_json::Value> = {
        let hist = app.state::<ChatHistory>();
        let msgs = hist.0.lock().unwrap().clone();
        msgs
    };

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true
        }))
        .send()
        .await
        .map_err(|e| format!("Erro de rede: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("API Error {}: {}", status, body);
        let _ = tauri::Emitter::emit(&app, "log-update", serde_json::json!({
            "source": "stderr", "message": msg
        }));
        return Ok(CommandResponse { success: false, message: "API error".into(), data: None });
    }

    // Stream SSE chunks to frontend and collect the full reply for history
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut stream = resp.bytes_stream();
        let mut full_reply = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk { Ok(b) => b, Err(_) => break };
            let text = String::from_utf8_lossy(&bytes);

            for line in text.lines() {
                let line = line.trim();
                if line == "data: [DONE]" { break; }
                if let Some(json_str) = line.strip_prefix("data: ") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                        if let Some(delta) = v
                            .get("choices").and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"))
                            .and_then(|d| d.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            full_reply.push_str(delta);
                            let _ = tauri::Emitter::emit(&app2, "log-update", serde_json::json!({
                                "source": "stdout", "message": delta
                            }));
                        }
                    }
                }
            }
        }

        // Push assistant reply into history for next turn
        if !full_reply.is_empty() {
            let hist = app2.state::<ChatHistory>();
            hist.0.lock().unwrap().push(serde_json::json!({
                "role": "assistant", "content": full_reply
            }));
        }

        // Signal end-of-message to frontend
        let _ = tauri::Emitter::emit(&app2, "log-update", serde_json::json!({
            "source": "done", "message": ""
        }));
    });

    Ok(CommandResponse { success: true, message: "streaming".into(), data: None })
}

#[tauri::command]
pub async fn clear_chat_history(
    app: tauri::AppHandle,
) -> Result<(), String> {
    let hist = app.state::<ChatHistory>();
    hist.0.lock().unwrap().clear();
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CommandResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

fn sanitize_input(input: &str) -> String {
    // Keep only safe printable characters to prevent injection
    input
        .chars()
        .filter(|c| matches!(*c, '\t' | '\n' | '\r' | '\x20'..='\x7e'))
        .collect()
}

#[tauri::command]
pub async fn start_process(
    process_mgr: tauri::State<'_, ProcessManager>,
    config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
) -> Result<StatusInfo, String> {
    let cfg = config.read().await.clone();
    let info = process_mgr
        .start(&cfg.openclaude_path, &cfg.args, &cfg.working_dir)
        .await?;
        Ok(info)
}

#[tauri::command]
pub async fn stop_process(
    process_mgr: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    process_mgr.stop().await?;
        Ok(())
}

#[tauri::command]
pub async fn restart_process(
    process_mgr: tauri::State<'_, ProcessManager>,
    config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
) -> Result<StatusInfo, String> {
    let cfg = config.read().await.clone();
    process_mgr.stop().await.ok();
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    let info = process_mgr
        .start(&cfg.openclaude_path, &cfg.args, &cfg.working_dir)
        .await?;
        Ok(info)
}

#[tauri::command]
pub async fn send_command(
    app: tauri::AppHandle,
    config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
    input: String,
) -> Result<CommandResponse, String> {
    let sanitized = sanitize_input(&input);
    let cfg = config.read().await.clone();
    let app_handle = app.clone();

    // One-shot per message: faster with bun (falls back to node).
    // Equivalent to: echo "msg" | openclaude --print
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;

        // Prefer bun for much faster startup (~5-10x vs node).
        // Try bun first; if spawn fails, retry with node.
        let executables = ["bun", &cfg.openclaude_path];

        // Base script args without --bare/--print (we add them ourselves)
        let base_args: Vec<String> = cfg.args.iter()
            .filter(|a| *a != "--bare" && *a != "--print")
            .cloned()
            .collect();

        let mut spawned = None;
        for exe in &executables {
            let mut cmd = tokio::process::Command::new(exe);
            cmd.args(&base_args);
            cmd.arg("--print");
            cmd.arg("-p");
            cmd.arg(&sanitized);
            cmd.current_dir(&cfg.working_dir);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.stdin(std::process::Stdio::null());

            // Load .env
            let env_path = std::path::Path::new(&cfg.working_dir).join(".env");
            if env_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&env_path) {
                    for line in content.lines() {
                        let line = line.trim();
                        if line.is_empty() || line.starts_with('#') || line.starts_with('$') { continue; }
                        if let Some((key, value)) = line.split_once('=') {
                            let key = key.trim();
                            let value = value.trim();
                            if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                                cmd.env(key, value);
                            }
                        }
                    }
                }
            }

            match cmd.spawn() {
                Ok(proc) => { spawned = Some(proc); break; }
                Err(_) => continue,
            }
        }

        let mut proc = match spawned {
            Some(p) => p,
            None => {
                let _ = tauri::Emitter::emit(&app_handle, "log-update", serde_json::json!({
                    "source": "stderr",
                    "message": "Erro: não foi possível iniciar o processo (bun/node não encontrado)"
                }));
                return;
            }
        };

        // Stream stdout
        if let Some(mut stdout) = proc.stdout.take() {
            let handle = app_handle.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = tauri::Emitter::emit(&handle, "log-update", serde_json::json!({
                                "source": "stdout", "message": text
                            }));
                        }
                    }
                }
            });
        }

        // Stream stderr
        if let Some(mut stderr) = proc.stderr.take() {
            let handle = app_handle.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = tauri::Emitter::emit(&handle, "log-update", serde_json::json!({
                                "source": "stderr", "message": text
                            }));
                        }
                    }
                }
            });
        }

        let _ = proc.wait().await;
    });

    Ok(CommandResponse {
        success: true,
        message: "Command sent".to_string(),
        data: None,
    })
}

#[tauri::command]
pub async fn get_status(
    process_mgr: tauri::State<'_, ProcessManager>,
) -> Result<StatusInfo, String> {
    Ok(process_mgr.get_status().await)
}

#[tauri::command]
pub async fn get_logs(
    process_mgr: tauri::State<'_, ProcessManager>,
    limit: Option<usize>,
) -> Result<Vec<LogEntry>, String> {
    Ok(process_mgr.get_logs(limit).await)
}

#[tauri::command]
pub async fn clear_logs(
    process_mgr: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    process_mgr.clear_logs().await;
    Ok(())
}

#[tauri::command]
pub async fn get_config(config: tauri::State<'_, Arc<RwLock<AppConfig>>>) -> Result<AppConfig, String> {
    Ok(config.read().await.clone())
}

#[tauri::command]
pub async fn save_config(
    app: tauri::AppHandle,
    new_config: AppConfig,
) -> Result<CommandResponse, String> {
    let config = app.state::<Arc<RwLock<AppConfig>>>();
    {
        let mut cfg = config.write().await;
        *cfg = new_config.clone();
    }

    let config_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");

    let content = serde_json::to_string_pretty(&new_config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, content).map_err(|e| e.to_string())?;

    Ok(CommandResponse {
        success: true,
        message: "Configuration saved".to_string(),
        data: None,
    })
}

#[tauri::command]
pub async fn open_logs_folder(
    app: tauri::AppHandle,
) -> Result<CommandResponse, String> {
    let folder = app.path().app_data_dir()
        .map(|p: std::path::PathBuf| p.join("openclaude-gui").to_string_lossy().to_string());

    match folder {
        Ok(path) => {
            if std::fs::create_dir_all(&path).is_ok() {
                Ok(CommandResponse {
                    success: true,
                    message: format!("Logs folder: {}", path),
                    data: None,
                })
            } else {
                Ok(CommandResponse {
                    success: false,
                    message: "Failed to open logs folder".to_string(),
                    data: None,
                })
            }
        }
        Err(_) => Ok(CommandResponse {
            success: false,
            message: "Could not determine logs folder".to_string(),
            data: None,
        }),
    }
}

#[tauri::command]
pub async fn list_sessions(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let sessions_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions");
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }
    
    let mut entries = std::fs::read_dir(sessions_dir).map_err(|e| e.to_string())?
        .filter_map(|res| res.ok())
        .map(|entry| {
            let metadata = entry.metadata().ok();
            let modified = metadata.and_then(|m| m.modified().ok())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            (entry.file_name().to_string_lossy().into_owned(), modified)
        })
        .filter(|(name, _)| name.ends_with(".json"))
        .collect::<Vec<_>>();
    
    // Sort by modification time (most recent first)
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    
    Ok(entries.into_iter().map(|(name, _)| name).collect())
}

#[tauri::command]
pub async fn save_session(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let sessions_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions");
    std::fs::create_dir_all(&sessions_dir).map_err(|e| e.to_string())?;

    let messages = {
        let hist = app.state::<ChatHistory>();
        let msgs = hist.0.lock().unwrap().clone();
        msgs
    };
    if messages.is_empty() { return Ok(()); }

    let file_path = sessions_dir.join(format!("{}.json", sanitize_filename(&id)));
    let content = serde_json::to_string_pretty(&messages).map_err(|e| e.to_string())?;
    std::fs::write(file_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_session(app: tauri::AppHandle, id: String) -> Result<Vec<serde_json::Value>, String> {
    let sessions_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions");
    let file_path = sessions_dir.join(format!("{}.json", sanitize_filename(&id)));
    
    let content = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let messages: Vec<serde_json::Value> = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    {
        let hist = app.state::<ChatHistory>();
        let mut h = hist.0.lock().unwrap();
        *h = messages.clone();
    }
    Ok(messages)
}

#[tauri::command]
pub async fn delete_session(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let sessions_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions");
    let file_path = sessions_dir.join(format!("{}.json", sanitize_filename(&id)));
    if file_path.exists() {
        std::fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

#[tauri::command]
pub async fn test_connection(
    config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
) -> Result<CommandResponse, String> {
    let cfg = config.read().await.clone();
    let path_exists = std::path::Path::new(cfg.openclaude_path.as_str()).exists();
    let arg_exists = cfg.args.iter().any(|a| std::path::Path::new(a).exists());

    Ok(CommandResponse {
        success: path_exists || arg_exists,
        message: if path_exists || arg_exists { "Path exists and is valid" } else { "Path not found" }.to_string(),
        data: None,
    })
}
