//! The iPod's own description of itself.
//!
//! - `iPod_Control/Device/SysInfo`: plain `Key: value` lines, which older
//!   firmware writes and newer firmware leaves empty or missing.
//! - `SysInfoExtended`: an XML property list the iPod sends in answer to a USB
//!   vendor request (and that tools keep a copy of beside `SysInfo`). Its
//!   firmware writes it as an invalid plist (keys inside arrays, among other
//!   things), so it is not parsed as one: [`extended_values`] scans it for
//!   `<key>` elements followed by a scalar.

use std::collections::BTreeMap;

/// The values of a `SysInfo` file, by key, in the order of the keys' names.
/// The first value wins when a key is repeated.
pub fn parse_sysinfo(text: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            if !key.is_empty() {
                values
                    .entry(key.to_string())
                    .or_insert_with(|| value.trim().to_string());
            }
        }
    }
    values
}

/// Every `<key>` of a `SysInfoExtended` followed by a scalar (`<string>`,
/// `<integer>`, `<real>`, `<date>`, `<true/>` or `<false/>`), wherever it is in the
/// document, by key. The first value wins when a key is repeated, so nested
/// dictionaries never override a top-level value that comes first.
///
/// Entities (`&amp;`, `&lt;`, …) are decoded. A key followed by anything else
/// (a `<dict>`, an `<array>`, `<data>`) is skipped.
pub fn extended_values(xml: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<key>") {
        rest = &rest[start + "<key>".len()..];
        let Some(end) = rest.find("</key>") else { break };
        let key = decode_entities(rest[..end].trim());
        rest = rest[end + "</key>".len()..].trim_start();
        if let Some(value) = scalar(rest) {
            values.entry(key).or_insert(value);
        }
    }
    values
}

/// The scalar element `text` starts with, if it starts with one.
fn scalar(text: &str) -> Option<String> {
    if text.starts_with("<true/>") {
        return Some("true".to_string());
    }
    if text.starts_with("<false/>") {
        return Some("false".to_string());
    }
    for tag in ["string", "integer", "real", "date"] {
        let open = format!("<{tag}>");
        if let Some(body) = text.strip_prefix(&open) {
            let close = format!("</{tag}>");
            let end = body.find(&close)?;
            return Some(decode_entities(&body[..end]));
        }
        if text.starts_with(&format!("<{tag}/>")) {
            return Some(String::new());
        }
    }
    None
}

/// The text with XML's five predefined entities and numeric references
/// decoded. An unknown or malformed entity is kept as it is.
pub(crate) fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest.find(';').and_then(|semi| {
            let name = &rest[1..semi];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => {
                    let code = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        name.strip_prefix('#').and_then(|dec| dec.parse().ok())
                    };
                    code.and_then(char::from_u32)
                }
            };
            ch.map(|ch| (ch, semi))
        });
        match decoded {
            Some((ch, semi)) => {
                out.push(ch);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sysinfo_lines() {
        let values = parse_sysinfo(
            "BoardHwName: iPod Q98\r\nFirewireGuid: 0x000A2700138B4E3E\nModelNumStr: xA623\nbad line\nModelNumStr: later\n: empty key\n",
        );
        assert_eq!(values["BoardHwName"], "iPod Q98");
        assert_eq!(values["FirewireGuid"], "0x000A2700138B4E3E");
        assert_eq!(values["ModelNumStr"], "xA623");
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn extended_scalars_anywhere() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>SerialNumber</key><string>CC4KX0ABCDEF</string>
  <key>FireWireGUID</key>
  <string>000A27002138B0E5</string>
  <key>FamilyID</key><integer>32</integer>
  <key>Nested</key><array><key>Inside</key><string>a &amp; b &#x41;&#66; &bogus; &</string></array>
  <key>AudioCodecs</key><dict><key>SerialNumber</key><string>not this one</string></dict>
  <key>SupportsSparseArtwork</key><true/>
  <key>Off</key><false/>
  <key>Empty</key><string/>
  <key>Blob</key><data>AAAA</data>
</dict></plist>"#;
        let values = extended_values(xml);
        assert_eq!(values["SerialNumber"], "CC4KX0ABCDEF");
        assert_eq!(values["FireWireGUID"], "000A27002138B0E5");
        assert_eq!(values["FamilyID"], "32");
        assert_eq!(values["Inside"], "a & b AB &bogus; &");
        assert_eq!(values["SupportsSparseArtwork"], "true");
        assert_eq!(values["Off"], "false");
        assert_eq!(values["Empty"], "");
        assert!(!values.contains_key("Blob"));
        assert!(!values.contains_key("Nested"));
    }

    #[test]
    fn extended_truncated() {
        assert!(extended_values("<key>Open").is_empty());
        assert!(extended_values("<key>A</key><string>never closed").is_empty());
    }
}
