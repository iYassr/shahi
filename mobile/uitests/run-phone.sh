#!/usr/bin/env bash
# Runs PhoneTests on a real iPhone, against a disposable computer on this Mac.
#
# The computer is a named herdr session under a fresh XDG_CONFIG_HOME (no
# plugins, so Shahi's startup hook never sees it) with a 200x90 client
# attached, the size of a laptop running herdr full screen, and a sidecar from
# this checkout with its own secrets, database and port, reached through
# Shahi's relay as any paired phone reaches a computer. Every test here keeps
# the phone's own computers: it adds this one and revokes only this one. The
# other test classes sign out of every saved computer, so this script refuses
# to run them on a phone.
#
#   PHONE_UDID=<udid> mobile/uitests/run-phone.sh
#   PHONE_UDID=<udid> SHAHI_PHONE_BUILD=46 mobile/uitests/run-phone.sh   # install that TestFlight build first
#
# The UDID is in `xcrun devicectl list devices`. The phone must be paired with
# Xcode, in Developer Mode and unlocked for the run: iOS refuses UI tests on a
# locked phone. The runner is signed through Xcode's account, or through an
# App Store Connect key when ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID are set,
# which also works while the Mac is locked.
set -euo pipefail
cd "$(dirname "$0")"
repo=$(cd ../.. && pwd)
: "${PHONE_UDID:?set PHONE_UDID to the UDID of the iPhone, from xcrun devicectl list devices}"
for arg in "$@"; do
  case "$arg" in
    -only-testing:ShahiUITests/PhoneTests*) ;;
    -only-testing:*|-skip-testing:*) echo "only PhoneTests may run on a phone: $arg" >&2; exit 2 ;;
  esac
done

port=${SHAHI_PHONE_PORT:-17575}
session=shahi-phone
# Short on purpose: a macOS socket address holds 104 bytes, and $TMPDIR's
# /var/folders/… path makes herdr's client socket longer than that.
root=$(mktemp -d /tmp/shahi-phone.XXXXXX)
sock=$root/herdr/sessions/$session/herdr.sock
# Run from inside a herdr pane, the variables herdr sets would point every
# command below at the owner's own session.
clean=(env -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_ENV -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u CLAUDECODE XDG_CONFIG_HOME="$root")
keeper=
cleanup() {
  lsof -ti "tcp:$port" | xargs kill 2>/dev/null || true
  "${clean[@]}" herdr session stop "$session" > /dev/null 2>&1 || true
  [ -n "$keeper" ] && kill "$keeper" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT
if lsof -ti "tcp:$port" > /dev/null; then echo "port $port is in use; set SHAHI_PHONE_PORT" >&2; exit 1; fi

"${clean[@]}" nohup herdr --session "$session" server < /dev/null > "$root/herdr.log" 2>&1 &
for _ in $(seq 80); do [ -S "$sock" ] && break; sleep 0.25; done
[ -S "$sock" ] || { echo "the scratch herdr session did not start" >&2; exit 1; }
# A new named session has no workspace and so no pane.
"${clean[@]}" HERDR_SOCKET_PATH="$sock" herdr workspace create --cwd "$root" --label "Phone check" --focus > /dev/null
# A client attached in a 200x90 terminal sets the panes' size. It gets a
# pseudo-terminal of its own: `script` copies the settings of the terminal it
# runs in and fails without one ("tcgetattr/ioctl: Operation not supported").
"${clean[@]}" TERM=xterm-256color python3 -c '
import fcntl, os, pty, struct, sys, termios
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 90, 200, 0, 0))
    os.execvp("herdr", ["herdr", "--session", sys.argv[1]])
while True:
    try:
        if not os.read(fd, 65536): break
    except OSError: break
' "$session" < /dev/null > /dev/null 2>&1 &
keeper=$!
disown "$keeper"
pane=$("${clean[@]}" HERDR_SOCKET_PATH="$sock" herdr pane list | grep -o 'w[0-9]*:p[0-9]*' | head -1 || true)
[ -n "$pane" ] || { echo "the scratch session has no pane" >&2; exit 1; }
rows() { "${clean[@]}" HERDR_SOCKET_PATH="$sock" herdr pane get "$pane" | grep -o '"viewport_rows":[0-9]*' | grep -o '[0-9]*$' || echo 0; }
for _ in $(seq 60); do [ "$(rows)" -ge 80 ] && break; sleep 0.5; done
[ "$(rows)" -ge 80 ] || { echo "the pane stayed $(rows) rows tall; the 200x90 client did not attach" >&2; exit 1; }
# Numbered rows taller than any phone and wider than its screen (herdr's
# sidebar leaves the pane about 170 columns), ending at the shell's prompt:
# Screen must open on the last rows and the prompt, and scroll back and across.
"${clean[@]}" HERDR_SOCKET_PATH="$sock" herdr pane run "$pane" \
  'clear; for i in $(seq 1 160); do printf "Shahi phone check, row %03d %s\n" $i "$(printf "%0.s-" $(seq 1 110))"; done'

mkdir -m 700 "$root/data"
box=("${clean[@]}" SHAHI_ENV_FILE="$root/env" SHAHI_DATA="$root/data/shahi.sqlite" PORT="$port"
  RELAY_URL="${SHAHI_PHONE_RELAY:-https://relay.getshahi.dev}" HERDR_SOCKET_PATH="$sock")
(cd "$repo" && "${box[@]}" bun run server/scripts/init-secrets.ts --passcode "$(LC_ALL=C tr -dc 0-9 < /dev/urandom | head -c 8)" > /dev/null)
(cd "$repo" && "${box[@]}" bun run server/index.ts > "$root/sidecar.log" 2>&1 &)
for _ in $(seq 60); do
  curl -s --max-time 1 "127.0.0.1:$port/api/meta" | grep -q '"connected":true' && break
  sleep 0.5
done
curl -s --max-time 1 "127.0.0.1:$port/api/meta" | grep -q '"connected":true' \
  || { echo "the scratch computer never reached the relay" >&2; tail -5 "$root/sidecar.log" >&2; exit 1; }
code=$(cd "$repo" && "${box[@]}" bun run server/scripts/pair.ts --code-only 2> /dev/null | grep -o 'shahi://[^[:space:]]*' | head -1)
[ -n "$code" ] || { echo "no pairing code" >&2; exit 1; }

signing=(-allowProvisioningUpdates)
if [ -n "${ASC_KEY_PATH:-}" ]; then
  signing+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
only=(-only-testing:ShahiUITests/PhoneTests)
for arg in "$@"; do case "$arg" in -only-testing:*) only=() ;; esac; done

# xcodebuild hands TEST_RUNNER_-prefixed variables to the test process.
export TEST_RUNNER_SHAHI_PHONE_PAIR_CODE="$code" TEST_RUNNER_SHAHI_PHONE_PANE="$pane"
export TEST_RUNNER_SHAHI_PHONE_BUILD="${SHAHI_PHONE_BUILD:-}"
xcodegen generate --spec project.yml --quiet
xcodebuild test \
  -project ShahiUITests.xcodeproj \
  -scheme ShahiUITests \
  -destination "platform=iOS,id=$PHONE_UDID" \
  -resultBundlePath "${RESULT_BUNDLE_PATH:-build/phone-$(date +%Y%m%d-%H%M%S).xcresult}" \
  -collect-test-diagnostics never \
  "${signing[@]}" \
  DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-6H24S2PL9V}" CODE_SIGN_STYLE=Automatic CODE_SIGNING_ALLOWED=YES \
  "${only[@]}" "$@"
