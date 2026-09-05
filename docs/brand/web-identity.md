# Web identity implementation

The website and browser app use the same approved identity as native. This document describes the browser implementation; the cross-platform rules live in [Shahi identity](README.md).

## One source for visual roles

`shared/src/brand.ts` defines the shared palette consumed by native. `bun run brand:assets` generates `web/public/identity.css` from it, alongside font stacks, radii, and the motion curve defined in `scripts/brand-assets.ts`. The application bundles it through `web/src/styles.css`; `site/build.ts` copies the same file to `/identity.css` for the website and privacy page. Change palette values in the shared source and regenerate; do not hand-edit generated CSS or add a second palette to a page.

- `--accent`: brand, primary action, needs your answer.
- `--working`: blue activity.
- `--success`: green completion and successful connection.
- `--muted`: idle and secondary content.
- `--danger`: errors and destructive actions.
- `--text`, `--void`, `--surface`, `--raised`, and the line tokens define the neutral hierarchy.

Provider artwork keeps its colors. `AgentAvatar.tsx` combines it with a separate state dot and the working bob; Agents and Spaces use the same component. The terminal reads its ground, foreground, and cursor from the identity tokens while retaining ANSI output colors.

## Styles by responsibility

`web/src/styles.css` imports the canonical identity followed by these files, in order:

- `foundation.css`: reset, viewport, app shell, headers, connection state.
- `tasks.css`: agent rows, approvals, permission modes, file preview.
- `session.css`: pane chrome, terminal, composer, sign-in, feedback.
- `workspace.css`: navigation, spaces, sheets, folder and agent selection.
- `conversation.css`: reader, Markdown, attachments, grouping, activity.
- `interface.css`: responsive layouts, settings, pairing, shared interaction states, and the final Reduced Motion policy.

Add component styles in their owning file. Avoid appending a new palette or a second motion policy. Keep transcript and terminal layout stable during polling. Sans is used for prose, headings, controls, and the composer; mono remains for code, paths, identifiers, and technical metadata.

The marketing page and privacy policy load `site.css` and `privacy.css` respectively after the shared identity. Their HTML holds content and semantics, rather than embedded style sheets.

## Behavior retained

The once-per-tab greeting, explicit website replay, working-avatar bob, tactile controls, and neutral routine selections remain. The logo has no hover glow. Reduced Motion suppresses automatic animation, and replay is an explicit one-time opt-in. Status labels accompany the color system. Settings uses grouped panels and clear destructive actions; pairing presents connection controls in a bounded form panel.

## Validation

Build both web targets, run web unit tests, and run the existing Chromium and WebKit scenario suite. Check Agents, Spaces, a pane reader, Settings, and pairing at narrow and desktop widths. All writes in tests or previews must target the stub, never live agents. For cross-platform identity changes, also typecheck and test native. Relay behavior, authorization, and connection contracts are outside visual changes.
