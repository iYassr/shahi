/**
 * Which herdr session a socket belongs to, and how to reach that herdr from
 * an ordinary shell.
 *
 * herdr puts the default session's socket at `<config root>/herdr/herdr.sock`
 * and a named session's at `<config root>/herdr/sessions/<name>/herdr.sock`,
 * where the config root is `XDG_CONFIG_HOME`, or `~/.config` without it
 * (measured on herdr 0.9.1, on macOS and Linux alike). One parser, used by
 * the live suite's guard and by every command the plugin prints.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface HerdrSession {
  configRoot: string;
  /** null for the default session. */
  name: string | null;
}

export function herdrSession(socket: string): HerdrSession | null {
  const named = /^(.*)\/herdr\/sessions\/([^/]+)\/herdr\.sock$/.exec(socket);
  if (named) return { configRoot: named[1]!, name: named[2]! };
  const plain = /^(.*)\/herdr\/herdr\.sock$/.exec(socket);
  return plain ? { configRoot: plain[1]!, name: null } : null;
}

const word = (value: string) => (/^[\w./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/**
 * `herdr`, as someone should type it in any terminal to reach the herdr that
 * owns `socket`. Every hint the plugin printed used to be a bare `herdr`,
 * which outside a session's own panes talks to the default session: for
 * someone running `herdr --session work` the printed commands failed with
 * server_not_running, or acted on another session, and "run `herdr` to
 * attach" started the default session, whose startup hook then took the
 * service away from `work` (pre-release bug hunt). A socket at no path herdr
 * would choose itself is named outright.
 */
export function herdrCli(socket: string | undefined, home = homedir()): string {
  if (!socket) return "herdr";
  const session = herdrSession(socket);
  if (!session) return `HERDR_SOCKET_PATH=${word(socket)} herdr`;
  const root = session.configRoot === join(home, ".config") ? "" : `XDG_CONFIG_HOME=${word(session.configRoot)} `;
  return `${root}herdr${session.name === null ? "" : ` --session ${word(session.name)}`}`;
}
