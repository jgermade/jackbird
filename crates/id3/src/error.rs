use std::fmt;

/// Why a tag or a frame could not be read or written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// The tag's major version is not 2, 3 or 4.
    UnsupportedVersion(u8),
    /// The tag says it is longer than the bytes given.
    Truncated,
    /// The extended header's size does not fit in the tag.
    ExtendedHeader,
    /// A v2.2 tag flagged as compressed (the standard says to ignore it).
    CompressedTag,
    /// A frame is compressed or encrypted, so its content cannot be read here.
    Undecodable(&'static str),
    /// A frame's content is too short for its kind.
    Malformed(&'static str),
    /// The tag or a frame would be larger than ID3v2 can say.
    TooLarge,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::UnsupportedVersion(major) => write!(f, "ID3v2.{major} is not a version this reads"),
            Error::Truncated => write!(f, "the tag is longer than the file"),
            Error::ExtendedHeader => write!(f, "the tag's extended header does not fit in it"),
            Error::CompressedTag => write!(f, "the ID3v2.2 tag is compressed"),
            Error::Undecodable(why) => write!(f, "the frame is {why}"),
            Error::Malformed(what) => write!(f, "the frame is too short for {what}"),
            Error::TooLarge => write!(f, "the tag would be larger than ID3v2 allows"),
        }
    }
}

impl std::error::Error for Error {}
