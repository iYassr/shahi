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
never connected a computer can read them too. The screen has four parts:

- *Built into the SSH connection*: OpenSSL 3.6.3 (Apache-2.0) and libssh2
  1.11.0 (BSD-3-Clause), the two libraries compiled into the binary for SSH.
  libssh2's licence asks a binary redistribution to "reproduce the above
  copyright notice … in the documentation and/or other materials provided
  with the distribution", and the header files that carry those notices are
  not in the IPA. The texts are the files in
  `mobile/modules/ssh-tunnel/licenses/`, unchanged, kept in
  `mobile/src/screens/licenses-text.ts` and pinned by `licenses.test.tsx`.
- *Native libraries React Native and Expo build in*: the native code CocoaPods
  fetches from outside `node_modules`, so the generated list below cannot
  see it. A Release build's `Podfile.lock`, link flags and embedded
  frameworks show what that is:

  | Library | Version | Licence | Carried by |
  | --- | --- | --- | --- |
  | Folly | 2024.11.18.00 | Apache-2.0 (no NOTICE at that tag) | ReactNativeDependencies.framework |
  | glog | 0.3.5 | BSD-3-Clause | ReactNativeDependencies.framework |
  | double-conversion | 1.1.6 | BSD-3-Clause | ReactNativeDependencies.framework |
  | {fmt} | 12.1.0 | MIT | ReactNativeDependencies.framework |
  | Boost | 1.84.0 | BSL-1.0 | ReactNativeDependencies.framework, headers only |
  | fast_float | 8.0.0 | MIT, one of its three | ReactNativeDependencies.framework |
  | SocketRocket | 0.7.1 | BSD-3-Clause | ReactNativeDependencies.framework |
  | Hermes | 250829098.0.17 | MIT, with parts under their own licences | hermesvm.framework |
  | ZXingObjC | 3.6.9 | Apache-2.0, with its NOTICE | ZXingObjC.framework, expo-camera's barcode scanning |
  | Reachability.swift | 5.2.4 | MIT | linked statically for expo-updates |

  Hermes is listed with what its symbols show is linked into it, each with
  its own file: LLVM's support library (`llvh`, Apache-2.0 with LLVM
  exceptions and the older NCSA licence, plus its System Interface Library's
  extra copyright), the regular-expression engine derived from libc++
  (NCSA or MIT), David Gay's dtoa and Unicode's ConvertUTF, whose notices
  exist only as comments at the top of their source files and are carried as
  those lines. What Hermes's repository also contains but hermesvm does not
  link (llvh's regex, MD5, xxhash and strlcpy, the wasm sandbox, asmjit, zip,
  Boost) is not listed. Each text is the upstream file at the tag the build
  used, kept in `mobile/src/screens/native-notices.ts` and pinned by SHA-256
  in `native-notices.test.ts`. That test also checks every version against
  the pin in `node_modules` that decides what a build downloads — React
  Native's podspecs and `helpers.rb`, `sdks/.hermesv1version`, expo-camera's
  `spm.config.json` — and fails when React Native adds a dependency podspec.
  ReachabilitySwift has no pin: expo-updates depends on it without a
  version, so CocoaPods takes the newest from its trunk, and only a
  `Podfile.lock` records which. That lock is generated with `mobile/ios` and
  not committed, so the test checks it when a local native build has left
  one, and is skipped otherwise. Separately,
  `scripts/third-party-notices.test.ts` reads every podspec the app's
  packages ship and fails on a dependency no `node_modules` package provides
  unless `EXTERNAL_PODS` in `native-notices.ts` says what became of it.
  Four such dependencies are not linked, for the reasons recorded there:
  sqlite3 (only with a Podfile property Shahi does not set), React-jsc
  (JavaScriptCore; Shahi runs Hermes), ExpoModulesTestCore (test specs) and
  ReactAppDependencyProvider (React Native's codegen output for Shahi's own
  app).

  Nothing was skipped as debug-only: the Debug and Release configurations
  link the same pods and embed the same frameworks. What a Release build
  leaves out are the debug builds of those same frameworks (Hermes's,
  React Native's and ZXingObjC's debug archives). The system's own libbz2 and
  libc++, which expo-updates and React Native link against, are part of iOS
  and not copied into the app.
- *Icons and marks*: Lucide's LICENSE (with Feather's notice), Tabler's and
  Primer Octicons' MIT licences, and a statement naming Simple Icons and the
  marks' owners. Lucide's is in `licenses-text.ts`; the rest are in
  `shared/src/artwork-notices.ts`, beside the artwork, because the web client
  draws the same marks. Each file is the upstream one at a recorded tag,
  pinned by SHA-256 in `licenses.test.tsx` and `artwork-notices.test.ts`.
- *JavaScript and native modules from npm*: every npm package whose code is in the App
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
bytes, 1.5%), 55 KB of it the generated list; the native libraries' notices
add another 61 KB (to 4,733,463 bytes), most of it LLVM's, Folly's and
ZXingObjC's Apache texts.

**The web client** publishes `third-party-notices.txt` beside itself, linked
from Settings, the sign-in page and the pairing page. `web/notices-build.ts`
writes it during every build from Vite's own module graph, so it lists what
that build contains — React, React Router, xterm.js, pdf.js, jsQR, the
`@noble` libraries, Vite's module-preload helpers — and cannot fall behind.
The service worker precaches it with the release, and the sidecar serves it
as `text/plain`; as the `application/octet-stream` it used to give unknown
extensions, under `nosniff`, a browser would download it rather than show it.

### Not yet covered

- **What is inside a prebuilt framework** is read off one Release build, not
  checked on every build. Hermes's list above comes from its symbols, and
  React Native's prebuilt dependencies from the configuration React Native
  builds them with. If a later Hermes links more of its repository, or a
  prebuilt framework starts carrying a library of its own, nothing here
  fails; the same check against the next Release build's frameworks would
  find it.
- **Packages without a licence file** point at their repository rather than
  reproducing a notice. expo-router in particular carries React Navigation's
  source without React Navigation's notice. No `@react-navigation` package,
  nor any copy of its licence, is in `node_modules` to take it from, and
  expo-router does not say which release it copied, so the text cannot be
  pinned to a version the way the others are. That omission is upstream's,
  but the app redistributes it.
- **Android**: the list is the iOS app's. An Android build would bundle a
  slightly different set and link different native code.

[openai-removal]: https://github.com/simple-icons/simple-icons/pull/13944
