#!/usr/bin/env bash
# Installs herdr's linux-x86_64 binary for one release tag as ~/.local/bin/herdr,
# and only once its bytes match the SHA-256 digest GitHub records for that
# release asset, and the caller's pinned digest when it passes one.
#
#   install-herdr.sh TAG [SHA256]
#
# Found in the pre-release review (September 2026): CI ran herdr binaries that
# nothing had checked. Pinned tags were fetched by URL, the nightly took the
# newest prerelease as it was, and stable came from `curl herdr.dev/install.sh
# | sh`, all on runners whose checkout left the job token in .git/config.
# herdr publishes immutable releases with a digest on every asset, so checking
# costs one API call. GitHub's digest proves the download is the asset the
# release holds. A pinned digest (ci.yml's supported tags, or herdr.dev's
# manifest for stable) proves it is the asset we meant. Nothing here runs the
# binary. The caller does that later, in a step that holds no token.
set -euo pipefail

tag=${1:?usage: install-herdr.sh TAG [SHA256]}
pinned=$(printf '%s' "${2:-}" | tr 'A-F' 'a-f')
asset=herdr-linux-x86_64

refuse() {
  echo "herdr $tag: $1; refusing to install it." >&2
  exit 1
}

release=$(gh api "repos/herdrdev/herdr/releases/tags/$tag")
url=$(jq -r --arg asset "$asset" '.assets[] | select(.name == $asset) | .browser_download_url' <<<"$release")
digest=$(jq -r --arg asset "$asset" '.assets[] | select(.name == $asset) | .digest // ""' <<<"$release")
[ -n "$url" ] || refuse "the release has no $asset asset"
expected=${digest#sha256:}
if [[ $digest != sha256:* || ! $expected =~ ^[0-9a-f]{64}$ ]]; then
  refuse "GitHub records no SHA-256 digest for $asset"
fi
if [ -n "$pinned" ] && [ "$pinned" != "$expected" ]; then
  refuse "GitHub's digest for $asset ($expected) is not the pinned one ($pinned)"
fi

download=$(mktemp)
trap 'rm -f "$download"' EXIT
curl -fsSL --retry 3 -o "$download" "$url"
# sha256sum on the Linux runners; shasum where the test suite runs on a Mac.
if command -v sha256sum > /dev/null; then
  actual=$(sha256sum "$download")
else
  actual=$(shasum -a 256 "$download")
fi
[ "${actual%% *}" = "$expected" ] || refuse "the downloaded $asset does not match its release digest"

mkdir -p "$HOME/.local/bin"
install -m 0755 "$download" "$HOME/.local/bin/herdr"
echo "Installed herdr $tag ($asset, sha256 $expected)."
