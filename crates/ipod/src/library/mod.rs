//! The SQLite library of the nano 6G and 7G (`iPod_Control/iTunes/iTunes
//! Library.itlp/`), as data: its files' schema, the post-process its
//! `SysInfoExtended` asks for, and its rows. No I/O and no SQLite here; the
//! files are read and written by `jackbird-ipod-sqlite`.
//!
//! How Apple writes it, as the round trip on the owner's nano 7G shows
//! (`RECORD/2026-11-14.ipod-sync.WIP.md`, N3): every table with all its
//! columns ([`schema::FILES`]), then its rows, then the post-process, run on the
//! library with the other four files attached. The post-process makes
//! `track_artist`, `track_size_calc`, every index, the "unknown" album, artist,
//! composer and genre rows, and the counts and flags. Its `ALTER TABLE … ADD
//! COLUMN`s fail on columns the schema already has, and that is expected: each
//! command is run on its own and a failure does not stop the others.

pub mod schema;

/// One of the library's files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct File {
    /// Its name in `iTunes Library.itlp/`.
    pub name: &'static str,
    /// The name it is attached under while the post-process runs (`main` for
    /// the library itself).
    pub schema_name: &'static str,
    /// Its page size. `Locations.itdb`'s is 1 KB, the block its checksum book
    /// hashes.
    pub page_size: u32,
    /// Its `PRAGMA user_version`.
    pub user_version: i64,
    /// Its tables before the post-process: name and `CREATE TABLE`.
    pub tables: &'static [(&'static str, &'static str)],
}

/// The file named `name`.
pub fn file(name: &str) -> Option<&'static File> {
    schema::FILES.iter().find(|f| f.name == name)
}

/// The columns of `table` (in any file of the schema) and the value each
/// takes when a row leaves it out: its `DEFAULT`, or `NULL`. Read from the
/// `CREATE TABLE` itself.
pub fn columns(table: &str) -> Option<Vec<(String, Value)>> {
    let create = schema::FILES
        .iter()
        .flat_map(|f| f.tables.iter())
        .find(|(name, _)| *name == table)?
        .1;
    let body = &create[create.find('(')? + 1..create.rfind(')')?];
    let mut out = Vec::new();
    for definition in split_top_level(body) {
        let definition = definition.trim();
        let first = definition.split_whitespace().next().unwrap_or("");
        if ["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"].contains(&first) {
            continue;
        }
        let words: Vec<&str> = definition.split_whitespace().collect();
        let default = words
            .iter()
            .position(|w| w.eq_ignore_ascii_case("DEFAULT"))
            .and_then(|i| words.get(i + 1))
            .map_or(Value::Null, |literal| parse_literal(literal));
        out.push((first.to_string(), default));
    }
    Some(out)
}

/// `text` split at the commas that are not inside parentheses.
fn split_top_level(text: &str) -> Vec<&str> {
    let (mut out, mut depth, mut start) = (Vec::new(), 0usize, 0);
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                out.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&text[start..]);
    out
}

fn parse_literal(literal: &str) -> Value {
    if let Ok(i) = literal.parse::<i64>() {
        Value::Integer(i)
    } else if let Ok(r) = literal.parse::<f64>() {
        Value::Real(r)
    } else if let Some(t) = literal.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')) {
        Value::Text(t.replace("''", "'"))
    } else {
        Value::Null
    }
}

/// A value in a row, as SQLite stores it.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// `NULL`.
    Null,
    /// An integer.
    Integer(i64),
    /// A floating-point number.
    Real(f64),
    /// Text.
    Text(String),
    /// Bytes.
    Blob(Vec<u8>),
}

/// A table's rows, with the columns they give values for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Table {
    /// The table's name.
    pub name: String,
    /// The columns, in the order of each row's values.
    pub columns: Vec<String>,
    /// The rows.
    pub rows: Vec<Vec<Value>>,
}

impl Table {
    /// Where `column` is in a row.
    pub fn column(&self, column: &str) -> Option<usize> {
        self.columns.iter().position(|c| c == column)
    }

    /// Adds a row with these values; the table's other columns take their
    /// default ([`columns`]), or `NULL` for a table the schema does not have.
    /// A value for a column the table lacks is an error, naming it.
    pub fn push(&mut self, values: &[(&str, Value)]) -> Result<(), String> {
        if let Some((name, _)) = values.iter().find(|(c, _)| self.column(c).is_none()) {
            return Err(format!("{} has no column {name}", self.name));
        }
        let defaults = columns(&self.name).unwrap_or_default();
        let row = self
            .columns
            .iter()
            .map(|c| {
                values
                    .iter()
                    .find(|(name, _)| name == c)
                    .map(|(_, v)| v.clone())
                    .or_else(|| defaults.iter().find(|(name, _)| name == c).map(|(_, v)| v.clone()))
                    .unwrap_or(Value::Null)
            })
            .collect();
        self.rows.push(row);
        Ok(())
    }

    /// The rows whose `column` is `value`.
    pub fn find<'a>(&'a self, column: &str, value: &'a Value) -> impl Iterator<Item = &'a Vec<Value>> + 'a {
        let c = self.column(column);
        self.rows.iter().filter(move |r| c.is_some_and(|c| &r[c] == value))
    }

    /// The value of `column` in `row`, `NULL` when the table lacks it.
    pub fn get(&self, row: &[Value], column: &str) -> Value {
        self.column(column).map_or(Value::Null, |c| row[c].clone())
    }
}

/// The rows of one file: a [`Table`] for each of its tables, in its schema's
/// order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rows {
    /// The file's name ([`File::name`]).
    pub file: String,
    /// Its tables.
    pub tables: Vec<Table>,
}

impl Rows {
    /// The table named `name`.
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.tables.iter().find(|t| t.name == name)
    }

    /// The table named `name`, to change it.
    pub fn table_mut(&mut self, name: &str) -> Option<&mut Table> {
        self.tables.iter_mut().find(|t| t.name == name)
    }
}

/// A named command of the post-process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    /// Its name in `SQLCommands`.
    pub name: String,
    /// Its SQL.
    pub sql: String,
}

/// Why the post-process could not be read from a `SysInfoExtended`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PostProcessError {
    /// The document has no `SQLMusicLibraryPostProcessCommands`, or it has no
    /// `SQLCommands` or `UserVersionCommandSets`.
    Missing,
    /// No command set for this `user_version`.
    NoSetFor(i64),
    /// A set names a command `SQLCommands` does not define.
    Undefined(String),
}

impl std::fmt::Display for PostProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PostProcessError::Missing => write!(f, "SysInfoExtended holds no library post-process"),
            PostProcessError::NoSetFor(v) => write!(f, "the post-process has no command set for user_version {v}"),
            PostProcessError::Undefined(name) => write!(f, "the post-process names an undefined command, {name}"),
        }
    }
}

impl std::error::Error for PostProcessError {}

/// The key of the post-process in `SysInfoExtended`.
pub const POST_PROCESS_KEY: &str = "com.apple.mobile.iTunes.SQLMusicLibraryPostProcessCommands";

/// The commands a library at `user_version` is to be post-processed with, in
/// order, read from a `SysInfoExtended` (the device's, never a copy built in
/// jackbird: each firmware may ask for other commands). A name listed twice is
/// given twice.
pub fn post_process(sysinfo_extended: &str, user_version: i64) -> Result<Vec<Command>, PostProcessError> {
    let section = element_after_key(sysinfo_extended, POST_PROCESS_KEY).ok_or(PostProcessError::Missing)?;
    let definitions = element_after_key(section, "SQLCommands").ok_or(PostProcessError::Missing)?;
    let sets = element_after_key(section, "UserVersionCommandSets").ok_or(PostProcessError::Missing)?;
    let set = element_after_key(sets, &user_version.to_string()).ok_or(PostProcessError::NoSetFor(user_version))?;
    let names = element_after_key(set, "Commands").ok_or(PostProcessError::NoSetFor(user_version))?;
    let definitions = crate::sysinfo::extended_values(definitions);
    strings(names)
        .into_iter()
        .map(|name| match definitions.get(&name) {
            Some(sql) => Ok(Command { name, sql: sql.clone() }),
            None => Err(PostProcessError::Undefined(name)),
        })
        .collect()
}

/// The inside of the `<dict>` or `<array>` that follows `<key>key</key>` in
/// `text`, at the first such key whose value is one. Nested elements are
/// counted, so the inside ends at its own closing tag.
pub(crate) fn element_after_key<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("<key>{key}</key>");
    let mut from = 0;
    while let Some(at) = text[from..].find(&needle) {
        let after = from + at + needle.len();
        let rest = text[after..].trim_start();
        let start = text.len() - rest.len();
        for tag in ["dict", "array"] {
            let open = format!("<{tag}>");
            if rest.starts_with(&open) {
                let inner = start + open.len();
                return closing(text, inner, tag).map(|end| &text[inner..end]);
            }
        }
        from = after;
    }
    None
}

/// Where the `</tag>` that closes an element whose inside starts at `from` is.
fn closing(text: &str, from: usize, tag: &str) -> Option<usize> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut depth = 1usize;
    let mut at = from;
    loop {
        let next_open = text[at..].find(&open).map(|i| at + i);
        let next_close = text[at..].find(&close).map(|i| at + i)?;
        match next_open {
            Some(o) if o < next_close => {
                depth += 1;
                at = o + open.len();
            }
            _ => {
                depth -= 1;
                if depth == 0 {
                    return Some(next_close);
                }
                at = next_close + close.len();
            }
        }
    }
}

/// The `<string>`s in `text`, in order, with their entities decoded.
pub(crate) fn strings(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("<string>") {
        rest = &rest[at + "<string>".len()..];
        let Some(end) = rest.find("</string>") else { break };
        out.push(crate::sysinfo::decode_entities(&rest[..end]));
        rest = &rest[end..];
    }
    out
}

/// What the post-process makes, taken out of a library read from a device so
/// that it can run again on what is left: the rows of `track_artist` and
/// `track_size_calc` (which it drops and rebuilds), the "unknown" rows of
/// `album`, `artist`, `composer` and `genre_map` (`is_unknown` = 1, which it
/// inserts again whenever an item lacks one), and the links of the items to
/// those rows, set back to what an item without an album, artist, composer or
/// genre has before it runs (`NULL`, `NULL`, 0 and 0).
///
/// Every other value is kept as it is: the post-process recomputes its counts
/// and flags over them and gives the same ones back.
pub fn strip_post_processed(library: &mut Rows) {
    library
        .tables
        .retain(|t| t.name != "track_artist" && t.name != "track_size_calc");
    let links = [
        ("album", "pid", "album_pid", Value::Null),
        ("artist", "pid", "artist_pid", Value::Null),
        ("composer", "pid", "composer_pid", Value::Integer(0)),
        ("genre_map", "id", "genre_id", Value::Integer(0)),
    ];
    for (table, key, link, unset) in links {
        let Some(t) = library.table_mut(table) else { continue };
        let (Some(unknown), Some(key)) = (t.column("is_unknown"), t.column(key)) else {
            continue;
        };
        let mut ids = Vec::new();
        t.rows.retain(|row| {
            let is = row.get(unknown) == Some(&Value::Integer(1));
            if is {
                ids.extend(row.get(key).cloned());
            }
            !is
        });
        let Some(items) = library.table_mut("item") else {
            continue;
        };
        let Some(link) = items.column(link) else { continue };
        for row in &mut items.rows {
            if row.get(link).is_some_and(|v| ids.contains(v)) {
                row[link] = unset.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXTENDED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
<key>FireWireGUID</key>
<string>000A270024AE97A7</string>
<key>com.apple.mobile.iTunes.SQLMusicLibraryPostProcessCommands</key>
<dict>
<key>UserVersionCommandSets</key>
<dict>
<key>25</key>
<dict>
<key>Commands</key>
<array>
<string>Bump</string>
<string>Count</string>
</array>
</dict>
<key>26</key>
<dict>
<key>Commands</key>
<array>
<string>Count</string>
<string>Count</string>
<string>Level</string>
</array>
</dict>
</dict>
<key>SQLCommands</key>
<dict>
<key>Bump</key>
<string>PRAGMA user_version=26;</string>
<key>Count</key>
<string>UPDATE album SET item_count = (SELECT COUNT(*) FROM item WHERE item.album_pid &gt; 0);</string>
<key>Level</key>
<string>UPDATE version_info SET device_update_level = 1109;</string>
</dict>
</dict>
<key>Accessories</key>
<dict>
<key>Empeds</key>
<array>
<key></key>
<dict>
<key>ID</key>
<integer>0</integer>
</dict>
</array>
</dict>
</dict>
</plist>
"#;

    #[test]
    fn post_process_in_order_with_repeats() {
        let names =
            |v: i64| -> Vec<String> { post_process(EXTENDED, v).unwrap().into_iter().map(|c| c.name).collect() };
        assert_eq!(names(26), ["Count", "Count", "Level"]);
        assert_eq!(names(25), ["Bump", "Count"]);
        let commands = post_process(EXTENDED, 26).unwrap();
        assert_eq!(
            commands[0].sql,
            "UPDATE album SET item_count = (SELECT COUNT(*) FROM item WHERE item.album_pid > 0);"
        );
        assert_eq!(post_process(EXTENDED, 24), Err(PostProcessError::NoSetFor(24)));
    }

    #[test]
    fn post_process_errors() {
        assert_eq!(
            post_process("<plist><dict/></plist>", 26),
            Err(PostProcessError::Missing)
        );
        let undefined = EXTENDED.replace("<key>Level</key>", "<key>Other</key>");
        assert_eq!(
            post_process(&undefined, 26),
            Err(PostProcessError::Undefined("Level".into()))
        );
        // Cut short: never a panic.
        for cut in (0..EXTENDED.len()).step_by(7) {
            let _ = post_process(&EXTENDED[..cut], 26);
        }
    }

    #[test]
    fn columns_and_their_defaults() {
        let item = columns("item").unwrap();
        assert_eq!(item[0], ("pid".to_string(), Value::Null));
        assert!(item.contains(&("is_song".to_string(), Value::Integer(0))));
        assert!(!item.iter().any(|(c, _)| c == "PRIMARY"));
        let stats = columns("item_stats").unwrap();
        assert!(stats.contains(&("bookmark_time_ms".to_string(), Value::Null)));
        assert_eq!(columns("nothing"), None);
        assert_eq!(parse_literal("'it''s'"), Value::Text("it's".into()));
        assert_eq!(parse_literal("1.5"), Value::Real(1.5));
        assert_eq!(parse_literal("x"), Value::Null);

        let mut t = Table {
            name: "genre_map".into(),
            columns: vec!["id".into(), "genre".into(), "has_music".into()],
            rows: vec![],
        };
        t.push(&[("id", Value::Integer(5)), ("genre", Value::Text("Rock".into()))])
            .unwrap();
        assert_eq!(
            t.rows[0],
            [Value::Integer(5), Value::Text("Rock".into()), Value::Integer(0)]
        );
        assert!(t.push(&[("nope", Value::Null)]).is_err());
        assert_eq!(t.find("id", &Value::Integer(5)).count(), 1);
        assert_eq!(t.get(&t.rows[0], "genre"), Value::Text("Rock".into()));
        assert_eq!(t.get(&t.rows[0], "nope"), Value::Null);
    }

    #[test]
    fn the_schema_is_whole() {
        let names: Vec<&str> = schema::FILES.iter().map(|f| f.name).collect();
        assert_eq!(
            names,
            [
                "Library.itdb",
                "Locations.itdb",
                "Dynamic.itdb",
                "Extras.itdb",
                "Genius.itdb"
            ]
        );
        assert_eq!(file("Locations.itdb").unwrap().page_size, 1024);
        assert_eq!(file("Library.itdb").unwrap().user_version, 26);
        for f in &schema::FILES {
            for (name, sql) in f.tables {
                assert!(sql.starts_with(&format!("CREATE TABLE {name} (")), "{name}");
                assert_ne!(*name, "track_artist");
            }
        }
    }

    fn table(name: &str, columns: &[&str], rows: Vec<Vec<Value>>) -> Table {
        Table {
            name: name.into(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows,
        }
    }

    #[test]
    fn strip_what_the_post_process_makes() {
        use Value::{Integer as I, Null, Text as T};
        let mut library = Rows {
            file: "Library.itdb".into(),
            tables: vec![
                table(
                    "item",
                    &["pid", "album_pid", "artist_pid", "composer_pid", "genre_id"],
                    vec![
                        vec![I(1), I(10), I(20), I(30), I(40)],
                        vec![I(2), I(11), I(21), I(31), I(41)],
                    ],
                ),
                table(
                    "album",
                    &["pid", "name", "is_unknown"],
                    vec![
                        vec![I(10), T("A".into()), I(0)],
                        vec![I(11), T("Unknown Album".into()), I(1)],
                    ],
                ),
                table(
                    "artist",
                    &["pid", "is_unknown"],
                    vec![vec![I(20), I(0)], vec![I(21), I(1)]],
                ),
                table(
                    "composer",
                    &["pid", "is_unknown"],
                    vec![vec![I(30), I(0)], vec![I(31), I(1)]],
                ),
                table(
                    "genre_map",
                    &["id", "is_unknown"],
                    vec![vec![I(40), I(0)], vec![I(41), I(1)]],
                ),
                table("track_artist", &["pid"], vec![vec![I(1)]]),
                table("track_size_calc", &["pid"], vec![vec![I(1)]]),
            ],
        };
        strip_post_processed(&mut library);
        let names: Vec<&str> = library.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["item", "album", "artist", "composer", "genre_map"]);
        let items = &library.table("item").unwrap().rows;
        assert_eq!(items[0], [I(1), I(10), I(20), I(30), I(40)]);
        assert_eq!(items[1], [I(2), Null, Null, I(0), I(0)]);
        for t in ["album", "artist", "composer", "genre_map"] {
            assert_eq!(library.table(t).unwrap().rows.len(), 1, "{t}");
        }
    }
}
