import { render } from "@testing-library/react-native";
import { ARTWORK, Licenses, licenseRows, PACKAGES, textRows, type Row } from "./licenses";
import { LIBSSH2_COPYING, LUCIDE_LICENSE, NOTICES, OPENSSL_LICENSE } from "./licenses-text";

jest.mock("expo-router", () => ({ Stack: { Screen: () => null } }));

/*
 * The App Store binary redistributes OpenSSL and libssh2, whose licenses ask
 * for their notices to travel with it; before this screen they did not
 * (September 2026 review). The texts are pinned by hash to the upstream files,
 * and the versions to the libraries actually vendored, so a library update
 * cannot ship with the previous release's notice.
 */
// Node's own modules, which the app's type configuration does not describe.
declare const __dirname: string;
const { createHash } = require("node:crypto") as { createHash(algorithm: "sha256"): { update(text: string): { digest(encoding: "hex"): string } } };
const { readFileSync } = require("node:fs") as { readFileSync(path: string, encoding: "utf8"): string };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const header = (path: string) => readFileSync(`${__dirname}/../../modules/ssh-tunnel/ios/${path}`, "utf8");
const opensslHeaders = ["ios-arm64", "ios-arm64_x86_64-simulator"].map((slice) =>
  header(`OpenSSL.xcframework/${slice}/OpenSSL.framework/Headers/opensslv.h`));
const define = (source: string, name: string) => source.match(new RegExp(`#\\s*define ${name}\\s+"?([^"\\s]+)"?`))?.[1];

test("the app carries OpenSSL's and libssh2's license files word for word", () => {
  // OpenSSL 3.6.3's LICENSE.txt and libssh2 1.11.0's COPYING, as released.
  expect(sha256(OPENSSL_LICENSE)).toBe("7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a");
  expect(sha256(LIBSSH2_COPYING)).toBe("fda5e2522c58ba1f31c9f2044747616457466f4aebec16ade4af86e3a16a8e02");
});

test("the app carries Lucide's license file, Feather's notice included, word for word", () => {
  // lucide-icons/lucide's LICENSE at tag 1.47.0: its ISC notice, then the MIT
  // notice for the icons it took from Feather — check, info, server, terminal.
  expect(sha256(LUCIDE_LICENSE)).toBe("b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57");
});

test("the notices name the library versions the app actually links", () => {
  const openssl = NOTICES.find((n) => n.name === "OpenSSL")!;
  for (const source of opensslHeaders) {
    expect(["MAJOR", "MINOR", "PATCH"].map((part) => define(source, `OPENSSL_VERSION_${part}`)).join(".")).toBe(openssl.version);
    expect(source).toContain(` * ${openssl.copyright}\n`);
  }
  const libssh2 = NOTICES.find((n) => n.name === "libssh2")!;
  for (const slice of ["ios-arm64", "ios-arm64-simulator"]) {
    expect(define(header(`libssh2.xcframework/${slice}/Headers/libssh2.h`), "LIBSSH2_VERSION")).toBe(libssh2.version);
  }
});

/** A notice's rows put back together: paragraphs apart, lines within them. */
function shown(rows: Row[], key: string) {
  return rows.flatMap((row) => row.kind === "text" && row.key.startsWith(`${key}:`) ? [row] : [])
    .map((row, index) => `${index && row.paragraph ? "\n\n" : index ? "\n" : ""}${row.text}`).join("");
}
/** The same text with each run of blank lines as one, which is all a row drops. */
const paragraphs = (text: string) => text.replace(/^\s*\n/, "").trimEnd().replace(/\n(?:[ \t]*\n)+/g, "\n\n");

test("the licenses screen shows every notice whole", () => {
  const rows = licenseRows();
  for (const notice of NOTICES) expect(shown(rows, `ssh:${notice.name}`)).toBe(paragraphs(notice.text));
  for (const notice of ARTWORK) expect(shown(rows, `art:${notice.name}`)).toBe(paragraphs(notice.text));
  PACKAGES.texts.forEach((text, index) => expect(shown(rows, `package:${index}`)).toBe(paragraphs(text)));
});

test("every package the app ships is named above its notice, with its version and license", () => {
  const titles = licenseRows().flatMap((row) => row.kind === "title" ? [row] : []);
  expect(PACKAGES.packages.length).toBeGreaterThan(80);
  for (const pkg of PACKAGES.packages) {
    const title = titles.find((row) => row.key === `package:${pkg.text ?? `${pkg.name}@${pkg.version}`}`)!;
    expect(title.meta[0]!.split(", ")).toContain(`${pkg.name} ${pkg.version}`);
    expect(title.meta[1]!.split(", ")).toContain(pkg.license);
  }
  // A package that ships no license file says so, and where its license is,
  // instead of borrowing someone else's text.
  const bare = PACKAGES.packages.filter((pkg) => pkg.text === null);
  for (const pkg of bare) {
    expect(pkg.note).toMatch(/includes no licence file/);
    expect(licenseRows()).toContainEqual(expect.objectContaining({ kind: "text", text: pkg.note, mono: false }));
  }
});

test("a long license is drawn a dozen lines at a time, so large text never makes one giant view", () => {
  // At accessibility sizes the Apache License as one Text would be a single
  // view tens of thousands of points tall; rows keep each view short.
  const lines = licenseRows().flatMap((row) => row.kind === "text" ? [row.text.split("\n").length] : []);
  expect(Math.max(...lines)).toBeLessThanOrEqual(12);
  expect(textRows("x", "a\n\n\n  b\n   \nc")).toEqual([
    { kind: "text", key: "x:0:0", text: "a", mono: true, paragraph: true },
    { kind: "text", key: "x:1:0", text: "  b", mono: true, paragraph: true },
    { kind: "text", key: "x:2:0", text: "c", mono: true, paragraph: true },
  ]);
});

test("the licenses screen opens on the SSH notices, with every row in its list", () => {
  const view = render(<Licenses />);
  expect(view.getByTestId("licenses-ssh")).toBeTruthy();
  expect(view.getByTestId("license-OpenSSL")).toBeTruthy();
  expect(view.getByTestId("licenses-list").props.data).toEqual(licenseRows());
  for (const section of ["licenses-ssh", "licenses-artwork", "licenses-packages"]) {
    expect(licenseRows()).toContainEqual(expect.objectContaining({ kind: "section", testID: section }));
  }
});
