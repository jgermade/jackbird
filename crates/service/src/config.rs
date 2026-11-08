//! The service's configuration: its port and the roots it has open, kept as JSON in the
//! system's configuration folder, so a restart reopens them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The default port (the owner's choice for S1): easy to remember and to bookmark.
pub const PORT: u16 = 4646;

/// What the configuration file holds.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct Config {
    /// The port it listens on, on the loopback address.
    #[serde(default = "default_port")]
    pub port: u16,
    /// The folders it has open.
    #[serde(default)]
    pub roots: Vec<String>,
}

fn default_port() -> u16 {
    PORT
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: PORT,
            roots: Vec::new(),
        }
    }
}

impl Config {
    /// Reads it; a missing file is the default, an unreadable one an error.
    pub fn load(path: &Path) -> Result<Config, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(error) => Err(format!("{}: {error}", path.display())),
        }
    }

    /// Writes it, through a new file renamed over the old one.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        std::fs::write(
            &temporary,
            serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(temporary, path)
    }
}

/// Where the configuration lives: `JACKBIRD_SERVICE_CONFIG` if set, else the system's own
/// configuration folder (`$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application
/// Support` on macOS, `%APPDATA%` on Windows), in `jackbird/service.json`.
pub fn default_path() -> PathBuf {
    if let Some(path) = std::env::var_os("JACKBIRD_SERVICE_CONFIG") {
        return PathBuf::from(path);
    }
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let base = if cfg!(windows) {
        var("APPDATA").unwrap_or_else(|| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        var("HOME").map_or_else(|| PathBuf::from("."), |home| home.join("Library/Application Support"))
    } else {
        var("XDG_CONFIG_HOME")
            .unwrap_or_else(|| var("HOME").map_or_else(|| PathBuf::from("."), |home| home.join(".config")))
    };
    base.join("jackbird").join("service.json")
}

/// The configuration of the person whose home this is, as `default_path` finds it when they run
/// it: for installing with the system, which runs as an administrator, for them.
pub fn path_in(home: &Path) -> PathBuf {
    let base = if cfg!(windows) {
        home.join("AppData").join("Roaming")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        home.join(".config")
    };
    base.join("jackbird").join("service.json")
}
