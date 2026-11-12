# Installing the service

`jackbird-service` serves jackbird to every browser of the house (and, with a proxy, from outside
it): the family library, people and their roles, sign-in by email and passkeys. Three ways to
install it; each ends with the first owner signing in.

| Way | For | Runs as |
| --- | --- | --- |
| [Docker Compose](#docker-compose) | a home server, a NAS, a Raspberry Pi | a container, `ghcr.io/jgermade/jackbird` (x64 and arm64) |
| [A binary](#a-binary) | any Linux (static: x64, arm64) or macOS (arm64, x64) | a service of the system, started at boot |
| [The desktop app](#the-desktop-app) | the computer you use | your own user, from the app's Preferences |

Each release attaches the binaries (`jackbird-service-linux-x64-static`,
`…-linux-arm64-static`, `…-macos-*`, `…-windows-*`) and pushes the image.

## Docker Compose

On a machine with Docker:

```sh
mkdir jackbird && cd jackbird
curl -fsSLO https://raw.githubusercontent.com/jgermade/jackbird/main/deploy/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/jgermade/jackbird/main/deploy/.env.example
mkdir -p config library
$EDITOR .env           # JACKBIRD_USER (`id -u`:`id -g`), MUSIC (your music, read only), restic
docker compose up -d
```

jackbird answers on <http://localhost:4646>, on this machine only: it is open, for one person, and
the port is published on the machine's loopback (`127.0.0.1:4646`). Open it in a browser here,
or from another computer through an SSH tunnel (`ssh -L 4646:localhost:4646 the-server`).

**Music** is mounted read only at the container's `Music` folder: **Add music**, **Import a
folder of this machine…** copies it into the library, which lives in `./library` (back that up).
`./config` keeps the service's settings, its people and the console's key.

**Sign-in, and the first owner** (by email and a code; a mail server is needed):

```sh
docker compose exec jackbird jackbird-service setup
```

It asks for your SMTP server and your address, sends a code there, and turns sign-in on once you
type it back. From then on, owners and admins invite people from **People and sign-in…**.

**From outside home**, with sign-in on: put HTTPS in front at your own address. Uncomment `caddy`
in `compose.yaml`, set `JACKBIRD_ADDRESS` in `.env` (a name that points at your home, with ports
80 and 443 forwarded to this machine), set the same address in **People and sign-in…**,
**Sign-in**, **The instance's address**, and `docker compose up -d`. Or, with nothing opened at
home, run [intergate](https://jgermade.github.io/intergate/)'s client beside it, or any SSH
reverse tunnel to a server of yours with a proxy (see [Using jackbird](usage.md#people-and-sign-in-the-service)).

**The copy away from home**: set `RESTIC_PASSWORD` and a repository in `.env` (a folder on a disk
kept elsewhere, or a storage service), and start restic beside jackbird:

```sh
docker compose --profile backup up -d
```

It copies the library once a day and keeps 7 daily, 4 weekly and 12 monthly copies. To restore,
see [Keeping the library safe](usage.md#people-and-sign-in-the-service).

**Updating**: `docker compose pull && docker compose up -d`.

## A binary

On Linux (needs systemd) or macOS, one line sets it up:

```sh
curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh
```

It says what is installed and asks what to do: **install**, **re-install**, **update** or
**uninstall**. It downloads the latest release's binary for the machine and runs that binary's own
commands (below), with `sudo` where the service is installed with the system; the library and the
service's configuration are never touched. Installing, it asks how the service should start (with
the system, from boot, or when you log in, with no administrator rights) and then offers to set up
sign-in and the first owner. With no questions, say what to do:

```sh
curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh -s -- install          # or: install --logon
curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh -s -- update           # the latest release
curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh -s -- reinstall
curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh -s -- uninstall --yes
```

(`status` says what is installed; `--version vX.Y.Z` takes a release other than the latest;
`--binary PATH` a binary you already have.)

**By hand**: download the binary for the machine from the latest release, then, on Linux:

```sh
chmod +x jackbird-service-linux-arm64-static
sudo ./jackbird-service-linux-arm64-static install --with-system --user "$USER" --home "$HOME"
```

or on macOS (`jackbird-service-macos-arm64`, `…-x64`), the same `install --with-system`. It is
installed as a service of the system that starts at boot and runs as you, on
<http://localhost:4646>. `jackbird-service install` without `--with-system` starts it when you log
in, with no administrator rights. Then, on the same machine, with the installed binary (the
installation prints where it is: `/usr/local/lib/jackbird/jackbird-service` on Linux, with the
system):

```sh
jackbird-service setup        # email, the first owner, sign-in on
jackbird-service status       # installed, running, its version
```

The library lives in `~/.local/share/jackbird/library` on Linux and `~/Library/Application
Support/jackbird/library` on macOS (or `service.json`'s `library`). From outside home, as with
Docker: a proxy with HTTPS in front (Caddy: `caddy reverse-proxy --from music.example.com --to
localhost:4646`) and the instance's address set in **Sign-in**. **Updating**: the one-line
setup's **update**, `jackbird-service update` with the new binary, or the desktop app's **Update**.

## The desktop app

Install the app from the latest release; in **Preferences**, **Service**, **Install** starts the
service when you log in (or **Install with the system**, with administrator rights once). The app
is then its interface; the rest is as above (see [Using jackbird](usage.md)).

## The Android app

The Android app is a client of an instance installed in one of the ways above: it asks for the
instance's address the first time (`192.168.1.20:4646` at home, or the address it has outside
home, such as one through intergate) and signs in there. Its player keeps playing with the screen
off, with its controls in the notification and on the lock screen.

1. On the phone, download `jackbird-vX.Y.Z-android.apk` from the latest release.
2. Open it. The first time, Android asks to allow the browser (or Files) to install apps: allow it,
   go back, and install.
3. Updating: install the new APK over the old one. An APK named `…-android-testkey.apk` was signed
   with a key made for that build: remove the app before installing the next one.

Android 7 or later. It is not in Google Play.
