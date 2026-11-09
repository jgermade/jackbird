//! Signing in (S3): signed tokens for what travels between two requests, the one-time codes sent
//! by email, and the limits on asking for them. The rules are intergate's
//! (`internal/web/email.go`; RECORD, 2026-11-09 11:20): six digits, valid 10 minutes, bound to
//! the browser that asked (a signed token carries the attempt's id, and the code is kept hashed
//! with it), kept in memory, 5 tries; at most 5 codes per address in 15 minutes and 20 per IP
//! address in an hour.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

use crate::people::{now, random};

/// How long a code is valid.
pub const CODE_SECONDS: i64 = 10 * 60;
const CODE_TRIES: u32 = 5;
const CODES_PER_EMAIL: usize = 5;
const EMAIL_WINDOW: Duration = Duration::from_secs(15 * 60);
const CODES_PER_IP: usize = 20;
const IP_WINDOW: Duration = Duration::from_secs(3600);

/// Signs and checks small values that travel through the browser (or the console) between two
/// requests: an attempt to sign in, a passkey ceremony, a media token.
pub struct Signer {
    key: Vec<u8>,
}

#[derive(Serialize, serde::Deserialize)]
struct Signed<T> {
    p: String,
    e: i64,
    v: T,
}

impl Signer {
    /// A signer with the instance's own key.
    pub fn new(key: Vec<u8>) -> Signer {
        Signer { key }
    }

    fn mac(&self, payload: &[u8]) -> Vec<u8> {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key).expect("any key length");
        mac.update(payload);
        mac.finalize().into_bytes().to_vec()
    }

    /// `value`, signed for `purpose`, valid `seconds`.
    pub fn sign<T: Serialize>(&self, purpose: &str, value: &T, seconds: i64) -> String {
        let payload = serde_json::to_vec(&Signed {
            p: purpose.to_owned(),
            e: now() + seconds,
            v: value,
        })
        .expect("a value as JSON");
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(self.mac(&payload))
        )
    }

    /// The value of a token signed for `purpose`, if its signature holds and it has not expired.
    pub fn verify<T: DeserializeOwned>(&self, purpose: &str, token: &str) -> Option<T> {
        let (payload, mac) = token.split_once('.')?;
        let payload = URL_SAFE_NO_PAD.decode(payload).ok()?;
        let mac = URL_SAFE_NO_PAD.decode(mac).ok()?;
        let mut check = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key).expect("any key length");
        check.update(&payload);
        check.verify_slice(&mac).ok()?;
        let signed: Signed<T> = serde_json::from_slice(&payload).ok()?;
        (signed.p == purpose && signed.e >= now()).then_some(signed.v)
    }
}

/// A random id for an attempt.
pub fn attempt_id() -> String {
    URL_SAFE_NO_PAD.encode(random::<16>())
}

/// Six random digits.
pub fn six_digits() -> String {
    let value = u32::from_le_bytes(random::<4>()) % 1_000_000;
    format!("{value:06}")
}

/// What checking a code found.
#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    /// The right code: it is used up.
    Right,
    /// A wrong code, with tries left.
    Wrong,
    /// Expired, used, or tried too often: a new one must be asked for.
    Expired,
}

struct Pending {
    hash: Vec<u8>,
    expires: i64,
    tries: u32,
}

fn hash(attempt: &str, code: &str) -> Vec<u8> {
    Sha256::digest(format!("{attempt}:{code}").as_bytes()).to_vec()
}

/// Limits events per key in a sliding window.
pub struct Limiter {
    max: usize,
    window: Duration,
    hits: Mutex<HashMap<String, Vec<Instant>>>,
}

impl Limiter {
    /// At most `max` events per key in `window`.
    pub fn new(max: usize, window: Duration) -> Limiter {
        Limiter {
            max,
            window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Whether one more event for `key` is allowed now; if so it counts.
    pub fn allow(&self, key: &str) -> bool {
        let mut hits = self.hits.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let at = Instant::now();
        if hits.len() > 10_000 {
            hits.retain(|_, times| times.last().is_some_and(|last| at.duration_since(*last) < self.window));
        }
        let times = hits.entry(key.to_owned()).or_default();
        times.retain(|time| at.duration_since(*time) < self.window);
        if times.len() >= self.max {
            return false;
        }
        times.push(at);
        true
    }
}

/// The codes waiting to be typed, and the limits on sending them.
pub struct Codes {
    pending: Mutex<HashMap<String, Pending>>,
    /// Codes per address.
    pub by_email: Limiter,
    /// Codes per IP address.
    pub by_ip: Limiter,
}

impl Default for Codes {
    fn default() -> Self {
        Codes {
            pending: Mutex::new(HashMap::new()),
            by_email: Limiter::new(CODES_PER_EMAIL, EMAIL_WINDOW),
            by_ip: Limiter::new(CODES_PER_IP, IP_WINDOW),
        }
    }
}

impl Codes {
    /// Keeps a code sent for an attempt.
    pub fn add(&self, attempt: &str, code: &str) {
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let at = now();
        pending.retain(|_, waiting| waiting.expires >= at);
        pending.insert(
            attempt.to_owned(),
            Pending {
                hash: hash(attempt, code),
                expires: at + CODE_SECONDS,
                tries: 0,
            },
        );
    }

    /// Checks a code typed for an attempt: right once, and burnt after too many wrong tries.
    pub fn check(&self, attempt: &str, code: &str) -> Checked {
        let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(waiting) = pending.get_mut(attempt) else {
            return Checked::Expired;
        };
        if waiting.expires < now() {
            pending.remove(attempt);
            return Checked::Expired;
        }
        let typed = hash(attempt, &code);
        let same = typed.len() == waiting.hash.len()
            && typed.iter().zip(&waiting.hash).fold(0, |diff, (a, b)| diff | (a ^ b)) == 0;
        if same {
            pending.remove(attempt);
            return Checked::Right;
        }
        waiting.tries += 1;
        if waiting.tries >= CODE_TRIES {
            pending.remove(attempt);
            return Checked::Expired;
        }
        Checked::Wrong
    }
}
