<p align="center">
  <img src="src/assets/brand/jackbird-metal.svg" alt="" width="120">
</p>

<h1 align="center">jackbird</h1>

<p align="center"><strong>Your library, right where it is.</strong></p>

jackbird is a browser app for a local music collection, MP3 and FLAC. Open a music folder and it lays out your
albums with their covers, plays them, and lets you fix their tags and covers, one track or many at
once. Changes are written straight into your files: there is no server, and nothing is
uploaded anywhere.

Its interface, **Deck**, takes after old portable audio gear: keys that travel when pressed, a
dot-matrix display, labels printed like a faceplate's, and two tones, Silver and Graphite.

## Screenshots

![The library in Silver, with a track playing](docs/screenshots/library-silver.png)

| Graphite | Editing three tracks at once |
| --- | --- |
| ![A two-disc album in Graphite, with a track playing](docs/screenshots/library-graphite.png) | ![The edit dialog with three tracks selected](docs/screenshots/edit-dialog.png) |

<p align="center">
  <img src="docs/screenshots/phone.png" alt="jackbird on a phone, playing a track" width="300">
</p>

<sub>The albums, artists and covers in the screenshots are made up.</sub>

## Quick start

You need [Node.js](https://nodejs.org/) 22.6 or later, [Rust](https://rustup.rs/) stable with
its WebAssembly target (`rustup target add wasm32-unknown-unknown`: jackbird's tag engine is
built from source into the web app), and a Chromium-based desktop browser
(Chrome, Edge, Brave, Opera). jackbird reads and writes your files through the File System Access
API, which Firefox and Safari do not have: there a folder opens read-only (it plays and its tags
are read, nothing is saved to it, and it is not reopened after a reload).

```bash
make up
```

It installs the dependencies the first time, then starts the dev server. Open
<http://localhost:8666>, choose **Open folder** and pick a folder with MP3 or FLAC files. The browser asks
for permission to edit the files in it; jackbird needs it to save your changes.

Run the checks with `make test`, and build for production with `make build` (into `dist/`). Each
one runs its npm script (`npm run dev`, `npm test`, `npm run build`), which also work on their own
after `npm install`.

jackbird also runs as a desktop app (Tauri v2) on macOS, Windows and Linux, with the same
interface: `make desktop` starts it in development mode, and `make desktop-build` makes its
installers. Each release attaches them, unsigned for now, so macOS and Windows warn when they are
opened. On Linux it needs WebKitGTK (see [Development](docs/development.md)).

And as a service: `make service` builds `jackbird-service`, one binary with the web inside, and
starts it on <http://localhost:4646>. Its page opens folders of the machine it runs on, in any
browser, and keeps a family library with people, roles and sign-in by email and passkeys. To
install it on a home server, a NAS or a Raspberry Pi (Docker, or a binary), see
[Installing the service](docs/install.md). The
desktop app carries it and installs it from its Preferences, to start when you log in (no
administrator rights) or with the system (administrator rights once); while it is installed, the
app is its interface. On Linux this needs systemd.

## Documentation

- [Using jackbird](docs/usage.md)
- [Installing the service](docs/install.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Releases and deployment](docs/releases.md)
