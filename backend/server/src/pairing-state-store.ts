/** `server_config`-backed persistence for the pairing code.
 *
 *  ⛔ THIS EXISTS BECAUSE THE CODE USED TO BE PER-PROCESS. `/auth/pair` verifies
 *  against the RUNNING server's manager, so `recued pair` — a separate,
 *  short-lived process — was minting a code the server had never heard of and
 *  would reject. A correct-looking code that fails at the door, with nothing on
 *  either side explaining it. And a live server had no way to replace a burnt or
 *  expired code at all: `refreshCode` had one caller, that same CLI, and no rpc
 *  reached it.
 *
 *  One row, shared by both processes, fixes both.
 *
 *  ⚠ Not a new class of secret at rest. `server_config` already carries
 *  `realm_token`, a long-lived bearer; this is a short-lived single-use code
 *  beside it, readable only by someone who can already read that token and the
 *  warehouse. The alternative design — a loopback-gated refresh endpoint — is
 *  actively worse for this product: behind a tunnel that terminates locally
 *  (the Cloudflare Tunnel posture recommended for demo/review servers) every
 *  remote request arrives as loopback, so the gate would admit the internet.
 */

import type Database from 'better-sqlite3';

import type { PairingState, PairingStateStore } from './pairing.js';

const KEY = 'pairing_state';

const isPairingState = (v: unknown): v is PairingState =>
  typeof v === 'object' && v !== null
  && typeof (v as PairingState).code === 'string'
  && typeof (v as PairingState).created_at === 'number'
  && typeof (v as PairingState).expires_at === 'number'
  && typeof (v as PairingState).consumed === 'boolean';

export const createPairingStateStore = (db: Database.Database): PairingStateStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const readStmt = db.prepare(`SELECT value FROM server_config WHERE key = ?`);
  const writeStmt = db.prepare(
    `INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`,
  );
  return {
    read() {
      const row = readStmt.get(KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        const parsed: unknown = JSON.parse(row.value);
        // A malformed row mints a fresh code rather than wedging a boot — the
        // cost of a bad row is one re-pair, the cost of throwing is no server.
        return isPairingState(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write(state) {
      writeStmt.run(KEY, JSON.stringify(state));
    },
  };
};
