# Claude conversations missing from Reader

Shahi can detect a Claude terminal while still lacking the session identity
needed to find its saved conversation. On the computer running Claude:

```sh
herdr integration install claude
```

Quit Claude and resume the affected conversation inside herdr. Installing the
hook does not replay SessionStart for a session already running. Reader keeps
checking and should populate once herdr receives the session ID and Claude has
saved messages. Screen remains available meanwhile.

If Reader reports that it found the session but cannot read its saved
conversation, check that Claude is saving history and that Shahi runs under the
same account and `CLAUDE_CONFIG_DIR`. Shahi uses that configured projects folder
for both messages and images. It refuses ambiguous transcript copies and does
not select another conversation by working folder or modification time.

The September 28 TestFlight report showed the old generic empty state on build
20. That screenshot confirms an unavailable transcript, but does not reveal the
computer's integration status or custom configuration. The reporter still needs
to verify recovery on that computer. Updating the phone alone does not install
the computer's Claude integration.

The fix adds separate server reasons for missing identity and missing saved
history, displays those reasons in both clients, and honors `CLAUDE_CONFIG_DIR`.
New clients also show setup guidance when an older computer returns a plain
404. Existing API 5 clients remain compatible. The server change needs a
computer release; the native guidance needs a phone update.

Validation covers configured-folder message and image lookup, containment and
duplicate protection, both HTTP reasons, native and browser guidance, and
recovery after the next successful poll. Physical verification on the reporting
tester’s computer remains outstanding.

See [herdr’s Claude integration documentation](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.1/docs/next/website/src/content/docs/integrations.mdx)
for installation and [Claude’s hooks documentation](https://code.claude.com/docs/en/hooks)
for SessionStart behavior.
