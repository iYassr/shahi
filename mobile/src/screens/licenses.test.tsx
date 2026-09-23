import { render } from "@testing-library/react-native";
import { Licenses } from "./licenses";
import { LIBSSH2_COPYING, NOTICES, OPENSSL_LICENSE } from "./licenses-text";

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

test("the licenses screen shows every notice whole", () => {
  const view = render(<Licenses />);
  for (const notice of NOTICES) {
    expect(view.getByTestId(`license-${notice.name}`)).toBeTruthy();
    expect(view.getByText(notice.text)).toBeTruthy();
  }
});
