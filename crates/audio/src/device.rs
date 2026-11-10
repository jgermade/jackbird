//! The devices (the `device` feature): `cpal` for every system's shared output and for the
//! exclusive paths it can take, and each system's own exclusive path where it cannot.
//!
//! - **macOS**: CoreAudio through `cpal`, which sets the device's rate and physical format to the
//!   song's; exclusive is *hog mode* (`coreaudio-rs`), taken before the stream opens and given
//!   back when it closes.
//! - **Linux**: ALSA through `cpal`. Shared plays to the system's default (PipeWire or PulseAudio
//!   behind it); exclusive opens a `hw:` device itself, with no mixer and no resampling between.
//! - **Windows**: shared is WASAPI's shared mode through `cpal`; exclusive is WASAPI's exclusive
//!   mode (`wasapi`), which `cpal` does not speak.
//!
//! Each opening runs on a thread of its own, which owns the stream until it closes.

use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, DeviceId, SampleFormat, StreamConfig};

use crate::{DeviceInfo, DeviceSample, Fidelity, Mode, Output, PcmFormat, Pipe, Route, Settings, to_device};

/// Whether a device's id names an ALSA hardware device (Linux's exclusive path).
fn is_hardware(id: &str) -> bool {
    id.starts_with("hw:")
}

/// ALSA's names for the same hardware through plugins, left out of the list.
fn is_plugin_alias(id: &str) -> bool {
    [
        "plughw:",
        "front:",
        "surround",
        "dmix",
        "dsnoop",
        "iec958:",
        "hdmi:",
        "usbstream:",
        "sysdefault:",
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
}

fn inner_id(device: &Device) -> Option<String> {
    device.id().ok().map(|id| id.id().to_string())
}

fn name_of(device: &Device) -> String {
    device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| inner_id(device).unwrap_or_default())
}

/// The devices that can be chosen, the system's default first.
pub fn devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|device| inner_id(&device));
    let mut list: Vec<DeviceInfo> = host
        .output_devices()
        .map(|devices| devices.collect::<Vec<_>>())
        .unwrap_or_default()
        .iter()
        .filter_map(|device| {
            let id = device.id().ok()?;
            let inner = id.id().to_string();
            if cfg!(target_os = "linux") && is_plugin_alias(&inner) {
                return None;
            }
            let modes = if cfg!(target_os = "linux") {
                if is_hardware(&inner) {
                    vec![Mode::Exclusive]
                } else {
                    vec![Mode::Shared]
                }
            } else {
                vec![Mode::Shared, Mode::Exclusive]
            };
            Some(DeviceInfo {
                id: id.to_string(),
                name: name_of(device),
                default: default.as_deref() == Some(inner.as_str()),
                modes,
            })
        })
        .collect();
    list.sort_by_key(|device| !device.default);
    list
}

/// The device the settings name, or the system's default (on Linux, exclusive: its first `hw:`).
fn find(settings: &Settings) -> Result<Device, String> {
    let host = cpal::default_host();
    if let Some(id) = &settings.device
        && let Ok(id) = id.parse::<DeviceId>()
        && let Some(device) = host.device_by_id(&id)
    {
        return Ok(device);
    }
    if cfg!(target_os = "linux") && settings.mode == Mode::Exclusive {
        return host
            .output_devices()
            .map_err(|error| error.to_string())?
            .find(|device| inner_id(device).is_some_and(|id| is_hardware(&id)))
            .ok_or_else(|| "no sound card to play to exclusively".to_string());
    }
    host.default_output_device()
        .ok_or_else(|| "no device to play to".to_string())
}

fn device_sample(format: SampleFormat) -> Option<DeviceSample> {
    match format {
        SampleFormat::I16 => Some(DeviceSample::I16),
        SampleFormat::I24 => Some(DeviceSample::I24),
        SampleFormat::I32 => Some(DeviceSample::I32),
        SampleFormat::F32 => Some(DeviceSample::F32),
        _ => None,
    }
}

/// The device's formats that carry `bits`, best first; then the ones that reduce them.
fn preferences(bits: u32) -> [SampleFormat; 4] {
    if bits <= 16 {
        [
            SampleFormat::I16,
            SampleFormat::I24,
            SampleFormat::I32,
            SampleFormat::F32,
        ]
    } else if bits <= 24 {
        [
            SampleFormat::I24,
            SampleFormat::I32,
            SampleFormat::F32,
            SampleFormat::I16,
        ]
    } else {
        [
            SampleFormat::I32,
            SampleFormat::F32,
            SampleFormat::I24,
            SampleFormat::I16,
        ]
    }
}

/// The stream's format for a song: its rate and channels, in the format that carries its depth
/// best; `None` when the device lists no such rate (a shared device may still take it, converted).
fn choose(device: &Device, format: PcmFormat) -> Option<SampleFormat> {
    let ranges: Vec<_> = device
        .supported_output_configs()
        .map(|ranges| ranges.collect())
        .unwrap_or_default();
    preferences(format.bits).into_iter().find(|wanted| {
        ranges.iter().any(|range| {
            range.sample_format() == *wanted && range.channels() == format.channels && range.contains_rate(format.rate)
        })
    })
}

/// A device output, shared or exclusive.
pub struct DeviceOutput {
    settings: Settings,
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl DeviceOutput {
    /// The output for these settings; nothing is opened until a song plays.
    pub fn new(settings: &Settings) -> DeviceOutput {
        DeviceOutput {
            settings: settings.clone(),
            stop: None,
            thread: None,
        }
    }
}

impl Output for DeviceOutput {
    fn open(&mut self, format: PcmFormat, pipe: Arc<Pipe>) -> Result<Route, String> {
        self.close();
        let (ready, answer) = channel();
        let (stop, stopped) = channel::<()>();
        let settings = self.settings.clone();
        let thread = std::thread::Builder::new()
            .name("jackbird-audio-device".into())
            .spawn(move || {
                #[cfg(windows)]
                if settings.mode == Mode::Exclusive {
                    windows::run(&settings, format, pipe, ready, stopped);
                    return;
                }
                run(&settings, format, pipe, ready, stopped);
            })
            .map_err(|error| error.to_string())?;
        match answer.recv() {
            Ok(Ok(route)) => {
                self.stop = Some(stop);
                self.thread = Some(thread);
                Ok(route)
            }
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(message)
            }
            Err(_) => {
                let _ = thread.join();
                Err("the device's thread ended".to_string())
            }
        }
    }

    fn close(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for DeviceOutput {
    fn drop(&mut self) {
        self.close();
    }
}

/// Opens the stream with `cpal`, says how, and keeps it until told to stop.
fn run(
    settings: &Settings,
    format: PcmFormat,
    pipe: Arc<Pipe>,
    ready: Sender<Result<Route, String>>,
    stopped: std::sync::mpsc::Receiver<()>,
) {
    let device = match find(settings) {
        Ok(device) => device,
        Err(message) => {
            let _ = ready.send(Err(message));
            return;
        }
    };
    let name = name_of(&device);
    #[cfg(target_os = "macos")]
    let hogged = if settings.mode == Mode::Exclusive {
        match macos::hog(settings.device.as_ref().map(|_| name.as_str())) {
            Ok(id) => Some(id),
            Err(message) => {
                let _ = ready.send(Err(message));
                return;
            }
        }
    } else {
        None
    };
    let listed = choose(&device, format);
    // A shared device may take a rate it does not list (WASAPI converts it), as floats.
    let sample_format = match listed {
        Some(chosen) => chosen,
        None if settings.mode == Mode::Shared => SampleFormat::F32,
        None => {
            #[cfg(target_os = "macos")]
            if let Some(id) = hogged {
                macos::release(id);
            }
            let _ = ready.send(Err(format!(
                "{name} does not play {} channels at {} Hz",
                format.channels, format.rate
            )));
            return;
        }
    };
    let Some(sample) = device_sample(sample_format) else {
        return;
    };
    let config = StreamConfig {
        channels: format.channels,
        sample_rate: format.rate,
        buffer_size: cpal::BufferSize::Default,
    };
    let feed = Arc::clone(&pipe);
    let mut scratch: Vec<i32> = Vec::new();
    let stream = device.build_output_stream_raw(
        config,
        sample_format,
        move |data: &mut cpal::Data, _: &cpal::OutputCallbackInfo| {
            let bytes = data.bytes_mut();
            let count = bytes.len() / sample.bytes();
            if scratch.len() != count {
                scratch.resize(count, 0);
            }
            feed.pull(&mut scratch);
            to_device(&scratch, format.bits, sample, bytes);
        },
        |error| eprintln!("jackbird-audio: {error}"),
        None,
    );
    let stream = match stream.and_then(|stream| stream.play().map(|()| stream)) {
        Ok(stream) => stream,
        Err(error) => {
            #[cfg(target_os = "macos")]
            if let Some(id) = hogged {
                macos::release(id);
            }
            let _ = ready.send(Err(format!("{name}: {error}")));
            return;
        }
    };
    let carries = sample.carries(format.bits) && listed.is_some();
    let fidelity = match (settings.mode, carries) {
        (_, false) => Fidelity::Converted,
        (Mode::Exclusive, true) => Fidelity::BitPerfect,
        (Mode::Shared, true) => Fidelity::Mixer,
    };
    let _ = ready.send(Ok(Route {
        device: name,
        mode: settings.mode,
        rate: format.rate,
        sample,
        fidelity,
    }));
    let _ = stopped.recv();
    drop(stream);
    #[cfg(target_os = "macos")]
    if let Some(id) = hogged {
        macos::release(id);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! Hog mode: the device for this process alone, given back when the stream closes.

    use coreaudio::audio_unit::macos_helpers::{
        get_default_device_id, get_device_id_from_name, get_hogging_pid, toggle_hog_mode,
    };

    /// No process holds the device.
    const NOBODY: i32 = -1;

    fn me() -> i32 {
        std::process::id() as i32
    }

    /// Takes the device (by name; the default output when none) for this process.
    pub fn hog(name: Option<&str>) -> Result<u32, String> {
        let id = match name {
            Some(name) => get_device_id_from_name(name, false),
            None => get_default_device_id(false),
        }
        .ok_or_else(|| "the device is not there".to_string())?;
        let owner = get_hogging_pid(id).map_err(|error| format!("{error:?}"))?;
        if owner == me() {
            return Ok(id);
        }
        if owner != NOBODY {
            return Err("another app has the device for itself".to_string());
        }
        let owner = toggle_hog_mode(id).map_err(|error| format!("{error:?}"))?;
        if owner != me() {
            return Err("the device could not be taken for this app alone".to_string());
        }
        Ok(id)
    }

    /// Gives the device back, if this process still holds it.
    pub fn release(id: u32) {
        if get_hogging_pid(id).is_ok_and(|owner| owner == me()) {
            let _ = toggle_hog_mode(id);
        }
    }
}

#[cfg(windows)]
mod windows {
    //! WASAPI's exclusive mode: the device opened at the song's rate in a format that carries its
    //! depth, fed from the pipe each time it asks.

    use std::sync::Arc;
    use std::sync::mpsc::{Receiver, Sender, TryRecvError};

    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

    use crate::{DeviceSample, Fidelity, Mode, PcmFormat, Pipe, Route, Settings, to_device};

    fn text(error: impl std::fmt::Display) -> String {
        error.to_string()
    }

    /// The device's formats to try, best first: (bits stored, bits valid).
    fn candidates(bits: u32) -> [(usize, usize); 3] {
        if bits <= 16 {
            [(16, 16), (32, 24), (32, 32)]
        } else if bits <= 24 {
            [(32, 24), (32, 32), (16, 16)]
        } else {
            [(32, 32), (32, 24), (16, 16)]
        }
    }

    pub fn run(
        settings: &Settings,
        format: PcmFormat,
        pipe: Arc<Pipe>,
        ready: Sender<Result<Route, String>>,
        stopped: Receiver<()>,
    ) {
        let _ = initialize_mta();
        let opened = (|| -> Result<_, String> {
            let enumerator = DeviceEnumerator::new().map_err(text)?;
            let wanted = settings
                .device
                .as_ref()
                .and_then(|id| id.parse::<cpal::DeviceId>().ok())
                .map(|id| id.id().to_string());
            let device = match wanted.and_then(|id| enumerator.get_device(&id).ok()) {
                Some(device) => device,
                None => enumerator.get_default_device(Direction::Render).map_err(text)?,
            };
            let name = device.get_friendlyname().unwrap_or_else(|_| "the device".to_string());
            let mut client = device.get_iaudioclient().map_err(text)?;
            let mut chosen = None;
            for (stored, valid) in candidates(format.bits) {
                let wanted = WaveFormat::new(
                    stored,
                    valid,
                    SampleType::Int,
                    format.rate as usize,
                    usize::from(format.channels),
                    None,
                );
                if let Ok(supported) = client.is_supported_exclusive_with_quirks(&wanted) {
                    let sample = match (supported.get_bitspersample(), supported.get_validbitspersample()) {
                        (16, 16) => DeviceSample::I16,
                        (32, 24) => DeviceSample::I24High,
                        (32, 32) => DeviceSample::I32,
                        _ => continue,
                    };
                    chosen = Some((supported, sample));
                    break;
                }
            }
            let (wave, sample) =
                chosen.ok_or_else(|| format!("{name} does not play {} Hz exclusively", format.rate))?;
            let (default_period, _) = client.get_device_period().map_err(text)?;
            let period = client
                .calculate_aligned_period_near(default_period, Some(128), &wave)
                .unwrap_or(default_period);
            let mode = StreamMode::EventsExclusive { period_hns: period };
            if client.initialize_client(&wave, Direction::Render, mode, None).is_err() {
                // Some devices want the buffer aligned to their own size: once more with it.
                let frames = client.get_buffer_size().map_err(text)?;
                let period = wasapi::calculate_period_100ns(i64::from(frames), i64::from(format.rate));
                client = device.get_iaudioclient().map_err(text)?;
                let mode = StreamMode::EventsExclusive { period_hns: period };
                client
                    .initialize_client(&wave, Direction::Render, mode, None)
                    .map_err(|error| format!("{name}: {error}"))?;
            }
            let event = client.set_get_eventhandle().map_err(text)?;
            let render = client.get_audiorenderclient().map_err(text)?;
            Ok((name, client, event, render, wave, sample))
        })();
        let (name, client, event, render, wave, sample) = match opened {
            Ok(opened) => opened,
            Err(message) => {
                let _ = ready.send(Err(message));
                return;
            }
        };
        let channels = usize::from(format.channels);
        let block = wave.get_blockalign() as usize;
        let mut samples: Vec<i32> = Vec::new();
        let mut bytes: Vec<u8> = Vec::new();
        let mut write = |frames: usize| -> Result<(), String> {
            samples.resize(frames * channels, 0);
            bytes.resize(frames * block, 0);
            pipe.pull(&mut samples);
            to_device(&samples, format.bits, sample, &mut bytes);
            render.write_to_device(&bytes, None).map_err(text)
        };
        let started = client
            .get_available_space_in_frames()
            .map_err(text)
            .and_then(|frames| write(frames as usize))
            .and_then(|()| client.start_stream().map_err(text));
        if let Err(message) = started {
            let _ = ready.send(Err(format!("{name}: {message}")));
            return;
        }
        let _ = ready.send(Ok(Route {
            device: name,
            mode: Mode::Exclusive,
            rate: format.rate,
            sample,
            fidelity: if sample.carries(format.bits) {
                Fidelity::BitPerfect
            } else {
                Fidelity::Converted
            },
        }));
        loop {
            match stopped.try_recv() {
                Ok(()) | Err(TryRecvError::Disconnected) => break,
                Err(TryRecvError::Empty) => {}
            }
            if event.wait_for_event(1000).is_err() {
                break;
            }
            let frames = match client.get_available_space_in_frames() {
                Ok(frames) => frames as usize,
                Err(_) => break,
            };
            if frames > 0 && write(frames).is_err() {
                break;
            }
        }
        let _ = client.stop_stream();
    }
}
