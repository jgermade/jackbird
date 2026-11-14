//! The SQLite library of the nano 6G and 7G (`iTunes Library.itlp/`), read and
//! written with SQLite: the I/O half of [`jackbird_ipod::library`].
//!
//! - [`read`] gives the rows of each file's tables, as the schema of
//!   [`jackbird_ipod::library::schema::FILES`] has them.
//! - [`write`] makes the five files anew in a folder: schema, rows, then the
//!   device's post-process, with the other files attached to the library.
//!
//! Files are never changed in place: [`write`] refuses a folder that already
//! holds one of them. See `RECORD/2026-11-14.ipod-sync.WIP.md`, N3.

use std::path::Path;

use jackbird_ipod::library::{Command, File, Rows, Table, Value, schema::FILES};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, params_from_iter};

/// Why the library could not be read or written.
#[derive(Debug)]
pub enum Error {
    /// SQLite's error, with the file it was on.
    Sqlite(String, rusqlite::Error),
    /// A file to write is already there.
    Exists(String),
    /// Rows given for a file or a table the schema does not have.
    Unknown(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sqlite(file, e) => write!(f, "{file}: {e}"),
            Error::Exists(file) => write!(f, "{file} is already there; the library is only ever written anew"),
            Error::Unknown(what) => write!(f, "{what} is not in the library's schema"),
        }
    }
}

impl std::error::Error for Error {}

fn sqlite(file: &str) -> impl Fn(rusqlite::Error) -> Error + '_ {
    move |e| Error::Sqlite(file.to_string(), e)
}

/// The rows of every file in `folder` (an `iTunes Library.itlp`), opened read
/// only: for each table of the schema, the columns the file has and its rows
/// in `rowid` order. A file that is missing gives no rows; a table the file
/// lacks gives an empty one.
pub fn read(folder: &Path) -> Result<Vec<Rows>, Error> {
    FILES
        .iter()
        .filter(|f| folder.join(f.name).is_file())
        .map(|f| read_file(&folder.join(f.name), f))
        .collect()
}

fn read_file(path: &Path, file: &File) -> Result<Rows, Error> {
    let on = sqlite(file.name);
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(&on)?;
    let mut tables = Vec::new();
    for (name, _) in file.tables {
        let mut columns = Vec::new();
        let mut info = db.prepare(&format!("PRAGMA table_info(\"{name}\")")).map_err(&on)?;
        let mut rows = info.query([]).map_err(&on)?;
        while let Some(row) = rows.next().map_err(&on)? {
            columns.push(row.get::<_, String>(1).map_err(&on)?);
        }
        let mut table = Table {
            name: name.to_string(),
            columns,
            rows: Vec::new(),
        };
        if !table.columns.is_empty() {
            let mut select = db
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .map_err(&on)?;
            let width = table.columns.len();
            let mut rows = select.query([]).map_err(&on)?;
            while let Some(row) = rows.next().map_err(&on)? {
                let values = (0..width)
                    .map(|i| row.get_ref(i).map(value))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(&on)?;
                table.rows.push(values);
            }
        }
        tables.push(table);
    }
    Ok(Rows {
        file: file.name.to_string(),
        tables,
    })
}

fn value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Integer(i),
        ValueRef::Real(r) => Value::Real(r),
        ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Blob(b.to_vec()),
    }
}

fn sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Integer(i) => SqlValue::Integer(*i),
        Value::Real(r) => SqlValue::Real(*r),
        Value::Text(t) => SqlValue::Text(t.clone()),
        Value::Blob(b) => SqlValue::Blob(b.clone()),
    }
}

/// A command of the post-process that failed, and SQLite's reason. Apple's
/// lists hold `ALTER TABLE … ADD COLUMN`s for columns the schema already has,
/// and these fail every time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failed {
    /// The command's name.
    pub name: String,
    /// SQLite's message.
    pub error: String,
}

impl Failed {
    /// Whether it failed only because the column it adds is there already,
    /// as Apple's commands do on Apple's own schema.
    pub fn is_duplicate_column(&self) -> bool {
        self.error.starts_with("duplicate column name")
    }
}

/// Makes the five files of the library in `folder` (which must not hold any of
/// them yet): each with its page size, `auto_vacuum` and `user_version`, its
/// tables and the rows given for them (`rows`, by file; a file or a table
/// without rows is made empty); then runs `post_process` on the library with
/// the other files attached. Every command is run, whatever the ones before it
/// did, as Apple's lists expect; the ones that failed are given back.
pub fn write(folder: &Path, rows: &[Rows], post_process: &[Command]) -> Result<Vec<Failed>, Error> {
    for r in rows {
        let file = FILES
            .iter()
            .find(|f| f.name == r.file)
            .ok_or_else(|| Error::Unknown(r.file.clone()))?;
        if let Some(t) = r.tables.iter().find(|t| !file.tables.iter().any(|(n, _)| *n == t.name)) {
            return Err(Error::Unknown(format!("{}'s table {}", r.file, t.name)));
        }
    }
    if let Some(f) = FILES.iter().find(|f| folder.join(f.name).exists()) {
        return Err(Error::Exists(f.name.to_string()));
    }
    for file in &FILES {
        write_file(&folder.join(file.name), file, rows.iter().find(|r| r.file == file.name))?;
    }
    run(folder, post_process)
}

fn write_file(path: &Path, file: &File, rows: Option<&Rows>) -> Result<(), Error> {
    let on = sqlite(file.name);
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut db = Connection::open_with_flags(path, flags).map_err(&on)?;
    // Before the first table, or they do not take.
    db.execute_batch(&format!(
        "PRAGMA page_size = {}; PRAGMA auto_vacuum = FULL; PRAGMA user_version = {};",
        file.page_size, file.user_version
    ))
    .map_err(&on)?;
    let tx = db.transaction().map_err(&on)?;
    for (name, create) in file.tables {
        tx.execute_batch(create).map_err(&on)?;
        let Some(table) = rows.and_then(|r| r.table(name)) else {
            continue;
        };
        if table.rows.is_empty() {
            continue;
        }
        let columns: Vec<String> = table.columns.iter().map(|c| format!("\"{c}\"")).collect();
        let marks = vec!["?"; columns.len()].join(", ");
        let mut insert = tx
            .prepare(&format!(
                "INSERT INTO \"{name}\" ({}) VALUES ({marks})",
                columns.join(", ")
            ))
            .map_err(&on)?;
        for row in &table.rows {
            insert
                .execute(params_from_iter(row.iter().map(sql_value)))
                .map_err(&on)?;
        }
    }
    tx.commit().map_err(&on)?;
    db.close().map_err(|(_, e)| on(e))
}

fn run(folder: &Path, post_process: &[Command]) -> Result<Vec<Failed>, Error> {
    let [library, others @ ..] = &FILES;
    let on = sqlite(library.name);
    let mut db = Connection::open_with_flags(
        folder.join(library.name),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(&on)?;
    for file in others {
        let path = folder.join(file.name);
        db.execute(
            &format!("ATTACH DATABASE ?1 AS \"{}\"", file.schema_name),
            [path.to_string_lossy()],
        )
        .map_err(&on)?;
    }
    let tx = db.transaction().map_err(&on)?;
    let mut failed = Vec::new();
    for command in post_process {
        if let Err(e) = tx.execute_batch(&command.sql) {
            failed.push(Failed {
                name: command.name.clone(),
                error: e.to_string(),
            });
        }
    }
    tx.commit().map_err(&on)?;
    for file in others {
        db.execute(&format!("DETACH DATABASE \"{}\"", file.schema_name), [])
            .map_err(&on)?;
    }
    db.close().map_err(|(_, e)| on(e))?;
    Ok(failed)
}

/// Everything a file holds that a comparison looks at: its `sqlite_master`
/// (type, name, table and SQL, in `rowid` order), its `user_version`, page size
/// and `auto_vacuum`, and the rows of every table, those the post-process
/// makes included.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    /// `sqlite_master`, in `rowid` order.
    pub master: Vec<[Option<String>; 4]>,
    /// `PRAGMA user_version`, `page_size` and `auto_vacuum`.
    pub pragmas: [i64; 3],
    /// Every table, in `sqlite_master`'s order.
    pub tables: Vec<Table>,
}

/// The [`Snapshot`] of the file at `path`, opened read only.
pub fn snapshot(path: &Path) -> Result<Snapshot, Error> {
    let name = path.display().to_string();
    let on = sqlite(&name);
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(&on)?;
    let mut master: Vec<[Option<String>; 4]> = Vec::new();
    let mut statement = db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid")
        .map_err(&on)?;
    let mut rows = statement.query([]).map_err(&on)?;
    while let Some(row) = rows.next().map_err(&on)? {
        master.push([0, 1, 2, 3].map(|i| row.get::<_, Option<String>>(i).ok().flatten()));
    }
    let pragma = |p: &str| db.query_row(&format!("PRAGMA {p}"), [], |r| r.get::<_, i64>(0));
    let pragmas = [
        pragma("user_version").map_err(&on)?,
        pragma("page_size").map_err(&on)?,
        pragma("auto_vacuum").map_err(&on)?,
    ];
    let mut tables = Vec::new();
    for entry in master.iter().filter(|m| m[0].as_deref() == Some("table")) {
        let Some(table) = &entry[1] else { continue };
        let mut select = db
            .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
            .map_err(&on)?;
        let columns: Vec<String> = select.column_names().iter().map(|c| c.to_string()).collect();
        let width = columns.len();
        let mut out = Vec::new();
        let mut rows = select.query([]).map_err(&on)?;
        while let Some(row) = rows.next().map_err(&on)? {
            out.push(
                (0..width)
                    .map(|i| row.get_ref(i).map(value))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(&on)?,
            );
        }
        tables.push(Table {
            name: table.clone(),
            columns,
            rows: out,
        });
    }
    Ok(Snapshot {
        master,
        pragmas,
        tables,
    })
}

#[cfg(test)]
mod tests;
