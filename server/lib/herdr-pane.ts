/**
 * What herdr says about one pane, read the way it holds true.
 *
 * Part of the herdr adapter: the fields here do not mean what their names
 * suggest on their own, and every reader of them should go through this module
 * rather than rediscover that.
 */
import type { Database } from "bun:sqlite";
import type { PaneInfo } from "./herdr-schema";

/**
 * The session of the agent running in the pane now, or null.
 *
 * herdr keeps a pane's `agent_session` after the agent that reported it is
 * gone. Found in the pre-release bug hunt on herdr 0.9.1: restart herdr with
 * `resume_agents_on_restore = false`, or with an agent the restarted server
 * cannot find on its PATH (one installed through nvm), and the pane comes back
 * as a shell with `agent: null` and the old conversation's `agent_session`
 * still on it. Read on its own, that field served the dead conversation in the
 * reader and in the dashboard preview, with "Reply to this agent…" beneath it,
 * and the reply was typed into the shell as a command. A session counts only
 * while herdr reports the same agent running in the pane.
 */
export function agentSessionOf(pane: Pick<PaneInfo, "agent" | "agent_session"> | undefined): string | null {
  const session = pane?.agent_session;
  return pane?.agent && session?.agent === pane.agent ? session.value : null;
}

/**
 * Which run of a program holds each pane id: its occupancy.
 *
 * herdr reuses pane ids. Measured on 0.9.1 in the pre-release bug hunt: ids
 * only grow within one run of herdr, but its workspace counter is not saved,
 * so after a restart a new workspace takes the id of the highest one closed
 * before it (close w3, restart, create: w3 again, and w3:p1 with it), and
 * every named session starts at w1:p1. Whatever was kept under a pane id alone
 * followed the id to its next holder: a draft typed for one conversation
 * appeared in another and a retried send was typed into a new shell, recorded
 * terminal history from another session was served as this pane's, and a pin
 * and a notification landed on the wrong conversation.
 *
 * `terminal_id` is herdr's name for the terminal a pane runs, and changes with
 * it: a new pane gets a new one, and so does every pane herdr restores after a
 * restart (measured: `term_65c4caf4b3a401` came back as `term_65c4cb03418da1`).
 * It is derived from the time, so it does not repeat across restarts or
 * sessions. An occupancy is named by the terminal id it began with.
 *
 * That alone would make every restart replace every occupant, which is wrong
 * for an agent: with `resume_agents_on_restore`, herdr's default, the restored
 * pane runs the same conversation, and it is the conversation someone pinned
 * or was told about. herdr restores such a pane with its agent and session
 * already set (measured: the first snapshot after the restart carried both),
 * and a new pane that took a closed pane's id never begins with another
 * conversation's session. So a new terminal continues the occupancy exactly
 * when it runs the agent and session the pane last ran. Anything else is a new
 * occupant, a restored shell included: it has no session to prove it is the
 * same, and starting it afresh is the safe mistake.
 *
 * Kept in the sidecar's database, because every herdr start restarts the
 * sidecar too (the startup hook reinstalls its service), and the comparison
 * needs what the pane held before that.
 */
export class PaneInstances {
  readonly #byPane = new Map<string, Occupancy>();
  readonly #db: Database | undefined;

  constructor(db?: Database) {
    this.#db = db;
    if (!db) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS pane_occupancy (
        pane_id  TEXT PRIMARY KEY,
        instance TEXT NOT NULL,
        terminal TEXT NOT NULL,
        agent    TEXT,
        session  TEXT
      )
    `);
    for (const row of db.query<Occupancy & { pane_id: string }, []>("SELECT pane_id, instance, terminal, agent, session FROM pane_occupancy").all()) {
      this.#byPane.set(row.pane_id, { instance: row.instance, terminal: row.terminal, agent: row.agent, session: row.session });
    }
  }

  /** The pane's occupancy, or undefined for a pane herdr has not reported with a terminal. */
  of(paneId: string): string | undefined {
    return this.#byPane.get(paneId)?.instance;
  }

  /** Brings the record up to date with every pane herdr reports now, and forgets the rest. */
  observe(panes: readonly PaneInfo[]): void {
    const live = new Set<string>();
    const changed: [string, Occupancy][] = [];
    for (const pane of panes) {
      live.add(pane.pane_id);
      // Every pane on protocol 22 has one; a report without it has nothing to
      // name an occupant by, and a client then keys by pane id as before.
      if (!pane.terminal_id) continue;
      const held = this.#byPane.get(pane.pane_id);
      const session = agentSessionOf(pane);
      let next: Occupancy;
      if (held?.terminal === pane.terminal_id) {
        // The last session seen, not the current one: a pane whose agent
        // flickers out of detection must still be recognised when herdr
        // restores it.
        if (session === null || (held.agent === pane.agent && held.session === session)) continue;
        next = { ...held, agent: pane.agent ?? null, session };
      } else {
        const resumed = held !== undefined && session !== null && held.agent === pane.agent && held.session === session;
        next = { instance: resumed ? held.instance : pane.terminal_id, terminal: pane.terminal_id, agent: session ? pane.agent ?? null : null, session };
      }
      this.#byPane.set(pane.pane_id, next);
      changed.push([pane.pane_id, next]);
    }
    const gone = [...this.#byPane.keys()].filter((paneId) => !live.has(paneId));
    for (const paneId of gone) this.#byPane.delete(paneId);
    const db = this.#db;
    if (!db || (changed.length === 0 && gone.length === 0)) return;
    const upsert = db.prepare(
      `INSERT INTO pane_occupancy (pane_id, instance, terminal, agent, session) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pane_id) DO UPDATE SET instance = excluded.instance, terminal = excluded.terminal, agent = excluded.agent, session = excluded.session`,
    );
    const remove = db.prepare("DELETE FROM pane_occupancy WHERE pane_id = ?");
    db.transaction(() => {
      for (const [paneId, o] of changed) upsert.run(paneId, o.instance, o.terminal, o.agent, o.session);
      for (const paneId of gone) remove.run(paneId);
    })();
  }
}

interface Occupancy {
  instance: string;
  terminal: string;
  /** The agent and session last seen running in this terminal, for recognising it when herdr restores it. */
  agent: string | null;
  session: string | null;
}
