# Transitive dependency security patches

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

`bun audit` only sees package versions, not these applied patches. It still
reports the three advisories above for these two patched package names; the
audit is not clean and no advisories are suppressed.
