#!/bin/bash
# The Swift copy of the crash-message redaction, against the shared vectors.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
xcrun swiftc -O "$here/../sentry-redaction.swift" "$here/main.swift" -o "$out/redaction"
"$out/redaction" "$here/../../../shared/src/error-redaction-vectors.json"
