import { spawnSync } from "node:child_process";

/** Pass secrets over stdin, never shell text or process arguments. */
export function copyToClipboard(text: string): boolean {
  const commands = process.platform === "darwin"
    ? [["/usr/bin/pbcopy"]]
    : process.platform === "linux"
      ? [
          ...(process.env.WAYLAND_DISPLAY ? [["wl-copy", "--type", "text/plain"]] : []),
          ...(process.env.DISPLAY ? [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]] : []),
        ]
      : [];
  for (const [command, ...args] of commands) {
    const result = spawnSync(command!, args, {
      input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 2_000,
    });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}
