//! The player: a thread that decodes the song playing (and the next one, when it has the same
//! format: gapless) into the pipe, opens the output for each format, and says what happens.
//!
//! The interface keeps the queue; it tells the player the song to play ([`Player::load`]) and the
//! one after it ([`Player::set_next`]), and hears back when a song starts sounding (also the next
//! one, by itself: [`Event::Started`]), when the last one ends, and when one cannot be played (it
//! then plays that song in the embedded output instead).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;

use crate::spectrum::{SIZE, Spectrum};
use crate::{Output, Outputs, PcmFormat, Pipe, Route, Settings, Source};

/// What the player tells the interface.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum Event {
    /// A song started sounding: the one loaded, or the next one, by itself.
    Started {
        /// The interface's name for the song.
        key: String,
        /// "FLAC" or "MP3".
        codec: String,
        /// What it decodes to.
        format: PcmFormat,
        /// Where it plays, and how.
        route: Route,
        /// Its length in seconds, when the file says.
        duration: Option<f64>,
    },
    /// The song ended and there is no next one.
    Ended {
        /// The interface's name for the song.
        key: String,
    },
    /// A song could not be played (its file, or the device); nothing plays.
    Failed {
        /// The interface's name for the song.
        key: String,
        /// Why.
        message: String,
    },
}

/// Where the player is.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Status {
    /// The song sounding (the interface's name for it).
    pub key: Option<String>,
    /// Whether it plays (not paused, not ended).
    pub playing: bool,
    /// Seconds into it.
    pub position: f64,
    /// Its length in seconds, when the file says.
    pub duration: Option<f64>,
    /// "FLAC" or "MP3".
    pub codec: Option<String>,
    /// What it decodes to.
    pub format: Option<PcmFormat>,
    /// Where it plays.
    pub route: Option<Route>,
}

enum Command {
    Load {
        path: PathBuf,
        key: String,
        at: f64,
        play: bool,
    },
    Next(Option<(PathBuf, String)>),
    Play,
    Pause,
    Seek(f64),
    Stop,
    Configure(Settings),
    Quit,
}

/// How far ahead the decoder keeps the pipe, in seconds.
const AHEAD: f64 = 0.5;

struct Song {
    serial: u64,
    path: PathBuf,
    key: String,
    source: Option<Source>,
    exhausted: bool,
}

#[derive(Clone)]
struct Info {
    serial: u64,
    key: String,
    codec: String,
    format: PcmFormat,
    duration: Option<f64>,
}

struct Engine {
    outputs: Outputs,
    settings: Settings,
    output: Option<Box<dyn Output>>,
    pipe: Arc<Mutex<Option<Arc<Pipe>>>>,
    route: Option<Route>,
    /// The song whose samples are being put in the pipe.
    decoding: Option<Song>,
    /// The song decoded before it, while it may still be sounding (gapless).
    previous: Option<Song>,
    /// The song after it.
    next: Option<Song>,
    infos: VecDeque<Info>,
    playing: bool,
    ended: bool,
    serials: u64,
    events: Box<dyn Fn(Event) + Send>,
    status: Arc<Mutex<Status>>,
}

impl Engine {
    fn pipe(&self) -> Option<Arc<Pipe>> {
        self.pipe.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn set_pipe(&self, pipe: Option<Arc<Pipe>>) {
        *self.pipe.lock().unwrap_or_else(PoisonError::into_inner) = pipe;
    }

    fn song(&mut self, path: PathBuf, key: String) -> Song {
        self.serials += 1;
        Song {
            serial: self.serials,
            path,
            key,
            source: None,
            exhausted: false,
        }
    }

    /// Opens a song's file if it is not open; false (and says so) when it cannot be.
    fn ready(&mut self, song: &mut Song) -> bool {
        if song.source.is_some() {
            return true;
        }
        match Source::open(&song.path) {
            Ok(source) => {
                self.infos.push_back(Info {
                    serial: song.serial,
                    key: song.key.clone(),
                    codec: source.codec().to_string(),
                    format: source.format(),
                    duration: source.duration(),
                });
                while self.infos.len() > 8 {
                    self.infos.pop_front();
                }
                song.source = Some(source);
                true
            }
            Err(message) => {
                (self.events)(Event::Failed {
                    key: song.key.clone(),
                    message,
                });
                false
            }
        }
    }

    fn close(&mut self) {
        if let Some(mut output) = self.output.take() {
            output.close();
        }
        self.set_pipe(None);
        self.route = None;
    }

    /// Plays `song` from `at` seconds, reusing the output when its format is the same.
    fn start(&mut self, mut song: Song, at: f64, play: bool, reopen: bool) {
        if !self.ready(&mut song) {
            self.stop();
            return;
        }
        let Some(source) = song.source.as_mut() else { return };
        let format = source.format();
        let from = if at > 0.0 {
            match source.seek(at) {
                Ok(from) => from,
                Err(message) => {
                    (self.events)(Event::Failed { key: song.key, message });
                    self.stop();
                    return;
                }
            }
        } else {
            0
        };
        song.exhausted = false;
        let reuse = !reopen && self.output.is_some() && self.pipe().is_some_and(|pipe| pipe.format() == format);
        if reuse && let Some(pipe) = self.pipe() {
            pipe.restart(song.serial, from);
            pipe.set_paused(!play);
        } else {
            self.close();
            let pipe = Arc::new(Pipe::new(
                format,
                crate::pipe::Mark {
                    at: 0,
                    song: song.serial,
                    from,
                },
            ));
            pipe.set_paused(!play);
            let mut output = (self.outputs)(&self.settings);
            match output.open(format, Arc::clone(&pipe)) {
                Ok(route) => {
                    self.route = Some(route);
                    self.output = Some(output);
                    self.set_pipe(Some(pipe));
                }
                Err(message) => {
                    (self.events)(Event::Failed { key: song.key, message });
                    self.stop();
                    return;
                }
            }
        }
        self.previous = None;
        self.decoding = Some(song);
        self.playing = play;
        self.ended = false;
    }

    fn stop(&mut self) {
        self.close();
        self.decoding = None;
        self.previous = None;
        self.next = None;
        self.playing = false;
    }

    /// Takes back the next song's samples already in the pipe: the song decoding becomes the one
    /// sounding again, and the next one is to be opened again from its start.
    fn take_back(&mut self) {
        if let Some(previous) = self.previous.take() {
            if let Some(pipe) = self.pipe() {
                pipe.drop_ahead();
            }
            if let Some(mut ahead) = self.decoding.replace(previous) {
                ahead.source = None;
                ahead.exhausted = false;
                if self.next.is_none() {
                    self.next = Some(ahead);
                }
            }
        }
    }

    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::Load { path, key, at, play } => {
                self.take_back();
                self.next = None;
                let song = self.song(path, key);
                self.start(song, at, play, false);
            }
            Command::Next(next) => {
                let is = |song: Option<&Song>| {
                    matches!((song, &next), (Some(song), Some((path, key))) if song.key == *key && song.path == *path)
                        || (song.is_none() && next.is_none())
                };
                // When the next song is already in the pipe, the song decoding is it.
                let already = if self.previous.is_some() {
                    is(self.decoding.as_ref())
                } else {
                    is(self.next.as_ref())
                };
                if !already {
                    self.take_back();
                    self.next = next.map(|(path, key)| self.song(path, key));
                }
            }
            Command::Play => {
                if let Some(pipe) = self.pipe()
                    && !self.ended
                {
                    pipe.set_paused(false);
                    self.playing = true;
                }
            }
            Command::Pause => {
                if let Some(pipe) = self.pipe() {
                    pipe.set_paused(true);
                }
                self.playing = false;
            }
            Command::Seek(at) => {
                self.take_back();
                if let Some(song) = self.decoding.take() {
                    let play = self.playing;
                    self.start(song, at, play, false);
                }
            }
            Command::Stop => self.stop(),
            Command::Configure(settings) => {
                if settings != self.settings {
                    self.settings = settings;
                    self.take_back();
                    if let Some(song) = self.decoding.take() {
                        let at = self.position().1;
                        let play = self.playing;
                        let next = self.next.take();
                        let mut song = song;
                        song.source = None;
                        self.start(song, at, play, true);
                        self.next = next;
                    }
                }
            }
            Command::Quit => {
                self.stop();
                return false;
            }
        }
        true
    }

    /// Keeps the pipe [`AHEAD`] seconds full; true while there is more to decode now.
    fn feed(&mut self) {
        let Some(pipe) = self.pipe() else { return };
        let format = pipe.format();
        let target = (AHEAD * f64::from(format.rate)) as u64;
        while pipe.queued() < target {
            let Some(song) = self.decoding.as_mut() else { return };
            if !song.exhausted {
                let Some(source) = song.source.as_mut() else { return };
                match source.next_block() {
                    Ok(Some(block)) => pipe.push(block),
                    Ok(None) => song.exhausted = true,
                    Err(message) => {
                        (self.events)(Event::Failed {
                            key: song.key.clone(),
                            message,
                        });
                        song.exhausted = true;
                    }
                }
                continue;
            }
            // The song is all in the pipe: the next one follows it there if it has its format.
            let Some(mut next) = self.next.take() else { return };
            if !self.ready(&mut next) {
                continue;
            }
            if next.source.as_ref().map(Source::format) != Some(format) {
                self.next = Some(next);
                return;
            }
            pipe.mark(next.serial, 0);
            self.previous = self.decoding.replace(next);
        }
    }

    /// The song sounding and its position in seconds.
    fn position(&self) -> (Option<u64>, f64) {
        match self.pipe() {
            Some(pipe) => {
                let (song, frame) = pipe.position();
                (Some(song), frame as f64 / f64::from(pipe.format().rate))
            }
            None => (None, 0.0),
        }
    }

    /// Says when a song starts sounding, moves on to a next song of another format once the pipe
    /// has run dry, and says when the last one ended.
    fn watch(&mut self) {
        let Some(pipe) = self.pipe() else { return };
        for sounding in pipe.take_started() {
            if self.decoding.as_ref().is_some_and(|song| song.serial == sounding) {
                self.previous = None;
            }
            if let (Some(info), Some(route)) = (
                self.infos.iter().find(|info| info.serial == sounding).cloned(),
                self.route.clone(),
            ) {
                (self.events)(Event::Started {
                    key: info.key,
                    codec: info.codec,
                    format: info.format,
                    route,
                    duration: info.duration,
                });
            }
        }
        let drained = self.decoding.as_ref().is_some_and(|song| song.exhausted) && pipe.queued() == 0;
        if !drained || self.ended {
            return;
        }
        if let Some(next) = self.next.take() {
            let play = self.playing;
            self.start(next, 0.0, play, false);
            return;
        }
        self.ended = true;
        self.playing = false;
        if let Some(song) = &self.decoding {
            (self.events)(Event::Ended { key: song.key.clone() });
        }
        // An exclusive device is given back once nothing more is to play.
        self.close();
    }

    fn publish(&self) {
        let (sounding, position) = self.position();
        let info = sounding.and_then(|serial| self.infos.iter().find(|info| info.serial == serial));
        let mut status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
        *status = Status {
            key: info.map(|info| info.key.clone()),
            playing: self.playing && !self.ended,
            position,
            duration: info.and_then(|info| info.duration),
            codec: info.map(|info| info.codec.clone()),
            format: info.map(|info| info.format),
            route: self.route.clone(),
        };
    }

    fn run(mut self, commands: Receiver<Command>) {
        loop {
            let hungry = self
                .pipe()
                .is_some_and(|pipe| pipe.queued() < (AHEAD * f64::from(pipe.format().rate)) as u64 / 2);
            let wait = Duration::from_millis(if hungry { 2 } else { 15 });
            match commands.recv_timeout(wait) {
                Ok(command) => {
                    if !self.handle(command) {
                        return;
                    }
                    // Commands that came together are taken together.
                    while let Ok(command) = commands.try_recv() {
                        if !self.handle(command) {
                            return;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.stop();
                    return;
                }
            }
            self.feed();
            self.watch();
            self.publish();
        }
    }
}

/// The native player.
pub struct Player {
    commands: Sender<Command>,
    status: Arc<Mutex<Status>>,
    pipe: Arc<Mutex<Option<Arc<Pipe>>>>,
    spectrum: Mutex<Spectrum>,
    thread: Option<JoinHandle<()>>,
}

impl Player {
    /// A player that opens its outputs with `outputs` and tells `events` what happens.
    pub fn new(outputs: Outputs, settings: Settings, events: impl Fn(Event) + Send + 'static) -> Player {
        let (commands, receiver) = channel();
        let status = Arc::new(Mutex::new(Status::default()));
        let pipe = Arc::new(Mutex::new(None));
        let engine = Engine {
            outputs,
            settings,
            output: None,
            pipe: Arc::clone(&pipe),
            route: None,
            decoding: None,
            previous: None,
            next: None,
            infos: VecDeque::new(),
            playing: false,
            ended: false,
            serials: 0,
            events: Box::new(events),
            status: Arc::clone(&status),
        };
        let thread = std::thread::Builder::new()
            .name("jackbird-audio".into())
            .spawn(move || engine.run(receiver))
            .ok();
        Player {
            commands,
            status,
            pipe,
            spectrum: Mutex::new(Spectrum::new()),
            thread,
        }
    }

    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    /// Plays the file at `path` (the interface's `key` for it) from `at` seconds, or loads it
    /// paused.
    pub fn load(&self, path: &Path, key: &str, at: f64, play: bool) {
        self.send(Command::Load {
            path: path.to_path_buf(),
            key: key.to_string(),
            at,
            play,
        });
    }

    /// The song after the one playing (none: the queue ends there).
    pub fn set_next(&self, next: Option<(&Path, &str)>) {
        self.send(Command::Next(
            next.map(|(path, key)| (path.to_path_buf(), key.to_string())),
        ));
    }

    /// Resumes.
    pub fn play(&self) {
        self.send(Command::Play);
    }

    /// Pauses.
    pub fn pause(&self) {
        self.send(Command::Pause);
    }

    /// Moves to `seconds` into the song sounding.
    pub fn seek(&self, seconds: f64) {
        self.send(Command::Seek(seconds));
    }

    /// Stops and lets the device go.
    pub fn stop(&self) {
        self.send(Command::Stop);
    }

    /// Changes the output's settings (the song sounding goes on from where it was).
    pub fn configure(&self, settings: Settings) {
        self.send(Command::Configure(settings));
    }

    /// Where it is.
    pub fn status(&self) -> Status {
        self.status.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The spectrum of what the device took last ([`crate::spectrum::BINS`] bins, 0–255) and the
    /// rate it plays at; `None` when nothing plays.
    pub fn spectrum(&self) -> Option<(Vec<u8>, u32)> {
        let pipe = self.pipe.lock().unwrap_or_else(PoisonError::into_inner).clone()?;
        let mut samples = vec![0.0f32; SIZE];
        pipe.recent(&mut samples);
        let bins = self
            .spectrum
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .bins(&samples);
        Some((bins, pipe.format().rate))
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.send(Command::Quit);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
