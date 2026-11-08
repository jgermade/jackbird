//! The service's version is jackbird's (`package.json`, which `release.yml` bumps), not the
//! crate's: the desktop app compares it with its own copy's to offer an update (S2).

fn main() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../package.json");
    println!("cargo:rerun-if-changed={path}");
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let version = text
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    println!("cargo:rustc-env=JACKBIRD_VERSION={version}");
}
