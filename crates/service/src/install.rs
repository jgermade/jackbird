//! Installing the service the way each system starts things (S2, RECORD/2026-08-11.musikmatch-
//! rust-migration.WIP.md, 18:42 as amended at 18:57). Two ways, on every system, and either way
//! it runs as the person, never as root or a system account:
//!
//! | | At logon (no administrator rights) | With the system (administrator rights once) |
//! | --- | --- | --- |
//! | Linux | a systemd user unit | a systemd system unit with `User=` |
//! | macOS | a launchd agent | a launchd daemon with `UserName` |
//! | Windows | a task at logon (Task Scheduler) | a Windows service logged on as the person |
//!
//! What each way writes and runs is made by pure functions (`Plan`), tested on every system; `run`
//! carries a plan out. Systemd is required on Linux.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The service's name, the same everywhere it is registered.
pub const NAME: &str = "jackbird-service";
/// Its label for launchd, and its unit's name for systemd.
pub const LABEL: &str = "es.germade.jackbird.service";
const UNIT: &str = "jackbird.service";

/// How the service is started.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Way {
    /// From when the person logs in, by their own session.
    Logon,
    /// From boot, by the system, still as the person.
    System,
}

/// The system the plans are for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    /// Linux, with systemd.
    Linux,
    /// macOS.
    Macos,
    /// Windows.
    Windows,
}

impl Os {
    /// The one this binary runs on.
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Macos
        } else {
            Os::Linux
        }
    }
}

/// Who and where: the person the service runs as, their home and their configuration file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    /// Their account's name.
    pub user: String,
    /// Their numeric id (Linux and macOS: launchd's and systemd's user domain).
    pub uid: u32,
    /// Their home folder.
    pub home: PathBuf,
    /// The service's configuration file (`config::default_path` for them).
    pub config: PathBuf,
}

/// What installing does: the files written (path and text), then the commands run, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Where the binary is copied.
    pub binary: PathBuf,
    /// The files written.
    pub files: Vec<(PathBuf, String)>,
    /// The commands run, each a program and its arguments.
    pub commands: Vec<Vec<String>>,
}

/// Where the binary goes: the person's own data folder at logon; a folder of the system's with
/// the system, so that it is there before anyone logs in.
pub fn binary_path(os: Os, way: Way, person: &Person) -> PathBuf {
    let exe = if os == Os::Windows {
        "jackbird-service.exe"
    } else {
        NAME
    };
    match (os, way) {
        (Os::Linux, Way::Logon) => person.home.join(".local/share/jackbird/bin").join(exe),
        (Os::Linux, Way::System) => PathBuf::from("/usr/local/lib/jackbird").join(exe),
        (Os::Macos, Way::Logon) => person.home.join("Library/Application Support/jackbird/bin").join(exe),
        (Os::Macos, Way::System) => PathBuf::from("/Library/Application Support/jackbird/bin").join(exe),
        (Os::Windows, Way::Logon) => local_app_data(person).join("jackbird").join("bin").join(exe),
        (Os::Windows, Way::System) => program_files().join("jackbird").join(exe),
    }
}

fn local_app_data(person: &Person) -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map_or_else(|| person.home.join("AppData").join("Local"), PathBuf::from)
}

fn program_files() -> PathBuf {
    std::env::var_os("ProgramFiles").map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from)
}

/// Where the registration lives (the unit, the plist, the task's name).
pub fn registration(os: Os, way: Way, person: &Person) -> PathBuf {
    match (os, way) {
        (Os::Linux, Way::Logon) => person.home.join(".config/systemd/user").join(UNIT),
        (Os::Linux, Way::System) => PathBuf::from("/etc/systemd/system").join(UNIT),
        (Os::Macos, Way::Logon) => person.home.join("Library/LaunchAgents").join(format!("{LABEL}.plist")),
        (Os::Macos, Way::System) => PathBuf::from("/Library/LaunchDaemons").join(format!("{LABEL}.plist")),
        (Os::Windows, _) => PathBuf::from(NAME),
    }
}

fn s(text: impl AsRef<str>) -> String {
    text.as_ref().to_owned()
}

/// A path as text.
fn p(path: &Path) -> String {
    path.display().to_string()
}

/// A systemd unit: the service started again if it stops; with the system, as the person.
pub fn systemd_unit(binary: &Path, person: &Person, way: Way) -> String {
    let quote = |path: &Path| format!("\"{}\"", p(path).replace('\\', "\\\\").replace('"', "\\\""));
    let (user, wanted) = match way {
        Way::Logon => (String::new(), "default.target"),
        Way::System => (format!("User={}\n", person.user), "multi-user.target"),
    };
    format!(
        "[Unit]\nDescription=jackbird's service\nAfter=network.target\n\n[Service]\n{user}ExecStart={} --config {}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy={wanted}\n",
        quote(binary),
        quote(&person.config)
    )
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A launchd property list: run at load, kept alive; with the system, as the person.
pub fn launchd_plist(binary: &Path, person: &Person, way: Way) -> String {
    let user = match way {
        Way::Logon => String::new(),
        Way::System => format!("  <key>UserName</key>\n  <string>{}</string>\n", xml(&person.user)),
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{}</string>\n    <string>--config</string>\n    <string>{}</string>\n  </array>\n{user}  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n</dict>\n</plist>\n",
        xml(&p(binary)),
        xml(&p(&person.config))
    )
}

/// A Task Scheduler task at the person's logon, with limited rights: no time limit (a task
/// stops after three days by default), started again if it fails.
pub fn windows_task(binary: &Path, person: &Person) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n  <RegistrationInfo><Description>jackbird's service</Description></RegistrationInfo>\n  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>\n  <Principals><Principal id=\"Author\"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n  <Settings>\n    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>\n    <Hidden>true</Hidden>\n  </Settings>\n  <Actions Context=\"Author\"><Exec><Command>{}</Command><Arguments>--config \"{}\"</Arguments></Exec></Actions>\n</Task>\n",
        xml(&p(binary)),
        xml(&p(&person.config)),
        user = xml(&person.user)
    )
}

/// The plan to install, the way and system given. On Windows with the system, `password` is the
/// person's (Windows keeps it; nothing here does).
pub fn install_plan(os: Os, way: Way, person: &Person, password: Option<&str>) -> Plan {
    let binary = binary_path(os, way, person);
    let place = registration(os, way, person);
    let (files, commands) = match (os, way) {
        (Os::Linux, Way::Logon) => (
            vec![(place, systemd_unit(&binary, person, way))],
            vec![
                vec![s("systemctl"), s("--user"), s("daemon-reload")],
                vec![s("systemctl"), s("--user"), s("enable"), s("--now"), s(UNIT)],
            ],
        ),
        (Os::Linux, Way::System) => (
            vec![(place, systemd_unit(&binary, person, way))],
            vec![
                vec![s("systemctl"), s("daemon-reload")],
                vec![s("systemctl"), s("enable"), s("--now"), s(UNIT)],
            ],
        ),
        (Os::Macos, Way::Logon) => (
            vec![(place.clone(), launchd_plist(&binary, person, way))],
            vec![vec![
                s("launchctl"),
                s("bootstrap"),
                format!("gui/{}", person.uid),
                p(&place),
            ]],
        ),
        (Os::Macos, Way::System) => (
            vec![(place.clone(), launchd_plist(&binary, person, way))],
            vec![vec![s("launchctl"), s("bootstrap"), s("system"), p(&place)]],
        ),
        (Os::Windows, Way::Logon) => {
            let task = std::env::temp_dir().join("jackbird-service-task.xml");
            (
                vec![(task.clone(), windows_task(&binary, person))],
                vec![
                    vec![
                        s("schtasks"),
                        s("/Create"),
                        s("/TN"),
                        s(NAME),
                        s("/XML"),
                        p(&task),
                        s("/F"),
                    ],
                    vec![s("schtasks"), s("/Run"), s("/TN"), s(NAME)],
                ],
            )
        }
        (Os::Windows, Way::System) => (
            Vec::new(),
            vec![
                vec![
                    s("sc.exe"),
                    s("create"),
                    s(NAME),
                    s("binPath="),
                    format!("\"{}\" windows-service --config \"{}\"", p(&binary), p(&person.config)),
                    s("start="),
                    s("auto"),
                    s("obj="),
                    format!(".\\{}", person.user),
                    s("password="),
                    s(password.unwrap_or("")),
                    s("DisplayName="),
                    s("jackbird"),
                ],
                vec![
                    s("sc.exe"),
                    s("failure"),
                    s(NAME),
                    s("reset="),
                    s("86400"),
                    s("actions="),
                    s("restart/3000"),
                ],
                vec![s("sc.exe"), s("start"), s(NAME)],
            ],
        ),
    };
    Plan {
        binary,
        files,
        commands,
    }
}

/// The plan to uninstall: stop and unregister (failures of these are not fatal: it may be
/// stopped already), then the registration and the binary removed (`files` lists what goes).
pub fn uninstall_plan(os: Os, way: Way, person: &Person) -> Plan {
    let binary = binary_path(os, way, person);
    let place = registration(os, way, person);
    let (files, commands) = match (os, way) {
        (Os::Linux, Way::Logon) => (
            vec![(place, String::new())],
            vec![vec![s("systemctl"), s("--user"), s("disable"), s("--now"), s(UNIT)]],
        ),
        (Os::Linux, Way::System) => (
            vec![(place, String::new())],
            vec![vec![s("systemctl"), s("disable"), s("--now"), s(UNIT)]],
        ),
        (Os::Macos, Way::Logon) => (
            vec![(place, String::new())],
            vec![vec![
                s("launchctl"),
                s("bootout"),
                format!("gui/{}/{LABEL}", person.uid),
            ]],
        ),
        (Os::Macos, Way::System) => (
            vec![(place, String::new())],
            vec![vec![s("launchctl"), s("bootout"), format!("system/{LABEL}")]],
        ),
        (Os::Windows, Way::Logon) => (
            Vec::new(),
            vec![
                vec![s("schtasks"), s("/End"), s("/TN"), s(NAME)],
                vec![s("schtasks"), s("/Delete"), s("/TN"), s(NAME), s("/F")],
            ],
        ),
        (Os::Windows, Way::System) => (
            Vec::new(),
            vec![
                vec![s("sc.exe"), s("stop"), s(NAME)],
                vec![s("sc.exe"), s("delete"), s(NAME)],
            ],
        ),
    };
    Plan {
        binary,
        files,
        commands,
    }
}

/// The commands that start or stop it, installed this way.
pub fn control(os: Os, way: Way, person: &Person, start: bool) -> Vec<String> {
    match (os, way, start) {
        (Os::Linux, Way::Logon, _) => vec![
            s("systemctl"),
            s("--user"),
            s(if start { "start" } else { "stop" }),
            s(UNIT),
        ],
        (Os::Linux, Way::System, _) => vec![s("systemctl"), s(if start { "start" } else { "stop" }), s(UNIT)],
        (Os::Macos, Way::Logon, true) => vec![s("launchctl"), s("kickstart"), format!("gui/{}/{LABEL}", person.uid)],
        (Os::Macos, Way::Logon, false) => vec![
            s("launchctl"),
            s("kill"),
            s("TERM"),
            format!("gui/{}/{LABEL}", person.uid),
        ],
        (Os::Macos, Way::System, true) => vec![s("launchctl"), s("kickstart"), format!("system/{LABEL}")],
        (Os::Macos, Way::System, false) => vec![s("launchctl"), s("kill"), s("TERM"), format!("system/{LABEL}")],
        (Os::Windows, Way::Logon, true) => vec![s("schtasks"), s("/Run"), s("/TN"), s(NAME)],
        (Os::Windows, Way::Logon, false) => vec![s("schtasks"), s("/End"), s("/TN"), s(NAME)],
        (Os::Windows, Way::System, _) => vec![s("sc.exe"), s(if start { "start" } else { "stop" }), s(NAME)],
    }
}

/// Which way it is installed, if it is: its registration is there.
pub fn installed(os: Os, person: &Person) -> Option<Way> {
    [Way::Logon, Way::System].into_iter().find(|&way| match os {
        Os::Windows => {
            let query = match way {
                Way::Logon => vec!["schtasks", "/Query", "/TN", NAME],
                Way::System => vec!["sc.exe", "query", NAME],
            };
            Command::new(query[0])
                .args(&query[1..])
                .output()
                .is_ok_and(|out| out.status.success())
        }
        _ => registration(os, way, person).exists(),
    })
}

/// Runs one command; its error output when it fails.
fn run_command(command: &[String]) -> Result<(), String> {
    let out = Command::new(&command[0])
        .args(&command[1..])
        .output()
        .map_err(|error| format!("{}: {error}", command[0]))?;
    if out.status.success() {
        Ok(())
    } else {
        let said = String::from_utf8_lossy(&out.stderr);
        let said = if said.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout)
        } else {
            said
        };
        Err(format!(
            "{} failed: {}",
            command[..2.min(command.len())].join(" "),
            said.trim()
        ))
    }
}

/// Whether systemd is there to start things, for the person (`--user`) or the system.
fn systemd(way: Way) -> bool {
    let mut command = Command::new("systemctl");
    if way == Way::Logon {
        command.arg("--user");
    }
    command
        .arg("show-environment")
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Installs the service this way: the binary (this one) copied, its registration written, and it
/// started. Refuses when it is installed already (the other way first uninstalled), and on Linux
/// without systemd.
pub fn install(os: Os, way: Way, person: &Person, password: Option<&str>) -> Result<Plan, String> {
    if let Some(already) = installed(os, person) {
        return Err(format!(
            "the service is installed already ({}); uninstall it first",
            if already == Way::Logon {
                "at logon"
            } else {
                "with the system"
            }
        ));
    }
    if os == Os::Linux && !systemd(way) {
        return Err("installing the service needs systemd, which this system does not run".into());
    }
    let plan = install_plan(os, way, person, password);
    let here = std::env::current_exe().map_err(|error| format!("this binary: {error}"))?;
    copy_binary(&here, &plan.binary)?;
    for (path, text) in &plan.files {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        let written = if os == Os::Windows && path.extension().is_some_and(|ext| ext == "xml") {
            std::fs::write(path, utf16(text))
        } else {
            std::fs::write(path, text)
        };
        written.map_err(|error| format!("{}: {error}", path.display()))?;
    }
    for command in &plan.commands {
        run_command(command)?;
    }
    Ok(plan)
}

/// Text as UTF-16 with its byte order mark, as the Task Scheduler reads its XML.
fn utf16(text: &str) -> Vec<u8> {
    let mut out = vec![0xff, 0xfe];
    out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    out
}

/// Copies the binary to its place (over an older one, which the caller stopped first).
pub fn copy_binary(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    if from != to {
        std::fs::copy(from, to).map_err(|error| format!("{}: {error}", to.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("{}: {error}", to.display()))?;
    }
    Ok(())
}

/// Uninstalls whichever way it is installed: stopped, unregistered, the registration and the
/// binary removed. The configuration (its folders) stays.
pub fn uninstall(os: Os, person: &Person) -> Result<Option<Way>, String> {
    let Some(way) = installed(os, person) else {
        return Ok(None);
    };
    let plan = uninstall_plan(os, way, person);
    for command in &plan.commands {
        let _ = run_command(command);
    }
    for (path, _) in &plan.files {
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
    }
    if os == Os::Linux {
        let reload = if way == Way::Logon {
            vec![s("systemctl"), s("--user"), s("daemon-reload")]
        } else {
            vec![s("systemctl"), s("daemon-reload")]
        };
        let _ = run_command(&reload);
    }
    if plan.binary.exists() {
        // On Windows a binary still running cannot be removed: leave it, it is harmless.
        let _ = std::fs::remove_file(&plan.binary);
    }
    Ok(Some(way))
}

/// Starts or stops it, installed whichever way.
pub fn start_or_stop(os: Os, person: &Person, start: bool) -> Result<Way, String> {
    let way = installed(os, person).ok_or("the service is not installed")?;
    run_command(&control(os, way, person, start))?;
    Ok(way)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person() -> Person {
        Person {
            user: "ana".into(),
            uid: 501,
            home: PathBuf::from("/home/ana"),
            config: PathBuf::from("/home/ana/.config/jackbird/service.json"),
        }
    }

    #[test]
    fn linux_units_run_as_the_person_and_restart() {
        let at_logon = install_plan(Os::Linux, Way::Logon, &person(), None);
        assert_eq!(
            at_logon.binary,
            PathBuf::from("/home/ana/.local/share/jackbird/bin/jackbird-service")
        );
        let (path, unit) = &at_logon.files[0];
        assert_eq!(path, &PathBuf::from("/home/ana/.config/systemd/user/jackbird.service"));
        assert!(unit.contains("ExecStart=\"/home/ana/.local/share/jackbird/bin/jackbird-service\" --config \"/home/ana/.config/jackbird/service.json\"\n"));
        assert!(
            unit.contains("Restart=on-failure") && unit.contains("WantedBy=default.target") && !unit.contains("User=")
        );
        assert_eq!(
            at_logon.commands[1],
            ["systemctl", "--user", "enable", "--now", "jackbird.service"]
        );

        let with_system = install_plan(Os::Linux, Way::System, &person(), None);
        assert_eq!(
            with_system.binary,
            PathBuf::from("/usr/local/lib/jackbird/jackbird-service")
        );
        let (path, unit) = &with_system.files[0];
        assert_eq!(path, &PathBuf::from("/etc/systemd/system/jackbird.service"));
        assert!(unit.contains("User=ana\n") && unit.contains("WantedBy=multi-user.target"));
        assert_eq!(
            with_system.commands[1],
            ["systemctl", "enable", "--now", "jackbird.service"]
        );
        assert_eq!(
            uninstall_plan(Os::Linux, Way::System, &person()).commands[0],
            ["systemctl", "disable", "--now", "jackbird.service"]
        );
        assert_eq!(
            control(Os::Linux, Way::Logon, &person(), false),
            ["systemctl", "--user", "stop", "jackbird.service"]
        );
    }

    #[test]
    fn a_path_with_quotes_is_quoted_in_a_unit() {
        let odd = Person {
            config: PathBuf::from("/home/ana/my \"music\"/service.json"),
            ..person()
        };
        let unit = systemd_unit(Path::new("/opt/j s/jackbird-service"), &odd, Way::Logon);
        assert!(
            unit.contains(
                "ExecStart=\"/opt/j s/jackbird-service\" --config \"/home/ana/my \\\"music\\\"/service.json\""
            )
        );
    }

    #[test]
    fn macos_plists_keep_it_alive_and_name_the_person_with_the_system() {
        let at_logon = install_plan(Os::Macos, Way::Logon, &person(), None);
        let (path, plist) = &at_logon.files[0];
        assert_eq!(
            path,
            &PathBuf::from("/home/ana/Library/LaunchAgents/es.germade.jackbird.service.plist")
        );
        assert!(plist.contains("<string>/home/ana/Library/Application Support/jackbird/bin/jackbird-service</string>"));
        assert!(plist.contains("<key>KeepAlive</key>") && !plist.contains("UserName"));
        assert_eq!(at_logon.commands[0][..3], ["launchctl", "bootstrap", "gui/501"]);
        let with_system = install_plan(Os::Macos, Way::System, &person(), None);
        assert!(
            with_system.files[0]
                .1
                .contains("<key>UserName</key>\n  <string>ana</string>")
        );
        assert_eq!(
            with_system.files[0].0,
            PathBuf::from("/Library/LaunchDaemons/es.germade.jackbird.service.plist")
        );
        assert_eq!(with_system.commands[0][..3], ["launchctl", "bootstrap", "system"]);
        assert_eq!(
            uninstall_plan(Os::Macos, Way::Logon, &person()).commands[0],
            ["launchctl", "bootout", "gui/501/es.germade.jackbird.service"]
        );
        let escaped = launchd_plist(
            Path::new("/a&b"),
            &Person {
                user: "a<b".into(),
                ..person()
            },
            Way::System,
        );
        assert!(escaped.contains("<string>/a&amp;b</string>") && escaped.contains("<string>a&lt;b</string>"));
    }

    #[test]
    fn windows_runs_a_task_at_logon_or_a_service_as_the_person() {
        let at_logon = install_plan(Os::Windows, Way::Logon, &person(), None);
        let task = &at_logon.files[0].1;
        assert!(task.contains("<LogonTrigger><Enabled>true</Enabled><UserId>ana</UserId>"));
        assert!(
            task.contains("<RunLevel>LeastPrivilege</RunLevel>")
                && task.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>")
        );
        assert_eq!(at_logon.commands[0][..3], ["schtasks", "/Create", "/TN"]);
        assert_eq!(at_logon.commands[1], ["schtasks", "/Run", "/TN", "jackbird-service"]);
        let with_system = install_plan(Os::Windows, Way::System, &person(), Some("secret"));
        let create = &with_system.commands[0];
        assert_eq!(create[..3], ["sc.exe", "create", "jackbird-service"]);
        assert!(create[4].ends_with("\" windows-service --config \"/home/ana/.config/jackbird/service.json\""));
        assert_eq!(create[7..11], ["obj=", ".\\ana", "password=", "secret"]);
        assert!(with_system.files.is_empty(), "the password is written nowhere");
        assert_eq!(
            uninstall_plan(Os::Windows, Way::System, &person()).commands[1],
            ["sc.exe", "delete", "jackbird-service"]
        );
        assert_eq!(utf16("A")[..], [0xff, 0xfe, b'A', 0]);
    }

    #[test]
    fn nothing_is_installed_on_a_clean_home() {
        let home = std::env::temp_dir().join(format!("jackbird-install-{}", std::process::id()));
        let clean = Person { home, ..person() };
        if Os::current() != Os::Windows {
            assert_eq!(installed(Os::current(), &clean).filter(|&way| way == Way::Logon), None);
        }
    }
}
