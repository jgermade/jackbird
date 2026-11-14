//! `hashAB`, the signature the iPod nano 6G and 7G check on their databases.
//!
//! A Rust port of [dstaley/hashab](https://github.com/dstaley/hashab)
//! (commit `f80d464`), a C implementation reverse engineered from a nano 6G's
//! decrypted firmware and released into the public domain under the
//! Unlicense; its EDON-R part is RHash's, under a permissive licence (see
//! [`digest`]). The tables are dumped from its C, not typed ([`tables`]), and
//! the port is checked against its 100 test vectors
//! (`fixtures/ipod/hashab-vectors.json`). The owner approved the port on
//! 2026-11-14 (`RECORD/2026-11-14.ipod-sync.WIP.md`).
//!
//! [`signature`] is the algorithm: a 57-byte signature of a 20-byte SHA-1 and
//! the device's 8-byte FireWire GUID, which carries 23 random bytes in the
//! clear. Where it is applied:
//!
//! - **`iTunesCDB`** ([`database_digest`]): the scheme `3` at `0x30`, and the
//!   signature at `0xAB..0xE4`, of the SHA-1 of the file with `0x18..0x20`,
//!   `0x58..0x6C`, `0x72..0xA0` and the signature zeroed.
//! - **`Locations.itdb.cbk`** ([`checksum_book_digest`]): the signature, then
//!   the SHA-1 of the SHA-1s of every 1 KB block of `Locations.itdb`, then
//!   those SHA-1s.
//!
//! Neither framing is in dstaley's code: they come from how libgpod and
//! SyncMyPod describe them, and the owner's nano checks them (N2).

mod cipher;
mod digest;
mod reduce;
mod tables;

use crate::sha1::sha1;

/// The signature's length.
pub const SIGNATURE_LEN: usize = 57;
/// The random bytes a signature carries.
pub const RANDOM_LEN: usize = 23;
/// The random bytes libgpod uses (iTunes uses fresh ones; any will do).
pub const LIBGPOD_RANDOM: [u8; RANDOM_LEN] = *b"ABCDEFGHIJKLMNOPQRSTUVW";

const PERMUTATION_32: [usize; 32] = [
    0x06, 0x18, 0x11, 0x07, 0x13, 0x0d, 0x0e, 0x09, 0x15, 0x1d, 0x02, 0x1f, 0x01, 0x04, 0x1c, 0x1a, 0x10, 0x14, 0x0b,
    0x1e, 0x03, 0x0a, 0x1b, 0x19, 0x05, 0x0f, 0x16, 0x00, 0x12, 0x17, 0x08, 0x0c,
];

/// Where each of the signature's last 55 bytes comes from: below 23, a random
/// byte; from 23, a byte of the second cipher's output.
const PERMUTATION_55: [usize; 55] = [
    0x15, 0x1c, 0x06, 0x0c, 0x07, 0x1a, 0x05, 0x13, 0x08, 0x19, 0x03, 0x01, 0x2d, 0x1e, 0x10, 0x31, 0x1d, 0x14, 0x28,
    0x27, 0x35, 0x00, 0x2f, 0x1b, 0x26, 0x0b, 0x0e, 0x02, 0x23, 0x17, 0x24, 0x22, 0x12, 0x1f, 0x20, 0x04, 0x29, 0x25,
    0x21, 0x09, 0x18, 0x0d, 0x32, 0x0f, 0x11, 0x2e, 0x33, 0x2b, 0x30, 0x2a, 0x36, 0x0a, 0x2c, 0x34, 0x16,
];

/// The signature of `sha1` for the device `guid`, with `random`.
pub fn signature(sha1: &[u8; 20], guid: &[u8; 8], random: &[u8; RANDOM_LEN]) -> [u8; SIGNATURE_LEN] {
    let mut input = [0xc1u8; 80];
    for (dst, src) in input.iter_mut().zip(guid.iter().chain(sha1).chain(random)) {
        *dst = src.wrapping_mul(0xed);
    }
    let stage1 = tables::STAGE1.encrypt(&input, tables::STAGE1_INITIAL_CHAIN);
    let expanded = reduce::expand(&stage1[20..44], &stage1[..20]);
    let iv = reduce::reduce(&expanded);
    let stage2_input: Vec<u8> = PERMUTATION_32.iter().map(|&p| stage1[44 + p]).collect();
    let stage2 = tables::STAGE2.encrypt(&stage2_input, tables::STAGE2.chain_from_output(&iv));

    let mut out = [0u8; SIGNATURE_LEN];
    out[0] = 3;
    for (dst, &source) in out[2..].iter_mut().zip(PERMUTATION_55.iter()) {
        *dst = if source < RANDOM_LEN {
            random[source]
        } else {
            stage2[source - RANDOM_LEN].wrapping_mul(0x2d)
        };
    }
    out
}

/// The random bytes a signature carries, read back out of it (so a signature
/// iTunes made can be checked: [`signature`] with them must give it again).
pub fn random_of(signature: &[u8; SIGNATURE_LEN]) -> [u8; RANDOM_LEN] {
    let mut random = [0; RANDOM_LEN];
    for (&byte, &source) in signature[2..].iter().zip(PERMUTATION_55.iter()) {
        if source < RANDOM_LEN {
            random[source] = byte;
        }
    }
    random
}

/// Whether `stored` is `sha1`'s signature for `guid`, whatever random bytes it was made with.
pub fn verify(stored: &[u8; SIGNATURE_LEN], sha1: &[u8; 20], guid: &[u8; 8]) -> bool {
    signature(sha1, guid, &random_of(stored)) == *stored
}

/// Where an `iTunesCDB` keeps its scheme and its signature.
pub const DATABASE_SCHEME_AT: usize = 0x30;
/// The signature's place in an `iTunesCDB`.
pub const DATABASE_SIGNATURE: std::ops::Range<usize> = 0xab..0xab + SIGNATURE_LEN;
const DATABASE_ZEROED: [std::ops::Range<usize>; 4] = [0x18..0x20, 0x58..0x6c, 0x72..0xa0, DATABASE_SIGNATURE];

/// The SHA-1 a database's signature signs: of the file as it is, with its
/// database ID, its other checksums' fields and the signature zeroed. `None`
/// when the file is too short to hold a signature.
pub fn database_digest(database: &[u8]) -> Option<[u8; 20]> {
    if database.len() < DATABASE_SIGNATURE.end {
        return None;
    }
    let mut copy = database.to_vec();
    for range in DATABASE_ZEROED {
        copy[range].fill(0);
    }
    Some(sha1(&copy))
}

/// The signature stored in a database, when it is long enough to hold one.
pub fn database_signature(database: &[u8]) -> Option<[u8; SIGNATURE_LEN]> {
    database.get(DATABASE_SIGNATURE)?.try_into().ok()
}

/// Signs a database (an `iTunesCDB` as it will be on the iPod, compressed)
/// for `guid`, in place: the scheme at `0x30` is set to `hashAB`'s (3) and the
/// signature written at `0xAB`. `false`, and nothing changed, when the file is
/// too short to hold a signature.
pub fn sign_database(database: &mut [u8], guid: &[u8; 8], random: &[u8; RANDOM_LEN]) -> bool {
    if database.len() < DATABASE_SIGNATURE.end {
        return false;
    }
    database[DATABASE_SCHEME_AT..DATABASE_SCHEME_AT + 2].copy_from_slice(&3u16.to_le_bytes());
    let Some(digest) = database_digest(database) else {
        return false;
    };
    database[DATABASE_SIGNATURE].copy_from_slice(&signature(&digest, guid, random));
    true
}

/// Whether a database (an `iTunesCDB` as it is on the iPod, compressed) is
/// signed for `guid`.
pub fn verify_database(database: &[u8], guid: &[u8; 8]) -> bool {
    match (database_digest(database), database_signature(database)) {
        (Some(digest), Some(stored)) => verify(&stored, &digest, guid),
        _ => false,
    }
}

/// The SHA-1s of every 1 KB block of `Locations.itdb`, one after another.
fn block_digests(locations: &[u8]) -> Vec<u8> {
    locations.chunks(1024).flat_map(sha1).collect()
}

/// The SHA-1 the signature of `Locations.itdb.cbk` signs: of the SHA-1s of
/// every 1 KB block of `Locations.itdb`.
pub fn checksum_book_digest(locations: &[u8]) -> [u8; 20] {
    sha1(&block_digests(locations))
}

/// `Locations.itdb.cbk` for `locations`: the signature, the digest it signs,
/// then the blocks' SHA-1s.
pub fn checksum_book(locations: &[u8], guid: &[u8; 8], random: &[u8; RANDOM_LEN]) -> Vec<u8> {
    let blocks = block_digests(locations);
    let digest = sha1(&blocks);
    let mut out = signature(&digest, guid, random).to_vec();
    out.extend_from_slice(&digest);
    out.extend(blocks);
    out
}

/// Whether `book` is a `Locations.itdb.cbk` for `locations`, signed for `guid`.
pub fn verify_checksum_book(book: &[u8], locations: &[u8], guid: &[u8; 8]) -> bool {
    let Some(stored) = book
        .get(..SIGNATURE_LEN)
        .and_then(|s| <[u8; SIGNATURE_LEN]>::try_from(s).ok())
    else {
        return false;
    };
    let blocks = block_digests(locations);
    let digest = sha1(&blocks);
    book[SIGNATURE_LEN..] == [digest.as_slice(), &blocks].concat() && verify(&stored, &digest, guid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// dstaley's 100 vectors, made with libgpod's random bytes.
    fn vectors() -> Vec<([u8; 20], [u8; 8], [u8; SIGNATURE_LEN])> {
        let text = include_str!("../../../../fixtures/ipod/hashab-vectors.json");
        let field = |entry: &str, name: &str| {
            let at = entry.find(&format!("\"{name}\"")).unwrap();
            let rest = &entry[at + name.len() + 2..];
            let start = rest.find('"').unwrap() + 1;
            let end = start + rest[start..].find('"').unwrap();
            hex(&rest[start..end])
        };
        text.split('}')
            .filter(|e| e.contains("\"sha1\""))
            .map(|e| {
                (
                    field(e, "sha1").try_into().unwrap(),
                    field(e, "uuid").try_into().unwrap(),
                    field(e, "target").try_into().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn dstaleys_vectors() {
        let vectors = vectors();
        assert_eq!(vectors.len(), 100);
        for (n, (sha1, guid, target)) in vectors.iter().enumerate() {
            assert_eq!(&signature(sha1, guid, &LIBGPOD_RANDOM), target, "vector {n}");
            assert_eq!(random_of(target), LIBGPOD_RANDOM);
            assert!(verify(target, sha1, guid));
        }
    }

    #[test]
    fn verify_with_any_random_bytes() {
        let (sha1, guid, _) = vectors()[0];
        let random: [u8; RANDOM_LEN] = std::array::from_fn(|i| (i as u8).wrapping_mul(37) ^ 0x5a);
        let made = signature(&sha1, &guid, &random);
        assert_eq!(random_of(&made), random);
        assert!(verify(&made, &sha1, &guid));
        let mut other = guid;
        other[7] ^= 1;
        assert!(!verify(&made, &sha1, &other));
        let mut broken = made;
        broken[40] ^= 1;
        assert!(!verify(&broken, &sha1, &guid));
    }

    #[test]
    fn database_framing() {
        let guid = [0x00, 0x0a, 0x27, 0x00, 0x13, 0x8b, 0x4e, 0x3e];
        let mut db = vec![0u8; 0x200];
        db[..4].copy_from_slice(b"mhbd");
        db[0x100..].iter_mut().enumerate().for_each(|(i, b)| *b = i as u8);
        assert!(!verify_database(&db, &guid));
        let digest = database_digest(&db).unwrap();
        db[DATABASE_SCHEME_AT..DATABASE_SCHEME_AT + 2].copy_from_slice(&3u16.to_le_bytes());
        // The scheme is not zeroed, so it must be set before signing.
        let digest_after = database_digest(&db).unwrap();
        assert_ne!(digest, digest_after);
        db[DATABASE_SIGNATURE].copy_from_slice(&signature(&digest_after, &guid, &LIBGPOD_RANDOM));
        assert!(verify_database(&db, &guid));
        // The zeroed fields do not count; any other byte does.
        db[0x18] ^= 0xff;
        db[0x60] ^= 0xff;
        assert!(verify_database(&db, &guid));
        db[0x150] ^= 1;
        assert!(!verify_database(&db, &guid));
        assert!(!verify_database(&db[..0x80], &guid));
        assert_eq!(database_digest(&db[..0x80]), None);
    }

    #[test]
    fn sign_database_in_place() {
        let guid = [0x00, 0x0a, 0x27, 0x00, 0x13, 0x8b, 0x4e, 0x3e];
        let mut db = vec![0u8; 0x200];
        db[..4].copy_from_slice(b"mhbd");
        db[0x100..].iter_mut().enumerate().for_each(|(i, b)| *b = i as u8);
        assert!(sign_database(&mut db, &guid, &LIBGPOD_RANDOM));
        assert_eq!(db[DATABASE_SCHEME_AT..DATABASE_SCHEME_AT + 2], 3u16.to_le_bytes());
        assert!(verify_database(&db, &guid));
        assert_eq!(random_of(&database_signature(&db).unwrap()), LIBGPOD_RANDOM);
        // Signing again after a change gives a valid signature again.
        db[0x150] ^= 1;
        assert!(!verify_database(&db, &guid));
        assert!(sign_database(&mut db, &guid, &LIBGPOD_RANDOM));
        assert!(verify_database(&db, &guid));
        let mut short = vec![0u8; 0x80];
        assert!(!sign_database(&mut short, &guid, &LIBGPOD_RANDOM));
        assert_eq!(short, vec![0u8; 0x80]);
    }

    #[test]
    fn checksum_book_framing() {
        let guid = [1, 2, 3, 4, 5, 6, 7, 8];
        let locations: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
        let book = checksum_book(&locations, &guid, &LIBGPOD_RANDOM);
        assert_eq!(book.len(), SIGNATURE_LEN + 20 + 3 * 20);
        assert_eq!(
            book[SIGNATURE_LEN..SIGNATURE_LEN + 20],
            checksum_book_digest(&locations)
        );
        assert!(verify_checksum_book(&book, &locations, &guid));
        let mut changed = locations.clone();
        changed[2000] ^= 1;
        assert!(!verify_checksum_book(&book, &changed, &guid));
        assert!(!verify_checksum_book(&book, &locations, &[0; 8]));
        assert!(!verify_checksum_book(&book[..10], &locations, &guid));
    }
}
