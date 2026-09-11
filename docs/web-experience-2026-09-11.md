# Web experience revision — 11 September 2026

The public app at https://getshahi.dev/pwa/ now carries the welcome page's visual language through the connected experience. Source: `7488d1439b7ddbc6efa3f17e98bf5decd633f58f`; computer package: 0.3.4.

## Changes

- A prominent computer selector identifies the current machine. Its menu shows connection states, marks the selected computer, and closes on selection, outside interaction, or Escape. Escape returns keyboard focus to its toggle.
- Computer management has a selected card, readable connection states, clear pairing guidance, and separate access-revocation controls.
- Agents has a compact activity summary, a searchable list with a clear control, and a way back from empty search/filter results. An empty installation points to Spaces.
- Spaces explains the project model and guides the first space creation. Folder icons identify workspace rows.
- Settings groups computers, encryption, notifications, and device access with shared icons. Connection details expand on request. Sign-out explains its effect, and help/privacy links are available.
- The notification invitation occupies less space and remains opt-in. Login welcomes returning users and announces errors.
- Read and Screen have recognizable icons. File previews trap keyboard focus, restore it on close, and reset stale text when opening another file.
- Navigation has a named landmark and clearer selected states. The existing conversation, prompt-answering, attachment, terminal zoom, keyboard and scroll behavior remains covered by regression tests.

## Validation

- Local type checks and 619 unit checks passed; 26 environment-dependent checks skipped. Four dependency backport tests passed.
- Full local browser regression: 184 passed, four environment/platform skips. After the final polish, 43 dashboard/file checks passed, including the new search recovery and preview keyboard tests.
- Final hosted suite: 44 passed across Chromium and WebKit, including live computer switching, encrypted files, revocation, notification ownership, automatic reconnect and authenticated update recovery.
- Final PWA suite: 11 passed; one WebKit browser-network emulation skip. Tests cover installation assets, cached offline launch, relay recovery and interrupted worker updates.
- Browser Harness review used disposable, encrypted test computers at desktop, 390 px and 320 px widths. No real agent commands or notification signup submissions were used.

- The approved release pipeline passed on the exact source commit: 188 browser regressions, 44 hosted checks, 11 PWA checks, 614 unit checks, 254 native checks, 68 relay checks, two live-herdr profiles (21 checks each), and four platform upgrade suites (49 checks each). [Release run](https://github.com/iYassr/shahi/actions/runs/34602907143).

## Hosted publication

Cloudflare site version: `d3d03006-5dbf-42ad-a67b-fd2fc6a87519`. Public HTML, scripts, styles, worker and install icons matched the built assets byte for byte. Routing, restrictive content security policy, worker caching headers and unknown-route rejection were checked after deployment.

Physical iPhone Home Screen installation and background notification delivery still need a check on a real phone. Browser and WebKit checks do not establish those operating-system behaviors.

## Computer rollout

The immutable package was downloaded from the successful release run and verified against its signed catalog, archive size/digest, version and source commit. The Mac upgraded through Beta first. The same approved bytes were promoted to Stable; the public Stable catalog signature was verified and retains five supported releases.

Both the Mac and separate Ubuntu server now report `0.3.4-7488d1439b7d` on Stable, with herdr and the relay connected. Before/after comparisons confirmed the same server identity and paired-device set on each machine. herdr sessions were not restarted.
