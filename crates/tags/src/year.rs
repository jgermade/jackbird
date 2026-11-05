//! The year: ID3v2.4 timestamps (`yyyy[-MM[-dd[THH[:mm[:ss]]]]]`, §4 of its
//! frames document), and what ID3v2.3 can hold of one.

/// A timestamp's date parts; `None` from the first part not given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Timestamp {
    pub year: u16,
    pub month: Option<u8>,
    pub day: Option<u8>,
    pub has_time: bool,
}

fn digits(text: &str, count: usize) -> Option<u16> {
    if text.len() == count && text.bytes().all(|byte| byte.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

/// Parses an ID3v2.4 timestamp; `None` for anything else ("c. 1959", "59").
pub(crate) fn parse(value: &str) -> Option<Timestamp> {
    let (date, time) = match value.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (value, None),
    };
    let mut parts = date.split('-');
    let year = digits(parts.next()?, 4)?;
    let month = match parts.next() {
        None => None,
        Some(part) => Some(digits(part, 2).filter(|month| (1..=12).contains(month))? as u8),
    };
    let day = match parts.next() {
        None => None,
        Some(part) => Some(digits(part, 2).filter(|day| (1..=31).contains(day))? as u8),
    };
    if parts.next().is_some() {
        return None;
    }
    if let Some(time) = time {
        day?;
        let fields: Vec<&str> = time.split(':').collect();
        if fields.len() > 3 {
            return None;
        }
        for (field, limit) in fields.iter().zip([23, 59, 59]) {
            if digits(field, 2)? > limit {
                return None;
            }
        }
    }
    Some(Timestamp {
        year,
        month,
        day,
        has_time: time.is_some(),
    })
}
