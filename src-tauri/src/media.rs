//! Where the player's `<audio>` element plays a track from (E4-D5, from E0's
//! findings, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md 18:55 to
//! 19:41). macOS and Windows play from Tauri's asset protocol, whose scope
//! holds only the open roots. Linux's webview does not play from it, so there
//! a server on 127.0.0.1 gives the files: a random port, a token of this run
//! in every URL, only files this app has handed out a URL for (each checked
//! under its root when it was), byte ranges, and CORS for the app's page.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// How many handed-out files the server remembers: the queue's few, many times over.
const REMEMBERED: usize = 256;

/// The files the server may give, by the number in their URL.
#[derive(Default)]
struct Served {
    files: HashMap<u64, PathBuf>,
    next: u64,
}

/// The local media server (Linux).
pub struct MediaServer {
    port: u16,
    token: String,
    served: Arc<Mutex<Served>>,
}

/// A token nobody else on the machine can guess: from the system's own randomness
/// where there is one, else from the clock and the process.
fn token() -> String {
    let mut bytes = [0u8; 16];
    let read = File::open("/dev/urandom").and_then(|mut random| random.read_exact(&mut bytes));
    if read.is_err() {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos())
            ^ u128::from(std::process::id()) << 64;
        bytes = seed.to_le_bytes();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl MediaServer {
    /// Starts it on 127.0.0.1, on a port the system picks.
    pub fn start() -> std::io::Result<MediaServer> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = token();
        let served = Arc::new(Mutex::new(Served::default()));
        let (shared, prefix) = (Arc::clone(&served), format!("/{token}/"));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (shared, prefix) = (Arc::clone(&shared), prefix.clone());
                std::thread::spawn(move || {
                    let _ = answer(stream, &prefix, &shared);
                });
            }
        });
        Ok(MediaServer { port, token, served })
    }

    /// The URL for a file already checked under its root.
    pub fn url(&self, path: PathBuf) -> String {
        let mut served = self.served.lock().expect("the media server's list");
        served.next += 1;
        let number = served.next;
        served.files.insert(number, path);
        if served.files.len() > REMEMBERED {
            let oldest = number - REMEMBERED as u64;
            served.files.retain(|&kept, _| kept > oldest);
        }
        format!("http://127.0.0.1:{}/{}/{number}", self.port, self.token)
    }
}

/// A file's MIME type, by extension (as `src/helpers/formats.ts` gives them).
fn mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// A `Range: bytes=…` header's range in a file of `size` bytes (one range
/// only); `None` for what cannot be served.
pub fn range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || size == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let length: u64 = suffix.parse().ok()?;
            (size.saturating_sub(length), size - 1)
        }
        (start, "") => (start.parse().ok()?, size - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(size - 1)),
    };
    (start <= end && start < size).then_some((start, end))
}

/// Answers one request.
fn answer(stream: TcpStream, prefix: &str, served: &Mutex<Served>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let mut wanted = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("range")
        {
            wanted = Some(value.trim().to_owned());
        }
    }
    let mut out = stream;
    let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n";
    if method == "OPTIONS" {
        return write!(
            out,
            "HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n"
        );
    }
    let path = target
        .strip_prefix(prefix)
        .and_then(|number| number.parse::<u64>().ok())
        .and_then(|number| served.lock().ok()?.files.get(&number).cloned());
    let Some(path) = path.filter(|_| method == "GET" || method == "HEAD") else {
        return write!(
            out,
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
    };
    let Ok(mut file) = File::open(&path) else {
        return write!(
            out,
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
    };
    let size = file.metadata()?.len();
    let kind = mime(&path);
    let (status, start, end) = match wanted.as_deref().map(|header| range(header, size)) {
        Some(Some((start, end))) => ("206 Partial Content", start, end),
        Some(None) => {
            return write!(
                out,
                "HTTP/1.1 416 Range Not Satisfiable\r\n{cors}Content-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
        }
        None => ("200 OK", 0, size.saturating_sub(1)),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let content_range = if status.starts_with("206") {
        format!("Content-Range: bytes {start}-{end}/{size}\r\n")
    } else {
        String::new()
    };
    write!(
        out,
        "HTTP/1.1 {status}\r\n{cors}Accept-Ranges: bytes\r\nContent-Type: {kind}\r\n{content_range}Content-Length: {length}\r\nConnection: close\r\n\r\n"
    )?;
    if method == "GET" && length > 0 {
        file.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut file.take(length), &mut out)?;
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_read_as_one_range_within_the_file() {
        assert_eq!(range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(range("bytes=-500", 100), Some((0, 99)));
        for bad in [
            "bytes=100-",
            "bytes=20-10",
            "bytes=0-1,5-6",
            "items=0-1",
            "bytes=x-",
            "bytes=-",
        ] {
            assert_eq!(range(bad, 100), None, "{bad}");
        }
        assert_eq!(range("bytes=0-", 0), None);
    }

    fn get(port: u16, path: &str, headers: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: x\r\n{headers}\r\n").unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = response.windows(4).position(|window| window == b"\r\n\r\n").unwrap();
        (
            String::from_utf8_lossy(&response[..split]).into_owned(),
            response[split + 4..].to_vec(),
        )
    }

    #[test]
    fn serves_handed_out_files_only_with_ranges_and_cors() {
        let folder = std::env::temp_dir().join(format!("jackbird-media-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.flac");
        std::fs::write(&file, (0..=255u8).collect::<Vec<_>>()).unwrap();
        let server = MediaServer::start().unwrap();
        let url = server.url(file);
        let path = url.split_once(&format!(":{}", server.port)).unwrap().1.to_owned();

        let (head, body) = get(server.port, &path, "");
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.contains("Content-Type: audio/flac") && head.contains("Access-Control-Allow-Origin: *"));
        assert_eq!(body.len(), 256);
        let (head, body) = get(server.port, &path, "Range: bytes=10-19\r\n");
        assert!(
            head.starts_with("HTTP/1.1 206") && head.contains("Content-Range: bytes 10-19/256"),
            "{head}"
        );
        assert_eq!(body, (10..20u8).collect::<Vec<_>>());
        let (head, _) = get(server.port, &path, "Range: bytes=300-\r\n");
        assert!(head.starts_with("HTTP/1.1 416"), "{head}");
        // Another number, the wrong token, or a path: nothing.
        let wrong = path.replace(&server.token, "0000");
        for other in [
            path.replace("/1", "/2"),
            wrong,
            "/etc/passwd".into(),
            format!("/{}/../a.flac", server.token),
        ] {
            assert!(get(server.port, &other, "").0.starts_with("HTTP/1.1 404"), "{other}");
        }
        assert_eq!(server.token.len(), 32);
    }
}
