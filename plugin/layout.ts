/**
 * Where everything lives, derived from what herdr injects.
 *
 * Three directories, and the distinction is herdr's, not ours: the plugin
 * root is a managed checkout that a reinstall replaces, so nothing that must
 * survive an update goes there. Secrets go in the config directory, which the
 * user may edit; the database and the log go in the state directory.
 */
import { join } from "node:path";

export interface Layout {
  /** The checkout: working directory of the sidecar, home of `web/dist`. */
  root: string;
  configDir: string;
  stateDir: string;
  /** Secrets, and any override of PORT or HOST. */
  envFile: string;
  /** SQLite: transcripts, paired devices, push subscriptions, server identity. */
  dataPath: string;
  logPath: string;
  webRoot: string;
  /** The herdr this plugin was started by — a named session gets its own. */
  socketPath: string;
}

const REQUIRED = ["HERDR_PLUGIN_ROOT", "HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR", "HERDR_SOCKET_PATH"] as const;

export function layoutFromEnv(env: NodeJS.ProcessEnv = process.env): Layout {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(
      `${missing.join(", ")} not set. This runs inside herdr — ` +
        "as the plugin's startup hook, or via `herdr plugin action invoke shahi.<action>`.",
    );
  }
  const root = env.HERDR_PLUGIN_ROOT!;
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR!;
  const stateDir = env.HERDR_PLUGIN_STATE_DIR!;
  return {
    root,
    configDir,
    stateDir,
    envFile: join(configDir, ".env"),
    dataPath: join(stateDir, "shahi.sqlite"),
    logPath: join(stateDir, "shahi.log"),
    webRoot: join(root, "web", "dist"),
    socketPath: env.HERDR_SOCKET_PATH!,
  };
}
