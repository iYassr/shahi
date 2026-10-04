/**
 * The one-line installer at https://getshahi.dev/install, for a computer that
 * may not have herdr yet (the owner, October 2026: "it automatically installs
 * herdr if not there"). install.sh is the script; herdr-pin.json is the herdr
 * it installs, by version and by the SHA-256 of each platform's binary, written
 * into the script here at build time so the script needs nothing to parse and
 * a pin changes only through a reviewed commit. The plugin stays the one way
 * Shahi itself is installed (docs/plugin.md); this only gets a computer to it.
 */
import pin from "./herdr-pin.json";

export const HERDR_PLATFORMS = ["macos-aarch64", "macos-x86_64", "linux-aarch64", "linux-x86_64"] as const;

export async function installScript(template?: string, herdr: typeof pin = pin): Promise<string> {
  const source = template ?? await Bun.file(new URL("./install.sh", import.meta.url)).text();
  const sha = herdr.sha256 as Record<string, string>;
  for (const platform of HERDR_PLATFORMS) {
    if (!/^[0-9a-f]{64}$/.test(sha[platform] ?? "")) throw new Error(`herdr-pin.json has no SHA-256 for ${platform}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(herdr.version)) throw new Error(`herdr-pin.json version "${herdr.version}" is not a version`);
  const script = source
    .replaceAll("__HERDR_VERSION__", herdr.version)
    .replaceAll("__SHA_MACOS_AARCH64__", sha["macos-aarch64"]!)
    .replaceAll("__SHA_MACOS_X86_64__", sha["macos-x86_64"]!)
    .replaceAll("__SHA_LINUX_AARCH64__", sha["linux-aarch64"]!)
    .replaceAll("__SHA_LINUX_X86_64__", sha["linux-x86_64"]!);
  if (/__[A-Z0-9_]+__/.test(script)) throw new Error("install.sh has a placeholder install.ts does not fill");
  return script;
}
