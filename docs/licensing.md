# Licensing — a decision to confirm before going public

**This is a default I picked, not a decision you signed off on. Confirm or
change it before the repo is made public.**

The repo currently ships **MIT** (`/LICENSE`). Here is the reasoning and the
alternatives, so you can decide deliberately.

## Your situation

- You want the project **open source**.
- You want an **iOS version that may be commercialised** later.
- You (currently) **own all the copyright** — every commit is yours.

That last point is the important one: as the copyright holder you are **not
bound by your own open-source licence**. You can license the public repo under
one licence *and* sell a closed commercial build of the same code — that is
standard dual-licensing / open-core. So the licence choice is mostly about what
you let **other people** do, not what constrains you.

## Why MIT (the default here)

- **Permissive and App-Store-friendly.** No copyleft friction with Apple's
  distribution terms (GPL/AGPL have well-known conflicts with the App Store).
- **Simple and trusted.** The most common OSS licence; contributors understand
  it instantly.
- Others may reuse the code, including commercially. For a product whose moat is
  distribution, brand, and the polished iOS build — not secrecy of the code —
  that is usually fine and even helps adoption.

## If you want stronger protection instead

- **Apache-2.0** — like MIT but adds an explicit patent grant and a NOTICE
  requirement. Still permissive, still App-Store-safe. A reasonable upgrade if
  you care about patent defence.
- **AGPL-3.0** — copyleft: anyone running a modified version as a service must
  publish their changes. Deters closed commercial forks of the *server*, but
  brings GPL-vs-App-Store friction for the mobile app and asks more of
  contributors. Choose only if preventing closed forks matters more than
  frictionless adoption.
- **Open-core split** — MIT/Apache on `server/`, `shared/`, `web/`, and a
  source-available or non-commercial licence on `mobile/`. Keeps the iOS app
  yours to sell while opening the rest. More moving parts; only worth it if the
  iOS code itself is the thing you must protect.

## Also confirm

- The **copyright line** in `/LICENSE` says "Shahi contributors" — replace with
  your legal name or company if you prefer.
- A **CLA** (contributor licence agreement) is worth adding if you take outside
  contributions and want to keep the option to relicense or dual-license later.
