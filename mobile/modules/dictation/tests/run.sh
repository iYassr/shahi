#!/bin/bash
# Runs LiveTranscription against Apple's real SpeechTranscriber on this Mac with
# synthesized English speech. Needs macOS 26+ and Xcode; downloads Apple's
# English model on first run if the system does not have it.
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
xcrun swiftc -O -parse-as-library ../ios/LiveTranscription.swift main.swift -o "$work/harness"
say -o "$work/speech.aiff" "Please update the readme file, then run the tests and fix the failing login callback. After that, open the settings screen and check that the toggle for notifications still works on a small phone."
"$work/harness" "$work/speech.aiff" "update the read" "run the tests" "login call" "settings screen" "notification"
