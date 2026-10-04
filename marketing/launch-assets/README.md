# Shahi launch graphics

Three square, share-ready cards for LinkedIn, X, Reddit and community posts.
Each export is 1200 × 1200 pixels with an opaque background. Use the PNGs when
posting; the outlined SVGs are editable, resolution-independent source assets.

Download the [complete ready-to-share launch ZIP](../video/out/launch-safe/shahi-launch-kit.zip)
for these cards, wide and square silent videos, optional English captions,
channel-specific copy and a short posting guide. The ZIP is an ignored local
build artifact; the source assets remain here.

| Card | SVG source | PNG export | Suggested use |
| --- | --- | --- | --- |
| Launch announcement | [01-launch.svg](01-launch.svg) | [01-launch.png](../video/out/launch-safe/graphics/01-launch.png) | Lead image for a launch post |
| Six features | [02-features.svg](02-features.svg) | [02-features.png](../video/out/launch-safe/graphics/02-features.png) | Second image or a feature follow-up |
| Install and pair | [03-install-pair.svg](03-install-pair.svg) | [03-install-pair.png](../video/out/launch-safe/graphics/03-install-pair.png) | Setup reply, technical community post or final carousel card |

Run from the repository root:

```sh
bun marketing/launch-assets/render.ts
```

The renderer uses the existing `@napi-rs/canvas` and `sharp` dependencies. It
loads the bundled IBM Plex Sans and Mono fonts, outlines all lettering, writes
the SVG sources here and exports PNGs under the ignored
`marketing/video/out/launch-safe/graphics/` directory. The SVGs require no
installed fonts, remote assets or raster images. Text fit and safe margins are
checked during rendering. Inspect all three PNGs after changing layout or copy.

The palette, lockup and provider artwork come from
[shared/src/brand.ts](../../shared/src/brand.ts), following
[the brand guide](../../docs/brand/README.md). Font licenses are bundled in
[site/public/fonts/](../../site/public/fonts/); provider artwork notices are in
[shared/src/artwork-notices.ts](../../shared/src/artwork-notices.ts).

The copy describes verified product capabilities: a free tunnel without VPN
setup, Reader, five supported providers, starting agent sessions, multiple
computers and answering supported prompts. The setup card assumes herdr is
already installed. It includes the exact plugin install and pairing commands,
and explains that the computer must stay awake and connected. These cards make
no claim about a pending App Store version or verified push delivery.

## Alt text

**Launch announcement:** Shahi: coding agents on your phone. Read the work and
answer what comes next. Supports Claude Code, Codex, Cursor, OpenCode and
Antigravity. Free tunnel, no VPN setup, phone and browser access. Your agents run
on your computer. Get started at getshahi.dev.

**Six features:** Shahi offers a free tunnel without VPN setup; Reader for clear
agent conversations; five providers, from Claude Code to Antigravity; starting
agent sessions from your phone; switching between multiple computers; and
approving or declining supported prompts with context. Available on phone and
browser at getshahi.dev.

**Install and pair:** With herdr installed on your computer, run
`herdr plugin install iYassr/shahi`, then
`herdr plugin action invoke shahi.pair`. Scan the pairing QR code with Shahi’s
scanner or your phone camera to open your agents. Keep the computer awake and
connected. More information at getshahi.dev.
