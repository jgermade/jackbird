//! The machine the service runs on, for its owners (Preferences, Server): how busy its CPU is, its
//! GPUs' load and temperature where they say, and its temperature sensors. See
//! RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-19 02:32, plan D, the owner's choice (a)).
//!
//! The CPU and the sensors come from `sysinfo` (Linux's hwmon, macOS's SMC, Windows' WMI, which
//! often gives nothing without an administrator's rights). The GPUs from `nvidia-smi` where it is
//! installed (Linux, Windows) and, on Linux, AMD's from `/sys/class/drm`. What a system does not
//! tell is left out, never made up.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use axum::extract::State;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::Value;

use crate::{Answer, Service, blocking};

/// The routes, for owners: `GET /api/machine`.
pub fn owners() -> Router<Arc<Service>> {
    Router::new().route("/machine", axum::routing::get(machine))
}

/// The CPU: how busy, in percent of all its cores, how many, and its name.
#[derive(Debug, Serialize, PartialEq)]
pub struct Cpu {
    pub percent: f32,
    pub cores: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A GPU: its name, and its load and temperature where it tells them.
#[derive(Debug, Serialize, PartialEq)]
pub struct Gpu {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub celsius: Option<f32>,
}

/// A temperature sensor.
#[derive(Debug, Serialize, PartialEq)]
pub struct Sensor {
    pub label: String,
    pub celsius: f32,
}

/// The answer.
#[derive(Debug, Serialize)]
pub struct Reading {
    pub cpu: Cpu,
    pub gpus: Vec<Gpu>,
    pub temperatures: Vec<Sensor>,
}

/// The CPU's counters, kept between answers: its usage is the time between two readings, so a
/// reading needs no wait unless the last one is too recent or there was none.
struct Probe {
    system: sysinfo::System,
    last: Option<Instant>,
}

fn probe() -> &'static Mutex<Probe> {
    static PROBE: OnceLock<Mutex<Probe>> = OnceLock::new();
    PROBE.get_or_init(|| {
        Mutex::new(Probe {
            system: sysinfo::System::new(),
            last: None,
        })
    })
}

async fn machine(State(_): State<Arc<Service>>) -> Answer<Json<Value>> {
    let reading = blocking(|| Ok(read())).await?;
    Ok(Json(serde_json::to_value(reading).unwrap_or(Value::Null)))
}

/// Reads the machine (blocking: up to sysinfo's minimum interval, and `nvidia-smi`).
pub fn read() -> Reading {
    Reading {
        cpu: cpu(),
        gpus: gpus(),
        temperatures: temperatures(),
    }
}

fn cpu() -> Cpu {
    let mut probe = probe().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let fresh = probe
        .last
        .is_some_and(|last| last.elapsed() >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    if !fresh {
        // No reading to measure from yet, or one too recent: two, the shortest time apart.
        probe.system.refresh_cpu_usage();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    }
    probe.system.refresh_cpu_usage();
    probe.last = Some(Instant::now());
    let cpus = probe.system.cpus();
    let name = cpus
        .first()
        .map(|cpu| cpu.brand().trim().to_owned())
        .filter(|name| !name.is_empty());
    Cpu {
        percent: round(probe.system.global_cpu_usage()),
        cores: cpus.len(),
        name,
    }
}

fn temperatures() -> Vec<Sensor> {
    let components = sysinfo::Components::new_with_refreshed_list();
    let mut sensors: Vec<Sensor> = components
        .iter()
        .filter_map(|component| {
            let celsius = component.temperature().filter(|celsius| plausible(*celsius))?;
            Some(Sensor {
                label: component.label().trim().to_owned(),
                celsius: round(celsius),
            })
        })
        .collect();
    sensors.sort_by(|a, b| b.celsius.total_cmp(&a.celsius));
    sensors
}

fn gpus() -> Vec<Gpu> {
    let mut gpus = nvidia();
    if cfg!(target_os = "linux") {
        gpus.extend(amd(Path::new("/sys/class/drm")));
    }
    gpus
}

/// NVIDIA's GPUs, as `nvidia-smi` tells them; none where it is not installed or answers nothing.
fn nvidia() -> Vec<Gpu> {
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    match out {
        Ok(out) if out.status.success() => parse_nvidia(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// `nvidia-smi`'s lines read: `name, percent, celsius`, with `[N/A]` (or anything not a number)
/// left out. The name may hold commas: the two numbers are the last two fields.
pub(crate) fn parse_nvidia(text: &str) -> Vec<Gpu> {
    text.lines()
        .filter_map(|line| {
            let mut fields: Vec<&str> = line.rsplitn(3, ',').map(str::trim).collect();
            if fields.len() != 3 {
                return None;
            }
            fields.reverse();
            let number = |field: &str| field.parse::<f32>().ok().filter(|value| value.is_finite());
            let name = fields[0].to_owned();
            (!name.is_empty()).then(|| Gpu {
                name,
                percent: number(fields[1]).map(round),
                celsius: number(fields[2]).filter(|celsius| plausible(*celsius)).map(round),
            })
        })
        .collect()
}

/// AMD's GPUs on Linux: each `card<N>` whose device tells its load (`gpu_busy_percent`, amdgpu's),
/// its temperature from its hwmon (`temp1_input`, in millidegrees). Under `drm` (a fake one in tests).
pub(crate) fn amd(drm: &Path) -> Vec<Gpu> {
    let Ok(entries) = std::fs::read_dir(drm) else {
        return Vec::new();
    };
    let mut cards: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("card"))
                .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        })
        .collect();
    cards.sort();
    cards
        .iter()
        .filter_map(|card| {
            let device = card.join("device");
            let percent = read_number(&device.join("gpu_busy_percent"))?;
            let celsius = std::fs::read_dir(device.join("hwmon"))
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .find_map(|hwmon| read_number(&hwmon.path().join("temp1_input")))
                .map(|milli| milli / 1000.0)
                .filter(|celsius| plausible(*celsius));
            let name = std::fs::read_to_string(device.join("product_name"))
                .ok()
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "AMD GPU".to_owned());
            Some(Gpu {
                name,
                percent: Some(round(percent)),
                celsius: celsius.map(round),
            })
        })
        .collect()
}

fn read_number(path: &Path) -> Option<f32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// A temperature a sensor could really read (some report 0, -273 or 255 when they have none).
fn plausible(celsius: f32) -> bool {
    celsius.is_finite() && celsius > 0.0 && celsius < 150.0
}

/// One decimal.
fn round(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}
