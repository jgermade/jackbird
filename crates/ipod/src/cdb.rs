//! The `iTunesCDB` of the iPod nano 5G to 7G: an `iTunesDB` whose `mhbd`
//! header is kept as it is, and whose children follow it as one zlib stream.
//! The header says so with a `1` at `0xA8`.

use crate::Error;
use crate::bytes::{len_at, u16_at};
use miniz_oxide::inflate::decompress_to_vec_zlib_with_limit;

/// Where the header flags compression.
pub const COMPRESSED_FLAG: usize = 0xa8;

/// The most an `iTunesCDB` may inflate to: far above a full 160 GB classic's
/// database, and a bound on what a malformed stream can make jackbird allocate.
pub const MAX_INFLATED: usize = 512 * 1024 * 1024;

/// Whether `data` is a compressed database (an `mhbd` with the flag set and a
/// header long enough to hold it).
pub fn is_compressed(data: &[u8]) -> bool {
    data.starts_with(b"mhbd")
        && len_at(data, 4, 0).is_ok_and(|h| h > COMPRESSED_FLAG + 1 && h < data.len())
        && u16_at(data, COMPRESSED_FLAG) == Ok(1)
}

/// The `iTunesDB` an `iTunesCDB` holds: its header, with the total length set
/// to the inflated database's and the compression flag cleared, then the
/// inflated children. Data that is not compressed is given back unchanged.
pub fn inflate(data: &[u8]) -> Result<Vec<u8>, Error> {
    if !is_compressed(data) {
        return Ok(data.to_vec());
    }
    let header = len_at(data, 4, 0)?;
    let body = decompress_to_vec_zlib_with_limit(&data[header..], MAX_INFLATED)
        .map_err(|_| Error::Inflate { offset: header })?;
    let mut out = Vec::with_capacity(header + body.len());
    out.extend_from_slice(&data[..header]);
    out.extend_from_slice(&body);
    let total = u32::try_from(out.len()).map_err(|_| Error::BadLength { offset: 0 })?;
    out[8..12].copy_from_slice(&total.to_le_bytes());
    out[COMPRESSED_FLAG..COMPRESSED_FLAG + 2].copy_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::sample_database;
    use miniz_oxide::deflate::compress_to_vec_zlib;

    pub(crate) fn compress(db: &[u8]) -> Vec<u8> {
        let header = u32::from_le_bytes(db[4..8].try_into().unwrap()) as usize;
        let mut out = db[..header].to_vec();
        out.extend(compress_to_vec_zlib(&db[header..], 6));
        let total = out.len() as u32;
        out[8..12].copy_from_slice(&total.to_le_bytes());
        out[COMPRESSED_FLAG..COMPRESSED_FLAG + 2].copy_from_slice(&1u16.to_le_bytes());
        out
    }

    #[test]
    fn round_trip() {
        let db = sample_database();
        let cdb = compress(&db);
        assert!(is_compressed(&cdb));
        assert!(!is_compressed(&db));
        assert_eq!(inflate(&cdb).unwrap(), db);
        assert_eq!(inflate(&db).unwrap(), db);
    }

    #[test]
    fn broken_stream() {
        let mut cdb = compress(&sample_database());
        let header = u32::from_le_bytes(cdb[4..8].try_into().unwrap()) as usize;
        cdb.truncate(header + 6);
        assert_eq!(inflate(&cdb), Err(Error::Inflate { offset: header }));
    }

    #[test]
    fn not_a_database() {
        assert!(!is_compressed(b"mhb"));
        assert_eq!(inflate(b"anything").unwrap(), b"anything");
    }
}
