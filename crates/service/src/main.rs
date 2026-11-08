//! `jackbird-service`: the service, and the commands that install it the way each system starts
//! things (S2; the desktop app runs them from its own copy of this binary).
//!
//! ```text
//! jackbird-service [--port N] [--config PATH]           serve (the default)
//! jackbird-service install [--with-system] [--user NAME --uid N --home PATH --config PATH]
//!                          [--password-file PATH]        (Windows, with the system)
//! jackbird-service uninstall | update | start | stop | status    (status: one line of JSON)
//! jackbird-service --version
//! ```
//!
//! It listens on 127.0.0.1 (and ::1) only, on the configuration's port (4646 by default).

use std::net::SocketAddr;
use std::path::PathBuf;

use jackbird_service::config::{self, Config};
use jackbird_service::install::{self, Os, Person, Way};

fn usage() -> ! {
    eprintln!(
        "usage: jackbird-service [--port N] [--config PATH]\n       jackbird-service install [--with-system] [--user NAME --uid N --home PATH --config PATH] [--password-file PATH]\n       jackbird-service uninstall | update | start | stop | status | --version"
    );
    std::process::exit(2);
}

fn fail(what: &str, why: impl std::fmt::Display) -> ! {
    eprintln!("jackbird-service: {what}: {why}");
    std::process::exit(1);
}

/// The flags after the command, as name and value pairs (`--with-system` alone).
fn flags(args: &[String]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "--with-system" => out.push((args[at].clone(), String::new())),
            name if name.starts_with("--") => {
                let value = args.get(at + 1).cloned().unwrap_or_else(|| usage());
                out.push((name.to_owned(), value));
                at += 1;
            }
            _ => usage(),
        }
        at += 1;
    }
    out
}

fn flag<'a>(flags: &'a [(String, String)], name: &str) -> Option<&'a str> {
    flags
        .iter()
        .find(|(own, _)| own == name)
        .map(|(_, value)| value.as_str())
}

/// Who runs this, unless the flags say who the service is for (as root, installing with the
/// system for a person).
fn person(flags: &[(String, String)]) -> Person {
    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let user = flag(flags, "--user")
        .map(str::to_owned)
        .or_else(|| var("USER"))
        .or_else(|| var("USERNAME"))
        .or_else(|| {
            command_line(
                if cfg!(windows) { "whoami" } else { "id" },
                if cfg!(windows) { &[] } else { &["-un"] },
            )
        });
    let home = flag(flags, "--home")
        .map(PathBuf::from)
        .or_else(|| var("HOME").or_else(|| var("USERPROFILE")).map(PathBuf::from));
    let uid = flag(flags, "--uid")
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(current_uid);
    Person {
        user: user.unwrap_or_else(|| fail("install", "who the service is for is not known (--user)")),
        uid,
        home: home.unwrap_or_else(|| fail("install", "the home folder is not known (--home)")),
        // Run as an administrator for a person (`--home`), their own configuration, not root's.
        config: match (flag(flags, "--config"), flag(flags, "--home")) {
            (Some(path), _) => PathBuf::from(path),
            (None, Some(home)) => config::path_in(std::path::Path::new(home)),
            (None, None) => config::default_path(),
        },
    }
}

/// A command's first line of output, if it runs.
fn command_line(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program).args(args).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !line.is_empty()).then_some(line)
}

/// This process's user id (`id -u`), or 0 where there is none (Windows).
fn current_uid() -> u32 {
    if cfg!(windows) {
        return 0;
    }
    command_line("id", &["-u"]).and_then(|id| id.parse().ok()).unwrap_or(0)
}

/// Whether the service answers on its port, and its version.
fn answering(port: u16) -> Option<String> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_secs(2),
    )
    .ok()?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok()?;
    write!(
        stream,
        "GET /api/info HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let body = response.split_once("\r\n\r\n")?.1;
    let info: serde_json::Value = serde_json::from_str(body).ok()?;
    (info["name"] == "jackbird-service").then(|| info["version"].as_str().unwrap_or("").to_owned())
}

fn status(person: &Person) -> serde_json::Value {
    let port = Config::load(&person.config).map_or(config::PORT, |config| config.port);
    let version = answering(port);
    serde_json::json!({
        "installed": install::installed(Os::current(), person),
        "running": version.is_some(),
        "version": version,
        "port": port,
        "binaryVersion": env!("JACKBIRD_VERSION"),
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let os = Os::current();
    match args.first().map(String::as_str) {
        Some("--version") => println!("{}", env!("JACKBIRD_VERSION")),
        Some("status") => println!("{}", status(&person(&flags(&args[1..])))),
        Some("install") => {
            let flags = flags(&args[1..]);
            let way = if flag(&flags, "--with-system").is_some() {
                Way::System
            } else {
                Way::Logon
            };
            let password = flag(&flags, "--password-file").map(|path| {
                let text = std::fs::read_to_string(path).unwrap_or_else(|error| fail("install", error));
                let _ = std::fs::remove_file(path);
                text.trim_end_matches(['\r', '\n']).to_owned()
            });
            let person = person(&flags);
            match install::install(os, way, &person, password.as_deref()) {
                Ok(plan) => println!(
                    "{}",
                    serde_json::json!({ "installed": way, "binary": plan.binary.display().to_string() })
                ),
                Err(why) => fail("install", why),
            }
        }
        Some("uninstall") => match install::uninstall(os, &person(&flags(&args[1..]))) {
            Ok(way) => println!("{}", serde_json::json!({ "uninstalled": way })),
            Err(why) => fail("uninstall", why),
        },
        Some("update") => match install::update(os, &person(&flags(&args[1..]))) {
            Ok(way) => println!("{}", serde_json::json!({ "updated": way })),
            Err(why) => fail("update", why),
        },
        Some(command @ ("start" | "stop")) => {
            match install::start_or_stop(os, &person(&flags(&args[1..])), command == "start") {
                Ok(_) => println!("{}", serde_json::json!({ command: true })),
                Err(why) => fail(command, why),
            }
        }
        #[cfg(windows)]
        Some("windows-service") => windows::run(),
        _ => serve(&args),
    }
}

/// The server, until it is stopped.
fn serve(args: &[String]) {
    let flags = flags(args);
    let path = flag(&flags, "--config").map_or_else(config::default_path, PathBuf::from);
    let config = Config::load(&path).unwrap_or_else(|error| fail("the configuration cannot be read", error));
    let port = flag(&flags, "--port").map_or(config.port, |value| value.parse().unwrap_or_else(|_| usage()));
    let runtime = tokio::runtime::Runtime::new().unwrap_or_else(|error| fail("start", error));
    runtime.block_on(async {
        let shutdown = async {
            let _ = tokio::signal::ctrl_c().await;
        };
        run_server(port, path, config, shutdown).await;
    });
}

/// Serves on 127.0.0.1 and ::1 until `shutdown` ends.
async fn run_server(
    port: u16,
    path: PathBuf,
    config: Config,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) {
    let service = jackbird_service::Service::new(port, Some(path.clone()), &config.roots);
    let app = jackbird_service::router(service);
    let v4 = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .unwrap_or_else(|error| {
            fail(
                &format!("127.0.0.1:{port} is not free"),
                format!("{error}; set another port with --port"),
            )
        });
    // ::1 too where the machine has it, since browsers may try it first for `localhost`.
    if let Ok(v6) = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port))).await {
        let app = app.clone();
        tokio::spawn(async move { axum::serve(v6, app).await });
    }
    println!(
        "jackbird-service: http://localhost:{port}/ (configuration: {})",
        path.display()
    );
    if let Err(error) = axum::serve(v4, app).with_graceful_shutdown(shutdown).await {
        eprintln!("jackbird-service: {error}");
    }
}

/// Running under Windows' Service Control Manager (installed with the system, S2): it reports
/// running, serves, and stops when the manager asks.
#[cfg(windows)]
mod windows {
    use std::ffi::OsString;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};

    windows_service::define_windows_service!(ffi_main, main);

    pub fn run() {
        if let Err(error) = windows_service::service_dispatcher::start(super::install::NAME, ffi_main) {
            super::fail("windows-service", error);
        }
    }

    fn status(state: ServiceState, accept: ServiceControlAccept) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        }
    }

    fn main(_: Vec<OsString>) {
        let args: Vec<String> = std::env::args().skip(2).collect();
        let flags = super::flags(&args);
        let path = super::flag(&flags, "--config").map_or_else(super::config::default_path, std::path::PathBuf::from);
        let config = super::Config::load(&path).unwrap_or_default();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let stop = std::sync::Mutex::new(Some(stop));
        let handler = service_control_handler::register(super::install::NAME, move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                if let Some(stop) = stop.lock().ok().and_then(|mut stop| stop.take()) {
                    let _ = stop.send(());
                }
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        });
        let Ok(handler) = handler else { return };
        let _ = handler.set_service_status(status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        ));
        if let Ok(runtime) = tokio::runtime::Runtime::new() {
            runtime.block_on(super::run_server(config.port, path, config, async {
                let _ = stopped.await;
            }));
        }
        let _ = handler.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()));
    }
}
