# Conversations missing from Reader

Reader finds a conversation by the session id its agent reports through
herdr's integration for that agent. herdr also detects an agent from its
terminal, which is enough to show it as Claude or Codex but not to say which
saved conversation it is. So Shahi's computer service keeps those integrations
installed: each time it starts, which is every herdr start and every update, it
runs `herdr integration status` and, for each agent Reader supports, installs
a missing integration if the agent is on the computer and updates an outdated
one (`server/lib/herdr-integrations.ts`). Nothing needs typing. It is the
service's job, not the plugin's startup hook, because "Update computer" in the
app replaces the service; the hook changes only with a plugin reinstall.

What it changes is what `herdr integration install` changes, and nothing else:
for Claude, a hook script under `~/.claude/hooks/` and a `SessionStart` entry
in `~/.claude/settings.json`, keeping the settings already there. An
integration removed after Shahi has seen it installed stays removed. What it
did, including anything it could not install, is in the service's log:
`herdr plugin action invoke shahi.logs`, then `herdr plugin log list --plugin shahi`.

Reader shows one of two waiting states rather than an error:

- **Claude has not saved any messages in this conversation yet.** Claude writes
  its transcript with the first message; measured on Claude Code 2.1.284,
  there is none after 12 seconds at the prompt. Every new conversation starts
  here, and Reader fills in on the next poll after the first message.
- **This Claude conversation started before Shahi could identify it.** The
  hook reports a session when it starts, so a conversation already running when
  the integration was installed never reported one, and herdr cannot resume it
  after a restart either: it resumes with `--resume=<session id>` (0.9.1). So
  Reader offers **Choose the conversation**: the computer lists the
  conversations Claude saved for the folder Claude runs in, newest first, each
  with its first request and latest message, and the person picks the one
  running. The one Claude's own process record names is marked **Likely**,
  following a conversation parked as a background job to the job's session;
  on September 28 that put the right conversation first, marked, for all six
  live panes. It stays a hint, not a choice: the record is undocumented and a
  fresh Claude does not write one. The choice holds for that Claude process in that
  terminal and ends with it, and the hook's own report replaces it. **Choose
  another** above a chosen conversation corrects a mistaken pick, or one that
  went stale after `/clear` in a Claude with no hook. Resuming the conversation
  in Claude also identifies it.

Screen shows the terminal meanwhile in both cases.

Reader reads Claude's history from `~/.claude/projects` by default. If Claude
uses a different `CLAUDE_CONFIG_DIR`, Shahi's service needs the same absolute
configuration directory, not its `projects` subdirectory. Set
`CLAUDE_CONFIG_DIR=/absolute/path/to/claude-config` in the `.env` inside
`herdr plugin config-dir shahi`, keeping the other entries, then run
`herdr plugin action invoke shahi.restart`. The plugin carries it into the
launchd/systemd environment so both messages and images use that folder. The
file's value wins over the setup shell; an empty value restores Claude's default.
Restart regenerates the service definition. This startup correction requires
an updated plugin installation when published; **Update computer** alone does
not replace the plugin's startup hook.

Picker previews use the same canonical transcript checks as Reader before
reading any content. Links outside the history root, aliases naming a different
session, and distinct copies of one session are not offered. A directory alias
for the same canonical transcript remains supported. The person must choose;
Reader never selects a conversation by working folder or modification time.

The installed background service preserves `CLAUDE_CONFIG_DIR` from the
environment that sets it up. To configure it explicitly, add
`CLAUDE_CONFIG_DIR=/absolute/path/to/claude-config` to the existing `.env` inside
the folder printed by `herdr plugin config-dir shahi`, then run
`herdr plugin action invoke shahi.restart`. Keep the rest of that file intact.
That explicit setting takes precedence over the setup shell's environment;
`CLAUDE_CONFIG_DIR=` restores the default `~/.claude` folder. Use the same
absolute folder as Claude, not its `projects` subfolder. Restart Shahi after
changing this setting so its service definition is regenerated.

The September 28 TestFlight report showed the old generic empty state on build
20, which confirms an unavailable transcript but not the cause. The reporter's
computer gets the integration when it updates to a release with this change,
from the app or by reinstalling the plugin; physical verification on that
computer remains outstanding.

See [herdr's integration documentation](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.1/docs/next/website/src/content/docs/integrations.mdx)
and [Claude's hooks documentation](https://code.claude.com/docs/en/hooks) for
`SessionStart`.
