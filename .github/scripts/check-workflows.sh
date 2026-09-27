#!/usr/bin/env bash
# A pinned binary, verified before it executes; no package resolution in CI.
# Upstream: https://github.com/rhysd/actionlint/releases/tag/v1.7.12
set -euo pipefail

lint_dir=$(mktemp -d)
trap 'rm -rf "$lint_dir"' EXIT
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform=linux_amd64
    digest=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  Darwin-arm64)
    platform=darwin_arm64
    digest=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  *) echo 'Run actionlint 1.7.12 directly on this platform.' >&2; exit 1 ;;
esac
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_${platform}.tar.gz" \
  --output "$lint_dir/actionlint.tar.gz"
printf '%s  %s\n' "$digest" "$lint_dir/actionlint.tar.gz" | shasum -a 256 --check --status
tar -xzf "$lint_dir/actionlint.tar.gz" -C "$lint_dir" actionlint
# Keep the result independent of optional tools on a developer/runner's PATH.
# Workflow schemas, expressions, action inputs and job dependencies are checked.
"$lint_dir/actionlint" -shellcheck= -pyflakes=
