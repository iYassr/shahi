#!/bin/sh
#
# Runs bun, wherever it is. Every command in herdr-plugin.toml goes through
# this rather than naming `bun` directly, for one reason: herdr launches plugin
# commands with its own PATH, and a bun installed by its installer lives in
# ~/.bun/bin, which is on the PATH of a login shell and often on nothing else.
# A bare `bun` would then fail to spawn, and herdr would report the spawn
# error rather than what to do about it. This says what to do about it.
#
#   sh plugin/bun.sh install --frozen-lockfile
#   sh plugin/bun.sh run plugin/shahi.ts setup

for candidate in bun "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" "$@"
  fi
done

echo "Shahi needs bun, and none was found on PATH, in ~/.bun/bin, /opt/homebrew/bin or /usr/local/bin." >&2
echo "Install it with:" >&2
echo "  curl -fsSL https://bun.sh/install | bash" >&2
echo "then restart herdr so its startup hook runs again." >&2
exit 1
