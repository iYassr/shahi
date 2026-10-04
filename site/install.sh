#!/bin/sh
# Shahi installer.
#
#   curl -fsSL https://getshahi.dev/install | sh
#
# 1. Installs herdr __HERDR_VERSION__ into ~/.local/bin if herdr is missing,
#    and only after its SHA-256 matches the one written below.
# 2. Installs the Shahi plugin into herdr (herdr plugin install iYassr/shahi).
# 3. Starts herdr in the background if it is not running, which sets up
#    Shahi's service.
# 4. Shows a QR code to scan with the Shahi app.
#
# Running it again skips what is already done and shows a new code. The plugin
# manages its service and herdr's agent integrations. If bun is missing, its
# installer adds ~/.bun/bin to your shell profile. No administrator password
# is requested.
# Source: https://github.com/iYassr/shahi/blob/master/site/install.sh
set -eu

HERDR_VERSION="__HERDR_VERSION__"
HERDR_SHA256_MACOS_AARCH64="__SHA_MACOS_AARCH64__"
HERDR_SHA256_MACOS_X86_64="__SHA_MACOS_X86_64__"
HERDR_SHA256_LINUX_AARCH64="__SHA_LINUX_AARCH64__"
HERDR_SHA256_LINUX_X86_64="__SHA_LINUX_X86_64__"
HERDR_MIN="0.9.0"
BIN_DIR="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\nShahi was not installed: %s\n' "$*" >&2; exit 1; }

# True when version $1 is at least $2 (major.minor.patch).
at_least() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0
  }'
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else fail "neither shasum nor sha256sum is installed, so herdr's download cannot be checked."
  fi
}

platform() {
  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) fail "Shahi runs on macOS and Linux, and this is $(uname -s)." ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) cpu=aarch64 ;;
    x86_64 | amd64) cpu=x86_64 ;;
    *) fail "herdr has no build for this processor ($(uname -m))." ;;
  esac
  case "$os-$cpu" in
    macos-aarch64) expected=$HERDR_SHA256_MACOS_AARCH64 ;;
    macos-x86_64) expected=$HERDR_SHA256_MACOS_X86_64 ;;
    linux-aarch64) expected=$HERDR_SHA256_LINUX_AARCH64 ;;
    linux-x86_64) expected=$HERDR_SHA256_LINUX_X86_64 ;;
  esac
}

# Sets HERDR to a herdr this script can use, installing one if there is none.
find_herdr() {
  HERDR=""
  if command -v herdr >/dev/null 2>&1; then HERDR=$(command -v herdr)
  elif [ -x "$BIN_DIR/herdr" ]; then HERDR="$BIN_DIR/herdr"
  fi
  if [ -n "$HERDR" ]; then
    have=$("$HERDR" --version 2>/dev/null | awk '{print $NF}')
    printf '%s\n' "$have" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
      fail "could not read a supported version from $HERDR --version. Check that herdr runs, then try again."
    if at_least "${have:-0}" "$HERDR_MIN"; then
      say "herdr $have is installed."
      return
    fi
    fail "herdr $have is older than Shahi supports ($HERDR_MIN or newer). Update it with:  $HERDR update   then run this again."
  fi
  command -v curl >/dev/null 2>&1 || fail "curl is needed to download herdr. Install curl, then run this again."
  install_herdr
}

install_herdr() {
  step "Installing herdr $HERDR_VERSION"
  url="https://github.com/herdrdev/herdr/releases/download/v$HERDR_VERSION/herdr-$os-$cpu"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/herdr" "$url" || fail "could not download herdr from $url"
  got=$(sha256 "$tmp/herdr")
  # Never run a binary whose bytes are not the ones Shahi pinned.
  [ "$got" = "$expected" ] || fail "herdr's download does not match its expected SHA-256 (expected $expected, got $got). Nothing was installed."
  mkdir -p "$BIN_DIR"
  chmod 755 "$tmp/herdr"
  mv "$tmp/herdr" "$BIN_DIR/herdr"
  HERDR="$BIN_DIR/herdr"
  say "Installed herdr $HERDR_VERSION in $BIN_DIR, checked against its SHA-256."
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) PATH_HINT=1 ;;
  esac
}

# What the steps below need and cannot install without a password: git, which
# herdr fetches plugins with, and curl, unzip and bash when bun's installer
# will be needed. Checked before anything is changed, and
# named together, so one command fixes them all.
need_tools() {
  missing=""
  command -v git >/dev/null 2>&1 || missing="git"
  if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
    for tool in curl unzip bash; do
      command -v "$tool" >/dev/null 2>&1 || missing="${missing:+$missing }$tool"
    done
  fi
  [ -z "$missing" ] && return
  if [ "$os" = macos ]; then
    fail "this computer needs $missing first. Install missing command-line tools (for git: xcode-select --install), then run this again."
  fi
  if command -v apt-get >/dev/null 2>&1; then hint="sudo apt-get install -y $missing"
  elif command -v dnf >/dev/null 2>&1; then hint="sudo dnf install -y $missing"
  elif command -v pacman >/dev/null 2>&1; then hint="sudo pacman -S --needed $missing"
  elif command -v apk >/dev/null 2>&1; then hint="sudo apk add $missing"
  else hint="install: $missing"
  fi
  fail "this computer needs $(printf %s "$missing" | sed 's/ / and /') first. Run:  $hint   then run this again."
}

server_running() { "$HERDR" status server 2>/dev/null | grep -q '^status: running'; }

plugin_installed() {
  "$HERDR" plugin list --json 2>/dev/null | grep -q '"plugin_id": *"shahi"'
}

install_plugin() {
  if plugin_installed; then
    say "The Shahi plugin is installed."
    return
  fi
  step "Installing the Shahi plugin"
  # -y: the confirmation herdr asks for would read this script, not a person.
  "$HERDR" plugin install -y iYassr/shahi || fail "herdr could not install the Shahi plugin; its output above says why."
}

start_herdr() {
  if server_running; then
    STARTED=0
    return
  fi
  step "Starting herdr in the background"
  # The plugin's startup hook sets Shahi up when herdr starts. Run herdr to
  # open it; it attaches to this same session.
  nohup "$HERDR" server >/dev/null 2>&1 &
  deadline=$(($(date +%s) + 30))
  until server_running; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "herdr did not start within 30 seconds. Try running:  $HERDR"
    sleep 0.5
  done
  STARTED=1
}

# bun, which the plugin install provided (plugin/bun.sh).
find_bun() {
  if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun)
  elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"
  else fail "bun was not found after the plugin install; its output above says why."
  fi
}

service_up() {
  # Any Shahi can answer /api/meta. Reuse the plugin's authenticated probe,
  # with this installation's private key, so another service on the port is
  # refused before claiming it is ready or trying to mint a pairing code.
  status=0
  (cd "$ROOT" && SHAHI_ENV_FILE="$CONFIG/.env" "$BUN" -e '
    import { existsSync } from "node:fs";
    import { whoAnswers } from "./plugin/shahi.ts";
    import { readEnvFile } from "./server/lib/secrets.ts";
    import { parsePort } from "./server/lib/config.ts";
    if (!existsSync(process.env.SHAHI_ENV_FILE)) process.exit(1);
    const env = readEnvFile(process.env.SHAHI_ENV_FILE);
    let port;
    try { port = parsePort(env.get("PORT")); }
    catch (error) { console.error(error.message); process.exit(3); }
    const who = await whoAnswers(`http://${env.get("HOST") || "127.0.0.1"}:${port}`, env);
    process.exit(who === "ours" ? 0 : who === "other" ? 2 : 1);
  ') || status=$?
  if [ "$status" = 2 ]; then
    fail "another program is answering on Shahi's configured port and refused this install's session key. Put PORT=<a free port> in $CONFIG/.env, then run:  $HERDR plugin action invoke shahi.restart"
  fi
  [ "$status" != 3 ] || fail "check PORT in $CONFIG/.env, then run this again."
  [ "$status" = 0 ]
}

wait_for_service() {
  CONFIG=$("$HERDR" plugin config-dir shahi)
  ROOT=$("$HERDR" plugin list --json | "$BUN" -e 'const d = await Bun.stdin.json(); const p = (d.result ?? d).plugins.find((x) => x.plugin_id === "shahi"); console.log(p?.plugin_root ?? "")')
  [ -n "$ROOT" ] || fail "herdr does not report where the Shahi plugin is installed."
  # A disabled plugin stays disabled. Pairing should not silently re-enable
  # an installation the owner deliberately stopped.
  enabled=$("$HERDR" plugin list --json | "$BUN" -e 'const d = await Bun.stdin.json(); const p = (d.result ?? d).plugins.find((x) => x.plugin_id === "shahi"); console.log(p?.enabled === false ? "no" : "yes")')
  [ "$enabled" != no ] || fail "the Shahi plugin is disabled. Enable it with:  $HERDR plugin enable shahi   then run this again."
  service_up && { say "Shahi's service is running."; return; }
  # A herdr that was already running did not run the startup hook just now.
  [ "$STARTED" = 1 ] || "$HERDR" plugin action invoke shahi.restart >/dev/null 2>&1 || true
  step "Starting Shahi's service"
  deadline=$(($(date +%s) + 60))
  until service_up; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "Shahi's service did not answer within a minute. Its log:  $HERDR plugin log list --plugin shahi"
    fi
    sleep 0.5
  done
  say "Shahi's service is running."
}

pair() {
  step "Pair your phone"
  say "Open the Shahi iPhone app or https://getshahi.dev/pwa/ and scan this code inside Shahi."
  (cd "$ROOT" && SHAHI_ENV_FILE="$CONFIG/.env" "$BUN" run server/scripts/pair.ts --no-copy) ||
    fail "the pairing code could not be made. Try:  $HERDR plugin action invoke shahi.status"
}

main() {
  say "Installing Shahi: see and answer your coding agents from your phone."
  platform
  need_tools
  find_herdr
  install_plugin
  start_herdr
  find_bun
  wait_for_service
  pair
  step "Done"
  if [ "${PATH_HINT:-0}" = 1 ]; then
    say "herdr is in $BIN_DIR, which is not on your PATH. Add this line to your shell's profile:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
  fi
  say "Run herdr to open your session:  $HERDR"
  say "To pair another phone later, run this again, or inside herdr:  herdr plugin action invoke shahi.pair"
}

# Everything above is a definition. Nothing runs until this line, so a download
# cut short runs nothing.
main "$@"
