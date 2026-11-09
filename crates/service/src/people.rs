//! The people of an instance, their sessions, their passkeys and the log of changes (S3,
//! RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-09 10:45 to 11:57), kept in
//! `jackbird.db` (SQLite) beside the service's configuration.
//!
//! Every instance starts with one person, its owner, with no email. With sign-in off, people are
//! profiles (a name and a role); with it on, a person signs in once their email is confirmed by a
//! code, and the others are disabled until then. Turning sign-in on or off changes no role.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// What a person may do, each role including the ones before it (21:32, renamed at 11:57).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Reads and plays.
    Listener,
    /// Also changes the folders: tags, covers, renames, playlists.
    Editor,
    /// Also adds people (up to editor), reads the log, sets SMTP.
    Admin,
    /// Also the folders, the switches, the address, and other owners and admins.
    Owner,
}

impl Role {
    /// Its name, as stored and as the interface sees it.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Listener => "listener",
            Role::Editor => "editor",
            Role::Admin => "admin",
            Role::Owner => "owner",
        }
    }

    /// The role of a name, if it is one.
    pub fn parse(name: &str) -> Option<Role> {
        match name {
            "listener" => Some(Role::Listener),
            "editor" => Some(Role::Editor),
            "admin" => Some(Role::Admin),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }
}

/// A person of the instance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Person {
    /// Its id.
    pub id: i64,
    /// Its name, shown in the interface and the log.
    pub name: String,
    /// Its email, set by an owner or admin, or by itself when sign-in is turned on.
    pub email: Option<String>,
    /// Whether that email was confirmed by a code: with sign-in on, only then may it sign in.
    pub confirmed: bool,
    /// Its role.
    pub role: Role,
    /// Its WebAuthn user handle (random, never shown).
    #[serde(skip)]
    pub handle: Vec<u8>,
    /// What follows it from device to device (F3).
    #[serde(skip)]
    pub settings: Settings,
}

/// A person's settings, kept with them on the service (F3): applied wherever they sign in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Settings {
    /// `light` or `dark`, once chosen.
    #[serde(default)]
    pub theme: Option<String>,
    /// The interface's language, once chosen.
    #[serde(default)]
    pub language: Option<String>,
    /// Whether they see their own version of the library's songs (else the family's).
    #[serde(default = "yes")]
    pub mine: bool,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: None,
            language: None,
            mine: true,
        }
    }
}

/// One of a person's sessions, as "My account" lists them.
#[derive(Clone, Debug, Serialize)]
pub struct Session {
    /// Its id (not its token).
    pub id: i64,
    /// The person it is of.
    #[serde(skip)]
    pub person: i64,
    /// The browser or app it was made in.
    pub agent: String,
    /// When it was made and last used, in seconds since 1970.
    pub created: i64,
    /// When it was last used.
    pub seen: i64,
}

/// A passkey, as "My account" lists it.
#[derive(Clone, Debug, Serialize)]
pub struct Passkey {
    /// Its id.
    pub id: i64,
    /// Its name.
    pub name: String,
    /// When it was added and last used.
    pub created: i64,
    /// When it was last used, if it was.
    pub used: Option<i64>,
    /// The credential, as `webauthn-rs` serialises it.
    #[serde(skip)]
    pub credential: String,
}

/// A change to the folders, with who made it.
#[derive(Clone, Debug, Serialize)]
pub struct Change {
    /// When, in seconds since 1970.
    pub at: i64,
    /// Who.
    pub person: String,
    /// What: save, write, rename, mkdir, delete, open, close.
    pub action: String,
    /// The folder.
    pub root: String,
    /// The path in it.
    pub path: String,
}

/// A session lasts this long after it was last used (30 days).
pub const SESSION_SECONDS: i64 = 30 * 24 * 3600;

/// Seconds since 1970.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() as i64)
}

/// Random bytes from the system.
pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).expect("the system's random numbers");
    bytes
}

/// A session's token as kept: its SHA-256, so the database alone opens nothing.
fn digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// An email as compared and kept: trimmed, lower case.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Why a change to the people was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// That email (or passkey) is already someone's.
    Taken,
    /// The last owner cannot stop being one.
    LastOwner,
    /// No such person.
    NotFound,
    /// The database failed.
    Store(String),
}

impl From<rusqlite::Error> for Refusal {
    fn from(error: rusqlite::Error) -> Self {
        Refusal::Store(error.to_string())
    }
}

/// The database.
pub struct Store {
    db: Mutex<Connection>,
}

const SCHEMA: &str = "
create table if not exists people (
  id integer primary key,
  name text not null,
  email text unique,
  confirmed integer not null default 0,
  role text not null,
  handle blob not null,
  created integer not null
);
create table if not exists sessions (
  id integer primary key,
  token blob not null unique,
  person integer not null references people(id) on delete cascade,
  agent text not null,
  created integer not null,
  seen integer not null
);
create table if not exists passkeys (
  id integer primary key,
  person integer not null references people(id) on delete cascade,
  name text not null,
  credential_id blob not null unique,
  credential text not null,
  created integer not null,
  used integer
);
create table if not exists log (
  id integer primary key,
  at integer not null,
  person text not null,
  action text not null,
  root text not null,
  path text not null
);
create table if not exists secrets (
  name text primary key,
  value blob not null
);
";

fn person_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Person> {
    let role: String = row.get(4)?;
    Ok(Person {
        id: row.get(0)?,
        name: row.get(1)?,
        email: row.get(2)?,
        confirmed: row.get(3)?,
        role: Role::parse(&role).unwrap_or(Role::Listener),
        handle: row.get(5)?,
        settings: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
    })
}

const PERSON: &str = "select id, name, email, confirmed, role, handle, settings from people";

impl Store {
    /// Opens the database at `path`, making it and its first person (the owner) if it is new.
    pub fn open(path: &Path) -> Result<Store, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        let db = Connection::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let store = Store::with(db)?;
        // Its addresses and passkeys are the service's person's alone.
        #[cfg(unix)]
        for file in [
            path.to_owned(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
        }
        Ok(store)
    }

    /// A database in memory (tests).
    pub fn memory() -> Store {
        Store::with(Connection::open_in_memory().expect("SQLite in memory")).expect("the schema")
    }

    fn with(db: Connection) -> Result<Store, String> {
        db.execute_batch("pragma foreign_keys = on; pragma journal_mode = wal;")
            .and_then(|()| db.execute_batch(SCHEMA))
            .map_err(|error| error.to_string())?;
        // F3: settings that follow a person (added to S3's table).
        let _ = db.execute_batch("alter table people add column settings text not null default '{}'");
        let store = Store { db: Mutex::new(db) };
        if store.people().map_err(|error| format!("{error:?}"))?.is_empty() {
            store
                .add("Owner", None, Role::Owner)
                .map_err(|error| format!("{error:?}"))?;
        }
        Ok(store)
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A secret of the instance's own (32 random bytes), made the first time it is asked for.
    pub fn secret(&self, name: &str) -> Vec<u8> {
        let db = self.db();
        let found: Option<Vec<u8>> = db
            .query_row("select value from secrets where name = ?1", [name], |row| row.get(0))
            .optional()
            .ok()
            .flatten();
        found.unwrap_or_else(|| {
            let value = random::<32>().to_vec();
            let _ = db.execute(
                "insert into secrets (name, value) values (?1, ?2)",
                params![name, value],
            );
            value
        })
    }

    /// Everyone, oldest first.
    pub fn people(&self) -> Result<Vec<Person>, Refusal> {
        let db = self.db();
        let mut query = db.prepare(&format!("{PERSON} order by id"))?;
        let people = query.query_map([], person_of)?.collect::<Result<_, _>>()?;
        Ok(people)
    }

    /// A person by id.
    pub fn person(&self, id: i64) -> Option<Person> {
        let db = self.db();
        db.query_row(&format!("{PERSON} where id = ?1"), [id], person_of)
            .optional()
            .ok()
            .flatten()
    }

    /// A person by email.
    pub fn person_by_email(&self, email: &str) -> Option<Person> {
        let db = self.db();
        db.query_row(
            &format!("{PERSON} where email = ?1"),
            [normalize_email(email)],
            person_of,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// A person by their WebAuthn user handle.
    pub fn person_by_handle(&self, handle: &[u8]) -> Option<Person> {
        let db = self.db();
        db.query_row(&format!("{PERSON} where handle = ?1"), [handle], person_of)
            .optional()
            .ok()
            .flatten()
    }

    /// Adds a person.
    pub fn add(&self, name: &str, email: Option<&str>, role: Role) -> Result<Person, Refusal> {
        let email = email.map(normalize_email).filter(|email| !email.is_empty());
        if email
            .as_deref()
            .is_some_and(|email| self.person_by_email(email).is_some())
        {
            return Err(Refusal::Taken);
        }
        let id = {
            let db = self.db();
            db.execute(
                "insert into people (name, email, role, handle, created) values (?1, ?2, ?3, ?4, ?5)",
                params![name.trim(), email, role.as_str(), random::<16>().to_vec(), now()],
            )?;
            db.last_insert_rowid()
        };
        self.person(id).ok_or(Refusal::NotFound)
    }

    /// Changes a person's name.
    pub fn rename(&self, id: i64, name: &str) -> Result<(), Refusal> {
        let changed = self
            .db()
            .execute("update people set name = ?1 where id = ?2", params![name.trim(), id])?;
        if changed == 0 { Err(Refusal::NotFound) } else { Ok(()) }
    }

    /// Gives a person an email (or takes it away); a new email is not confirmed yet.
    pub fn set_email(&self, id: i64, email: Option<&str>) -> Result<(), Refusal> {
        let email = email.map(normalize_email).filter(|email| !email.is_empty());
        let person = self.person(id).ok_or(Refusal::NotFound)?;
        if person.email == email {
            return Ok(());
        }
        if let Some(other) = email.as_deref().and_then(|email| self.person_by_email(email))
            && other.id != id
        {
            return Err(Refusal::Taken);
        }
        self.db().execute(
            "update people set email = ?1, confirmed = 0 where id = ?2",
            params![email, id],
        )?;
        Ok(())
    }

    /// Keeps a person's settings.
    pub fn set_settings(&self, id: i64, settings: &Settings) -> Result<(), Refusal> {
        self.db().execute(
            "update people set settings = ?1 where id = ?2",
            params![serde_json::to_string(settings).unwrap_or_default(), id],
        )?;
        Ok(())
    }

    /// Marks a person's email as confirmed by a code.
    pub fn confirm(&self, id: i64) -> Result<(), Refusal> {
        self.db()
            .execute("update people set confirmed = 1 where id = ?1", [id])?;
        Ok(())
    }

    fn owners(&self) -> Result<usize, Refusal> {
        Ok(self
            .people()?
            .iter()
            .filter(|person| person.role == Role::Owner)
            .count())
    }

    /// Changes a person's role; the last owner stays one.
    pub fn set_role(&self, id: i64, role: Role) -> Result<(), Refusal> {
        let person = self.person(id).ok_or(Refusal::NotFound)?;
        if person.role == Role::Owner && role != Role::Owner && self.owners()? == 1 {
            return Err(Refusal::LastOwner);
        }
        self.db()
            .execute("update people set role = ?1 where id = ?2", params![role.as_str(), id])?;
        Ok(())
    }

    /// Removes a person, with their sessions and passkeys; the last owner stays.
    pub fn remove(&self, id: i64) -> Result<(), Refusal> {
        let person = self.person(id).ok_or(Refusal::NotFound)?;
        if person.role == Role::Owner && self.owners()? == 1 {
            return Err(Refusal::LastOwner);
        }
        self.db().execute("delete from people where id = ?1", [id])?;
        Ok(())
    }

    /// Starts a session for a person; its token is returned once and kept only as a digest.
    pub fn start_session(&self, person: i64, agent: &str) -> Result<String, Refusal> {
        use base64::Engine;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random::<32>());
        let at = now();
        let agent: String = agent.chars().take(200).collect();
        self.db().execute(
            "insert into sessions (token, person, agent, created, seen) values (?1, ?2, ?3, ?4, ?4)",
            params![digest(&token), person, agent, at],
        )?;
        Ok(token)
    }

    /// The session of a token and its person, if it has not expired; using it extends it.
    pub fn session(&self, token: &str) -> Option<(Session, Person)> {
        let at = now();
        let found = {
            let db = self.db();
            db.query_row(
                "select id, person, agent, created, seen from sessions where token = ?1",
                [digest(token)],
                |row| {
                    Ok(Session {
                        id: row.get(0)?,
                        person: row.get(1)?,
                        agent: row.get(2)?,
                        created: row.get(3)?,
                        seen: row.get(4)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()?
        };
        if at - found.seen > SESSION_SECONDS {
            self.end_session(found.id);
            return None;
        }
        // Written at most once a minute, not on every request.
        if at - found.seen > 60 {
            let _ = self
                .db()
                .execute("update sessions set seen = ?1 where id = ?2", params![at, found.id]);
        }
        let person = self.person(found.person)?;
        Some((found, person))
    }

    /// A person's sessions, the latest used first.
    pub fn sessions_of(&self, person: i64) -> Result<Vec<Session>, Refusal> {
        let db = self.db();
        let mut query =
            db.prepare("select id, person, agent, created, seen from sessions where person = ?1 order by seen desc")?;
        let sessions = query
            .query_map([person], |row| {
                Ok(Session {
                    id: row.get(0)?,
                    person: row.get(1)?,
                    agent: row.get(2)?,
                    created: row.get(3)?,
                    seen: row.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(sessions)
    }

    /// Ends one session.
    pub fn end_session(&self, id: i64) {
        let _ = self.db().execute("delete from sessions where id = ?1", [id]);
    }

    /// Ends one of a person's sessions (none of anyone else's).
    pub fn end_session_of(&self, person: i64, id: i64) {
        let _ = self
            .db()
            .execute("delete from sessions where id = ?1 and person = ?2", [id, person]);
    }

    /// Ends every session of a person.
    pub fn end_sessions_of(&self, person: i64) {
        let _ = self.db().execute("delete from sessions where person = ?1", [person]);
    }

    /// Ends every session (sign-in turned on or off).
    pub fn end_all_sessions(&self) {
        let _ = self.db().execute("delete from sessions", []);
    }

    /// Adds a passkey to a person.
    pub fn add_passkey(
        &self,
        person: i64,
        name: &str,
        credential_id: &[u8],
        credential: &str,
    ) -> Result<Passkey, Refusal> {
        let id = {
            let db = self.db();
            let added = db.execute(
                "insert into passkeys (person, name, credential_id, credential, created) values (?1, ?2, ?3, ?4, ?5)",
                params![person, name, credential_id, credential, now()],
            );
            match added {
                Err(rusqlite::Error::SqliteFailure(failure, _))
                    if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    return Err(Refusal::Taken);
                }
                other => other?,
            };
            db.last_insert_rowid()
        };
        self.passkeys_of(person)?
            .into_iter()
            .find(|passkey| passkey.id == id)
            .ok_or(Refusal::NotFound)
    }

    /// A person's passkeys.
    pub fn passkeys_of(&self, person: i64) -> Result<Vec<Passkey>, Refusal> {
        let db = self.db();
        let mut query =
            db.prepare("select id, name, created, used, credential from passkeys where person = ?1 order by id")?;
        let passkeys = query
            .query_map([person], |row| {
                Ok(Passkey {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created: row.get(2)?,
                    used: row.get(3)?,
                    credential: row.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(passkeys)
    }

    /// Records a passkey's use, with its credential as updated (its sign count).
    pub fn passkey_used(&self, credential_id: &[u8], credential: &str) {
        let _ = self.db().execute(
            "update passkeys set credential = ?1, used = ?2 where credential_id = ?3",
            params![credential, now(), credential_id],
        );
    }

    /// Renames one of a person's passkeys.
    pub fn rename_passkey(&self, person: i64, id: i64, name: &str) {
        let _ = self.db().execute(
            "update passkeys set name = ?1 where id = ?2 and person = ?3",
            params![name, id, person],
        );
    }

    /// Removes one of a person's passkeys.
    pub fn remove_passkey(&self, person: i64, id: i64) {
        let _ = self
            .db()
            .execute("delete from passkeys where id = ?1 and person = ?2", [id, person]);
    }

    /// Logs a change to the folders.
    pub fn log(&self, person: &str, action: &str, root: &str, path: &str) {
        let _ = self.db().execute(
            "insert into log (at, person, action, root, path) values (?1, ?2, ?3, ?4, ?5)",
            params![now(), person, action, root, path],
        );
    }

    /// The latest changes, newest first.
    pub fn changes(&self, limit: u32) -> Result<Vec<Change>, Refusal> {
        let db = self.db();
        let mut query = db.prepare("select at, person, action, root, path from log order by id desc limit ?1")?;
        let changes = query
            .query_map([limit], |row| {
                Ok(Change {
                    at: row.get(0)?,
                    person: row.get(1)?,
                    action: row.get(2)?,
                    root: row.get(3)?,
                    path: row.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(changes)
    }
}
