//! Which iPod this is, what its firmware expects, and its FireWire GUID.

use std::collections::BTreeMap;

/// Apple's USB vendor ID.
pub const APPLE_VENDOR_ID: u16 = 0x05ac;

/// The iPods that mount as a disk and that jackbird knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Generation {
    /// iPod (5th generation, "video"), 2005–06, the 5.5G included.
    Video,
    /// iPod classic (6th, 6.5th and 7th generations), 2007–09.
    Classic,
    /// iPod nano, 1st generation.
    Nano1,
    /// iPod nano, 2nd generation.
    Nano2,
    /// iPod nano, 3rd generation.
    Nano3,
    /// iPod nano, 4th generation.
    Nano4,
    /// iPod nano, 5th generation.
    Nano5,
    /// iPod nano, 6th generation.
    Nano6,
    /// iPod nano, 7th generation.
    Nano7,
}

/// How the firmware checks the database, as `mhbd` stores it at `0x30`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checksum {
    /// Not checked.
    None,
    /// `hash58`: an HMAC-SHA1 keyed on the FireWire GUID (classic, nano 3G and 4G).
    Hash58,
    /// `hash72`: a per-device secret taken from a database iTunes wrote (nano 5G).
    Hash72,
    /// `hashAB`: a white-box cipher over the SHA-1 and the GUID (nano 6G and 7G).
    HashAb,
}

impl Checksum {
    /// The scheme a database's header names (`mhbd`, offset `0x30`), if known.
    pub fn from_scheme(scheme: u16) -> Option<Checksum> {
        match scheme {
            0 => Some(Checksum::None),
            1 => Some(Checksum::Hash58),
            2 => Some(Checksum::Hash72),
            3 => Some(Checksum::HashAb),
            _ => None,
        }
    }

    /// The scheme's name, as the RECORD and the tools write it.
    pub fn name(self) -> &'static str {
        match self {
            Checksum::None => "none",
            Checksum::Hash58 => "hash58",
            Checksum::Hash72 => "hash72",
            Checksum::HashAb => "hashAB",
        }
    }
}

impl Generation {
    /// The generation a USB product ID (under [`APPLE_VENDOR_ID`]) belongs to, for
    /// an iPod in disk mode.
    pub fn from_usb_product(product_id: u16) -> Option<Generation> {
        Some(match product_id {
            0x1209 => Generation::Video,
            0x120a => Generation::Nano1,
            0x1260 => Generation::Nano2,
            0x1261 => Generation::Classic,
            0x1262 => Generation::Nano3,
            0x1263 => Generation::Nano4,
            0x1265 => Generation::Nano5,
            0x1266 => Generation::Nano6,
            0x1267 => Generation::Nano7,
            _ => return None,
        })
    }

    /// The name people know it by.
    pub fn name(self) -> &'static str {
        match self {
            Generation::Video => "iPod (5th generation, video)",
            Generation::Classic => "iPod classic",
            Generation::Nano1 => "iPod nano (1st generation)",
            Generation::Nano2 => "iPod nano (2nd generation)",
            Generation::Nano3 => "iPod nano (3rd generation)",
            Generation::Nano4 => "iPod nano (4th generation)",
            Generation::Nano5 => "iPod nano (5th generation)",
            Generation::Nano6 => "iPod nano (6th generation)",
            Generation::Nano7 => "iPod nano (7th generation)",
        }
    }

    /// The checksum its firmware expects on the database.
    pub fn checksum(self) -> Checksum {
        match self {
            Generation::Video | Generation::Nano1 | Generation::Nano2 => Checksum::None,
            Generation::Classic | Generation::Nano3 | Generation::Nano4 => Checksum::Hash58,
            Generation::Nano5 => Checksum::Hash72,
            Generation::Nano6 | Generation::Nano7 => Checksum::HashAb,
        }
    }

    /// The database file its firmware reads, under `iPod_Control/iTunes/`.
    pub fn database_file(self) -> &'static str {
        match self {
            Generation::Nano5 | Generation::Nano6 | Generation::Nano7 => "iTunesCDB",
            _ => "iTunesDB",
        }
    }

    /// Whether its firmware also reads the SQLite library (`iTunes Library.itlp`).
    pub fn uses_sqlite_library(self) -> bool {
        matches!(self, Generation::Nano6 | Generation::Nano7)
    }
}

/// The device's 8-byte FireWire GUID, which `hash58` and `hashAB` are keyed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Guid(pub [u8; 8]);

impl Guid {
    /// Parses 16 hex digits, with or without a `0x` prefix; spaces and
    /// surrounding whitespace are ignored.
    pub fn from_hex(text: &str) -> Option<Guid> {
        let text = text.trim();
        let text = text
            .strip_prefix("0x")
            .or_else(|| text.strip_prefix("0X"))
            .unwrap_or(text);
        let digits: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if digits.len() != 16 {
            return None;
        }
        Self::from_digits(&digits)
    }

    /// The GUID in a USB serial number: its first 16 characters, when they are
    /// hex digits (these iPods report the GUID as the start of their serial).
    pub fn from_usb_serial(serial: &str) -> Option<Guid> {
        let digits = serial.trim().get(..16)?;
        Self::from_digits(digits)
    }

    fn from_digits(digits: &str) -> Option<Guid> {
        if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let mut bytes = [0; 8];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&digits[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(Guid(bytes))
    }

    /// Sixteen upper-case hex digits.
    pub fn to_hex(self) -> String {
        self.0.iter().map(|b| format!("{b:02X}")).collect()
    }
}

/// Where a [`Guid`] was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuidSource {
    /// `SysInfoExtended`'s `FireWireGUID`.
    SysInfoExtended,
    /// `SysInfo`'s `FirewireGuid`.
    SysInfo,
    /// The first 16 hex digits of the USB serial number.
    UsbSerial,
}

/// The GUID from what is known of the device, trying `SysInfoExtended`, then
/// `SysInfo`, then the USB serial number.
pub fn find_guid(
    extended: &BTreeMap<String, String>,
    sysinfo: &BTreeMap<String, String>,
    usb_serial: Option<&str>,
) -> Option<(Guid, GuidSource)> {
    let named = |values: &BTreeMap<String, String>| {
        ["FireWireGUID", "FirewireGuid", "FireWireGuid"]
            .iter()
            .find_map(|key| values.get(*key).and_then(|v| Guid::from_hex(v)))
    };
    named(extended)
        .map(|g| (g, GuidSource::SysInfoExtended))
        .or_else(|| named(sysinfo).map(|g| (g, GuidSource::SysInfo)))
        .or_else(|| {
            usb_serial
                .and_then(Guid::from_usb_serial)
                .map(|g| (g, GuidSource::UsbSerial))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generations() {
        let nano7 = Generation::from_usb_product(0x1267).unwrap();
        assert_eq!(nano7, Generation::Nano7);
        assert_eq!(nano7.checksum(), Checksum::HashAb);
        assert_eq!(nano7.database_file(), "iTunesCDB");
        assert!(nano7.uses_sqlite_library());
        assert_eq!(nano7.name(), "iPod nano (7th generation)");
        let classic = Generation::from_usb_product(0x1261).unwrap();
        assert_eq!(classic.checksum(), Checksum::Hash58);
        assert_eq!(classic.database_file(), "iTunesDB");
        assert!(!classic.uses_sqlite_library());
        assert_eq!(Generation::from_usb_product(0x1209).unwrap().checksum(), Checksum::None);
        assert_eq!(
            Generation::from_usb_product(0x1265).unwrap().checksum(),
            Checksum::Hash72
        );
        assert_eq!(Generation::from_usb_product(0x12a8), None);
        for id in [0x1209, 0x120a, 0x1260, 0x1261, 0x1262, 0x1263, 0x1265, 0x1266, 0x1267] {
            assert!(!Generation::from_usb_product(id).unwrap().name().is_empty());
        }
    }

    #[test]
    fn schemes() {
        assert_eq!(Checksum::from_scheme(3), Some(Checksum::HashAb));
        assert_eq!(Checksum::from_scheme(0).map(Checksum::name), Some("none"));
        assert_eq!(Checksum::from_scheme(1).map(Checksum::name), Some("hash58"));
        assert_eq!(Checksum::from_scheme(2).map(Checksum::name), Some("hash72"));
        assert_eq!(Checksum::from_scheme(9), None);
    }

    #[test]
    fn guids() {
        let g = Guid::from_hex("0x000A2700138B4E3E").unwrap();
        assert_eq!(g.0, [0x00, 0x0a, 0x27, 0x00, 0x13, 0x8b, 0x4e, 0x3e]);
        assert_eq!(g.to_hex(), "000A2700138B4E3E");
        assert_eq!(Guid::from_hex(" 000a2700 138b4e3e "), Some(g));
        assert_eq!(Guid::from_hex("000A2700138B4E"), None);
        assert_eq!(Guid::from_hex("000A2700138B4EZZ"), None);
        assert_eq!(Guid::from_usb_serial("000A2700138B4E3E0000"), Some(g));
        assert_eq!(Guid::from_usb_serial("short"), None);
    }

    #[test]
    fn guid_sources_in_order() {
        let mut extended = BTreeMap::new();
        let mut sysinfo = BTreeMap::new();
        let serial = Some("000A270000000003");
        assert_eq!(find_guid(&extended, &sysinfo, serial).unwrap().1, GuidSource::UsbSerial);
        sysinfo.insert("FirewireGuid".into(), "0x000A270000000002".into());
        assert_eq!(find_guid(&extended, &sysinfo, serial).unwrap().1, GuidSource::SysInfo);
        extended.insert("FireWireGUID".into(), "000A270000000001".into());
        let (guid, source) = find_guid(&extended, &sysinfo, serial).unwrap();
        assert_eq!((guid.0[7], source), (1, GuidSource::SysInfoExtended));
        assert_eq!(find_guid(&BTreeMap::new(), &BTreeMap::new(), None), None);
    }
}
