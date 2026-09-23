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
- **Icons.** The app's chrome icons are Lucide (ISC); agent marks come from
  Simple Icons (CC0, brand marks belong to their owners) and Tabler (MIT). The
  path data is embedded in `mobile/src/components/icons.tsx`.
- **Fonts on the website.** getshahi.dev serves its own subsets of IBM Plex
  Sans and IBM Plex Mono (SIL Open Font License 1.1); the license is beside
  them in `site/public/fonts/LICENSE.txt`.
- **JavaScript dependencies** (React Native, Expo modules, React, the web
  client's libraries) carry their licenses in their packages; almost all are
  MIT.

## Where someone with only the app finds the notices

In the app: Settings → Open-source licenses reproduces the OpenSSL 3.6.3
(Apache-2.0) and libssh2 1.11.0 (BSD-3-Clause) texts in full — the two
libraries compiled into the binary for SSH, and the two whose licenses most
plainly require it: libssh2's asks a binary redistribution to "reproduce the
above copyright notice … in the documentation and/or other materials provided
with the distribution", and the header files that carry those notices are not
in the IPA. The screen's texts are the files in
`mobile/modules/ssh-tunnel/licenses/`, unchanged.

Not yet in the app: the icon sets' notices (Lucide ISC, Tabler MIT) and the
MIT/ISC notices of the JavaScript libraries bundled into the app. Those
licenses ask the same of their notices, so a public App Store build should
also list them; until then this page and the packages themselves are where
they are.
