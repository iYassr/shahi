#!/usr/bin/env bash
#
# HerdrUI, installed and running, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/iYassr/HerdrUI/master/install.sh | bash
#
# What it does, in order: checks that herdr is actually here, fetches the code,
# builds the web client, generates a passcode and the keys that go with it,
# installs a systemd user service, and prints the address to open. Every step is
# idempotent — running it again upgrades in place and leaves your passcode alone.
#
# Nothing here needs root. The service runs as you, because it is your herdr
# session it is talking to.
set -euo pipefail

REPO="${HERDRUI_REPO:-https://github.com/iYassr/HerdrUI.git}"
DIR="${HERDRUI_DIR:-$HOME/.local/share/herdrui/app}"
PORT="${HERDRUI_PORT:-7171}"
SERVICE="$HOME/.config/systemd/user/herdrui.service"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- what has to be true before anything else ------------------------------

command -v git >/dev/null || die "git is required."

if ! command -v herdr >/dev/null; then
  die "herdr is not installed, and HerdrUI is a window onto it rather than a thing of its own.
  See https://herdr.dev, then run this again."
fi

SOCKET="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
[ -S "$SOCKET" ] || note "herdr's socket is not at $SOCKET yet — start a session and it will appear."

if ! command -v bun >/dev/null; then
  say "Installing bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN="$(command -v bun)"

# --- the code ---------------------------------------------------------------

if [ -d "$DIR/.git" ]; then
  say "Updating HerdrUI in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Fetching HerdrUI into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing dependencies"
"$BUN" install --frozen-lockfile 2>/dev/null || "$BUN" install

say "Building the web client"
"$BUN" run build:web

# --- secrets ----------------------------------------------------------------

if [ -f .env ] && grep -q "PASSCODE_HASH_B64=." .env; then
  note "Keeping the passcode you already have."
  PASSCODE=""
else
  # Four digits, because it is typed on a phone behind a tailnet, and the
  # boundary that matters is the network rather than the length of this.
  PASSCODE="${HERDRUI_PASSCODE:-$(( RANDOM % 9000 + 1000 ))}"
  say "Generating secrets"
  "$BUN" run server/scripts/init-secrets.ts --passcode "$PASSCODE"
fi

# --- the service ------------------------------------------------------------

say "Installing the service"
HOST="${HERDRUI_HOST:-127.0.0.1}"

# Refuse to point an existing installation somewhere else by accident. Learned
# the hard way: a test run of this script rewrote a live unit to a scratch
# directory and took the running dashboard down with it.
if [ -f "$SERVICE" ] && ! grep -q "WorkingDirectory=$DIR\$" "$SERVICE" && [ -z "${HERDRUI_FORCE:-}" ]; then
  EXISTING="$(grep -m1 '^WorkingDirectory=' "$SERVICE" | cut -d= -f2-)"
  die "A HerdrUI service already exists and points at:
    $EXISTING

  This run would repoint it at:
    $DIR

  If that is what you want, run again with HERDRUI_FORCE=1. To upgrade the
  installation you already have, run this from there instead."
fi

mkdir -p "$(dirname "$SERVICE")"
cat > "$SERVICE" <<UNIT
[Unit]
Description=HerdrUI — a phone-shaped window onto herdr
After=default.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=HOST=$HOST
Environment=PORT=$PORT
Environment=WEB_ROOT=$DIR/web/dist
Environment=PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$BUN run server/index.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now herdrui.service >/dev/null 2>&1 || systemctl --user restart herdrui.service

# Survives logout and reboot, which is the whole point of a phone dashboard.
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  note "Could not enable lingering; the service will stop when you log out."

sleep 1
systemctl --user is-active --quiet herdrui.service || {
  systemctl --user status herdrui.service --no-pager | tail -20
  die "The service did not start. The log above says why."
}

# --- where to find it -------------------------------------------------------

say "Running"
note "http://$HOST:$PORT"
[ -n "$PASSCODE" ] && note "Passcode: $PASSCODE"

if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  NAME="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')"
  if [ -n "$NAME" ]; then
    cat <<TAILSCALE

  Your phone reaches this over Tailscale. One more command puts TLS in front,
  which is what makes notifications possible — iOS only delivers Web Push to an
  installed app on a secure origin:

    sudo tailscale serve --bg --https=443 http://$HOST:$PORT

  Then open https://$NAME on your phone and add it to your home screen.
TAILSCALE
  fi
fi

cat <<'NEXT'

  systemctl --user status herdrui     what it is doing
  journalctl --user -u herdrui -f     what it has been doing
  bash install.sh                     upgrade, keeping your passcode

NEXT
