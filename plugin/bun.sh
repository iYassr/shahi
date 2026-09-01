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
  echo "Install it (https://bun.sh), then:  herdr plugin action invoke shahi.restart" >&2
  exit 1
fi

for tool in curl unzip bash; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Shahi needs bun, none was found, and installing it needs $tool, which is missing too." >&2
    echo "Install bun by hand (https://bun.sh), then run:  herdr plugin install iYassr/shahi" >&2
    exit 1
  fi
done
echo "Shahi needs bun and none was found; installing it into $HOME/.bun with bun's own installer (https://bun.sh/install)." >&2
curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash >&2
if [ -x "$HOME/.bun/bin/bun" ]; then
  exec "$HOME/.bun/bin/bun" "$@"
fi
echo "The installer did not leave a bun at $HOME/.bun/bin/bun. Install bun by hand (https://bun.sh), then run:  herdr plugin install iYassr/shahi" >&2
exit 1
