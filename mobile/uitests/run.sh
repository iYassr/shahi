#!/usr/bin/env bash
# Generate the project and run the UI tests against the booted simulator.
#
# The app must already be installed and paired on that simulator (this drives
# it by bundle id, out of process; it does not build or install the app). With
# a dev-client build on Metro, toggling the feature under test is a JS reload,
# not a rebuild — which is what makes the negative control cheap.
set -euo pipefail
cd "$(dirname "$0")"

UDID="${SIM_UDID:-$(xcrun simctl list devices booted -j | /usr/bin/python3 -c '
import json,sys
for r in json.load(sys.stdin)["devices"].values():
    for d in r:
        if d.get("state")=="Booted": print(d["udid"]); raise SystemExit')}"
[ -n "$UDID" ] || { echo "no booted simulator"; exit 1; }
echo "simulator: $UDID"

xcodegen generate --spec project.yml
xcodebuild test \
  -project ShahiUITests.xcodeproj \
  -scheme ShahiUITests \
  -destination "platform=iOS Simulator,id=$UDID" \
  -resultBundlePath build/last.xcresult \
  CODE_SIGNING_ALLOWED=NO \
  "$@"
