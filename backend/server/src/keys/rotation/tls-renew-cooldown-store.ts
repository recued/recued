/** Durable TLS-renewal cooldown clock.
 *
 *  ── Why this exists ────────────────────────────────────────────────
 *  The `tls-cert-renewal` housekeeping task has throttled itself since
 *  D-148 § A.6.5: a 30-day renewal window plus a 6-hour per-attempt cooldown
 *  carried in its own housekeeping cursor. The operator `tls.renew` rpc —
 *  Settings → Server → Certificates → "Renew now" — reached
 *  `RotationEngine.renewTls(...)` with NEITHER. The only thing between that
 *  button and Let's Encrypt was the engine's in-flight mutex, which releases
 *  the moment a renewal finishes, so repeat clicks issued repeat certificates.
 *
 *  The one throttle that did exist is cloud-side and the wrong shape for the
 *  binding constraint: `ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY` is 12 per
 *  publisher per DAY, while a CA's duplicate-certificate limit is counted per
 *  identical name set per WEEK. An operator could stay under the cloud ceiling
 *  all afternoon and still exhaust the weekly duplicate allowance for their
 *  own hostname — after which AUTOMATIC renewal fails too, until the window
 *  rolls off. Near expiry that is an outage, and a self-inflicted one.
 *
 *  ── Why a store rather than a field ────────────────────────────────
 *  🔑 THE POINT IS THAT BOTH CALLERS CONTEND ON ONE CLOCK. The housekeeping
 *  cursor could not serve: it is framework-owned scheduling state, keyed on
 *  the task, and the engine has no business reaching into it. A second
 *  in-memory counter on the engine would have been a SECOND clock — a manual
 *  renew would not defer the scheduler, and the two would disagree exactly
 *  when it matters. So the clock moves to the layer both callers already pass
 *  through, and it is durable because a cooldown a restart clears is a
 *  cooldown an impatient operator clears.
 *
 *  ── Shape ──────────────────────────────────────────────────────────
 *  One row, holding a DEADLINE (`not_before`) rather than a last-attempt
 *  timestamp. Storing the deadline keeps the anchoring rule — which differs
 *  between success and failure, see `renewTls` — at the single WRITE site;
 *  every reader then asks the one question `now < not_before` and cannot
 *  reimplement the rule differently. A reader that had to derive the deadline
 *  from `last_attempt_at` would need to know the rule too, and that is the
 *  shape that drifts.
 *
 *  Backed by `createSQLiteCollection` (auto-creates the table, no migration),
 *  mirroring `compromise-ledger-store.ts`. */

import type Database from 'better-sqlite3';

import { createSQLiteCollection } from '../../sqlite-collection.js';
import type { TlsRenewCooldownStore } from './index.js';

/** Single-row table; the key is a constant. */
const ROW_KEY = 'tls_private_key';

interface TlsRenewCooldownRecord {
  key: string;
  /** Unix-ms. A renewal attempted before this is refused `renew_cooldown`. */
  not_before: number;
  /** Unix-ms of the attempt that set `not_before`. Not read by the gate —
   *  carried so an operator reading the table (or a future Key Health
   *  "next renewal available at" line) can tell a cooldown set by a
   *  successful staged rotation from one set by a failed attempt. */
  set_at: number;
  /** `'success' | 'failure'` — same reason as `set_at`. */
  outcome: string;
}

export const createSqliteTlsRenewCooldownStore = (
  db: Database.Database,
): TlsRenewCooldownStore => {
  const col = createSQLiteCollection<TlsRenewCooldownRecord>(
    db,
    'tls_renew_cooldown',
  );
  return {
    async readNotBefore() {
      const row = await col.get(ROW_KEY);
      // Absent ⇒ 0 ⇒ never throttled. First renewal after a fresh install
      // must always be allowed through.
      return row?.not_before ?? 0;
    },
    async writeNotBefore({ not_before, set_at, outcome }) {
      await col.set(ROW_KEY, { key: ROW_KEY, not_before, set_at, outcome });
    },
  };
};

/** In-memory variant for tests + dbless subcommands. Mirrors the SQLite
 *  behaviour exactly, including the absent ⇒ 0 default. */
export const createInMemoryTlsRenewCooldownStore = (): TlsRenewCooldownStore => {
  let notBefore = 0;
  return {
    async readNotBefore() {
      return notBefore;
    },
    async writeNotBefore({ not_before }) {
      notBefore = not_before;
    },
  };
};
