//! E0.2: what lofty keeps when jackbird edits a title.
//! `semantics <audio.mp3> <audio.flac> <out-dir>`: builds tagged files byte by
//! byte around ffmpeg's audio, edits them both ways (generic `Tag`, concrete
//! tags), writes every result to <out-dir> and prints what changed.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use e0_spike::{read, write_concrete, write_generic, write_merged, Cover, Fields};

// ---------------------------------------------------------------- ID3v2

#[derive(Clone, Debug, PartialEq)]
struct F {
    id: String,
    flags: [u8; 2],
    body: Vec<u8>,
}

fn f(id: &str, body: Vec<u8>) -> F {
    F { id: id.into(), flags: [0, 0], body }
}

fn text(id: &str, enc: u8, value: &str) -> F {
    let mut body = vec![enc];
    body.extend(value.as_bytes());
    f(id, body)
}

fn syncsafe(n: usize) -> [u8; 4] {
    [((n >> 21) & 0x7f) as u8, ((n >> 14) & 0x7f) as u8, ((n >> 7) & 0x7f) as u8, (n & 0x7f) as u8]
}

fn unsync(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 16);
    for (i, &b) in body.iter().enumerate() {
        out.push(b);
        if b == 0xff && (i + 1 == body.len() || body[i + 1] >= 0xe0 || body[i + 1] == 0) {
            out.push(0);
        }
    }
    out
}

/// A tag: `plain_sizes` writes v2.4 frame sizes as plain integers (as old iTunes did).
fn tag(version: u8, frames: &[F], padding: usize, unsynchronised: bool, plain_sizes: bool) -> Vec<u8> {
    let mut body = Vec::new();
    for fr in frames {
        body.extend(fr.id.as_bytes());
        let n = fr.body.len();
        if version == 4 && !plain_sizes {
            body.extend(syncsafe(n));
        } else {
            body.extend((n as u32).to_be_bytes());
        }
        body.extend(fr.flags);
        body.extend(&fr.body);
    }
    if unsynchronised {
        body = unsync(&body);
    }
    body.extend(vec![0; padding]);
    let mut out = vec![b'I', b'D', b'3', version, 0, if unsynchronised { 0x80 } else { 0 }];
    out.extend(syncsafe(body.len()));
    out.extend(body);
    out
}

struct Parsed {
    version: u8,
    frames: Vec<F>,
    end: usize,
    padding: usize,
}

fn read_syncsafe(b: &[u8]) -> usize {
    ((b[0] as usize & 0x7f) << 21) | ((b[1] as usize & 0x7f) << 14) | ((b[2] as usize & 0x7f) << 7) | (b[3] as usize & 0x7f)
}

fn resync(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    for (i, &x) in b.iter().enumerate() {
        if x == 0 && i > 0 && b[i - 1] == 0xff {
            continue;
        }
        out.push(x);
    }
    out
}

fn parse(bytes: &[u8]) -> Option<Parsed> {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return None;
    }
    let version = bytes[3];
    let flags = bytes[5];
    let size = read_syncsafe(&bytes[6..10]);
    let end = 10 + size + if version == 4 && flags & 0x10 != 0 { 10 } else { 0 };
    let mut body = bytes[10..10 + size].to_vec();
    if flags & 0x80 != 0 {
        body = resync(&body); // v2.3 whole-tag unsynchronisation (lofty writes none)
    }
    let at = if flags & 0x40 != 0 { if version == 3 { u32::from_be_bytes(body[0..4].try_into().unwrap()) as usize + 4 } else { read_syncsafe(&body[0..4]) } } else { 0 };
    let start = at;
    let frames_with = |syncsafe_sizes: bool| {
        let mut at = start;
        let mut frames = Vec::new();
        while at + 10 <= body.len() && body[at].is_ascii_alphanumeric() {
            let id = String::from_utf8_lossy(&body[at..at + 4]).into_owned();
            let n = if syncsafe_sizes { read_syncsafe(&body[at + 4..at + 8]) } else { u32::from_be_bytes(body[at + 4..at + 8].try_into().unwrap()) as usize };
            if at + 10 + n > body.len() {
                return None;
            }
            frames.push(F { id, flags: [body[at + 8], body[at + 9]], body: body[at + 10..at + 10 + n].to_vec() });
            at += 10 + n;
        }
        body[at..].iter().all(|&b| b == 0).then_some((frames, at))
    };
    let (frames, at) = frames_with(version == 4).or_else(|| frames_with(false)).expect("unreadable test tag");
    let padding = body.len() - at;
    Some(Parsed { version, frames, end, padding })
}

/// MP3 audio: after the ID3v2 tag, before an ID3v1 tag (as `getAudioFrameSlice`).
fn mp3_audio(bytes: &[u8]) -> &[u8] {
    let start = parse(bytes).map(|p| p.end).unwrap_or(0);
    let mut end = bytes.len();
    if end - start > 128 && &bytes[end - 128..end - 125] == b"TAG" {
        end -= 128;
    }
    &bytes[start..end]
}

fn describe(fr: &F) -> String {
    let b = &fr.body;
    let printable: String = b.iter().take(40).map(|&c| if (0x20..0x7f).contains(&c) { c as char } else { '·' }).collect();
    format!("{} flags={:02x}{:02x} {}B \"{}\"", fr.id, fr.flags[0], fr.flags[1], b.len(), printable)
}

/// A frame's identity for matching: its id, and a picture's type.
fn key(fr: &F) -> String {
    if fr.id == "APIC" {
        let mime_end = fr.body[1..].iter().position(|&b| b == 0).unwrap_or(0) + 1;
        format!("APIC/{}", fr.body.get(mime_end + 1).copied().unwrap_or(255))
    } else {
        fr.id.clone()
    }
}

fn report_id3(label: &str, source: &[u8], out: &[u8], edited: &[&str]) {
    let before = parse(source);
    let after = parse(out).expect("output has no ID3v2 tag");
    let src_version = before.as_ref().map(|p| p.version);
    println!("  {label}: v2.{} → v2.{}, {} frames → {}, padding {} → {}, file {} → {} B",
        src_version.map(|v| v.to_string()).unwrap_or("-".into()), after.version,
        before.as_ref().map(|p| p.frames.len()).unwrap_or(0), after.frames.len(),
        before.as_ref().map(|p| p.padding).unwrap_or(0), after.padding, source.len(), out.len());
    println!("    out frames: {}", after.frames.iter().map(|f| f.id.as_str()).collect::<Vec<_>>().join(" "));
    let audio_same = mp3_audio(source) == mp3_audio(out);
    let audio_offset_same = before.as_ref().map(|p| p.end) == Some(after.end);
    println!("    audio bytes identical: {audio_same}; audio offset unchanged: {audio_offset_same}");
    if source.len() >= 128 && &source[source.len() - 128..source.len() - 125] == b"TAG" {
        println!("    ID3v1 kept: {}", source[source.len() - 128..] == out[out.len() - 128..]);
    }
    let Some(before) = before else { return };
    let mut seen: HashMap<String, usize> = HashMap::new();
    for fr in &before.frames {
        let k = seen.entry(key(fr)).or_default();
        let nth = *k;
        *k += 1;
        if edited.contains(&fr.id.as_str()) || edited.contains(&key(fr).as_str()) {
            continue;
        }
        let candidates: Vec<&F> = after.frames.iter().filter(|o| key(o) == key(fr)).collect();
        match candidates.get(nth) {
            Some(o) if *o == fr => {}
            Some(o) => println!("    CHANGED {}  →  {}", describe(fr), describe(o)),
            None => println!("    DROPPED {}", describe(fr)),
        }
    }
    let order_before: Vec<String> = before.frames.iter().map(key).filter(|k| !edited.contains(&k.as_str()) && !edited.contains(&&k[..4.min(k.len())])).collect();
    let order_after: Vec<String> = after.frames.iter().map(key).filter(|k| order_before.contains(k)).collect();
    if order_before != order_after {
        println!("    order of unedited frames changed");
    }
}

// ---------------------------------------------------------------- FLAC

#[derive(Clone, Debug, PartialEq)]
struct Block {
    kind: u8,
    body: Vec<u8>,
}

const NAMES: [&str; 7] = ["STREAMINFO", "PADDING", "APPLICATION", "SEEKTABLE", "VORBIS_COMMENT", "CUESHEET", "PICTURE"];

fn name(kind: u8) -> String {
    NAMES.get(kind as usize).map(|s| s.to_string()).unwrap_or(format!("TYPE{kind}"))
}

/// The blocks and where the audio starts; skips a leading ID3v2 tag.
fn flac_blocks(bytes: &[u8]) -> (Vec<Block>, usize, usize) {
    let start = parse(bytes).map(|p| p.end).unwrap_or(0);
    assert_eq!(&bytes[start..start + 4], b"fLaC");
    let mut at = start + 4;
    let mut blocks = Vec::new();
    let mut lasts = 0;
    loop {
        let header = bytes[at];
        let last = header & 0x80 != 0;
        let kind = header & 0x7f;
        let n = ((bytes[at + 1] as usize) << 16) | ((bytes[at + 2] as usize) << 8) | bytes[at + 3] as usize;
        blocks.push(Block { kind, body: bytes[at + 4..at + 4 + n].to_vec() });
        at += 4 + n;
        if last {
            lasts += 1;
            break;
        }
    }
    (blocks, at, lasts)
}

fn flac(prefix: &[u8], blocks: &[Block], audio: &[u8]) -> Vec<u8> {
    let mut out = prefix.to_vec();
    out.extend(b"fLaC");
    for (i, b) in blocks.iter().enumerate() {
        let last = if i + 1 == blocks.len() { 0x80 } else { 0 };
        out.push(last | b.kind);
        let n = b.body.len();
        out.extend([(n >> 16) as u8, (n >> 8) as u8, n as u8]);
        out.extend(&b.body);
    }
    out.extend(audio);
    out
}

fn vorbis(vendor: &str, comments: &[(&str, &str)]) -> Block {
    let mut body = (vendor.len() as u32).to_le_bytes().to_vec();
    body.extend(vendor.as_bytes());
    body.extend((comments.len() as u32).to_le_bytes());
    for (k, v) in comments {
        let c = format!("{k}={v}");
        body.extend((c.len() as u32).to_le_bytes());
        body.extend(c.as_bytes());
    }
    Block { kind: 4, body }
}

fn vorbis_items(block: &Block) -> (String, Vec<String>) {
    let b = &block.body;
    let vl = u32::from_le_bytes(b[0..4].try_into().unwrap()) as usize;
    let vendor = String::from_utf8_lossy(&b[4..4 + vl]).into_owned();
    let mut at = 4 + vl;
    let count = u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
    at += 4;
    let mut items = Vec::new();
    for _ in 0..count {
        let n = u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as usize;
        items.push(String::from_utf8_lossy(&b[at + 4..at + 4 + n]).into_owned());
        at += 4 + n;
    }
    (vendor, items)
}

fn flac_picture(kind: u32, mime: &str, desc: &str, data: &[u8]) -> Block {
    let mut body = kind.to_be_bytes().to_vec();
    body.extend((mime.len() as u32).to_be_bytes());
    body.extend(mime.as_bytes());
    body.extend((desc.len() as u32).to_be_bytes());
    body.extend(desc.as_bytes());
    for v in [16u32, 16, 24, 0] {
        body.extend(v.to_be_bytes());
    }
    body.extend((data.len() as u32).to_be_bytes());
    body.extend(data);
    Block { kind: 6, body }
}

fn cuesheet(total_samples: u64) -> Block {
    let mut body = vec![0u8; 128]; // media catalogue number
    body.extend(0u64.to_be_bytes()); // lead-in
    body.push(0); // not a CD
    body.extend([0u8; 258]);
    body.push(2); // track 1, then the lead-out (ffmpeg wants a track besides it)
    body.extend(0u64.to_be_bytes());
    body.push(1);
    body.extend([0u8; 12]);
    body.push(0);
    body.extend([0u8; 13]);
    body.push(1); // one index point
    body.extend(0u64.to_be_bytes());
    body.push(1);
    body.extend([0u8; 3]);
    body.extend(total_samples.to_be_bytes());
    body.push(255); // lead-out number for a non-CD sheet
    body.extend([0u8; 12]); // ISRC
    body.push(0);
    body.extend([0u8; 13]);
    body.push(0); // no index points
    Block { kind: 5, body }
}

fn report_flac(label: &str, source: &[u8], out: &[u8]) {
    let (b0, a0, _) = flac_blocks(source);
    let (b1, a1, lasts) = flac_blocks(out);
    let list = |bs: &[Block]| bs.iter().map(|b| format!("{}({})", name(b.kind), b.body.len())).collect::<Vec<_>>().join(" ");
    println!("  {label}: file {} → {} B; metadata {} → {} B; last-block flags: {lasts}", source.len(), out.len(), a0, a1);
    println!("    in:  {}", list(&b0));
    println!("    out: {}", list(&b1));
    println!("    audio frames identical: {}; audio offset unchanged: {}", source[a0..] == out[a1..], a0 == a1);
    println!("    leading ID3v2 kept: {}", parse(source).map(|p| source[..p.end] == out[..p.end]).unwrap_or(true));
    for kind in [0u8, 2, 3, 5, 6] {
        let x: Vec<&Block> = b0.iter().filter(|b| b.kind == kind).collect();
        let y: Vec<&Block> = b1.iter().filter(|b| b.kind == kind).collect();
        if x != y {
            println!("    {} blocks differ: {} in, {} out", name(kind), x.len(), y.len());
        }
    }
    let (v0, i0) = b0.iter().find(|b| b.kind == 4).map(vorbis_items).unwrap_or_default();
    let (v1, i1) = b1.iter().find(|b| b.kind == 4).map(vorbis_items).unwrap_or_default();
    if v0 != v1 {
        println!("    vendor: {v0:?} → {v1:?}");
    }
    let unedited = |items: &[String]| items.iter().filter(|i| !i.to_uppercase().starts_with("TITLE=")).cloned().collect::<Vec<_>>();
    if unedited(&i0) != unedited(&i1) {
        println!("    comments in:  {:?}", i0);
        println!("    comments out: {:?}", i1);
    } else {
        println!("    every unedited comment kept, in order, keys as written; title: {:?}", i1.iter().find(|i| i.to_uppercase().starts_with("TITLE=")));
    }
}

// ---------------------------------------------------------------- cases

/// A real JPEG from the fixtures (`COVERS` names their folder): cover1, cover2, cover9.
fn fake_jpeg(seed: u8, _n: usize) -> Vec<u8> {
    fs::read(format!("{}/cover{seed}.jpg", std::env::var("COVERS").unwrap())).unwrap()
}

fn mp3_frames(version: u8) -> Vec<F> {
    let enc = if version == 4 { 3 } else { 0 };
    let mut comm = vec![enc];
    comm.extend(b"eng\0A comment");
    let mut uslt = vec![enc];
    uslt.extend(b"eng\0La la la");
    let mut txxx = vec![enc];
    txxx.extend(b"REPLAYGAIN_TRACK_GAIN\0-6.50 dB");
    let mut ufid = b"http://musicbrainz.org\0".to_vec();
    ufid.extend(b"0b6c2b4e-1a2b-4c3d-9e8f-001122334455");
    let mut private = b"WM/MediaClassPrimaryID\0".to_vec();
    private.extend([0xbc, 0x7d, 0x60, 0xd1, 0x23, 0xe3, 0xe2, 0x4b, 0x86, 0xa1, 0x48, 0xa4, 0x2a, 0x28, 0x44, 0x1e]);
    let apic = |kind: u8, desc: &str, data: Vec<u8>| {
        let mut b = vec![0];
        b.extend(b"image/jpeg\0");
        b.push(kind);
        b.extend(desc.as_bytes());
        b.push(0);
        b.extend(data);
        f("APIC", b)
    };
    let mut discard = text("TPE4", enc, "Remixer (to discard)");
    discard.flags[0] = if version == 4 { 0x40 } else { 0x80 };
    vec![
        text("TIT2", enc, "Before"),
        text("TPE1", enc, "Artist"),
        text("TALB", enc, "Album"),
        text(if version == 4 { "TDRC" } else { "TYER" }, enc, "1959"),
        text("TCON", enc, "Jazz"),
        text("TRCK", enc, "3/12"),
        text("TPOS", enc, "1/2"),
        text("TPE2", enc, "Album Artist"),
        f("COMM", comm),
        f("TXXX", txxx),
        f("USLT", uslt),
        f("UFID", ufid),
        f("PRIV", private),
        apic(3, "", fake_jpeg(1, 300)),
        apic(4, "back", fake_jpeg(2, 200)),
        f("XQZW", vec![1, 2, 3, 0xff, 0xe0, 4]),
        text("TCMP", enc, "1"),
        discard,
    ]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mp3_audio_bytes = fs::read(&args[1]).unwrap();
    let flac_audio = fs::read(&args[2]).unwrap();
    let out_dir = Path::new(&args[3]);
    fs::create_dir_all(out_dir).unwrap();

    let id3v1 = {
        let mut t = b"TAG".to_vec();
        t.extend(format!("{:<30}{:<30}{:<30}1959{:<28}", "Before", "Artist", "Album", "v1 comment").as_bytes());
        t.extend([0, 3, 8]);
        t
    };
    assert_eq!(id3v1.len(), 128);

    let mut mp3_cases: Vec<(&str, Vec<u8>)> = vec![
        ("v23-padded", tag(3, &mp3_frames(3), 2048, false, false)),
        ("v24-padded", tag(4, &mp3_frames(4), 2048, false, false)),
        ("v23-unsync", tag(3, &mp3_frames(3), 0, true, false)),
        ("v24-plain-sizes", tag(4, &mp3_frames(4), 0, false, true)),
        ("v23-with-id3v1", tag(3, &mp3_frames(3), 512, false, false)),
        ("no-tag", Vec::new()),
    ];
    for (name, t) in mp3_cases.iter_mut() {
        t.extend(&mp3_audio_bytes);
        if *name == "v23-with-id3v1" {
            t.extend(&id3v1);
        }
    }

    // FLAC: ffmpeg's STREAMINFO and audio, with blocks of our own.
    let (blocks, audio_at, _) = flac_blocks(&flac_audio);
    let streaminfo = blocks[0].clone();
    let total_samples = {
        let b = &streaminfo.body;
        (((b[13] & 0x0f) as u64) << 32) | u32::from_be_bytes(b[14..18].try_into().unwrap()) as u64
    };
    let audio = &flac_audio[audio_at..];
    let mut seektable = Vec::new();
    seektable.extend(0u64.to_be_bytes());
    seektable.extend(0u64.to_be_bytes());
    seektable.extend(4096u16.to_be_bytes());
    let full = vec![
        streaminfo.clone(),
        Block { kind: 3, body: seektable },
        Block { kind: 2, body: b"jkbdsome application data".to_vec() },
        vorbis("reference libFLAC 1.4.3 20230623", &[
            ("TITLE", "Before"), ("ARTIST", "One"), ("ARTIST", "Two"), ("ALBUM", "Album"), ("DATE", "1959"),
            ("GENRE", "Jazz"), ("TRACKNUMBER", "3"), ("ALBUMARTIST", "Album Artist"), ("DISCNUMBER", "1"),
            ("REPLAYGAIN_TRACK_GAIN", "-6.50 dB"), ("replaygain_album_gain", "-7.00 dB"),
            ("MUSICBRAINZ_TRACKID", "0b6c2b4e-1a2b-4c3d-9e8f-001122334455"), ("LYRICS", "La la la"), ("COMMENT", "Hi"),
        ]),
        cuesheet(total_samples),
        flac_picture(3, "image/jpeg", "", &fake_jpeg(1, 300)),
        flac_picture(4, "image/jpeg", "back", &fake_jpeg(2, 200)),
        Block { kind: 1, body: vec![0; 4096] },
    ];
    let mut padding_first = full.clone();
    let pad = padding_first.pop().unwrap();
    padding_first.insert(1, pad);
    let no_padding: Vec<Block> = full.iter().filter(|b| b.kind != 1).cloned().collect();
    let id3_prefix = tag(3, &[text("TIT2", 0, "id3 before fLaC")], 0, false, false);
    let flac_cases: Vec<(&str, Vec<u8>)> = vec![
        ("flac-full", flac(&[], &full, audio)),
        ("flac-padding-first", flac(&[], &padding_first, audio)),
        ("flac-no-padding", flac(&[], &no_padding, audio)),
        ("flac-id3-prefix", flac(&id3_prefix, &full, audio)),
    ];

    let new_cover = Cover { data: fake_jpeg(9, 400), mime: "image/jpeg".into() };
    let edited_mp3 = ["TIT2", "TPE1", "TALB", "TYER", "TDRC", "TCON", "TRCK"];

    for (case, source) in mp3_cases.iter().chain(flac_cases.iter()) {
        let is_flac = case.starts_with("flac");
        let ext = if is_flac { "flac" } else { "mp3" };
        fs::write(out_dir.join(format!("{case}.src.{ext}")), source).unwrap();
        let (fields, cover) = read(source).unwrap();
        println!("\n## {case}: read {:?}, cover {:?}", fields, cover.as_ref().map(|c| (c.data.len(), c.mime.clone())));
        let edit = Fields { title: "After".into(), ..fields };
        if *case == "v24-plain-sizes" {
            let strict = e0_spike::parse_options().parsing_mode(lofty::config::ParsingMode::Strict);
            let r = lofty::probe::Probe::new(std::io::Cursor::new(source)).options(strict).guess_file_type().unwrap().read();
            println!("  lofty, strict mode, on this file: {}", match r { Ok(_) => "read without an error".to_string(), Err(e) => format!("error: {e}") });
        }
        for (way, write) in [("generic", write_generic as fn(Vec<u8>, &Fields, Option<&Cover>) -> Result<Vec<u8>, String>), ("concrete", write_concrete), ("merged", write_merged)] {
            for (what, cover) in [("title", None), ("title+cover", Some(&new_cover))] {
                let label = format!("{way}/{what}");
                match write(source.clone(), &edit, cover) {
                    Ok(out) => {
                        fs::write(out_dir.join(format!("{case}.{way}.{}.{ext}", what.replace('+', "-"))), &out).unwrap();
                        let (back, _) = read(&out).unwrap();
                        if back.title != "After" {
                            println!("  {label}: TITLE NOT WRITTEN: {back:?}");
                        }
                        let mut edited: Vec<&str> = edited_mp3.to_vec();
                        if cover.is_some() {
                            edited.push("APIC/3");
                        }
                        if is_flac { report_flac(&label, source, &out) } else { report_id3(&label, source, &out, &edited) }
                    }
                    Err(e) => println!("  {label}: ERROR {e}"),
                }
            }
        }
    }
}
