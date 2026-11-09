//! Bit-perfect through a real ALSA device (E5's "done when", in CI on Linux): the 24/96 FLAC
//! played exclusively to ALSA's loopback card (`snd-aloop`, `hw:Loopback,0`) and recorded from its
//! other end (`hw:Loopback,1`) is the file's PCM, sample for sample. It runs only where
//! `JACKBIRD_AUDIO_LOOPBACK` is set (the card must be loaded: `sudo modprobe snd-aloop`).

#![cfg(all(feature = "device", target_os = "linux"))]

mod common;

use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{decode_all, fixture};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{DeviceId, SampleFormat, StreamConfig};
use jackbird_audio::{DeviceOutput, Event, Fidelity, Mode, Player, Settings};

#[test]
fn a_24_96_flac_through_alsa_s_loopback_is_bit_perfect() {
    if std::env::var_os("JACKBIRD_AUDIO_LOOPBACK").is_none() {
        eprintln!("skipped: JACKBIRD_AUDIO_LOOPBACK is not set");
        return;
    }
    let host = cpal::default_host();
    let input = host
        .device_by_id(&"alsa:hw:Loopback,1".parse::<DeviceId>().unwrap())
        .expect("the loopback card is loaded");
    // The recording end opens first, in 32 bits, and the playing end then has its format.
    let ranges: Vec<_> = input.supported_input_configs().unwrap().collect();
    let format = [SampleFormat::I32, SampleFormat::I24]
        .into_iter()
        .find(|format| {
            ranges
                .iter()
                .any(|range| range.sample_format() == *format && range.contains_rate(96000))
        })
        .expect("the loopback records 24 or 32 bits at 96 kHz");
    let recorded = Arc::new(Mutex::new(Vec::<i32>::new()));
    let into = Arc::clone(&recorded);
    let stream = input
        .build_input_stream_raw(
            StreamConfig {
                channels: 2,
                sample_rate: 96000,
                buffer_size: cpal::BufferSize::Default,
            },
            format,
            move |data: &cpal::Data, _: &cpal::InputCallbackInfo| {
                let mut into = into.lock().unwrap();
                into.extend(data.bytes().chunks_exact(4).map(|word| {
                    let value = i32::from_ne_bytes(word.try_into().unwrap());
                    if format == SampleFormat::I32 { value >> 8 } else { value }
                }));
            },
            |error| eprintln!("recording: {error}"),
            None,
        )
        .expect("the recording opens");
    stream.play().unwrap();

    let settings = Settings {
        mode: Mode::Exclusive,
        device: Some("alsa:hw:Loopback,0".into()),
    };
    let (sender, events) = channel();
    let player = Player::new(
        Box::new(|settings: &Settings| Box::new(DeviceOutput::new(settings)) as Box<dyn jackbird_audio::Output>),
        settings,
        move |event| {
            let _ = sender.send(event);
        },
    );
    player.load(&fixture("flac-24-96.flac"), "one", 0.0, true);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut route = None;
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .expect("the song ended in time");
        match events.recv_timeout(left).expect("an event") {
            Event::Started { route: started, .. } => route = Some(started),
            Event::Ended { .. } => break,
            Event::Failed { message, .. } => panic!("{message}"),
        }
    }
    let route = route.expect("it started");
    eprintln!("route: {route:?}");
    assert_eq!(route.fidelity, Fidelity::BitPerfect);
    assert_eq!(route.rate, 96000);
    std::thread::sleep(Duration::from_millis(300));
    drop(stream);

    let (_, samples) = decode_all("flac-24-96.flac");
    let recorded = recorded.lock().unwrap();
    // Silence before the song (the recording started first): from the first sound on, it is the song.
    let first = |samples: &[i32]| samples.iter().position(|sample| *sample != 0).unwrap() / 2 * 2;
    let (from_file, from_card) = (first(&samples), first(&recorded));
    let song = &samples[from_file..];
    assert!(recorded.len() >= from_card + song.len(), "the whole song was recorded");
    assert_eq!(&recorded[from_card..from_card + song.len()], song, "sample for sample");
}
