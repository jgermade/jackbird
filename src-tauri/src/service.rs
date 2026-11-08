//! The service, from the desktop app (S2, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
//! 18:42 as amended at 18:57): the app carries `jackbird-service` beside its own binary (Tauri's
//! `externalBin`) and runs its commands: `status`, `install`, `uninstall`, `update`, `start`.
//! Installed at logon, nothing asks for administrator rights; installed with the system, those
//! commands are run through the system's own prompt (`pkexec`, macOS's authorisation dialog,
//! Windows' UAC), and on Windows the person's password goes to Windows in a file only the
//! elevated command reads and removes.

use std::path::PathBuf;
use std::process::Command;

use jackbird_api::{Failure, failure};
use serde_json::Value;

type Answer<T> = Result<T, Failure>;

/// The service's binary, beside the app's own.
fn binary() -> Answer<PathBuf> {
    let here = std::env::current_exe().map_err(|error| failure("io", error.to_string()))?;
    let name = if cfg!(windows) {
        "jackbird-service.exe"
    } else {
        "jackbird-service"
    };
    let path = here.with_file_name(name);
    if path.exists() {
        Ok(path)
    } else {
        Err(failure(
            "not-found",
            format!("the service's binary is not beside the app ({})", path.display()),
        ))
    }
}

/// Who the app runs as, as the service's commands take it when they run as an administrator.
fn person_flags() -> Vec<String> {
    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let line = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    let user = var("USER")
        .or_else(|| var("USERNAME"))
        .or_else(|| line("id", &["-un"]))
        .unwrap_or_default();
    let home = var("HOME").or_else(|| var("USERPROFILE")).unwrap_or_default();
    let uid = if cfg!(windows) {
        "0".to_owned()
    } else {
        line("id", &["-u"]).unwrap_or_else(|| "0".into())
    };
    let config = std::env::var_os("JACKBIRD_SERVICE_CONFIG").map(|path| PathBuf::from(path).display().to_string());
    let mut flags = vec!["--user".into(), user, "--uid".into(), uid, "--home".into(), home];
    if let Some(config) = config {
        flags.extend(["--config".into(), config]);
    }
    flags
}

/// Runs the service's binary with these arguments; its line of JSON, or its error.
fn run(args: &[String]) -> Answer<Value> {
    let out = Command::new(binary()?)
        .args(args)
        .output()
        .map_err(|error| failure("io", error.to_string()))?;
    answer(out)
}

fn answer(out: std::process::Output) -> Answer<Value> {
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(serde_json::from_str(text.lines().last().unwrap_or("null")).unwrap_or(Value::Null))
    } else {
        let said = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        // `jackbird-service: install: why` → `why`.
        let said = said.strip_prefix("jackbird-service: ").unwrap_or(&said);
        let said = said
            .split_once(": ")
            .filter(|(command, _)| !command.contains(' '))
            .map_or(said, |(_, why)| why)
            .to_owned();
        Err(failure(
            "service",
            if said.is_empty() {
                "the service's command failed".into()
            } else {
                said
            },
        ))
    }
}

/// Quotes an argument for a POSIX shell.
fn sh(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// Runs the service's binary as an administrator, through the system's own prompt.
fn run_elevated(args: &[String]) -> Answer<Value> {
    let binary = binary()?;
    let out = if cfg!(target_os = "linux") {
        Command::new("pkexec").arg(&binary).args(args).output()
    } else if cfg!(target_os = "macos") {
        let line = std::iter::once(binary.display().to_string())
            .chain(args.iter().cloned())
            .map(|arg| sh(&arg))
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "do shell script \"{}\" with administrator privileges",
            line.replace('\\', "\\\\").replace('"', "\\\"")
        );
        Command::new("osascript").args(["-e", &script]).output()
    } else {
        // PowerShell's Start-Process asks UAC; its exit code is the binary's.
        let quoted = args
            .iter()
            .map(|arg| format!("'\"{}\"'", arg.replace('\'', "''").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(",");
        let script = format!(
            "$p = Start-Process -FilePath '{}' -ArgumentList {} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
            binary.display().to_string().replace('\'', "''"),
            if quoted.is_empty() { "@()".into() } else { quoted }
        );
        Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output()
    }
    .map_err(|error| failure("io", error.to_string()))?;
    // Elevated on Windows, the binary's own output is not seen: the exit code is what tells.
    if cfg!(windows) && out.status.success() {
        return Ok(Value::Null);
    }
    answer(out)
}

/// What the service's `status` says: installed (and how), running, versions, port.
#[tauri::command]
pub async fn service_status() -> Answer<Value> {
    tauri::async_runtime::spawn_blocking(|| run(&["status".into()]))
        .await
        .map_err(|error| failure("io", error.to_string()))?
}

fn installed_way() -> Answer<Option<String>> {
    Ok(run(&["status".into()])?["installed"].as_str().map(str::to_owned))
}

/// Installs it, at logon or with the system (`password`: the person's, on Windows only).
#[tauri::command]
pub async fn service_install(with_system: bool, password: Option<String>) -> Answer<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        if !with_system {
            return run(&["install".into()]);
        }
        let mut args = vec!["install".to_owned(), "--with-system".into()];
        args.extend(person_flags());
        let file = match password {
            Some(password) if cfg!(windows) => {
                let file = std::env::temp_dir().join(format!("jackbird-{}.txt", std::process::id()));
                std::fs::write(&file, password).map_err(|error| failure("io", error.to_string()))?;
                args.extend(["--password-file".into(), file.display().to_string()]);
                Some(file)
            }
            _ => None,
        };
        let done = run_elevated(&args);
        if let Some(file) = file {
            let _ = std::fs::remove_file(file);
        }
        done
    })
    .await
    .map_err(|error| failure("io", error.to_string()))?
}

/// Runs a command plainly when the service is installed at logon, as an administrator when with
/// the system.
async fn as_installed(command: &'static str) -> Answer<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec![command.to_owned()];
        if installed_way()?.as_deref() == Some("system") {
            args.extend(person_flags());
            run_elevated(&args)
        } else {
            run(&args)
        }
    })
    .await
    .map_err(|error| failure("io", error.to_string()))?
}

/// Uninstalls it, whichever way.
#[tauri::command]
pub async fn service_uninstall() -> Answer<Value> {
    as_installed("uninstall").await
}

/// Replaces the installed service with the app's copy, and restarts it.
#[tauri::command]
pub async fn service_update() -> Answer<Value> {
    as_installed("update").await
}

/// Starts it.
#[tauri::command]
pub async fn service_start() -> Answer<Value> {
    as_installed("start").await
}

/// Chooses a folder in the system's dialog, only its path (the service opens it).
#[tauri::command]
pub async fn choose_folder(app: tauri::AppHandle) -> Answer<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|error| failure("io", error.to_string()))?;
    picked
        .map(|path| path.into_path().map(|path| path.display().to_string()))
        .transpose()
        .map_err(|error| failure("io", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_arguments_are_quoted() {
        assert_eq!(sh("plain"), "'plain'");
        assert_eq!(sh("it's"), "'it'\\''s'");
    }

    #[test]
    fn the_person_is_named_for_an_administrator_run() {
        let flags = person_flags();
        assert_eq!(flags[0], "--user");
        assert_eq!(flags[2], "--uid");
        assert_eq!(flags[4], "--home");
    }
}
