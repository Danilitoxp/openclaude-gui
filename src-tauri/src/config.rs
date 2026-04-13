use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Theme {
    pub dark: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub openclaude_path: String,
    pub args: Vec<String>,
    pub working_dir: String,
    pub port: u16,
    pub startup_timeout_ms: u32,
    /// "dark" or "light"
    pub theme: String,
    pub start_with_windows: bool,
    pub auto_scroll: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            openclaude_path: "node".to_string(),
            args: vec!["dist/cli.mjs".to_string()],
            working_dir: ".".to_string(),
            port: 3000,
            startup_timeout_ms: 30000,
            theme: "dark".to_string(),
            start_with_windows: false,
            auto_scroll: true,
        }
    }
}

#[allow(dead_code)]
pub struct ConfigManager {
    config: AppConfig,
}

#[allow(dead_code)]
impl ConfigManager {
    pub fn create_default() -> Self {
        Self {
            config: AppConfig::default(),
        }
    }

    pub fn new_from_file(config_path: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let config = if config_path.exists() {
            let content = fs::read_to_string(&config_path)?;
            serde_json::from_str(&content)?
        } else {
            AppConfig::default()
        };

        Ok(Self { config })
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
        let content = serde_json::to_string_pretty(&self.config)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}
