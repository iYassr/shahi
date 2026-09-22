import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * plugin/bun.sh during `herdr plugin install` on a machine with no bun and no
 * `unzip` — a fresh Debian or Ubuntu. The pre-release review found it said
 * "Install bun by hand", which sends a person to bun's installer, which needs
 * the very `unzip` that was missing; the line that fixes it is the package
 * manager's.
 */
function installWithout(tools: string[], manager: string) {
  const dir = mkdtempSync(join(tmpdir(), "shahi-bunsh-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["curl", "unzip", "bash"].filter((t) => !tools.includes(t))) symlinkSync(Bun.which(tool) ?? `/usr/bin/${tool}`, join(bin, tool));
  writeFileSync(join(bin, manager), "#!/bin/sh\necho 'must not be run' >&2\nexit 99\n");
  chmodSync(join(bin, manager), 0o755);
  // The script also looks for bun at fixed paths; this machine's own bun must
  // not answer there, so the copy looks somewhere empty instead.
  const source = readFileSync(join(import.meta.dir, "bun.sh"), "utf8");
  const script = source.replace("/opt/homebrew/bin/bun /usr/local/bin/bun", `${dir}/none/bun ${dir}/none2/bun`);
  expect(script).not.toBe(source);
  writeFileSync(join(dir, "bun.sh"), script);
  const proc = Bun.spawnSync(["/bin/sh", join(dir, "bun.sh"), "--version"], {
    env: { PATH: bin, HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, said: proc.stderr.toString() };
}

test("a machine missing unzip is told the package-manager line, not to install bun by hand", () => {
  const { code, said } = installWithout(["unzip"], "apt-get");
  expect(code).toBe(1);
  expect(said).toContain("sudo apt-get install -y unzip");
  expect(said).toContain("herdr plugin install iYassr/shahi");
  expect(said).not.toContain("by hand");
  expect(said).not.toContain("must not be run");
});

test("every missing tool is named on the one line, in the machine's own manager", () => {
  const { said } = installWithout(["unzip", "curl"], "dnf");
  expect(said).toContain("sudo dnf install -y curl unzip");
  // Arch: `pacman -Sy` is a partial upgrade, which broke curl on the Arch VM.
  expect(installWithout(["unzip"], "pacman").said).toContain("sudo pacman -S --needed unzip");
});
