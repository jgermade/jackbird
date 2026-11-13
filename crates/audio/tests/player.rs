//! The player with the capture output: what a device would be given is the files' own PCM, bit
//! for bit; the next song of the same format follows in the same opening (gapless); another
//! format reopens the output; seeking, pausing and the events.

mod common;

use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{decode_all, fixture, pcm_bytes};
use jackbird_audio::{Capture, CaptureOutput, DeviceSample, Event, Fidelity, Player, Settings};

fn player(sample: Option<DeviceSample>) -> (Player, Arc<Mutex<Capture>>, Receiver<Event>) {
    paced(sample, 40)
}

fn paced(sample: Option<DeviceSample>, speed: u32) -> (Player, Arc<Mutex<Capture>>, Receiver<Event>) {
    let capture = Arc::new(Mutex::new(Capture::default()));
    let outputs = {
        let capture = Arc::clone(&capture);
        Box::new(move |_: &Settings| {
            Box::new(CaptureOutput::new(Arc::clone(&capture), sample, speed)) as Box<dyn jackbird_audio::Output>
        })
    };
    let (sender, events) = channel();
    let player = Player::new(outputs, Settings::default(), move |event| {
        let _ = sender.send(event);
    });
    (player, capture, events)
}

/// Events until `last` comes (or ten seconds pass).
fn until(events: &Receiver<Event>, last: impl Fn(&Event) -> bool) -> Vec<Event> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match events.recv_timeout(left) {
            Ok(event) => {
                let done = last(&event);
                seen.push(event);
                if done {
                    return seen;
                }
            }
            Err(_) => break,
        }
    }
    panic!("not there in time; seen: {seen:?}");
}

fn ended(event: &Event) -> bool {
    matches!(event, Event::Ended { .. })
}

fn started(event: &Event) -> Option<&str> {
    match event {
        Event::Started { key, .. } => Some(key),
        _ => None,
    }
}

/// The device's bytes for a whole file, written in 24-in-32 (`I24`) or 16 bits.
fn device_bytes(samples: &[i32], bits: u32, sample: DeviceSample) -> Vec<u8> {
    let mut bytes = vec![0u8; samples.len() * sample.bytes()];
    jackbird_audio::to_device(samples, bits, sample, &mut bytes);
    bytes
}

#[test]
fn a_24_96_flac_reaches_the_device_bit_for_bit() {
    let (player, capture, events) = player(None);
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, true);
    let seen = until(&events, ended);
    match &seen[0] {
        Event::Started {
            key,
            codec,
            format,
            route,
            duration,
        } => {
            assert_eq!(key, "one");
            assert_eq!(codec, "FLAC");
            assert_eq!((format.rate, format.bits, format.channels), (96000, 24, 2));
            assert_eq!(route.rate, 96000);
            assert_eq!(route.fidelity, Fidelity::BitPerfect);
            assert!((duration.unwrap() - 0.25).abs() < 1e-9);
        }
        other => panic!("{other:?}"),
    }
    let (_, samples) = decode_all("flac-24-96.flac");
    let capture = capture.lock().unwrap();
    assert_eq!(capture.opens.len(), 1);
    let (_, route, bytes) = &capture.opens[0];
    assert_eq!(route.sample, DeviceSample::I24);
    assert_eq!(*bytes, device_bytes(&samples, 24, DeviceSample::I24));
    // The same samples as FLAC's own PCM, once the 24 bits are taken out of their 32.
    let back: Vec<i32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|word| i32::from_ne_bytes(*word))
        .collect();
    assert_eq!(pcm_bytes(&back, 24), pcm_bytes(&samples, 24));
}

#[test]
fn the_next_song_of_the_same_format_follows_without_a_gap() {
    let (player, capture, events) = player(None);
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, true);
    player.set_next(Some((&fixture("flac-24-96-b.flac"), "two")));
    let seen = until(&events, ended);
    let keys: Vec<&str> = seen.iter().filter_map(started).collect();
    assert_eq!(keys, ["one", "two"]);
    assert!(matches!(seen.last(), Some(Event::Ended { key }) if key == "two"));
    let (_, one) = decode_all("flac-24-96.flac");
    let (_, two) = decode_all("flac-24-96-b.flac");
    let capture = capture.lock().unwrap();
    assert_eq!(capture.opens.len(), 1, "one opening: the device never stopped");
    let mut both = one.clone();
    both.extend_from_slice(&two);
    assert_eq!(
        capture.opens[0].2,
        device_bytes(&both, 24, DeviceSample::I24),
        "sample after sample"
    );
}

#[test]
fn a_next_song_of_another_format_reopens_the_output_at_its_rate() {
    let (player, capture, events) = player(None);
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, true);
    player.set_next(Some((&fixture("flac-16-44.flac"), "two")));
    let seen = until(&events, ended);
    let keys: Vec<&str> = seen.iter().filter_map(started).collect();
    assert_eq!(keys, ["one", "two"]);
    let (_, one) = decode_all("flac-24-96.flac");
    let (_, two) = decode_all("flac-16-44.flac");
    let capture = capture.lock().unwrap();
    assert_eq!(capture.opens.len(), 2);
    assert_eq!(capture.opens[0].1.rate, 96000);
    assert_eq!(capture.opens[0].2, device_bytes(&one, 24, DeviceSample::I24));
    assert_eq!(capture.opens[1].1.rate, 44100);
    assert_eq!(capture.opens[1].1.sample, DeviceSample::I16);
    assert_eq!(capture.opens[1].2, device_bytes(&two, 16, DeviceSample::I16));
}

#[test]
fn a_device_that_cannot_carry_the_depth_is_said_to_convert() {
    let (player, capture, events) = player(Some(DeviceSample::I16));
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, true);
    let seen = until(&events, ended);
    assert!(matches!(&seen[0], Event::Started { route, .. } if route.fidelity == Fidelity::Converted));
    let (_, samples) = decode_all("flac-24-96.flac");
    assert_eq!(
        capture.lock().unwrap().opens[0].2,
        device_bytes(&samples, 24, DeviceSample::I16)
    );
}

#[test]
fn a_floating_point_device_carries_24_bits_exactly() {
    let (player, capture, events) = player(Some(DeviceSample::F32));
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, true);
    let seen = until(&events, ended);
    assert!(matches!(&seen[0], Event::Started { route, .. } if route.fidelity == Fidelity::BitPerfect));
    let (_, samples) = decode_all("flac-24-96.flac");
    let capture = capture.lock().unwrap();
    let back: Vec<i32> = capture.opens[0]
        .2
        .as_chunks::<4>()
        .0
        .iter()
        .map(|word| (f32::from_ne_bytes(*word) * (1u32 << 23) as f32) as i32)
        .collect();
    assert_eq!(back, samples);
}

#[test]
fn seeking_plays_from_the_frame_and_the_position_follows() {
    let (player, capture, events) = player(None);
    player.load(&fixture("flac-24-96.flac"), "one", 0.1, true);
    until(&events, ended);
    let (_, samples) = decode_all("flac-24-96.flac");
    assert_eq!(
        capture.lock().unwrap().opens[0].2,
        device_bytes(&samples[9600 * 2..], 24, DeviceSample::I24)
    );
}

#[test]
fn a_paused_song_takes_nothing_until_it_plays() {
    let (player, capture, events) = player(None);
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, false);
    until(&events, |event| started(event).is_some());
    std::thread::sleep(Duration::from_millis(200));
    let status = player.status();
    assert_eq!(status.key.as_deref(), Some("one"));
    assert!(!status.playing);
    assert_eq!(status.position, 0.0);
    assert!(capture.lock().unwrap().opens[0].2.is_empty());
    player.play();
    until(&events, ended);
    assert_eq!(capture.lock().unwrap().opens[0].2.len(), 24000 * 2 * 4);
}

#[test]
fn a_changed_next_song_replaces_what_was_decoded_ahead() {
    let (player, capture, events) = player(None);
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, false);
    player.set_next(Some((&fixture("flac-24-96-b.flac"), "two")));
    // Paused, the decoder fills the pipe: "two" is decoded ahead of time.
    std::thread::sleep(Duration::from_millis(300));
    player.set_next(Some((&fixture("flac-24-96.flac"), "three")));
    player.play();
    let seen = until(&events, ended);
    let keys: Vec<&str> = seen.iter().filter_map(started).collect();
    assert_eq!(keys, ["one", "three"]);
    let (_, one) = decode_all("flac-24-96.flac");
    let mut both = one.clone();
    both.extend_from_slice(&one);
    assert_eq!(
        capture.lock().unwrap().opens[0].2,
        device_bytes(&both, 24, DeviceSample::I24)
    );
}

#[test]
fn a_missing_file_is_said_to_fail() {
    let (player, _, events) = player(None);
    player.load(std::path::Path::new("/nowhere/at/all.flac"), "gone", 0.0, true);
    let seen = until(&events, |event| matches!(event, Event::Failed { .. }));
    assert!(matches!(&seen[0], Event::Failed { key, .. } if key == "gone"));
}

#[test]
fn the_spectrum_shows_the_tones_played() {
    // At a device's own pace, so the song is still playing when the spectrum is read.
    let (player, _, events) = paced(None, 1);
    player.load(&fixture("flac-16-44.flac"), "one", 0.0, true);
    until(&events, |event| started(event).is_some());
    // Long enough for the 8192 frames the spectrum reads (186 ms at 44.1 kHz).
    std::thread::sleep(Duration::from_millis(250));
    let (bins, rate) = player.spectrum().expect("it plays");
    assert_eq!(rate, 44100);
    assert_eq!(bins.len(), 4096);
    // 440 and 880 Hz: bins 82 and 163 at 44.1 kHz over 8192 points.
    let loudest = bins.iter().enumerate().max_by_key(|(_, level)| **level).unwrap().0;
    assert!((78..=168).contains(&loudest), "{loudest}");
    assert!(bins[1600] < bins[loudest], "nothing up at 8.6 kHz");
}
