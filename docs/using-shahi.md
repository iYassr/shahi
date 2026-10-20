# Using Shahi

The [README](../README.md#quick-start) gets a computer and a phone connected.
This guide covers what comes after: pairing more devices, several computers,
messages and files, and what to do when something does not appear. Installing,
updating and removing the computer side is in the [plugin guide](plugin.md).

## Pairing phones and browsers

From a terminal inside herdr on the computer doing the work:

```sh
herdr plugin action invoke shahi.pair
```

The code appears in a popup in herdr's window, so a herdr window must be open;
on a server with no herdr window attached, run `herdr` first and invoke it from
there. The first time, the popup sets Shahi up in front of you and prints a
four-digit passcode, shown only once and needed for SSH or the locally served
web app. On Linux it also shows the lingering reminder when it applies. It
waits for Enter before showing the QR, and keeps any failure on screen until
Enter, with what to do next.

Press **T** then Enter to see the code as a `https://getshahi.dev/pwa/#pair=…`
link instead of a QR; T and Enter again brings the QR back, and Enter alone
closes the popup. If the QR asks for more room, enlarge the window or use the
link. From outside a named herdr session's panes, add `--session <name>` to
these commands.

The code can be claimed **once** and expires after **10 minutes**. Generate a
separate code for each phone or browser. Treat the QR code and the pairing link
as credentials: anyone who claims a valid code can operate your session.

- **iPhone app:** [install Shahi from the App Store](https://apps.apple.com/app/id6813370698),
  open it and choose **Scan QR code**. To try upcoming versions, you can also
  [request a TestFlight beta invite](https://getshahi.dev/#ios-beta);
  invitations are sent by email as places become available.
- **Browser:** open [getshahi.dev/pwa/](https://getshahi.dev/pwa/) and use
  **Scan QR code** inside Shahi, or paste the code. Your phone's camera app
  cannot hand a pairing code to the browser. Opening a `#pair=` link shows a
  **Connect this browser?** card first, naming the relay and the computer;
  continue only if you opened that link yourself. Add Shahi to your home screen
  for a standalone app window.

The browser app works on phones and computers. SSH tunnelling is built into the
iPhone app only; see [SSH connections](ssh.md). There is no native Android app.

**Lost the passcode?** `herdr plugin action invoke shahi.reset-passcode`
prints a new one to the plugin log; existing sessions and paired phones stay
signed in.

## Several computers

Pair more computers from **Settings → Computers → Add a computer**. Tap the
computer name on the main screen, or open Computers in Settings, to switch.
Every saved computer keeps its own live connection while Shahi is open;
switching only changes the view. The computer list shows which machines are
connected and lets you revoke this phone or browser's access to one without
disconnecting the others. Mobile operating systems can suspend connections
while the app is in the background; Shahi reconnects every saved computer when
you return.

Outbound internet access is all the default relay connection needs; you do not
expose Shahi's local port.

## Messages and drafts

Unsent messages are kept separately for each conversation and computer while
Shahi remains open. They are not saved permanently: reloading the browser or
closing the app process clears them. Signing out or revoking access also clears
that connection's drafts. A draft also goes when its pane closes or its
identifier is reassigned to another program, so it cannot reach the next agent.

Shahi never sends a draft or an answer on its own after a connection recovers.
A send whose outcome was uncertain stays in the composer; **Send** retries it as
the same request, which the computer recognises instead of typing it again.

## Files

Links to files on your computer open a labeled preview through your existing
connection. Text, images and PDFs can be viewed in Shahi. On iPhone, use
Save / Share to keep a copy in Files or open it in another app; the web viewer
has a Download button. PDFs have native scrolling and zoom on iPhone, and page
and zoom controls on the web. Downloads are limited to 25 MiB and travel
through the encrypted relay in 512 KiB parts; computer releases older than
0.3.7 can send only about 765 KiB through the relay. SSH has no such limit.

Attachments can be up to **32 MiB each** through the relay or SSH. Relay
uploads show progress, travel in small encrypted pieces, and recover from brief
connection losses while the upload remains open. Larger files take several
minutes, and closing the app may mean selecting the file again. Older computer
services keep the previous 761 KiB relay limit. Relay uploads run one at a
time, with at most 128 completed files an hour per computer.

## When something does not appear

- **No pairing popup.** Run `herdr plugin action invoke shahi.status`, then
  read its report with `herdr plugin log list --plugin shahi`. The invoke
  itself prints only a JSON action record. herdr's CLI exits successfully even
  when the popup could not open, for example with no herdr window attached; the
  plugin log then holds the reason and a command that prints the code as text.
- **A conversation shows no messages.** See
  [Reader troubleshooting](reader-troubleshooting.md).
- **The app says Update computer, or Update required.** Tap it, or run
  `herdr plugin install iYassr/shahi` again on the computer. Updating herdr
  does not update Shahi.
- **The computer shows as offline.** It must be awake, online and running
  herdr. On a headless Linux server, `loginctl enable-linger $USER` keeps the
  service running after you log out.
