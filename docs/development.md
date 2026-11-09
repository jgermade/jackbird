# Development

## Requirements

- Node.js 22.6 or later: the unit tests run TypeScript directly with `--experimental-strip-types`.
- A Chromium-based browser to run the app.
- `make`, for the shortcuts below (optional: the npm scripts do the same).
- Rust (stable) with the `wasm32-unknown-unknown` target (`rustup target add
  wasm32-unknown-unknown`): `npm run dev`, `npm test` and `npm run build` first build the tag
  engine into `src/lib/tags/engine.wasm` (`scripts/build-wasm.mjs`, skipped when it is newer than
  every file under `crates/`; `npm run build:wasm` forces it). `rustfmt` and `clippy` to work on
  the crates.
- For the desktop app only: on Linux, WebKitGTK and its kin (on Ubuntu: `libwebkit2gtk-4.1-dev
  build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, and
  `gstreamer1.0-plugins-good gstreamer1.0-libav` to play); on macOS and Windows, nothing more
  than Rust (Xcode's command-line tools; WebView2, which Windows 11 has).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` (`make up`) | The dev server, on <http://localhost:8666>. |
| `npm test` (`make test`) | Every check (below). Run it before every commit. |
| `npm run build` (`make build`) | Type check, then the production build into `dist/`. Under `safeEval`, jq79 precompiles every component's functions into one script, which each page preloads. |
| `npm run preview` | Serves `dist/` as it will be deployed. |
| `npm run type-check` | The TypeScript check alone. |

The `make` targets install the dependencies first (`npm ci`) when `node_modules` is missing or
older than `package-lock.json`. A bare `make` lists them.

## What `npm test` runs

1. **`test:layers`** (`scripts/check-layers.mjs`): no import crosses the layers the wrong way (see
   [Architecture](architecture.md#layers)). `import type` and assets are exempt.
2. **`test:styles`** (`scripts/check-styles.mjs`): no shorthand with `var()` overridden by its own
   longhand in one block (jq79's scoping would drop it), and no `:hover` rule outside
   `@media (hover: hover)`, so touch screens get no hover states.
3. **`test:types`**: a type check of the helpers, `src/lib/tags/` and their tests
   (`tsconfig.test.json`).
4. **`test:unit`**: the tests (`src/**/*.test.ts`), on Node's own test runner, with no
   framework: the helpers', and every fixture of `fixtures/tags/` against the built WebAssembly
   module (`src/lib/tags/wasm.test.ts`). It also writes coverage to `.tmp/coverage/lcov.info`.
5. **`test:coverage`** (`scripts/check-coverage.mjs`): every helper file must reach 90% of lines,
   branches and functions, and a helper that no test loads fails the check.

## The tag crates

`crates/` holds jackbird's own tag engine, in Rust, with no tag dependency (see
[Architecture](architecture.md#the-tag-engine)): `jackbird-id3`, `jackbird-flac` and
`jackbird-tags`, and `jackbird-tags-wasm` (the web app's module), one Cargo workspace whose
`Cargo.toml` is at the root. The module is built with the workspace's `wasm` profile (for size).

| Command | What it does |
| --- | --- |
| `cargo test --workspace` (`make test-crates`, with the two below) | The crates' unit tests, and `jackbird-tags`' tests on every fixture in `fixtures/tags/`. |
| `cargo fmt --all --check` | The formatting (`rustfmt.toml`). |
| `cargo clippy --workspace --all-targets -- -D warnings` | The lints, with warnings as errors, as CI runs them (`tags.yml`, which also lints and builds the module for `wasm32-unknown-unknown`). |

The fixtures are small MP3 and FLAC files built byte by byte, committed with `cases.json`, which
says what each must give; [their README](../fixtures/tags/README.md) says how to make them again.

## The desktop app

`src-tauri/` is the desktop app (Tauri v2): the web build in the system's webview, and its files
reached through `crates/core` by path (see [Architecture](architecture.md#the-desktop-app)).

| Command | What it does |
| --- | --- |
| `npm run desktop` (`make desktop`) | The app in development mode, over the dev server. |
| `npm run desktop:build` (`make desktop-build`) | The release build and its bundles, into `target/release/bundle/`. |
| `make desktop-test` | The app's lints and tests (`cargo clippy -p jackbird`, `cargo test -p jackbird`). |
| `node scripts/desktop-check.mjs target/release/jackbird` | The unattended check `desktop.yml` runs on the three systems (under `xvfb-run -a` on a Linux machine without a display): the fixtures opened, read, a title saved, an MP3 and a FLAC played, the library reopened after a restart. |

## The service

`crates/service` is `jackbird-service` (S1): `crates/core` behind HTTP (axum), with the web build
embedded in a release binary (`npm run build` first) and served from the same origin (see
[Architecture](architecture.md#the-service)).

| Command | What it does |
| --- | --- |
| `npm run service` (`make service`) | The web build, then the service in release mode on <http://localhost:4646>. |
| `jackbird-service [--port N] [--config PATH]` | The binary: its configuration (the port, the open folders) is `~/.config/jackbird/service.json` on Linux, `~/Library/Application Support/jackbird/service.json` on macOS, `%APPDATA%\jackbird\service.json` on Windows, or `JACKBIRD_SERVICE_CONFIG`. |
| `jackbird-service setup`, `jackbird-service signin off` | Ask the running service as an owner, with the key it writes beside its configuration (`service.key`, the person's alone): `setup` sets up email (SMTP) and confirms an owner's address with the code sent there, which turns sign-in on (or, with it on, is the way back in); `signin off` turns it off. |
| `jackbird-service install [--with-system]`, `uninstall`, `update`, `start`, `stop`, `status` | Installs it the way the system starts things, as the person running it: at logon (a systemd user unit, a launchd agent, a task at logon) or, as an administrator, with the system (a systemd system unit with `User=`, a launchd daemon with `UserName`, a Windows service logged on as the person: `--password-file`). `status` is a line of JSON. Linux needs systemd. |
| `node scripts/sidecar.mjs` | Builds the service in release mode and copies it to `src-tauri/binaries/` for the desktop app to carry (`externalBin`); `tauri.conf.json` runs it before every build. |
| `cargo test -p jackbird-service` | Its tests, through its router, and the files each system's installation writes. |
| `node scripts/service-check.cjs target/release/jackbird-service [a long FLAC]` | The unattended check `service.yml` runs on the three systems: Chromium (Playwright) on its page opens a folder, saves a title, plays, and finds the folder again after a restart. |
| `cargo test -p jackbird-store` | The family library (F1) on the shared fixtures: imports, the same audio twice, layers, what leaves read back by the engine, ranges, the library as a root. The fixtures of one format share their audio, so the tests make them distinct by adding bytes at their end. |
| `node scripts/library-check.cjs target/release/jackbird-service` | The library's check (F1), also in `service.yml`: an owner imports a folder of the machine, an editor uploads a song and retitles one, a listener plays it and downloads it with the new title; the files on the machine unchanged. |
| `node scripts/signin-check.cjs target/release/jackbird-service` | Sign-in's check (S3), also in `service.yml`: email set up against `scripts/smtp-sink.mjs` (an SMTP server that keeps every email in a file), sign-in turned on by the owner's code, an editor and a listener invited, a code and a passkey (Chromium's virtual authenticator), each role's limits, the log, sessions kept across a restart. A debug binary reads `dist/` as it is, so `npm run build` is enough between runs. |

## Translations

The interface is in English (the source and the fallback) and Spanish. No text is written inline:
each one is a key in `src/lib/locales/en.ts`, with its Spanish in `src/lib/locales/es.ts`, and is
read with `t("key", { param })`, or `t.n("key", count)` for a counted text with `.one` and
`.other` forms. The compiler rejects a Spanish catalogue that misses a key, and `npm test` rejects
one whose `{placeholders}` differ from the English.

## The Deck theme

The default theme lives in `theme/default/`. Its demo page, with every token and component, is
built alongside the app:

- locally: <http://localhost:8666/theme/default/>
- on GitHub Pages: <https://jgermade.github.io/jackbird/theme/default/>, once a release has been
  deployed (see [Releases and deployment](releases.md))

Sizes are in `rem`, so the interface scales with the root font size (`4vw` on phones); only
hairlines stay in `px`.

## Conventions

[`AGENTS.md`](../AGENTS.md) holds the project's conventions: the layers, sizes, language rules,
and how work is planned and recorded in [`RECORD/`](../RECORD/) and [`ROADMAP/`](../ROADMAP/).
Temporary files go in `.tmp/`, which git ignores.
