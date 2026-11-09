//! The service's configuration: its port, the roots it has open and, since S3, how people reach
//! it (sign-in, the instance's address, the home network, the proxies in front, SMTP), kept as
//! JSON in the system's configuration folder, readable by the service's person alone.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The default port (the owner's choice for S1): easy to remember and to bookmark.
pub const PORT: u16 = 4646;

/// The SMTP server codes and invitations are sent through.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct Smtp {
    /// Its host.
    pub host: String,
    /// Its port (465 for TLS, 587 for STARTTLS).
    pub port: u16,
    /// `tls`, `starttls`, or `none` (a server on the machine or in tests only).
    pub security: String,
    /// The account's name; empty for none.
    #[serde(default)]
    pub username: String,
    /// Its password, never sent back to the interface.
    #[serde(default)]
    pub password: String,
    /// The sender; the account's name if empty.
    #[serde(default)]
    pub from: String,
}

/// What the configuration file holds.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// The port it listens on.
    #[serde(default = "default_port")]
    pub port: u16,
    /// The folders it has open.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Whether people sign in (S3). Off, it answers on the machine only.
    #[serde(default)]
    pub signin: bool,
    /// The instance's own address (its public origin, such as `https://music.example.com`): the
    /// passkeys' RP ID is its host. Empty: `http://localhost:<port>`.
    #[serde(default)]
    pub address: String,
    /// With sign-in on, whether it also listens on the home network (every address).
    #[serde(default)]
    pub network: bool,
    /// The addresses whose `X-Forwarded-*` headers are believed (the proxy in front).
    #[serde(default = "default_proxies")]
    pub proxies: Vec<String>,
    /// The SMTP server, once set up.
    #[serde(default)]
    pub smtp: Option<Smtp>,
    /// The family library's folder (F1); empty: [`default_library`].
    #[serde(default)]
    pub library: String,
    /// Networks that count as this machine for an open instance (F5): in a container, the one
    /// the host reaches it from. `gateway` is the container's default gateway (the host).
    #[serde(default)]
    pub machine: Vec<String>,
}

fn default_port() -> u16 {
    PORT
}

fn default_proxies() -> Vec<String> {
    vec!["127.0.0.1".into(), "::1".into()]
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: PORT,
            roots: Vec::new(),
            signin: false,
            address: String::new(),
            network: false,
            proxies: default_proxies(),
            smtp: None,
            library: String::new(),
            machine: Vec::new(),
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
        let text = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        write_private(&temporary, &text)?;
        std::fs::rename(temporary, path)
    }
}

/// Writes a file only its owner can read (it may hold the SMTP password). On Windows the
/// profile's folder is the person's alone already.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::remove_file(path);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// Where the family library lives unless the configuration says otherwise: the person's own data
/// folder (`$XDG_DATA_HOME` or `~/.local/share` on Linux, `~/Library/Application Support` on
/// macOS, `%LOCALAPPDATA%` on Windows), in `jackbird/library`.
pub fn default_library() -> PathBuf {
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let base = if cfg!(windows) {
        var("LOCALAPPDATA").unwrap_or_else(|| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        var("HOME").map_or_else(|| PathBuf::from("."), |home| home.join("Library/Application Support"))
    } else {
        var("XDG_DATA_HOME")
            .unwrap_or_else(|| var("HOME").map_or_else(|| PathBuf::from("."), |home| home.join(".local/share")))
    };
    base.join("jackbird").join("library")
}

/// The people's database, beside the configuration.
pub fn database_path(config: &Path) -> PathBuf {
    config.with_file_name("jackbird.db")
}

/// The console's key, beside the configuration: the service writes it when it starts, and
/// `jackbird-service setup` and `signin off`, run by the same person, read it to act as an owner.
pub fn console_key_path(config: &Path) -> PathBuf {
    config.with_file_name("service.key")
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

/// A network, as `address/bits` (`172.17.0.1/32`, `10.0.0.0/8`), or an address alone.
pub fn parse_network(text: &str) -> Option<(std::net::IpAddr, u8)> {
    let (address, bits) = text.trim().split_once('/').unwrap_or((text.trim(), ""));
    let address: std::net::IpAddr = address.parse().ok()?;
    let most = if address.is_ipv4() { 32 } else { 128 };
    let bits = if bits.is_empty() { most } else { bits.parse().ok()? };
    (bits <= most).then_some((address, bits))
}

/// Whether `ip` is in a network.
pub fn in_network(ip: std::net::IpAddr, (network, bits): (std::net::IpAddr, u8)) -> bool {
    let ip = match ip {
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, std::net::IpAddr::V4),
        v4 => v4,
    };
    match (ip, network) {
        (std::net::IpAddr::V4(ip), std::net::IpAddr::V4(network)) => {
            let mask = if bits == 0 {
                0
            } else {
                u32::MAX << (32 - u32::from(bits))
            };
            u32::from(ip) & mask == u32::from(network) & mask
        }
        (std::net::IpAddr::V6(ip), std::net::IpAddr::V6(network)) => {
            let mask = if bits == 0 {
                0
            } else {
                u128::MAX << (128 - u32::from(bits))
            };
            u128::from(ip) & mask == u128::from(network) & mask
        }
        _ => false,
    }
}

/// The machine's default gateway, read from `/proc/net/route` (Linux; in a container, the host).
pub fn default_gateway() -> Option<std::net::IpAddr> {
    let routes = std::fs::read_to_string("/proc/net/route").ok()?;
    routes.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        (fields.get(1) == Some(&"00000000"))
            .then(|| u32::from_str_radix(fields.get(2)?, 16).ok())
            .flatten()
            .map(|gateway| std::net::IpAddr::V4(std::net::Ipv4Addr::from(gateway.swap_bytes())))
    })
}

/// The networks that count as this machine: `gateway` resolved, the rest parsed; unreadable ones
/// left out.
pub fn machine_networks(names: &[String]) -> Vec<(std::net::IpAddr, u8)> {
    names
        .iter()
        .filter_map(|name| {
            if name.trim() == "gateway" {
                default_gateway().map(|ip| (ip, 32))
            } else {
                parse_network(name)
            }
        })
        .collect()
}
