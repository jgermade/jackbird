//! How the nano's menus sort: the collation behind the SQLite library's ranks
//! (`item.title_order`, `artist.name_order`, …), and the ranks themselves.
//!
//! Found on the owner's nano 7G, synced by Apple's Music app in Spanish
//! (`RECORD/2026-11-14.ipod-sync.WIP.md`, N4b), where it gives every one of
//! its ranks exactly:
//!
//! - letters before digits only at the very start (a title that starts with a
//!   number comes after the letters); inside, punctuation, then numbers, then
//!   letters;
//! - numbers by their value (`3` before `19`);
//! - punctuation in CLDR's order (`-` before `'` before `.` before `*`…);
//! - case and accents ignored, but `ñ` is its own letter, after `n`;
//! - typographic quotes as plain ones, `…` as `...`.
//!
//! Ranks are dense, in steps of 100: equal keys share one, and a missing value
//! comes after every other. `genre_map.genre_order` alone counts in ones and
//! tells case apart (`Post-hardcore` before `Post-Hardcore`).

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use crate::library::{Rows, Value};

/// Punctuation and symbols in the order CLDR's root collation gives them;
/// anything else not a letter or a digit comes after these, by code point.
const PUNCTUATION: &str = " _-,;:!¡?¿.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// Accented Latin letters and the letter they sort as.
const ACCENTED: [(&str, char); 26] = [
    ("àáâãäåāăąǎ", 'a'),
    ("çćĉċč", 'c'),
    ("ďđ", 'd'),
    ("èéêëēĕėęě", 'e'),
    ("ĝğġģ", 'g'),
    ("ĥħ", 'h'),
    ("ìíîïĩīĭįıǐ", 'i'),
    ("ĵ", 'j'),
    ("ķ", 'k'),
    ("ĺļľŀł", 'l'),
    ("ńņňŉ", 'n'),
    ("òóôõöōŏőǒ", 'o'),
    ("ŕŗř", 'r'),
    ("śŝşšș", 's'),
    ("ţťŧț", 't'),
    ("ùúûüũūŭůűųǔǖǘǚǜ", 'u'),
    ("ŵ", 'w'),
    ("ýÿŷ", 'y'),
    ("źżž", 'z'),
    ("ø", 'o'),
    ("æ", 'a'),
    ("œ", 'o'),
    ("ð", 'd'),
    ("þ", 't'),
    ("ĳ", 'i'),
    ("ſ", 's'),
];

/// One element of a sort key, in the order they compare.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Element {
    /// A mark, by its place in [`PUNCTUATION`] (then by code point).
    Mark(u32),
    /// A run of digits, by value: its length without leading zeros, then its digits.
    Number(usize, String),
    /// A letter, and whether it is `ñ` (after `n`).
    Letter(char, bool),
}

/// What a string sorts by, case and accents aside.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Key {
    starts_with_digit: bool,
    elements: Vec<ElementKey>,
}

/// [`Element`], hashable.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct ElementKey(u8, u32, usize, String);

impl From<Element> for ElementKey {
    fn from(e: Element) -> Self {
        match e {
            Element::Mark(m) => ElementKey(0, m, 0, String::new()),
            Element::Number(len, digits) => ElementKey(1, 0, len, digits),
            Element::Letter(c, tilde) => ElementKey(2, c as u32 * 2 + u32::from(tilde), 0, String::new()),
        }
    }
}

/// The letters of `text`, lower case, accents off (but `ñ`), quotes plain.
fn fold(text: &str) -> Vec<char> {
    let mut out = Vec::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\u{2018}' | '\u{2019}' => out.push('\''),
            '\u{201c}' | '\u{201d}' => out.push('"'),
            '\u{2026}' => out.extend(['.', '.', '.']),
            'ß' => out.extend(['s', 's']),
            _ => {
                for lower in c.to_lowercase() {
                    let base = ACCENTED.iter().find(|(set, _)| set.contains(lower)).map(|(_, b)| *b);
                    out.push(base.unwrap_or(lower));
                }
            }
        }
    }
    out
}

/// The sort key of `text`.
pub fn key(text: &str) -> Key {
    let folded = fold(text);
    let mut elements = Vec::new();
    let mut i = 0;
    while i < folded.len() {
        let c = folded[i];
        if c.is_ascii_digit() {
            let start = i;
            while i < folded.len() && folded[i].is_ascii_digit() {
                i += 1;
            }
            let digits: String = folded[start..i].iter().collect();
            let trimmed = digits.trim_start_matches('0').to_string();
            elements.push(Element::Number(trimmed.len(), trimmed));
            continue;
        }
        elements.push(if c == 'ñ' {
            Element::Letter('n', true)
        } else if c.is_alphabetic() {
            Element::Letter(c, false)
        } else {
            match PUNCTUATION.chars().position(|p| p == c) {
                Some(p) => Element::Mark(p as u32),
                None => Element::Mark(1000 + c as u32),
            }
        });
        i += 1;
    }
    Key {
        starts_with_digit: folded.first().is_some_and(char::is_ascii_digit),
        elements: elements.into_iter().map(ElementKey::from).collect(),
    }
}

/// Compares two strings as the nano's menus do.
pub fn compare(a: &str, b: &str) -> Ordering {
    key(a).cmp(&key(b))
}

/// Dense ranks, in steps of `step`, of `values` by `key_of`: equal keys share
/// one, and `None` comes after every other.
pub fn ranks<K: Ord + Clone>(values: &[Option<K>], step: i64) -> Vec<i64> {
    let distinct: BTreeMap<K, ()> = values.iter().flatten().map(|k| (k.clone(), ())).collect();
    let rank: BTreeMap<&K, i64> = distinct
        .keys()
        .enumerate()
        .map(|(i, k)| (k, (i as i64 + 1) * step))
        .collect();
    let missing = (distinct.len() as i64 + 1) * step;
    values.iter().map(|v| v.as_ref().map_or(missing, |k| rank[k])).collect()
}

/// What makes `genre_map.genre_order` tell case apart: the key, then each
/// letter's case, lower first.
fn key_with_case(text: &str) -> (Key, Vec<bool>) {
    (key(text), text.chars().map(char::is_uppercase).collect())
}

fn text(v: &Value) -> Option<&str> {
    match v {
        Value::Text(t) => Some(t),
        _ => None,
    }
}

/// Recomputes every rank of a library (the rows of `Library.itdb` before the
/// post-process, without its "unknown" rows: see
/// [`crate::library::strip_post_processed`]):
///
/// - in `item`: `title_order`, `artist_order`, `album_order`, `composer_order`
///   (by the `sort_*` columns), `genre_order` (by its genre's name),
///   `album_artist_order` (its `artist` row's rank) and `series_name_order`;
/// - `name_order` in `artist`, `album` and `composer` (by `sort_name`);
/// - `genre_order` in `genre_map`.
///
/// A table or column the rows lack is left alone.
pub fn rank_library(library: &mut Rows) {
    let column_ranks = |library: &Rows, table: &str, column: &str, step: i64| -> Option<Vec<i64>> {
        let t = library.table(table)?;
        let c = t.column(column)?;
        let keys: Vec<Option<Key>> = t.rows.iter().map(|r| text(&r[c]).map(key)).collect();
        Some(ranks(&keys, step))
    };
    let set = |library: &mut Rows, table: &str, column: &str, values: Vec<i64>| {
        let Some(t) = library.table_mut(table) else { return };
        let Some(c) = t.column(column) else { return };
        for (row, v) in t.rows.iter_mut().zip(values) {
            row[c] = Value::Integer(v);
        }
    };

    for (table, column, order) in [
        ("artist", "sort_name", "name_order"),
        ("album", "sort_name", "name_order"),
        ("composer", "sort_name", "name_order"),
        ("item", "sort_title", "title_order"),
        ("item", "sort_artist", "artist_order"),
        ("item", "sort_album", "album_order"),
        ("item", "sort_composer", "composer_order"),
        ("item", "series_name", "series_name_order"),
    ] {
        if let Some(values) = column_ranks(library, table, column, 100) {
            set(library, table, order, values);
        }
    }

    // Genres: genre_map in ones, case told apart; items by the name, in hundreds.
    let genres: HashMap<i64, String> = library
        .table("genre_map")
        .and_then(|t| {
            let (id, genre) = (t.column("id")?, t.column("genre")?);
            Some(
                t.rows
                    .iter()
                    .filter_map(|r| match (&r[id], text(&r[genre])) {
                        (Value::Integer(i), Some(g)) => Some((*i, g.to_string())),
                        _ => None,
                    })
                    .collect(),
            )
        })
        .unwrap_or_default();
    if let Some(t) = library.table("genre_map")
        && let Some(g) = t.column("genre")
    {
        let keys: Vec<Option<(Key, Vec<bool>)>> = t.rows.iter().map(|r| text(&r[g]).map(key_with_case)).collect();
        let values = ranks(&keys, 1);
        set(library, "genre_map", "genre_order", values);
    }
    if let Some(t) = library.table("item")
        && let Some(g) = t.column("genre_id")
    {
        let keys: Vec<Option<Key>> = t
            .rows
            .iter()
            .map(|r| match &r[g] {
                Value::Integer(id) => genres.get(id).map(|n| key(n)),
                _ => None,
            })
            .collect();
        let values = ranks(&keys, 100);
        set(library, "item", "genre_order", values);
    }

    // An item's album artist sorts as its artist row does.
    let artist_ranks: HashMap<i64, i64> = library
        .table("artist")
        .and_then(|t| {
            let (pid, order) = (t.column("pid")?, t.column("name_order")?);
            Some(
                t.rows
                    .iter()
                    .filter_map(|r| match (&r[pid], &r[order]) {
                        (Value::Integer(p), Value::Integer(o)) => Some((*p, *o)),
                        _ => None,
                    })
                    .collect(),
            )
        })
        .unwrap_or_default();
    // No artist sorts where a missing name does: after the named ones.
    let named_artists = library
        .table("artist")
        .and_then(|t| {
            let c = t.column("sort_name")?;
            let keys: std::collections::BTreeSet<Key> = t.rows.iter().filter_map(|r| text(&r[c]).map(key)).collect();
            Some(keys.len())
        })
        .unwrap_or(0);
    let after_artists = (named_artists as i64 + 1) * 100;
    if let Some(t) = library.table("item")
        && let Some(a) = t.column("artist_pid")
    {
        let values: Vec<i64> = t
            .rows
            .iter()
            .map(|r| match &r[a] {
                Value::Integer(p) => artist_ranks.get(p).copied().unwrap_or(after_artists),
                _ => after_artists,
            })
            .collect();
        set(library, "item", "album_artist_order", values);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Table;

    fn sorted(mut v: Vec<&str>) -> Vec<&str> {
        v.sort_by(|a, b| compare(a, b));
        v
    }

    #[test]
    fn as_the_nano_sorts() {
        assert_eq!(sorted(vec!["Zaz", "13 Songs", "Abba"]), ["Abba", "Zaz", "13 Songs"]);
        assert_eq!(
            sorted(vec!["Greatest Hits II", "Greatest Hits 1970-2002"]),
            ["Greatest Hits 1970-2002", "Greatest Hits II"]
        );
        assert_eq!(sorted(vec!["19-2000", "3 Kilos"]), ["3 Kilos", "19-2000"]);
        assert_eq!(sorted(vec!["F**k The System", "F.O.D."]), ["F.O.D.", "F**k The System"]);
        assert_eq!(sorted(vec!["I'm Bad", "I-E-A-I"]), ["I-E-A-I", "I'm Bad"]);
        assert_eq!(sorted(vec!["Mañana", "Many Of Horror"]), ["Many Of Horror", "Mañana"]);
        assert_eq!(sorted(vec!["Nunca", "Ñu", "Oso"]), ["Nunca", "Ñu", "Oso"]);
        assert_eq!(sorted(vec!["Electrónica", "Electronic"]), ["Electronic", "Electrónica"]);
        assert_eq!(
            sorted(vec!["She´s Got", "She's the One"]),
            ["She's the One", "She´s Got"]
        );
        assert_eq!(compare("Out Of Control", "Out of Control"), Ordering::Equal);
        assert_eq!(compare("Doesn’t", "Doesn't"), Ordering::Equal);
        assert_eq!(compare("007", "7"), Ordering::Equal);
        assert_eq!(compare("Straße", "Strasse"), Ordering::Equal);
    }

    #[test]
    fn dense_ranks_with_missing_last() {
        let v = [Some(3), None, Some(1), Some(3), Some(2)];
        assert_eq!(ranks(&v, 100), [300, 400, 100, 300, 200]);
        assert_eq!(ranks::<i32>(&[None, None], 100), [100, 100]);
    }

    fn table(name: &str, columns: &[&str], rows: Vec<Vec<Value>>) -> Table {
        Table {
            name: name.into(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows,
        }
    }

    #[test]
    fn a_library_ranked() {
        use Value::{Integer as I, Null, Text as T};
        let t = |s: &str| T(s.into());
        let mut library = Rows {
            file: "Library.itdb".into(),
            tables: vec![
                table(
                    "item",
                    &[
                        "pid",
                        "sort_title",
                        "sort_artist",
                        "genre_id",
                        "artist_pid",
                        "title_order",
                        "artist_order",
                        "genre_order",
                        "album_artist_order",
                    ],
                    vec![
                        vec![I(1), t("b"), t("Y"), I(2), I(10), I(0), I(0), I(0), I(0)],
                        vec![I(2), t("a"), Null, I(1), Null, I(0), I(0), I(0), I(0)],
                        vec![I(3), t("B"), t("x"), I(0), I(11), I(0), I(0), I(0), I(0)],
                    ],
                ),
                table(
                    "artist",
                    &["pid", "sort_name", "name_order"],
                    vec![vec![I(10), t("Y"), I(0)], vec![I(11), t("X"), I(0)]],
                ),
                table(
                    "genre_map",
                    &["id", "genre", "genre_order"],
                    vec![vec![I(1), t("Rock"), I(0)], vec![I(2), t("rock"), I(0)]],
                ),
            ],
        };
        rank_library(&mut library);
        let col = |table: &str, c: &str| -> Vec<Value> {
            let t = library.table(table).unwrap();
            let i = t.column(c).unwrap();
            t.rows.iter().map(|r| r[i].clone()).collect()
        };
        assert_eq!(col("item", "title_order"), [I(200), I(100), I(200)]);
        assert_eq!(col("item", "artist_order"), [I(200), I(300), I(100)]);
        assert_eq!(col("artist", "name_order"), [I(200), I(100)]);
        assert_eq!(col("item", "album_artist_order"), [I(200), I(300), I(100)]);
        assert_eq!(col("genre_map", "genre_order"), [I(2), I(1)]);
        assert_eq!(col("item", "genre_order"), [I(100), I(100), I(200)]);
    }
}
