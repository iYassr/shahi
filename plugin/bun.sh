#!/bin/sh
#
# Runs bun, wherever it is — and, at install time only, installs it when it
# is nowhere.
#
# Every command in herdr-plugin.toml goes through this rather than naming
# `bun` directly: herdr launches plugin commands with its own PATH, and a bun
# installed by its installer lives in ~/.bun/bin, which is on the PATH of a
# login shell and often on nothing else. A bare `bun` would then fail to
# spawn, and herdr would report the spawn error rather than what to do about it.
#
# When no bun exists at all, the first build step of `herdr plugin install`
# runs bun's own installer into ~/.bun — the same line the docs used to ask
# people to run by hand before retrying. Only there: build commands get no
# plugin context (plugins.mdx, "Build commands"), which is how this tells the
# install — where a person has just confirmed a preview naming this script —
# from the startup hook and the actions, which run unattended and fetch
# nothing. The installer is bun's, over TLS, trusted as-is; it also appends
# ~/.bun/bin to the shell's rc file, as it always does, and needs curl, unzip
# and bash.
#
#   sh plugin/bun.sh install --frozen-lockfile
#   sh plugin/bun.sh run plugin/shahi.ts setup

if command -v bun >/dev/null 2>&1; then
  exec bun "$@"
fi
for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

if [ -n "${HERDR_PLUGIN_ID:-}" ]; then
  # A hook or an action, not the install: say what is missing and stop.
  echo "Shahi needs bun, and none was found on PATH, in ~/.bun/bin, /opt/homebrew/bin or /usr/local/bin." >&2
  echo "Install it (https://bun.sh), then return to the same herdr pane and run:  herdr plugin action invoke shahi.restart" >&2
  exit 1
fi

# Name the package-manager line for what is missing. `unzip` on a fresh Debian
# or Ubuntu is the usual one, and "install bun by hand" sent people to a second
# installer that needs the very same tool (pre-release review). Arch gets `-S`
# without `-y`: `pacman -Sy` is a partial upgrade, and on the Arch VM it broke
# curl, which broke pacman.
missing=""
for tool in curl unzip bash; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  if command -v apt-get >/dev/null 2>&1; then how="sudo apt-get install -y$missing"
  elif command -v dnf >/dev/null 2>&1; then how="sudo dnf install -y$missing"
  elif command -v pacman >/dev/null 2>&1; then how="sudo pacman -S --needed$missing"
  elif command -v zypper >/dev/null 2>&1; then how="sudo zypper install -y$missing"
  elif command -v apk >/dev/null 2>&1; then how="apk add$missing   (as root)"
  elif command -v brew >/dev/null 2>&1; then how="brew install$missing"
  else how="install$missing with this system's package manager"
  fi
  echo "Shahi needs bun, none was found, and bun's installer needs$missing, which this system lacks." >&2
  echo "Install it:  $how" >&2
  echo "Then run again:  herdr plugin install iYassr/shahi" >&2
  exit 1
fi
echo "Shahi needs bun and none was found; installing it into $HOME/.bun with bun's own installer (https://bun.sh/install)." >&2
curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash >&2
if [ -x "$HOME/.bun/bin/bun" ]; then
  exec "$HOME/.bun/bin/bun" "$@"
fi
echo "The installer did not leave a bun at $HOME/.bun/bin/bun. Install bun by hand (https://bun.sh), then run:  herdr plugin install iYassr/shahi" >&2
exit 1
