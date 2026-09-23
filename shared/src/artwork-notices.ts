/**
 * Notices for the third-party artwork in brand.ts, which both clients draw.
 *
 * The agent marks come from Iconify's copies of three sets, fetched once and
 * embedded (see mobile/src/components/icons.tsx for why). Two of them ask for
 * their notice to travel with every copy, and before the September 2026
 * pre-release review (F27) neither client carried it:
 *
 *  - Tabler Icons (MIT): the pi mark.
 *  - Primer Octicons (MIT): GitHub Copilot's mark. Simple Icons redistributes
 *    it, and its data records the licence as MIT from GitHub's Primer.
 *
 * The rest come from Simple Icons, which dedicates its artwork to the public
 * domain (CC0 1.0), so no notice is owed. It is named anyway, with what it
 * cannot waive: the marks are their owners' trademarks. OpenAI's is one
 * Simple Icons withdrew in 16.0.0 (simple-icons#13944) because OpenAI's brand
 * terms do not let the permission they grant be passed on; see
 * docs/licensing.md.
 *
 * Texts are the upstream files verbatim, never retyped: Tabler's LICENSE at
 * v3.48.0 and Octicons' at @primer/octicons@19.38.0. artwork-notices.test.ts
 * pins their SHA-256.
 */
export interface ArtworkNotice {
  name: string;
  license: string;
  /** Which of the app's images this covers. */
  covers: string;
  text: string;
}

export const TABLER_LICENSE = `MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export const OCTICONS_LICENSE = `MIT License

Copyright (c) 2026 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export const SIMPLE_ICONS_NOTICE = `The agent marks for Claude Code, OpenAI, Cursor, OpenCode, Google Gemini and
GitHub Copilot are from Simple Icons (https://simpleicons.org). Simple Icons
releases its artwork under CC0 1.0 Universal, except where an icon records a
licence of its own; GitHub Copilot's records MIT, and its notice is above.

Each mark is a trademark of its owner. It is shown only to say which agent is
running, and does not suggest that the owner endorses or is affiliated with
Shahi.
`;

export const ARTWORK_NOTICES: ArtworkNotice[] = [
  { name: "Tabler Icons", license: "MIT", covers: "The pi mark", text: TABLER_LICENSE },
  { name: "Primer Octicons", license: "MIT", covers: "GitHub Copilot’s mark", text: OCTICONS_LICENSE },
  { name: "Simple Icons", license: "CC0-1.0", covers: "The other agent marks", text: SIMPLE_ICONS_NOTICE },
];
