//! Little-endian reads that fail with an offset instead of panicking.

use crate::Error;

pub(crate) fn u16_at(data: &[u8], offset: usize) -> Result<u16, Error> {
    Ok(u16::from_le_bytes(array(data, offset)?))
}

pub(crate) fn u32_at(data: &[u8], offset: usize) -> Result<u32, Error> {
    Ok(u32::from_le_bytes(array(data, offset)?))
}

pub(crate) fn u64_at(data: &[u8], offset: usize) -> Result<u64, Error> {
    Ok(u64::from_le_bytes(array(data, offset)?))
}

pub(crate) fn u8_at(data: &[u8], offset: usize) -> Result<u8, Error> {
    data.get(offset).copied().ok_or(Error::Truncated { offset })
}

pub(crate) fn array<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N], Error> {
    let end = offset.checked_add(N).ok_or(Error::Truncated { offset })?;
    data.get(offset..end)
        .and_then(|s| s.try_into().ok())
        .ok_or(Error::Truncated { offset })
}

/// A `u32` length field as a `usize`, checked against the data's length.
pub(crate) fn len_at(data: &[u8], offset: usize, chunk: usize) -> Result<usize, Error> {
    let len = usize::try_from(u32_at(data, offset)?).map_err(|_| Error::BadLength { offset: chunk })?;
    Ok(len)
}
