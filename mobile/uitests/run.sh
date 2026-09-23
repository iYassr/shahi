#!/usr/bin/env bash
# Generate the project and run the UI tests against the booted simulator.
#
# The app must already be installed on that simulator (this drives it by
# bundle id, out of process; it does not build or install the app), and the
# recording fixtures must be running — see README.md. With a dev-client build
# on Metro, toggling the feature under test is a JS reload, not a rebuild —
# which is what makes the negative control cheap.
set -euo pipefail
cd "$(dirname "$0")"

UDID="${SIM_UDID:-$(xcrun simctl list devices booted -j | /usr/bin/python3 -c '
import json,sys
for r in json.load(sys.stdin)["devices"].values():
    for d in r:
        if d.get("state")=="Booted": print(d["udid"]); raise SystemExit')}"
[ -n "$UDID" ] || { echo "no booted simulator"; exit 1; }
echo "simulator: $UDID"

# xcodebuild hands TEST_RUNNER_-prefixed variables to the test process, minus
# the prefix; Fixture.swift reads the ports from there.
export TEST_RUNNER_SHAHI_FIXTURE_PORT="${SHAHI_FIXTURE_PORT:-7572}"
export TEST_RUNNER_SHAHI_SECOND_FIXTURE_PORT="${SHAHI_SECOND_FIXTURE_PORT:-7672}"

xcodegen generate --spec project.yml
# `-collect-test-diagnostics never`: without it Xcode 27 spent 600 seconds
# after the first failure on "Failure collecting diagnostics from simulator"
# before reporting anything (September 2026 review). The result bundle still
# holds the failure's screenshot and hierarchy.
xcodebuild test \
  -project ShahiUITests.xcodeproj \
  -scheme ShahiUITests \
  -destination "platform=iOS Simulator,id=$UDID" \
  -resultBundlePath "${RESULT_BUNDLE_PATH:-build/last.xcresult}" \
  -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  "$@"
