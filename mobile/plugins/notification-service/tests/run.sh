#!/bin/bash
# Opens the computer's sealed-notification vector with the extension's own
# Swift on this Mac (CryptoKit is the same there). Needs Xcode.
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
xcrun swiftc -parse-as-library ../PushEnvelope.swift ../NotificationService.swift main.swift -o "$work/harness"
"$work/harness" ../../../../server/fixtures/push-seal-vector.json
