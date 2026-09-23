# Licensing

Shahi's source code is licensed under [MIT](../LICENSE), except where a file or
bundled dependency carries its own license. Distribution must retain the
applicable copyright and permission notices.

MIT permits commercial use, modification, redistribution, and selling copies.
Charging for an official app or service does not change the permissions granted
for published MIT code. See the [MIT license text](https://opensource.org/license/mit).

No separate proprietary mobile license is currently in effect. Any future
licensing change must account for contributor rights and dependency licenses;
it does not remove permissions already granted for earlier MIT versions.

The repository's license does not determine App Store pricing or replace
Apple's distribution requirements.

## What carries its own license

- **`mobile/`** is Shahi's MIT code. It was first generated from Expo's
  project template; [`mobile/LICENSE`](../mobile/LICENSE) keeps that template's
  MIT notice (650 Industries, Inc.) for whatever template-derived code remains,
  and points at the root license for the rest. It used to be the template's
  file alone, which made the product directory read as Expo's copyright.
- **OpenSSL 3.6.3** (Apache License 2.0) and **libssh2 1.11.0** (BSD
  3-Clause) are vendored as prebuilt binaries in
  `mobile/modules/ssh-tunnel/ios/` and linked into the iOS app for the SSH
  tunnel. Their upstream license texts, copied unchanged from the
  `openssl-3.6.3` and `libssh2-1.11.0` tags, are in
  [`mobile/modules/ssh-tunnel/licenses/`](../mobile/modules/ssh-tunnel/licenses/).
  OpenSSL ships no `NOTICE` file at that tag. Where the binaries came from is
  in [ssh.md](ssh.md#the-binaries).
- **Icons and marks.** The iOS app's interface icons are Lucide's (ISC;
  those Lucide took from Feather, such as check, info, server and terminal,
  are MIT). The agent marks both clients draw, in
  `shared/src/brand.ts`, come from Tabler (MIT: the pi) and Simple Icons.
  Simple Icons dedicates its artwork to the public domain (CC0 1.0) except
  where an icon records a licence of its own: GitHub Copilot's records MIT,
  from GitHub's Primer Octicons. All the path data is embedded, fetched once
  from Iconify. The marks are their owners' trademarks whatever the artwork's
  licence, and one needs a decision rather than a notice: Simple Icons
  withdrew OpenAI's mark in 16.0.0 ([simple-icons#13944][openai-removal])
  because OpenAI's brand terms say the permission they grant cannot be passed
  on. The copy in `brand.ts` predates that withdrawal; whether to keep drawing
  it is the owner's call under OpenAI's brand guidelines, not a licensing
  question this page can settle.
- **Fonts on the website.** getshahi.dev serves its own subsets of IBM Plex
  Sans and IBM Plex Mono (SIL Open Font License 1.1); the license is beside
  them in `site/public/fonts/LICENSE.txt`.
- **JavaScript and native modules.** React, React Native, Expo's modules
  (expo-router among them, with React Navigation's code inside it), the
  Software Mansion libraries and the rest carry their licences in their
  packages; almost all are MIT. What each client ships of them, and where it shows their notices,
  is below.

## Where someone with only the app finds the notices

**The iOS app** shows every notice under **Open-source licenses**: in
Settings, and as a link at the foot of the Connect screen, so someone who has
never connected a computer can read them too. The screen has three parts:

- *Built into the SSH connection*: OpenSSL 3.6.3 (Apache-2.0) and libssh2
  1.11.0 (BSD-3-Clause), the two libraries compiled into the binary for SSH.
  libssh2's licence asks a binary redistribution to "reproduce the above
  copyright notice … in the documentation and/or other materials provided
  with the distribution", and the header files that carry those notices are
  not in the IPA. The texts are the files in
  `mobile/modules/ssh-tunnel/licenses/`, unchanged, kept in
  `mobile/src/screens/licenses-text.ts` and pinned by `licenses.test.tsx`.
- *Icons and marks*: Lucide's LICENSE (with Feather's notice), Tabler's and
  Primer Octicons' MIT licences, and a statement naming Simple Icons and the
  marks' owners. Lucide's is in `licenses-text.ts`; the rest are in
  `shared/src/artwork-notices.ts`, beside the artwork, because the web client
  draws the same marks. Each file is the upstream one at a recorded tag,
  pinned by SHA-256 in `licenses.test.tsx` and `artwork-notices.test.ts`.
- *JavaScript and native modules*: every npm package whose code is in the App
  Store binary — 89 packages (react-is in two versions) and one library
  vendored inside expo-updates, sharing 44 distinct licence texts, so each
  text is shown once under the packages that share it.

That last list is generated, not kept by hand. `bun run notices:app`
(`scripts/app-notices.ts`) builds the production iOS bundle the way the
Xcode build does (`expo export:embed`) and takes every package named in its
source map, asks Expo's autolinking which native modules a release build
links (expo-updates and expo-splash-screen, for instance, have no JavaScript
in the bundle but are compiled in), and reads each package's own `LICENSE`,
`LICENCE`, `COPYING` and `NOTICE` files into
`mobile/src/screens/third-party-notices.json`. A licence file deeper
inside a shipped package — code copied in from elsewhere, or files for
another platform — has to be decided by a person in the script's `NESTED`
table, and the script stops on one nobody has decided: that is how
`expo-updates/vendor/bspatch` (BSD-2-Clause, compiled into the iOS binary by
the expo-updates podspec) is listed. Nine packages publish no licence file
at all (expo-router, expo-updates, `@expo/ui`, expo-structured-headers, four
`@react-native/*` packages, standard-navigation); they are listed with the
licence their package.json declares and the repository that holds it, not
with a text borrowed from somewhere else.

`scripts/third-party-notices.test.ts` keeps the file honest without
bundling the app. It walks every package reachable from
`mobile/package.json` through dependencies and installed peers — wider than
the bundle, so no package can reach the bundle without first appearing
there — and fails
when that set of versions differs from the one recorded, and when any listed
notice differs from the installed package's file. Either failure says to run
`bun run notices:app` and commit the result; the script takes about ten
seconds and needs no simulator. Measured on the production iOS bundle, the
notices and the screen add 68 KB of Hermes bytecode (4,604,757 to 4,672,792
bytes, 1.5%), 55 KB of it the generated list.

**The web client** publishes `third-party-notices.txt` beside itself, linked
from Settings, the sign-in page and the pairing page. `web/notices-build.ts`
writes it during every build from Vite's own module graph, so it lists what
that build contains — React, React Router, xterm.js, pdf.js, jsQR, the
`@noble` libraries, Vite's module-preload helpers — and cannot fall behind.
The service worker precaches it with the release, and the sidecar serves it
as `text/plain`; as the `application/octet-stream` it used to give unknown
extensions, under `nosniff`, a browser would download it rather than show it.

### Not yet covered

- **React Native's own native dependencies.** CocoaPods downloads Folly
  (Apache-2.0), glog and double-conversion (BSD-3-Clause), boost (BSL-1.0),
  fmt and fast_float, SocketRocket and Hermes as prebuilt frameworks while
  the app builds. They are in the binary but not in `node_modules`, so the
  generator cannot see them; like OpenSSL and libssh2 they would need their
  upstream texts added by hand, at the versions React Native pins.
- **Packages without a licence file** point at their repository rather than
  reproducing a notice. expo-router in particular carries React Navigation's
  source without React Navigation's notice; that omission is upstream's, but
  the app redistributes it.
- **Android**: the list is the iOS app's. An Android build would bundle a
  slightly different set and link different native code.

[openai-removal]: https://github.com/simple-icons/simple-icons/pull/13944
