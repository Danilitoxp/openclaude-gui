use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProcessStatus {
    Offline,
    Starting,
    Running,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusInfo {
    pub status: ProcessStatus,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub timestamp: u64,
    pub source: LogSource,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogSource {
    Stdout,
    Stderr,
    System,
}

pub struct ProcessManager {
    status: Arc<RwLock<ProcessStatus>>,
    pid: Arc<RwLock<Option<u32>>>,
    child: Arc<RwLock<Option<Child>>>,
    handles: Arc<RwLock<Vec<tokio::task::JoinHandle<()>>>>,
    logs: Arc<RwLock<VecDeque<LogEntry>>>,
    log_limit: usize,
    log_tx: broadcast::Sender<String>,
}

impl Clone for ProcessManager {
    fn clone(&self) -> Self {
        Self {
            status: Arc::clone(&self.status),
            pid: Arc::clone(&self.pid),
            child: Arc::clone(&self.child),
            handles: Arc::clone(&self.handles),
            logs: Arc::clone(&self.logs),
            log_limit: self.log_limit,
            log_tx: self.log_tx.clone(),
        }
    }
}

#[allow(dead_code)]
impl ProcessManager {
    pub fn new(log_limit: usize) -> Self {
        let (log_tx, _) = broadcast::channel(1000);

        Self {
            status: Arc::new(RwLock::new(ProcessStatus::Offline)),
            pid: Arc::new(RwLock::new(None)),
            child: Arc::new(RwLock::new(None)),
            handles: Arc::new(RwLock::new(Vec::new())),
            logs: Arc::new(RwLock::new(VecDeque::with_capacity(log_limit))),
            log_limit,
            log_tx,
        }
    }

    pub async fn start(
        &self,
        executable: &str,
        args: &[String],
        working_dir: &str,
    ) -> Result<StatusInfo, String> {
        {
            let mut h = self.handles.write().await;
            for handle in h.drain(..) {
                handle.abort();
            }
        }

        let mut status = self.status.write().await;
        *status = ProcessStatus::Starting;
        drop(status);

        info!("Starting OpenClaude: {} {:?}", executable, args);

        let mut cmd = Command::new(executable);
        cmd.args(args);
        cmd.current_dir(working_dir);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::piped());

        // Force simple/non-TUI mode so we get clean text output on piped stdin/stdout
        cmd.env("CLAUDE_CODE_SIMPLE", "1");

        // Load .env file from working directory and pass env vars to child process
        let env_path = std::path::Path::new(working_dir).join(".env");
        if env_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&env_path) {
                for line in content.lines() {
                    let line = line.trim();
                    // Skip empty lines, comments, and PowerShell-style lines
                    if line.is_empty() || line.starts_with('#') || line.starts_with('$') {
                        continue;
                    }
                    if let Some((key, value)) = line.split_once('=') {
                        let key = key.trim().to_string();
                        let value = value.trim().to_string();
                        // Only valid env var names (alphanumeric + underscore)
                        if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                            info!("Setting env var: {}", key);
                            cmd.env(key, value);
                        }
                    }
                }
            }
        }

        let mut proc = match cmd.spawn() {
            Ok(p) => p,
            Err(e) => {
                let mut status = self.status.write().await;
                *status = ProcessStatus::Error(format!("Failed to start process: {}", e));
                drop(status);
                return Err(format!("Failed to start OpenClaude: {}", e));
            }
        };

        let pid_val = proc.id();

        let (stdout_reader, stderr_reader) = {
            let stdout = proc.stdout.take().ok_or("No stdout")?;
            let stderr = proc.stderr.take().ok_or("No stderr")?;
            let mut c = self.child.write().await;
            *c = Some(proc);
            (stdout, stderr)
        };

        let logs = Arc::clone(&self.logs);
        let tx = self.log_tx.clone();
        let status = Arc::clone(&self.status);
        let pid = Arc::clone(&self.pid);

        *pid.write().await = pid_val;

        let logs1 = Arc::clone(&logs);
        let tx1 = tx.clone();
        let status1 = Arc::clone(&status);
        
        let handle1 = tokio::spawn(async move {
            let _ = read_stream(stdout_reader, LogSource::Stdout, logs1, tx1, status1).await;
        });

        let handle2 = tokio::spawn(async move {
            let _ = read_stream(stderr_reader, LogSource::Stderr, logs, tx, status).await;
        });

        {
            let mut h = self.handles.write().await;
            *h = vec![handle1, handle2];
        }

        Ok(StatusInfo {
            status: ProcessStatus::Running,
            pid: pid_val,
        })
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut status = self.status.write().await;
        let mut child = self.child.write().await;
        let handles = self.handles.read().await;

        // Cancel all stream handlers
        for handle in handles.iter() {
            if !handle.is_finished() {
                handle.abort();
            }
        }

        if let Some(ref mut proc) = *child {
            info!("Stopping OpenClaude...");
            match proc.kill().await {
                Ok(_) => {
                    let _ = proc.wait().await;
                    info!("Process stopped cleanly");
                }
                Err(e) => {
                    warn!("Error stopping process: {}", e);
                }
            }
        }

        *child = None;
        *status = ProcessStatus::Offline;
        *self.pid.write().await = None;

        Ok(())
    }

    pub async fn restart(
        &self,
        executable: &str,
        args: &[String],
        working_dir: &str,
    ) -> Result<StatusInfo, String> {
        self.stop().await.ok();
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        self.start(executable, args, working_dir).await
    }

    pub async fn send_input(&self, input: &str) -> Result<(), String> {
        let mut child = self.child.write().await;
        if let Some(c) = child.as_mut() {
            if let Some(stdin) = c.stdin.as_mut() {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
                stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
        Err("Process not running or no stdin available".to_string())
    }

    pub async fn get_status(&self) -> StatusInfo {
        let status = self.status.read().await;
        let pid = self.pid.read().await;

        StatusInfo {
            status: status.clone(),
            pid: *pid,
        }
    }

    pub async fn get_logs(&self, limit: Option<usize>) -> Vec<LogEntry> {
        let logs = self.logs.read().await;
        let limit = limit.unwrap_or(500);
        logs.iter().rev().take(limit).cloned().collect()
    }

    pub async fn clear_logs(&self) {
        let mut logs = self.logs.write().await;
        logs.clear();
    }

    pub fn subscribe_logs(&self) -> broadcast::Receiver<String> {
        self.log_tx.subscribe()
    }
}

/// Strip ANSI/VT100 escape codes from text so the chat area shows clean output.
fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next(); // consume '['
                    // consume until alphabetic terminator
                    for ch in chars.by_ref() {
                        if ch.is_ascii_alphabetic() { break; }
                    }
                }
                Some(']') => {
                    chars.next(); // consume ']'
                    // consume until BEL or ST
                    for ch in chars.by_ref() {
                        if ch == '\x07' || ch == '\x1b' { break; }
                    }
                }
                _ => {
                    // single-char escape — skip next char
                    chars.next();
                }
            }
        } else if c == '\r' {
            // ignore carriage return
        } else {
            out.push(c);
        }
    }
    out
}

async fn read_stream<T>(
    mut reader: T,
    source: LogSource,
    logs: Arc<RwLock<VecDeque<LogEntry>>>,
    tx: broadcast::Sender<String>,
    status: Arc<RwLock<ProcessStatus>>,
) where
    T: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut buffer = [0u8; 4096];
    let mut first_output = true;

    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                info!("Stream closed for source {:?}", source);
                break;
            }
            Ok(n) => {
                let raw = String::from_utf8_lossy(&buffer[..n]).to_string();
                let text = strip_ansi(&raw);
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                let entry = LogEntry {
                    timestamp,
                    source: source.clone(),
                    message: text.clone(),
                };

                {
                    let mut logs_lock = logs.write().await;
                    logs_lock.push_back(entry);
                    if logs_lock.len() > 5000 {
                        logs_lock.pop_front();
                    }
                }

                // Send JSON with source so the frontend can distinguish stdout/stderr
                let source_str = match source {
                    LogSource::Stdout => "stdout",
                    LogSource::Stderr => "stderr",
                    LogSource::System => "system",
                };
                let payload = serde_json::json!({ "source": source_str, "message": text }).to_string();
                let _ = tx.send(payload);

                if first_output {
                    let mut status_lock = status.write().await;
                    if *status_lock == ProcessStatus::Starting {
                        *status_lock = ProcessStatus::Running;
                    }
                    first_output = false;
                }
            }
            Err(e) => {
                error!("Error reading stream {:?}: {}", source, e);
                break;
            }
        }
    }
}

