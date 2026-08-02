# Five minutes on the actual phone

The suite runs 146 tests in Chromium and WebKit and none of them are an iPhone.
WebKit is close — close enough to have caught a blank page, a tap that never
landed, and a thumbnail that collapsed — but it is not Safari, it has no soft
keyboard, no home screen, and no APNs.

This is the list of things only a device can answer. Run it after anything that
touches layout, the service worker, or notifications. It takes about five
minutes.

## Before you start

Background the app and reopen it. It compares its bundle against the served one
and reloads if they differ, so this is how you know you are testing the build you
just deployed rather than the one from last week.

## The checks

**1. It opens from the icon.**
Launch from the home screen, not a tab. It should paint immediately — the shell
is cached — and fill in as the session arrives. A white screen for more than a
moment means the worker is not doing its job.

**2. Scrolling is boring.**
Flick the agent list hard, then a long transcript. Nothing should stutter, jump,
or drift as Safari's toolbar collapses. This is the one that has broken twice and
neither time did a test notice: the app used to resize itself in response to the
toolbar moving.

**3. The keyboard does not bury the composer.**
Open a pane, tap the text box. The composer, the key bar and Send must all stay
above the keyboard. Type a few words, dismiss the keyboard, reopen it — the draft
should still be there. Then turn the phone sideways with the keyboard open: the
tab row disappears, and the composer is still reachable.

**4. Tapping works where it looks like it should.**
Tap an image in a transcript — it should open full screen, pinch-zoomable, with
Download. Tap a filename under a tool call — same viewer, different route. Both
of these have failed on iOS while working everywhere else.

**5. Answering an agent actually answers it.**
With something blocked, tap an option on the card and watch the agent move on.
This is the whole product; it is worth confirming with your own eyes
occasionally rather than trusting the test that mocks it.

**6. Notifications arrive.**
Turn them on, use "Send a test", and confirm one appears with the app closed.
Then tap it: it should open the pane it names, not the dashboard.

## What to write down when something fails

The three failures look identical from a distance and point in different
directions, so say which one it was:

- **blank** — a render threw; the boundary should have caught it, so if you see
  a truly blank screen the boundary itself is implicated
- **frozen with stale data** — the connection died and the watchdog did not
  notice
- **still says LIVE but nothing updates** — the socket is open and the server is
  not sending, which is a server-side question

A screenshot of the moment beats a description of it. `~/.local/share/shahi/uploads`
is a fine place to drop one — the app can then show it to whoever is debugging.
