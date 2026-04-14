use crate::process_mgr::{LogEntry, ProcessManager, StatusInfo};
use crate::config::AppConfig;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::Manager;
use futures_util::StreamExt;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct ChatAbortFlag(pub Arc<AtomicBool>);

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

/// Descobre a pasta onde o OpenClaude CLI global está instalado (via NPM).
/// Ordem de tentativas:
///   1. `npm root -g` → `<root>/openclaude`
///   2. `where openclaude` / `which openclaude` → resolve o link e pega o pai
///   3. Fallback: `%APPDATA%/npm/node_modules/openclaude` (Windows) ou `~/.npm-global/lib/node_modules/openclaude` (Unix)
fn resolve_cli_dir() -> Option<std::path::PathBuf> {
    // 1) npm root -g
    let npm_cmd = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
    if let Ok(out) = std::process::Command::new(npm_cmd)
        .args(["root", "-g"])
        .output()
    {
        if out.status.success() {
            let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !root.is_empty() {
                let p = std::path::Path::new(&root).join("openclaude");
                if p.exists() { return Some(p); }
                // Aceita o npm root mesmo sem subpasta (pode ser instalação custom)
                let parent = std::path::Path::new(&root).parent().map(|x| x.to_path_buf());
                if let Some(pp) = parent { if pp.exists() { return Some(pp); } }
            }
        }
    }

    // 2) `where` / `which`
    let (finder, _) = if cfg!(target_os = "windows") { ("where", "") } else { ("which", "") };
    if let Ok(out) = std::process::Command::new(finder).arg("openclaude").output() {
        if out.status.success() {
            let line = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !line.is_empty() {
                let p = std::path::Path::new(&line);
                if let Some(parent) = p.parent() {
                    if parent.exists() { return Some(parent.to_path_buf()); }
                }
            }
        }
    }

    // 3) Fallbacks conhecidos
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let p = std::path::Path::new(&appdata).join("npm").join("node_modules").join("openclaude");
            if p.exists() { return Some(p); }
            // AppData/npm também serve (é onde o openclaude.cmd fica)
            let p2 = std::path::Path::new(&appdata).join("npm");
            if p2.exists() { return Some(p2); }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            for sub in &[".npm-global/lib/node_modules/openclaude", ".nvm/versions/node/*/lib/node_modules/openclaude"] {
                let p = std::path::Path::new(&home).join(sub);
                if p.exists() { return Some(p); }
            }
        }
    }

    None
}

/// Retorna o caminho do .env global da CLI (mesmo que não exista ainda).
fn cli_env_path() -> Option<std::path::PathBuf> {
    resolve_cli_dir().map(|d| d.join(".env"))
}

/// Lê o .env global da CLI e devolve os campos para o frontend.
#[tauri::command]
pub async fn get_cli_env(project_dir: Option<String>) -> Result<serde_json::Value, String> {
    let mut env_path = None;

    // Tenta primeiro o diretório do projeto se fornecido
    if let Some(ref dir) = project_dir {
        let p = std::path::PathBuf::from(dir).join(".env");
        if p.exists() {
            env_path = Some(p);
        }
    }

    // Fallback para o global se o do projeto não existir ou não foi solicitado
    if env_path.is_none() {
        env_path = cli_env_path();
    }

    let env_path = env_path.ok_or("Não foi possível localizar o arquivo .env.")?;

    let mut base_url = String::new();
    let mut api_key = String::new();
    let mut model = String::new();
    let mut vars = std::collections::HashMap::new();

    if env_path.exists() {
        let content = std::fs::read_to_string(&env_path)
            .map_err(|e| format!("Falha ao ler .env: {}", e))?;
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { continue; }
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim().to_string();
                let value = v.trim().to_string();
                
                match key.as_str() {
                    "OPENAI_BASE_URL" => base_url = value.clone(),
                    "OPENAI_API_KEY"  => api_key  = value.clone(),
                    "OPENAI_MODEL"    => model    = value.clone(),
                    _ => {}
                }
                vars.insert(key, value);
            }
        }
    }

    let abs = env_path
        .canonicalize()
        .unwrap_or_else(|_| env_path.clone())
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();

    Ok(serde_json::json!({
        "envPath": abs,
        "exists": env_path.exists(),
        "baseUrl": base_url,
        "apiKey": api_key,
        "model": model,
        "vars": vars
    }))
}

/// Grava/atualiza as chaves OPENAI_* no .env GLOBAL do OpenClaude CLI
/// (instalação npm global). Preserva outras chaves que já estejam no arquivo.
#[tauri::command]
pub async fn save_env_config(
    _config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
    project_dir: Option<String>,
    vars: std::collections::HashMap<String, String>,
) -> Result<String, String> {
    let env_path = if let Some(dir_path) = project_dir {
        let p = std::path::PathBuf::from(dir_path).join(".env");
        p
    } else {
        let cli_dir = resolve_cli_dir()
            .ok_or("Não foi possível localizar a instalação global do OpenClaude CLI.")?;
        if !cli_dir.exists() {
            std::fs::create_dir_all(&cli_dir).map_err(|e| format!("Falha ao criar pasta da CLI: {}", e))?;
        }
        cli_dir.join(".env")
    };

    // Lê conteúdo atual (se existir) e preserva chaves que não estamos atualizando agora
    let mut kept_lines: Vec<String> = Vec::new();
    if env_path.exists() {
        let existing = std::fs::read_to_string(&env_path)
            .map_err(|e| format!("Falha ao ler .env existente: {}", e))?;
        for line in existing.lines() {
            let trimmed = line.trim_start();
            if let Some((k, _)) = trimmed.split_once('=') {
                if !vars.contains_key(k.trim()) {
                    kept_lines.push(line.to_string());
                }
            } else {
                kept_lines.push(line.to_string());
            }
        }
    }

    // Remove trailing empty lines
    while kept_lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        kept_lines.pop();
    }

    let mut out = kept_lines.join("\n");
    if !out.is_empty() { out.push('\n'); }
    
    // Adiciona as novas variáveis
    for (k, v) in vars {
        out.push_str(&format!("{}={}\n", k, v.trim()));
    }

    std::fs::write(&env_path, out).map_err(|e| format!("Falha ao escrever .env: {}", e))?;
    let absolute = env_path
        .canonicalize()
        .unwrap_or_else(|_| env_path.clone())
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();
    
    Ok(absolute)
}

#[tauri::command]
pub async fn save_global_profile(
    name: String,
    base_url: String,
    api_key: String,
    model: String,
    provider_id: String,
) -> Result<String, String> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "Não foi possível localizar pasta HOME")?;
    let paths = vec![
        std::path::PathBuf::from(&home).join(".openclaude.json"),
        std::path::PathBuf::from(&home).join(".claude.json"),
    ];

    let mut config_path = paths[1].clone();
    for p in paths {
        if p.exists() {
            config_path = p;
            break;
        }
    }

    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| format!("Falha ao ler config: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !config.is_object() {
        config = serde_json::json!({});
    }

    let profiles = config.get_mut("providerProfiles").and_then(|v| v.as_array_mut());
    
    let mut target_id = format!("provider_{}", &uuid::Uuid::new_v4().to_string()[..12].replace('-', ""));
    
    let mut found = false;
    if let Some(arr) = profiles {
        for profile in arr.iter_mut() {
            if profile.get("name").and_then(|v| v.as_str()) == Some(&name) {
                profile["baseUrl"] = serde_json::Value::String(base_url.clone());
                profile["apiKey"] = serde_json::Value::String(api_key.clone());
                profile["model"] = serde_json::Value::String(model.clone());
                profile["provider"] = serde_json::Value::String(if provider_id == "anthropic" || provider_id == "gemini" { provider_id.clone() } else { "openai".to_string() });
                if let Some(id) = profile.get("id").and_then(|v| v.as_str()) {
                    target_id = id.to_string();
                }
                found = true;
                break;
            }
        }
        if !found {
            arr.push(serde_json::json!({
                "id": target_id,
                "name": name,
                "provider": if provider_id == "anthropic" || provider_id == "gemini" { provider_id.clone() } else { "openai".to_string() },
                "baseUrl": base_url,
                "model": model,
                "apiKey": api_key
            }));
        }
    } else {
        config["providerProfiles"] = serde_json::json!([
            {
                "id": target_id,
                "name": name,
                "provider": if provider_id == "anthropic" || provider_id == "gemini" { provider_id.clone() } else { "openai".to_string() },
                "baseUrl": base_url,
                "model": model,
                "apiKey": api_key
            }
        ]);
    }

    config["activeProviderProfileId"] = serde_json::Value::String(target_id);

    let updated = serde_json::to_string_pretty(&config).map_err(|e| format!("Falha ao serializar: {}", e))?;
    std::fs::write(&config_path, updated).map_err(|e| format!("Falha ao gravar config: {}", e))?;

    Ok(config_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_global_config() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "Não foi possível localizar pasta HOME")?;
    let paths = vec![
        std::path::PathBuf::from(&home).join(".openclaude.json"),
        std::path::PathBuf::from(&home).join(".claude.json"),
    ];

    for p in paths {
        if p.exists() {
            let content = std::fs::read_to_string(&p).map_err(|e| format!("Falha ao ler config: {}", e))?;
            let val: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
            return Ok(val);
        }
    }
    Ok(serde_json::json!({}))
}

#[tauri::command]
pub async fn delete_global_profile(id: String) -> Result<(), String> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "Não foi possível localizar pasta HOME")?;
    let paths = vec![
        std::path::PathBuf::from(&home).join(".openclaude.json"),
        std::path::PathBuf::from(&home).join(".claude.json"),
    ];

    let mut config_path = None;
    for p in paths {
        if p.exists() {
            config_path = Some(p);
            break;
        }
    }

    let config_path = config_path.ok_or("Arquivo de configuração não encontrado.")?;
    let content = std::fs::read_to_string(&config_path).map_err(|e| format!("Falha ao ler config: {}", e))?;
    let mut config: serde_json::Value = serde_json::from_str(&content).map_err(|e| format!("JSON inválido: {}", e))?;

    if let Some(profiles) = config.get_mut("providerProfiles").and_then(|v| v.as_array_mut()) {
        profiles.retain(|p| p.get("id").and_then(|v| v.as_str()) != Some(&id));
    }

    let updated = serde_json::to_string_pretty(&config).map_err(|e| format!("Falha ao serializar: {}", e))?;
    std::fs::write(&config_path, updated).map_err(|e| format!("Falha ao gravar config: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn chat_stream(
    app: tauri::AppHandle,
    config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
    input: String,
    attachments: Option<Vec<Attachment>>,
) -> Result<CommandResponse, String> {
    let cfg = config.read().await.clone();
    let (base_url, api_key, model) =
        load_api_config(&cfg.working_dir).ok_or("Configuração de API não encontrada no .env")?;

    // Prepara o array de conteúdo para capacidades multimodais (texto + imagem)
    let mut content_arr = vec![];
    let mut has_image = false;

    if !input.is_empty() {
        content_arr.push(serde_json::json!({
            "type": "text",
            "text": input
        }));
    }

    if let Some(ref atts) = attachments {
        for att in atts {
            if let Some(ref data) = att.data {
                if data.starts_with("data:image") {
                    has_image = true;
                    content_arr.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": data }
                    }));
                }
            }
        }
    }

    let final_content = if has_image {
        serde_json::Value::Array(content_arr)
    } else {
        serde_json::Value::String(input.clone())
    };

    // Add user message to shared history
    {
        let hist = app.state::<ChatHistory>();
        hist.0.lock().unwrap().push(serde_json::json!({ "role": "user", "content": final_content }));
    }

    let messages: Vec<serde_json::Value> = {
        let hist = app.state::<ChatHistory>();
        let msgs = hist.0.lock().unwrap().clone();
        msgs
    };

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    eprintln!("[CHAT] Iniciando requisição para: {}", url);
    eprintln!("[CHAT] Modelo: {} | Mensagens: {}", model, messages.len());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Erro ao criar cliente HTTP: {}", e))?;

    eprintln!("[CHAT] Cliente HTTP criado com timeout de 120s");

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
        .map_err(|e| {
            let err_msg = if e.is_timeout() {
                eprintln!("[CHAT-ERROR] Timeout na API: {}", e);
                format!("Timeout na API (120s) - verifique a conexão ou tente novamente: {}", e)
            } else if e.is_connect() {
                eprintln!("[CHAT-ERROR] Erro de conexão: {}", e);
                format!("Erro de conexão com a API - verifique a URL e sua conexão: {}", e)
            } else if e.is_request() {
                eprintln!("[CHAT-ERROR] Erro na requisição: {}", e);
                format!("Erro na requisição: {}", e)
            } else {
                eprintln!("[CHAT-ERROR] Erro de rede: {}", e);
                format!("Erro de rede: {}", e)
            };
            err_msg
        })?;

    eprintln!("[CHAT] Resposta recebida com status: {}", resp.status());

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        eprintln!("[CHAT-ERROR] Status não sucesso: {} | Body: {}", status, body);
        let msg = match status.as_u16() {
            401 => format!("API Error 401: Autenticação falhou - verifique sua chave de API"),
            429 => format!("API Error 429: Limite de requisições atingido - espere um pouco e tente novamente"),
            500..=599 => format!("API Error {}: Servidor indisponível - tente novamente em alguns momentos", status),
            _ => format!("API Error {}: {}", status, body)
        };
        let _ = tauri::Emitter::emit(&app, "log-update", serde_json::json!({
            "source": "stderr", "message": msg
        }));
        return Ok(CommandResponse { success: false, message: "API error".into(), data: None });
    }

    let abort_flag = app.state::<ChatAbortFlag>().0.clone();
    abort_flag.store(false, Ordering::SeqCst);

    // Stream SSE chunks to frontend and collect the full reply for history
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut stream = resp.bytes_stream();
        let mut full_reply = String::new();
        let mut chunk_count = 0;

        eprintln!("[STREAM] Iniciando streaming...");

        while let Some(chunk) = stream.next().await {
            // Se o usuário clicar em Parar
            if abort_flag.load(Ordering::SeqCst) {
                eprintln!("[STREAM] Aborto solicitado pelo usuário");
                break;
            }

            let bytes = match chunk { 
                Ok(b) => {
                    chunk_count += 1;
                    eprintln!("[STREAM] Chunk {} recebido: {} bytes", chunk_count, b.len());
                    b
                },
                Err(e) => {
                    eprintln!("[STREAM-ERROR] Erro ao receber chunk: {}", e);
                    break;
                }
            };
            let text = String::from_utf8_lossy(&bytes);

            for line in text.lines() {
                let line = line.trim();
                if line == "data: [DONE]" { 
                    eprintln!("[STREAM] [DONE] recebido - finalizando streaming");
                    break; 
                }
                if let Some(json_str) = line.strip_prefix("data: ") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                        if let Some(delta) = v
                            .get("choices").and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"))
                            .and_then(|d| d.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            full_reply.push_str(delta);
                            eprintln!("[STREAM] Delta recebido: {} caracteres | Total: {}", delta.len(), full_reply.len());
                            let _ = tauri::Emitter::emit(&app2, "log-update", serde_json::json!({
                                "source": "stdout", "message": delta
                            }));
                        }
                    }
                }
            }
        }

        eprintln!("[STREAM] Streaming finalizado | Total de chunks: {} | Resposta total: {} caracteres", chunk_count, full_reply.len());

        // Push assistant reply into history for next turn
        if !full_reply.is_empty() {
            let hist = app2.state::<ChatHistory>();
            hist.0.lock().unwrap().push(serde_json::json!({
                "role": "assistant", "content": full_reply
            }));
            eprintln!("[STREAM] Resposta adicionada ao histórico");
        }

        // Signal end-of-message to frontend
        let _ = tauri::Emitter::emit(&app2, "log-update", serde_json::json!({
            "source": "done", "message": ""
        }));
    });

    Ok(CommandResponse { success: true, message: "streaming".into(), data: None })
}

#[tauri::command]
pub async fn stop_chat_stream(app: tauri::AppHandle) -> Result<(), String> {
    let abort_flag = app.state::<ChatAbortFlag>();
    abort_flag.0.store(true, Ordering::SeqCst);
    Ok(())
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

/// Extrai texto limpo do output stream-json do CLI.
/// Formato SDK: assistant events contêm message.content[{type:"text",text:"..."}]
/// result events contêm result:"texto completo"
fn extract_text_from_stream_json(raw: &str) -> String {
    let mut text = String::new();
    let mut result_text = String::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') { continue; }
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let evt_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
        // assistant → extrai texto dos content blocks
        if evt_type == "assistant" {
            if let Some(content) = obj.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            text.push_str(t);
                        }
                    }
                }
            }
        }
        // result → fallback com texto completo
        if evt_type == "result" {
            if let Some(t) = obj.get("result").and_then(|t| t.as_str()) {
                result_text = t.to_string();
            }
        }
    }
    if text.is_empty() { result_text } else { text }
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

#[derive(Debug, serde::Deserialize)]
pub struct Attachment {
    pub name: String,
    pub data: Option<String>, // base64
    pub path: Option<String>, // local path
    #[serde(rename = "type")]
    pub mime_type: Option<String>,
}

#[tauri::command]
pub async fn send_command(
    app: tauri::AppHandle,
    config: tauri::State<'_, Arc<RwLock<AppConfig>>>,
    input: String,
    attachments: Option<Vec<Attachment>>,
    env_vars: Option<std::collections::HashMap<String, String>>,
) -> Result<CommandResponse, String> {
    let sanitized = sanitize_input(&input);
    let cfg = config.read().await.clone();
    let app_handle = app.clone();
    let is_system_cmd = input.starts_with('/');

    // Grava a mensagem do usuário no histórico (ignorando comandos de sistema como /provider)
    if !is_system_cmd {
        let mut content_arr = vec![];
        let mut has_image = false;

        if !input.is_empty() {
            content_arr.push(serde_json::json!({ "type": "text", "text": input }));
        }

        if let Some(ref atts) = attachments {
            for att in atts {
                if let Some(ref data) = att.data {
                    if data.starts_with("data:image") {
                        has_image = true;
                        content_arr.push(serde_json::json!({
                            "type": "image_url",
                            "image_url": { "url": data }
                        }));
                    }
                }
            }
        }

        let final_content = if has_image {
            serde_json::Value::Array(content_arr)
        } else {
            serde_json::Value::String(input.clone())
        };

        let hist = app.state::<ChatHistory>();
        hist.0.lock().unwrap().push(serde_json::json!({ "role": "user", "content": final_content }));
    }

    // Log attachments for debug (optional)
    if let Some(ref atts) = attachments {
        if !atts.is_empty() {
             let _ = tauri::Emitter::emit(&app_handle, "log-update", serde_json::json!({
                "source": "system", 
                "message": format!("Enviando {} anexo(s)...", atts.len())
            }));
        }
    }

    let abort_flag = app.state::<ChatAbortFlag>().0.clone();
    abort_flag.store(false, Ordering::SeqCst);

    // One-shot per message: faster with bun (falls back to node).
    // Equivalent to: echo "msg" | openclaude --print
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;

        // Detecta o modo enviado pelo frontend (auto/ask/plan)
        let mode = env_vars.as_ref()
            .and_then(|v| v.get("OPENCLAUDE_MODE"))
            .map(|s| s.as_str())
            .unwrap_or("auto");

        // Pasta de trabalho: projeto selecionado na UI ou padrão da config
        let working_dir = env_vars.as_ref()
            .and_then(|v| v.get("OPENCLAUDE_CWD"))
            .map(|s| s.to_string())
            .unwrap_or_else(|| cfg.working_dir.clone());

        // Modo plan: prefixa o prompt para o agente só planejar
        let effective_prompt = if mode == "plan" {
            format!(
                "[MODO PLANEJAMENTO] Apenas descreva detalhadamente o que você faria para completar esta tarefa. NÃO execute nenhuma ferramenta, NÃO crie nem modifique arquivos. Responda apenas com um plano de ação em texto:\n\n{}",
                sanitized
            )
        } else {
            sanitized.clone()
        };

        // Resolve o caminho absoluto do script openclaude (base_args podem ser relativos)
        // Ex: "bin/openclaude" → "C:\...\openclaude-main\bin\openclaude"
        let base_args: Vec<String> = cfg.args.iter()
            .filter(|a| *a != "--bare" && *a != "--print")
            .map(|a| {
                let p = std::path::Path::new(a);
                if p.is_relative() {
                    std::path::Path::new(&cfg.working_dir).join(p)
                        .to_string_lossy().to_string()
                } else {
                    a.clone()
                }
            })
            .collect();

        let mut strategies = vec![];
        #[cfg(target_os = "windows")]
        {
            strategies.push((format!("{}.cmd", cfg.openclaude_path), vec![]));
            strategies.push((cfg.openclaude_path.clone(), vec![]));
            strategies.push(("npx.cmd".to_string(), vec![cfg.openclaude_path.clone()]));
        }
        #[cfg(not(target_os = "windows"))]
        {
            strategies.push((cfg.openclaude_path.clone(), vec![]));
            strategies.push(("npx".to_string(), vec![cfg.openclaude_path.clone()]));
        }

        let mut spawned = None;
        for (exe, pre_args) in strategies {
            let mut cmd = tokio::process::Command::new(&exe);
            cmd.args(&pre_args);
            cmd.args(&base_args);
            cmd.arg("--print");
            // stream-json: emite 1 evento JSON por linha (tool_use, text, result...)
            // --verbose é obrigatório para esse formato funcionar com --print
            cmd.arg("--output-format");
            cmd.arg("stream-json");
            cmd.arg("--verbose");
            if mode == "auto" || cfg.skip_permissions {
                cmd.arg("--dangerously-skip-permissions");
            }
            // --continue: retoma a última sessão do CLI nesta pasta
            let do_continue = env_vars.as_ref()
                .and_then(|v| v.get("OPENCLAUDE_CONTINUE"))
                .map(|v| v == "1")
                .unwrap_or(false);
            if do_continue {
                cmd.arg("--continue");
            }
            cmd.arg("-p");
            cmd.arg(&effective_prompt);
            // current_dir = projeto selecionado (script já é caminho absoluto)
            cmd.current_dir(&working_dir);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.stdin(std::process::Stdio::null());

            // Load .env: tenta pasta do projeto primeiro, depois a da config padrão
            let env_candidate = std::path::Path::new(&working_dir).join(".env");
            let env_path = if env_candidate.exists() {
                env_candidate
            } else {
                std::path::Path::new(&cfg.working_dir).join(".env")
            };
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

            // Injeta as configurações dinâmicas de Provedor e API Key vindas do Front-end
            if let Some(ref vars) = env_vars {
                for (k, v) in vars {
                    if !v.is_empty() {
                        cmd.env(k, v);
                    }
                }
            }

            eprintln!("[RUST-SPAWN] Tentando exe={:?} pre_args={:?} base_args={:?} mode={} cwd={}",
                exe, pre_args, base_args, mode, working_dir);
            match cmd.spawn() {
                Ok(proc) => {
                    eprintln!("[RUST-SPAWN] OK - processo iniciado com exe={:?}", exe);
                    spawned = Some(proc);
                    break;
                }
                Err(e) => {
                    eprintln!("[RUST-SPAWN] FALHOU exe={:?} err={}", exe, e);
                    continue;
                }
            }
        }

        let mut proc = match spawned {
            Some(p) => p,
            None => {
                let _ = tauri::Emitter::emit(&app_handle, "log-update", serde_json::json!({
                    "source": "stderr",
                        "message": "Erro Crítico: não foi possível iniciar o motor do OpenClaude. Verifique as configurações de PATH ou se o pacote está instalado globalmente via npm."
                }));
                    let _ = tauri::Emitter::emit(&app_handle, "log-update", serde_json::json!({ "source": "done", "message": "" }));
                return;
            }
        };

        let full_reply = Arc::new(tokio::sync::Mutex::new(String::new()));

        // Canais para sinalizar que cada stream terminou de ser lido
        let (stdout_done_tx, stdout_done_rx) = tokio::sync::oneshot::channel::<()>();
        let (stderr_done_tx, stderr_done_rx) = tokio::sync::oneshot::channel::<()>();

        // Stream stdout
        if let Some(mut stdout) = proc.stdout.take() {
            let handle = app_handle.clone();
            let reply_clone = full_reply.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            eprintln!("[RUST-STDOUT] {} bytes | preview: {:?}", n, text.chars().take(180).collect::<String>());
                            reply_clone.lock().await.push_str(&text);
                            let _ = tauri::Emitter::emit(&handle, "log-update", serde_json::json!({
                                "source": "stdout", "message": text
                            }));
                        }
                    }
                }
                // Sinaliza que terminou de ler todo o stdout
                let _ = stdout_done_tx.send(());
            });
        } else {
            let _ = stdout_done_tx.send(());
        }

        // Stream stderr
        if let Some(mut stderr) = proc.stderr.take() {
            let handle = app_handle.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                // Filtra warnings benignos repetidos do CLI (ex: "[context] Warning: model ... not in context window table")
                // O CLI loga esse warning a cada operação interna, causando flood na UI.
                let mut last_emitted = String::new();
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            eprintln!("[RUST-STDERR] {} bytes | preview: {:?}", n, text.chars().take(180).collect::<String>());

                            // Remove linhas que são puramente warnings de [context] duplicados
                            let filtered: String = text
                                .lines()
                                .filter(|l| {
                                    let t = l.trim();
                                    // Descarta linhas vazias (mantem comportamento) E warnings de [context]
                                    !t.starts_with("[context] Warning:")
                                })
                                .collect::<Vec<_>>()
                                .join("\n");

                            // Se depois do filtro sobrou só whitespace, não emite
                            if filtered.trim().is_empty() {
                                continue;
                            }

                            // Dedup: não emite se for exatamente igual ao último chunk emitido
                            if filtered == last_emitted {
                                continue;
                            }
                            last_emitted = filtered.clone();

                            let _ = tauri::Emitter::emit(&handle, "log-update", serde_json::json!({
                                "source": "stderr", "message": filtered
                            }));
                        }
                    }
                }
                // Sinaliza que terminou de ler todo o stderr
                let _ = stderr_done_tx.send(());
            });
        } else {
            let _ = stderr_done_tx.send(());
        }

        // Loop de espera do processo (com suporte a abortar)
        loop {
            tokio::select! {
                _ = proc.wait() => break,
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                    if abort_flag.load(Ordering::SeqCst) {
                        let _ = proc.kill().await;
                        break;
                    }
                }
            }
        }

        // IMPORTANTE: aguarda os readers de stdout e stderr terminarem completamente
        // antes de emitir 'done', evitando que o frontend receba 'done' antes de
        // todo o conteúdo ter sido entregue (race condition que causava respostas truncadas).
        let _ = stdout_done_rx.await;
        let _ = stderr_done_rx.await;

        // Adiciona a resposta da IA ao histórico e emite evento 'done'
        // Se o output é stream-json, extrai apenas o texto limpo para o histórico
        let final_reply = full_reply.lock().await.clone();
        if !is_system_cmd && !final_reply.is_empty() {
            let clean_reply = extract_text_from_stream_json(&final_reply);
            let reply_content = if clean_reply.is_empty() { final_reply } else { clean_reply };
            let hist = app_handle.state::<ChatHistory>();
            hist.0.lock().unwrap().push(serde_json::json!({ "role": "assistant", "content": reply_content }));
        }

        let _ = tauri::Emitter::emit(&app_handle, "log-update", serde_json::json!({ "source": "done", "message": "" }));
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

#[derive(Debug, Serialize)]
pub struct RequirementsStatus {
    pub openclaude: bool,
    pub node: bool,
    pub bun: bool,
    pub npm: bool,
}

#[tauri::command]
pub async fn check_requirements() -> Result<RequirementsStatus, String> {
    let check_cmd = |cmd: &str, args: &[&str]| -> bool {
        std::process::Command::new(cmd)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };

    // Check if openclaude is in path or usable
    // If it's a script path, we might need to check if node/bun can run it
    let has_openclaude = check_cmd("openclaude", &["--version"]);
    let has_node = check_cmd("node", &["--version"]);
    let has_bun = check_cmd("bun", &["--version"]);
    let has_npm = check_cmd("npm", &["--version"]);

    Ok(RequirementsStatus {
        openclaude: has_openclaude,
        node: has_node,
        bun: has_bun,
        npm: has_npm,
    })
}

#[tauri::command]
pub async fn install_openclaude(app: tauri::AppHandle) -> Result<CommandResponse, String> {
    let _ = tauri::Emitter::emit(&app, "log-update", serde_json::json!({
        "source": "system", "message": "Iniciando instalação do OpenClaude via NPM..."
    }));

    let status = tokio::process::Command::new("npm")
        .args(&["install", "-g", "openclaude"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(CommandResponse {
            success: true,
            message: "OpenClaude instalado com sucesso!".to_string(),
            data: None,
        })
    } else {
        Err("Falha ao instalar OpenClaude via NPM. Certifique-se de que o Node.js está instalado e você tem permissão de administrador.".into())
    }
}
