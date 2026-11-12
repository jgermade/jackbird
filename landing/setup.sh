#!/bin/sh
# jackbird's service on this machine, in one line:
#
#   curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh
#
# It says what is installed, asks what to do (install, re-install, update or uninstall) and does
# it. With no questions:
#
#   curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh -s -- install
#   curl -fsSL https://jgermade.github.io/jackbird/setup.sh | sh -s -- update
#
# The work is the release's own binary's (`jackbird-service install | update | uninstall`,
# crates/service/src/install.rs): this script fetches the binary for this machine from the
# release and runs those commands, with sudo where the service is installed with the system.
# Your library and the service's configuration are never touched.
#
# Linux with systemd (x64, arm64) and macOS (arm64, x64). POSIX sh; needs curl or wget.
# See docs/install.md and RECORD/2026-11-12.landing-page.WIP.md.

set -eu

REPO="jgermade/jackbird"
RELEASES="https://github.com/$REPO/releases"
# The names the service is registered under (crates/service/src/install.rs).
UNIT="jackbird.service"
LABEL="es.germade.jackbird.service"

usage() {
  cat <<'EOF'
usage: setup.sh [install | reinstall | update | uninstall | status] [options]

With no command it asks what to do.

  install      install the service and start it
  reinstall    uninstall it and install it again, the way it was (or the way given)
  update       replace the installed service with the latest release's and restart it
  uninstall    stop it and remove it (the library and the configuration stay)
  status       say what is installed

  --logon          start it when you log in, with no administrator rights
  --system         start it with the system, from boot (the default; asks for sudo once)
  --version vX.Y.Z a release other than the latest
  --binary PATH    a jackbird-service binary you already have, instead of downloading one
  -y, --yes        do not ask for confirmation
  -h, --help       this
EOF
  exit "${1:-2}"
}

# ---- saying things --------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  GREEN="$(printf '\033[32m')"
  OFF="$(printf '\033[0m')"
else
  BOLD=""
  DIM=""
  GREEN=""
  OFF=""
fi

say() { printf '%s\n' "$*"; }
done_() { printf '%s\n' "${GREEN}✓${OFF} $*"; }
fail() {
  printf 'setup: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# A terminal to ask on, even when the script itself comes down a pipe.
has_tty() { (: </dev/tty) 2>/dev/null; }

# ask PROMPT: the answer in $answer.
ask() {
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
}

# confirm QUESTION: true on yes; always true with --yes, and false with nobody to ask.
confirm() {
  [ -z "$yes" ] || return 0
  has_tty || return 1
  ask "$1 [y/N] "
  case "$answer" in
    y | Y | yes | Yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- this machine, and who the service is for -------------------------------------------------

detect() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "on Windows, download jackbird-service-windows-x64.exe from $RELEASES/latest and run its \"install\", or use the desktop app's Preferences"
      ;;
    *) fail "there is no jackbird-service for $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "there is no jackbird-service for $(uname -m) processors" ;;
  esac
  # A shell translated by Rosetta says x86_64 on Apple silicon.
  if [ "$os" = macos ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ]; then
    asset="jackbird-service-linux-$arch-static"
    machine="Linux $arch"
  else
    asset="jackbird-service-macos-$arch"
    machine="macOS $arch"
  fi

  user="$(id -un)"
  uid="$(id -u)"
  home="${HOME:-}"
  if [ "$uid" = 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    fail "run it as yourself, without sudo: it asks for administrator rights when it needs them"
  fi
  [ -n "$home" ] || fail "your home folder is not known (HOME)"
}

# Runs a command as an administrator.
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    fail "administrator rights are needed, and there is no sudo: run it as root, or choose --logon"
  fi
}

# How the service is installed, if it is: its registration is there (as `installed()` in
# install.rs tells it, at logon first), and where its binary then is.
installed() {
  way=""
  installed_bin=""
  installed_version=""
  # The system's folders are looked for under another one only by this script's own check
  # (scripts/setup-check.mjs).
  root="${JACKBIRD_SETUP_ROOT:-}"
  if [ "$os" = linux ]; then
    if [ -e "$home/.config/systemd/user/$UNIT" ]; then
      way=logon
      installed_bin="$home/.local/share/jackbird/bin/jackbird-service"
    elif [ -e "$root/etc/systemd/system/$UNIT" ]; then
      way=system
      installed_bin="$root/usr/local/lib/jackbird/jackbird-service"
    fi
  else
    if [ -e "$home/Library/LaunchAgents/$LABEL.plist" ]; then
      way=logon
      installed_bin="$home/Library/Application Support/jackbird/bin/jackbird-service"
    elif [ -e "$root/Library/LaunchDaemons/$LABEL.plist" ]; then
      way=system
      installed_bin="$root/Library/Application Support/jackbird/bin/jackbird-service"
    fi
  fi
  if [ -n "$way" ] && [ -x "$installed_bin" ]; then
    installed_version="$("$installed_bin" --version 2>/dev/null || true)"
  fi
}

way_name() {
  case "$1" in
    logon) printf '%s' "at logon" ;;
    system) printf '%s' "with the system" ;;
  esac
}

# Whether the installed service answers, and where: "running on http://localhost:4646".
answering() {
  [ -n "$way" ] && [ -x "$installed_bin" ] || return 0
  report="$("$installed_bin" status 2>/dev/null || true)"
  port="$(printf '%s' "$report" | sed -n 's/.*"port":\([0-9][0-9]*\).*/\1/p')"
  case "$report" in
    *'"running":true'*) printf '%s' "running on http://localhost:${port:-4646}" ;;
    *) printf '%s' "not running" ;;
  esac
}

# ---- the release's binary --------------------------------------------------------------------

# The latest release's tag (vX.Y.Z), from where its page leads; empty when it cannot be told.
latest_tag() {
  to=""
  if have curl; then
    to="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest" 2>/dev/null || true)"
  elif have wget; then
    to="$(wget -q -S --spider "$RELEASES/latest" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r' || true)"
  fi
  case "$to" in
    */releases/tag/v[0-9]*) printf '%s' "${to##*/}" ;;
    *) printf '' ;;
  esac
}

fetch() {
  if have curl; then
    curl -fL --progress-bar -o "$2" "$1"
  elif have wget; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is needed to download the binary"
  fi
}

work=""
clean() { [ -z "$work" ] || rm -rf "$work"; }

# The binary to run the commands with, in $bin, and its version in $bin_version: the one given
# (--binary), or the release's for this machine, downloaded to a temporary folder.
get_binary() {
  [ -z "${bin:-}" ] || return 0
  if [ -n "$given_binary" ]; then
    [ -f "$given_binary" ] || fail "$given_binary: no such file"
    bin="$given_binary"
  else
    if [ -n "$version" ]; then
      from="$RELEASES/download/$version/$asset"
    else
      from="$RELEASES/latest/download/$asset"
    fi
    work="$(mktemp -d "${TMPDIR:-/tmp}/jackbird-setup.XXXXXX")"
    trap clean EXIT
    trap 'clean; exit 130' INT TERM
    bin="$work/jackbird-service"
    say "Downloading $asset${shown:+ ($shown)}…"
    fetch "$from" "$bin" || fail "could not download $from"
    chmod +x "$bin"
    # A temporary folder that runs nothing (mounted noexec): from the home folder instead.
    if ! "$bin" --version >/dev/null 2>&1; then
      rm -rf "$work"
      mkdir -p "$home/.cache"
      work="$(mktemp -d "$home/.cache/jackbird-setup.XXXXXX")"
      bin="$work/jackbird-service"
      fetch "$from" "$bin" || fail "could not download $from"
      chmod +x "$bin"
    fi
  fi
  bin_version="$("$bin" --version 2>/dev/null)" || fail "the binary does not run on this machine ($machine)"
}

# ---- the commands ----------------------------------------------------------------------------

# run_command WAY COMMAND: the binary's own command, as an administrator with the system.
run_command() {
  if [ "$1" = system ]; then
    if [ "$2" = install ]; then
      as_root "$bin" install --with-system --user "$user" --uid "$uid" --home "$home" >/dev/null
    else
      as_root "$bin" "$2" --user "$user" --uid "$uid" --home "$home" >/dev/null
    fi
  else
    "$bin" "$2" >/dev/null
  fi
}

# Which way to install: the one asked for, else asked, else with the system.
choose_way() {
  [ -z "$want" ] || return 0
  if [ -z "$action" ] && has_tty; then
    say ""
    say "  1) With the system: it starts at boot ${DIM}(asks for sudo once)${OFF}"
    say "  2) At logon: it starts when you log in ${DIM}(no administrator rights)${OFF}"
    ask "How should it start? [1] "
    case "$answer" in
      2) want=logon ;;
      *) want=system ;;
    esac
  else
    want=system
  fi
}

# After installing: where it answers, and the step that follows (sign-in, the first owner).
installed_note() {
  installed
  done_ "jackbird's service ${bin_version:+$bin_version }is installed ($(way_name "$way")) on ${BOLD}http://localhost:4646${OFF}"
  if [ -z "$action" ] && has_tty && [ -x "$installed_bin" ] && confirm "Set up sign-in and the first owner now? (it asks for your mail server and your address)"; then
    # It talks to the running service: give it a moment to answer.
    sleep 2
    "$installed_bin" setup </dev/tty || say "Run it again when you are ready: \"$installed_bin\" setup"
  else
    say "Sign-in and the first owner: ${BOLD}\"$installed_bin\" setup${OFF}"
  fi
}

do_install() {
  if [ -n "$way" ]; then
    fail "it is installed already ($(way_name "$way")): update, reinstall or uninstall it"
  fi
  choose_way
  get_binary
  say "Installing jackbird's service $(way_name "$want")…"
  run_command "$want" install || fail "it could not be installed"
  installed_note
}

do_reinstall() {
  if [ -z "$way" ]; then
    say "It is not installed: installing it."
    do_install
    return
  fi
  # The way it was, unless another is asked for.
  [ -n "$want" ] || want="$way"
  # The binary first: without one, the service stays as it is.
  get_binary
  say "Uninstalling the service installed $(way_name "$way")…"
  run_command "$way" uninstall || fail "it could not be uninstalled"
  say "Installing jackbird's service $(way_name "$want")…"
  run_command "$want" install || fail "it was uninstalled, and could not be installed again"
  installed_note
}

do_update() {
  [ -n "$way" ] || fail "it is not installed: install it first"
  get_binary
  if [ -n "$installed_version" ] && [ "$installed_version" = "$bin_version" ]; then
    done_ "It is $installed_version already: nothing to update."
    return
  fi
  say "Updating jackbird's service${installed_version:+ from $installed_version} to $bin_version…"
  run_command "$way" update || fail "it could not be updated"
  done_ "jackbird's service is $bin_version, and running again."
}

do_uninstall() {
  if [ -z "$way" ]; then
    say "It is not installed: nothing to uninstall."
    return
  fi
  confirm "Uninstall jackbird's service (installed $(way_name "$way"))? Your library and its configuration stay." || {
    say "Left as it is."
    return
  }
  # The installed binary uninstalls itself; without it, the release's.
  if [ -x "$installed_bin" ]; then
    bin="$installed_bin"
  else
    get_binary
  fi
  run_command "$way" uninstall || fail "it could not be uninstalled"
  done_ "jackbird's service is uninstalled. Your library and its configuration are where they were."
}

do_status() {
  if [ -z "$way" ]; then
    say "jackbird's service is not installed."
  else
    say "jackbird's service is installed $(way_name "$way")${installed_version:+, $installed_version}, $(answering)."
  fi
}

# What is here, and what to do about it.
menu() {
  latest="$(latest_tag)"
  shown="${version:-$latest}"
  say ""
  say "${BOLD}jackbird's service${OFF}"
  say ""
  say "  This machine   $machine"
  if [ -n "$way" ]; then
    say "  Installed      $(way_name "$way")${installed_version:+, $installed_version} ${DIM}($(answering))${OFF}"
  else
    say "  Installed      no"
  fi
  [ -z "$shown" ] || say "  Release        $shown"
  say ""
  if [ -z "$way" ]; then
    say "  1) Install"
    say "  q) Quit"
    ask "What should it do? [1] "
    case "$answer" in
      "" | 1 | i | install) do_install ;;
      *) say "Nothing done." ;;
    esac
    return
  fi
  if [ -n "$shown" ] && [ "v$installed_version" = "$shown" ]; then
    say "  1) Update ${DIM}(it is $shown already)${OFF}"
  else
    say "  1) Update${shown:+ to $shown}"
  fi
  say "  2) Re-install"
  say "  3) Uninstall"
  say "  q) Quit"
  ask "What should it do? [q] "
  case "$answer" in
    1 | u | update) do_update ;;
    2 | r | reinstall | re-install) do_reinstall ;;
    3 | uninstall)
      # The question was answered by choosing it.
      do_uninstall
      ;;
    *) say "Nothing done." ;;
  esac
}

main() {
  action=""
  want=""
  version=""
  yes=""
  shown=""
  given_binary="${JACKBIRD_SETUP_BINARY:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      install | update | uninstall | status) action="$1" ;;
      reinstall | re-install) action=reinstall ;;
      --logon) want=logon ;;
      --system | --with-system) want=system ;;
      --version)
        [ $# -ge 2 ] || usage
        shift
        version="$1"
        ;;
      --binary)
        [ $# -ge 2 ] || usage
        shift
        given_binary="$1"
        ;;
      -y | --yes) yes=1 ;;
      -h | --help) usage 0 ;;
      *) usage ;;
    esac
    shift
  done
  if [ -n "$version" ]; then
    case "$version" in
      v*) ;;
      *) version="v$version" ;;
    esac
    case "$version" in
      *[!0-9.v]* | v | v.*) fail "$version is not a release (vX.Y.Z)" ;;
    esac
    shown="$version"
  fi

  detect
  installed
  case "$action" in
    install) do_install ;;
    reinstall) do_reinstall ;;
    update) do_update ;;
    uninstall) do_uninstall ;;
    status) do_status ;;
    "")
      has_tty || {
        say "There is no terminal to ask on: say what to do."
        usage
      }
      menu
      ;;
  esac
}

# Last, so that a script cut short on its way down the pipe runs nothing.
main "$@"
