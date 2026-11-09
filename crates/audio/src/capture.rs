//! An output with no device: it takes samples from the pipe at a device's pace (sped up), writes
//! them as a device's format would carry them, and keeps the bytes. The tests compare those bytes
//! with the file's own PCM: what a device would have been given, bit for bit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::{DeviceSample, Fidelity, Mode, Output, PcmFormat, Pipe, Route, to_device};

/// What a capture output was given.
#[derive(Default, Debug)]
pub struct Capture {
    /// Each opening: the format it was opened for, the route, and the bytes of music it took
    /// (silence while paused or starved is not kept).
    pub opens: Vec<(PcmFormat, Route, Vec<u8>)>,
}

/// The capture output.
pub struct CaptureOutput {
    capture: Arc<Mutex<Capture>>,
    sample: Option<DeviceSample>,
    speed: u32,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CaptureOutput {
    /// An output recording into `capture`, in `sample` (by default, the narrowest format that
    /// carries the song's depth), `speed` times faster than a device.
    pub fn new(capture: Arc<Mutex<Capture>>, sample: Option<DeviceSample>, speed: u32) -> CaptureOutput {
        CaptureOutput {
            capture,
            sample,
            speed: speed.max(1),
            running: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }
}

impl Output for CaptureOutput {
    fn open(&mut self, format: PcmFormat, pipe: Arc<Pipe>) -> Result<Route, String> {
        self.close();
        let sample = self.sample.unwrap_or(if format.bits <= 16 {
            DeviceSample::I16
        } else if format.bits <= 24 {
            DeviceSample::I24
        } else {
            DeviceSample::I32
        });
        let route = Route {
            device: "capture".into(),
            mode: Mode::Exclusive,
            rate: format.rate,
            sample,
            fidelity: if sample.carries(format.bits) {
                Fidelity::BitPerfect
            } else {
                Fidelity::Converted
            },
        };
        let open = {
            let mut capture = self.capture.lock().unwrap_or_else(PoisonError::into_inner);
            capture.opens.push((format, route.clone(), Vec::new()));
            capture.opens.len() - 1
        };
        self.running.store(true, Ordering::SeqCst);
        let running = Arc::clone(&self.running);
        let capture = Arc::clone(&self.capture);
        let block = 256usize;
        let pause = Duration::from_secs_f64(block as f64 / f64::from(format.rate) / f64::from(self.speed));
        self.thread = Some(std::thread::spawn(move || {
            let channels = usize::from(format.channels);
            let mut samples = vec![0i32; block * channels];
            let mut bytes = vec![0u8; block * channels * sample.bytes()];
            while running.load(Ordering::SeqCst) {
                let taken = pipe.pull(&mut samples);
                if taken > 0 {
                    let count = taken * channels;
                    to_device(&samples[..count], format.bits, sample, &mut bytes);
                    let mut capture = capture.lock().unwrap_or_else(PoisonError::into_inner);
                    capture.opens[open]
                        .2
                        .extend_from_slice(&bytes[..count * sample.bytes()]);
                }
                std::thread::sleep(pause);
            }
        }));
        Ok(route)
    }

    fn close(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CaptureOutput {
    fn drop(&mut self) {
        self.close();
    }
}
