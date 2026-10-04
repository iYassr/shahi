# Dependency patches

`bun install --frozen-lockfile` applies the patches declared in the root
`patchedDependencies`. Keep them until the affected consumers can use an
upstream fixed release. `bun run test:dependencies` checks the
installed modules in children with time and memory limits, including their
existing CommonJS callers.

- **decode-uri-component 0.2.2**: backports the linear UTF-8 scanner from
  [upstream v0.5.0](https://github.com/SamVerschueren/decode-uri-component/blob/v0.5.0/index.js)
  for [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).
  Retains the CommonJS function and plus-to-space behavior required by
  `query-string 7`, used by native navigation. Overriding to 0.5 would break
  that consumer because its published entry point is ESM-only.
- **image-size 1.2.1**: validates ICNS entry headers and minimum lengths,
  and bounds ISO box traversal used by JXL and HEIF. A zero box size consumes
  the remaining input; undersized, truncated and out-of-range boxes stop
  traversal. This addresses
  [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
  [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
  No fixed upstream version is published as of September 5, 2026.

The lockfile also updates `@xmldom/xmldom`, `brace-expansion`, `js-yaml` and
`nanoid` within their existing compatible release lines. The root override
selects `uuid 11.1.1`, which fixes its bounds advisory while retaining the
CommonJS `v4()` API used by `xcode`.

The September 9 review updates and overrides `sharp` to **0.35.4**, including
Miniflare's pinned transitive copy. Its prebuilt libraries address
[GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
This is build and local development tooling; the production relay does not
bundle Sharp or process images.

The independent review-demo npm lockfile does not inherit root overrides.
The October 4 launch review adds scoped Miniflare overrides in
`demo/package.json` for **Sharp 0.35.4** and **Undici 7.29.1**, updating only
those libraries and Sharp's required prebuilt/libvips packages. Direct
container, Wrangler and TypeScript versions are preserved. Its frozen install,
types, worker dry-run, model and state/archive tests passed; `npm audit
--prefix demo` reports zero advisories. This fixes the source of seven open
GitHub alerts on that separate lockfile; GitHub may still show them until its
next dependency scan.

The October 4 launch review updates **brace-expansion 5.0.12** and every
compatible 1.x copy to **1.1.21**, without changing the dependency ranges.
These releases fix recursion and malformed-brace rewrite exhaustion, including
[GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
[GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) and
[GHSA-q2hr-2g5m-vwhr](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr).
The bounded dependency checks exercise both release lines, ordinary CommonJS
Minimatch matching, deep nesting, comma parsing and the rewrite fallback.

Two newly disclosed advisories still have no published fixed release as of
October 4, 2026:

- **braces 3.0.3**, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
  deeply nested glob patterns can exhaust the parser stack. Its
  [upstream issue](https://github.com/micromatch/braces/issues/70) is open.
  In this repository it is consumed through Micromatch by Metro, Expo and
  test/build tooling. Metro's patterns come from project configuration;
  the public server and encrypted-transport bundle graphs do not include it.
- **node-forge 1.4.0**, [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv):
  RSA PKCS#1 v1.5 verification accepts extra nested DigestAlgorithm elements.
  The [proposed upstream fix](https://github.com/digitalbazaar/forge/pull/1152)
  remains unmerged; no local cryptographic patch is substituted. It is used by
  Expo/EAS certificate tooling, including local certificate/CSR checks, and
  is absent from the public server and encrypted-transport bundle graphs.
  The iOS update verifier uses Apple's `SecKeyVerifySignature` and
  `SecTrust`, rather than this JavaScript library. The separate
  `.github/eas/bun.lock` also contains the affected build-tool packages.

These are unresolved build-tool risks, not suppressed advisories. Treat
external glob configuration, certificates and CSRs as untrusted until upstream
fixes can be adopted; the reviewed release flow uses project configuration
and the existing operator-controlled signing material. This reachability review
does not claim that every possible tooling invocation is safe.

`bun audit --production` only sees package versions, not applied patches or
which workspace dependencies are shipped. On October 4 it reports five
advisories across four package names: three covered by the installed
`decode-uri-component` / `image-size` patches above, plus the unresolved
`braces` and `node-forge` advisories. The audit is not clean and no advisories
are suppressed.

The **full** root audit additionally reports ten Undici 7.29.0 advisories
(two high, five moderate and three low) through Miniflare's pinned development
dependency. [Undici 7.29.1](https://github.com/nodejs/undici/releases/tag/v7.29.1)
fixes them. The TLS callback advisory affects `BalancedPool` with custom
function-valued TLS/connection options; the reviewed Miniflare implementation
uses `Pool`. No Undici or Sharp input appears in the computer service, relay
or review-container application build graphs.

CI's Bun 1.3.13 does not support a parent-scoped override: isolated checks of
nested overrides, a version selector and Yarn path resolutions leave the
7.29.0 dependency unchanged. Applying a global 7.x override would also replace
Sentry CLI's separate 6.x dependency, so it is not used. The first inspected
Miniflare release with the fixed dependency is 5.20260926.1-alpha; moving from
the pinned 5.20260903.0-alpha also changes Workerd from 1.20260903.1 to
1.20260926.1. That broader alpha tooling/engine update is deferred. Preserve
the explicit development-tool risk and update the paired toolchain with its
integration checks rather than relying on an ignored override. The current
[Bun override documentation](https://bun.com/docs/pm/overrides) describes newer
scoped rules and a lock format that older Bun cannot read.
