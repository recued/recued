/** D-210 — the `booking` work entity: storage round-trip + the two
 *  invariants that make it worth being its own kind.
 *
 *  ⚠ The first describe here is NOT about booking. `ensureWorkEntitySchema`
 *  is a bare sequence of `db.exec()` calls with no `Record<WorkEntityKind, _>`
 *  anywhere in it, so a kind added WITHOUT its `CREATE TABLE` block
 *  typechecks perfectly and fails at runtime on the first write. Every
 *  other per-kind surface has a compiler forcing function; this one has
 *  none, and that is exactly the [[declared_is_not_backed]] shape. The
 *  table-per-kind test is the forcing function. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_DEFAULT_LIFECYCLE_STATE,
  BOOKING_LIFECYCLE_STATES,
  WORK_ENTITY_KINDS,
  isWorkEntitySourceDeclarableKind,
  isWorkEntitySourceKind,
} from '@recued/contracts';

import {
  BOOKING_TABLE,
  WorkEntityValidationError,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd210-booking-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  store.registerSource({
    id: 'recued.booking',
    top_tier_kind: 'booking',
    source_kind: 'builtin',
    source_label: 'Recued built-in (bookings)',
    write_capable: true,
    mcp_exposed: false,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tableNames = (): string[] =>
  (db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as { name: string }[]).map((r) => r.name);

// ────────────────────────────────────────────────────────────────
// The forcing function the schema installer does not have
// ────────────────────────────────────────────────────────────────

describe('ensureWorkEntitySchema — every kind has a real table', () => {
  it('creates one table per WORK_ENTITY_KINDS member', () => {
    // Derived from the union, so the NEXT kind added without a
    // CREATE TABLE block fails here instead of at a user's first write.
    const tables = tableNames();
    for (const kind of WORK_ENTITY_KINDS) {
      expect(tables).toContain(`data_${kind}`);
    }
  });

  it('every kind table is actually writable, not merely present', () => {
    // ⚠ This REALLY WRITES. The first version only read `PRAGMA table_info`
    // and asserted three column names, which stayed green against a malformed
    // per-kind CHECK, a missing NOT NULL column, or an INSERT/param mismatch —
    // it proved the table existed, while its NAME claimed it worked.
    //
    // Insert the shared Source-row-identity columns only (every kind carries
    // them verbatim per § A.1.6), so this stays kind-agnostic and keeps
    // working for the NEXT kind without being taught its columns.
    for (const kind of WORK_ENTITY_KINDS) {
      const table = `data_${kind}`;
      const notNullCols = (db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as { name: string; notnull: number; dflt_value: string | null }[])
        .filter((c) => c.notnull === 1 && c.dflt_value === null && c.name !== 'id');
      // Fill every required column with a type-agnostic placeholder so the
      // insert exercises the real DDL rather than a guess about the shape.
      const cols = ['id', 'source_id', 'last_seen_at', ...notNullCols.map((c) => c.name)];
      const unique = [...new Set(cols)];
      const values = unique.map((c) =>
        c === 'id' ? `probe-${kind}` : c === 'source_id' ? 'probe-source' : 1,
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO ${table} (${unique.join(', ')}) `
            + `VALUES (${unique.map(() => '?').join(', ')})`,
          )
          .run(...values),
        `${table} rejected a minimal row`,
      ).not.toThrow();
      const back = db
        .prepare(`SELECT id FROM ${table} WHERE id = ?`)
        .get(`probe-${kind}`) as { id: string } | undefined;
      expect(back?.id, `${table} did not persist the row`).toBe(`probe-${kind}`);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(`probe-${kind}`);
    }
  });

  it('is idempotent across repeated installs', () => {
    ensureWorkEntitySchema(db);
    ensureWorkEntitySchema(db);
    expect(tableNames()).toContain(BOOKING_TABLE);
  });
});

// ────────────────────────────────────────────────────────────────
// Round-trip
// ────────────────────────────────────────────────────────────────

describe('booking storage round-trip', () => {
  it('writes and reads a booking back', () => {
    const written = store.writeBooking(
      {
        source_id: 'recued.booking',
        title: 'Table for two — 19:30',
        counterparty_contact_id: 'contact-1',
        monetary_value: { amount: '45.00', currency: 'EUR' },
        reception_record_id: 'req-1',
      },
      NOW,
    );
    const read = store.readBooking(written.id);
    expect(read).not.toBeNull();
    expect(read?.title).toBe('Table for two — 19:30');
    expect(read?.monetary_value).toEqual({ amount: '45.00', currency: 'EUR' });
    expect(read?.counterparty_contact_id).toBe('contact-1');
    expect(read?.reception_record_id).toBe('req-1');
  });

  it('is born confirmed — NOT the first member of the enum', () => {
    // The trap this pins: `pending` sorts first in
    // BOOKING_LIFECYCLE_STATES, so any `STATES[0]` default would make a
    // freshly-approved reservation look unconfirmed. The reception path
    // mints only at APPROVE, so the approval IS the confirmation.
    expect(BOOKING_LIFECYCLE_STATES[0]).toBe('pending');
    expect(BOOKING_DEFAULT_LIFECYCLE_STATE).toBe('confirmed');
    const b = store.writeBooking(
      { source_id: 'recued.booking', title: 'Cut & colour' },
      NOW,
    );
    expect(b.lifecycle_state).toBe('confirmed');
  });

  it('has NO calendar column at all — booking ⟂ calendar (A.2)', () => {
    // ⚠ RE-POINTED at slice 3c, deliberately not deleted. This test used to
    // assert `calendar_event_source_id` was absent FROM A WRITTEN ROW, which
    // was real while the column existed and is VACUOUS now that it does not —
    // `Object.hasOwn` for a field no type declares is false for free, and the
    // test would have gone on passing if the DDL grew the column back.
    //
    // So it now pins the thing 3c actually did, at the only layer that can
    // still regress: the TABLE. Matched by SUBSTRING, not by the old exact
    // name, because the way this comes back is someone wiring reception to a
    // calendar again and reaching for `calendar_event_id` or
    // `calendar_source_id` — a name-exact assertion would wave that through.
    //
    // The invariant: a reservation is ONE artifact. A pointer to a second is
    // what let the two drift, which is the defect A.2 removed.
    const columns = (db
      .prepare(`PRAGMA table_info(${BOOKING_TABLE})`)
      .all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('slot_start_at');
    expect(columns.filter((c) => c.includes('calendar'))).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────
  // D-210 A.2 slice 3 — the booking owns its own time
  // ──────────────────────────────────────────────────────────────

  it('round-trips its own slot', () => {
    const b = store.writeBooking(
      {
        source_id: 'recued.booking',
        title: 'Consult',
        slot_start_at: NOW,
        slot_end_at: NOW + 3_600_000,
      },
      NOW,
    );
    const read = store.readBooking(b.id);
    expect(read?.slot_start_at).toBe(NOW);
    expect(read?.slot_end_at).toBe(NOW + 3_600_000);
  });

  it('omits the slot pair entirely when no time is agreed', () => {
    // Absent must be ABSENT, not `undefined`-valued or 0: an un-timed
    // booking is a real state (an enquiry before a slot is picked), and a
    // consumer distinguishing "no time" from "midnight 1970" reads the KEY.
    const b = store.writeBooking(
      { source_id: 'recued.booking', title: 'Enquiry' },
      NOW,
    );
    expect(Object.hasOwn(b, 'slot_start_at')).toBe(false);
    expect(Object.hasOwn(b, 'slot_end_at')).toBe(false);
  });

  it('REFUSES a half-supplied slot, in both directions', () => {
    // Both-or-neither is the whole contract. A start with no end is not a
    // partly-known time, it is a corrupt one — and it would reach a reader
    // as a booking that starts and never finishes.
    expect(() =>
      store.writeBooking(
        { source_id: 'recued.booking', title: 'Start only', slot_start_at: NOW },
        NOW,
      ),
    ).toThrow(/together/i);
    expect(() =>
      store.writeBooking(
        { source_id: 'recued.booking', title: 'End only', slot_end_at: NOW },
        NOW,
      ),
    ).toThrow(/together/i);
    expect(store.countBookings()).toBe(0);
  });

  it('REFUSES an end at or before its start', () => {
    for (const end of [NOW, NOW - 1]) {
      expect(() =>
        store.writeBooking(
          {
            source_id: 'recued.booking',
            title: 'Backwards',
            slot_start_at: NOW,
            slot_end_at: end,
          },
          NOW,
        ),
      ).toThrow(/after/i);
    }
    expect(store.countBookings()).toBe(0);
  });

  it('keeps the slot columns queryable in SQL, not sealed in a blob', () => {
    // The A.3 reasoning applied to table_b: availability and "what is on
    // today" are SQL questions. A slot folded into an opaque field could
    // not answer them, which is why these are plain INTEGER columns.
    store.writeBooking(
      {
        source_id: 'recued.booking',
        title: 'Queryable',
        slot_start_at: NOW,
        slot_end_at: NOW + 1_800_000,
      },
      NOW,
    );
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${BOOKING_TABLE}
          WHERE slot_start_at >= @from AND slot_start_at < @to`,
      )
      .get({ from: NOW - 1, to: NOW + 1 }) as { n: number };
    expect(row.n).toBe(1);
  });

  it('lists, counts, and tombstones', () => {
    store.writeBooking({ source_id: 'recued.booking', title: 'One' }, NOW);
    const two = store.writeBooking(
      { source_id: 'recued.booking', title: 'Two' },
      NOW + 1,
    );
    expect(store.countBookings()).toBe(2);
    expect(store.listBookings().map((b) => b.title)).toEqual(['Two', 'One']);
    expect(store.findBooking((b) => b.title === 'One')?.title).toBe('One');

    expect(store.deleteBooking(two.id, { tombstone: true, now: NOW + 2 })).toBe(true);
    // Tombstoned rows leave the default (live-only) list but the row survives.
    expect(store.countBookings()).toBe(1);
    expect(store.readBooking(two.id)?.sync_state).toBe('tombstoned');
  });

  it('reaches the polymorphic readers by kind', () => {
    const b = store.writeBooking(
      { source_id: 'recued.booking', title: 'Polymorphic' },
      NOW,
    );
    expect(store.readByKind('booking', b.id)).toMatchObject({
      _kind: 'booking',
      title: 'Polymorphic',
    });
    expect(store.countByKind('booking')).toBe(1);
    expect(store.listByKind('booking').map((e) => e._kind)).toEqual(['booking']);
  });
});

// ────────────────────────────────────────────────────────────────
// Provenance — one booking per reception record, written once
// ────────────────────────────────────────────────────────────────

describe('booking provenance', () => {
  it('refuses a SECOND booking for the same reception record', () => {
    // `booking-create` mints a fresh uuid per call, so a retried or replayed
    // approve would otherwise mint a duplicate booking for one request —
    // duplicating the customer and the money. The DB is the backstop; the
    // mint path reads this row back as its idempotency anchor.
    store.writeBooking(
      { source_id: 'recued.booking', title: 'First', reception_record_id: 'req-1' },
      NOW,
    );
    expect(() =>
      store.writeBooking(
        { source_id: 'recued.booking', title: 'Duplicate', reception_record_id: 'req-1' },
        NOW + 1,
      ),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('still allows many bookings with NO reception record', () => {
    // The index is PARTIAL — an owner-authored booking has no provenance, and
    // a unique index over NULLs would have capped those at one.
    store.writeBooking({ source_id: 'recued.booking', title: 'Manual A' }, NOW);
    store.writeBooking({ source_id: 'recued.booking', title: 'Manual B' }, NOW + 1);
    expect(store.countBookings()).toBe(2);
  });

  it('never rewrites provenance on a later upsert', () => {
    // The dispatcher carries the old value forward, but the STORE is public.
    // A bare upsert naming a different record must not silently change which
    // visitor request this booking came from.
    const b = store.writeBooking(
      { source_id: 'recued.booking', title: 'Original', reception_record_id: 'req-1' },
      NOW,
    );
    store.writeBooking(
      {
        id: b.id,
        source_id: 'recued.booking',
        title: 'Edited',
        reception_record_id: 'req-2',
      },
      NOW + 1,
    );
    expect(store.readBooking(b.id)?.title).toBe('Edited');
    expect(store.readBooking(b.id)?.reception_record_id).toBe('req-1');
  });

  it('lets a booking that had none acquire one', () => {
    // First-write-wins must not mean never-write: a booking minted before its
    // provenance is known can still be stamped once.
    const b = store.writeBooking({ source_id: 'recued.booking', title: 'Later' }, NOW);
    store.writeBooking(
      { id: b.id, source_id: 'recued.booking', title: 'Later', reception_record_id: 'req-9' },
      NOW + 1,
    );
    expect(store.readBooking(b.id)?.reception_record_id).toBe('req-9');
  });
});

// ────────────────────────────────────────────────────────────────
// Money — both halves or neither, at BOTH layers
// ────────────────────────────────────────────────────────────────

describe('booking monetary_value', () => {
  it('refuses a malformed amount', () => {
    expect(() =>
      store.writeBooking(
        {
          source_id: 'recued.booking',
          title: 'Bad money',
          monetary_value: { amount: '45.000', currency: 'EUR' },
        },
        NOW,
      ),
    ).toThrow(WorkEntityValidationError);
  });

  it('refuses a non-ISO currency', () => {
    expect(() =>
      store.writeBooking(
        {
          source_id: 'recued.booking',
          title: 'Bad currency',
          monetary_value: { amount: '45.00', currency: 'euro' },
        },
        NOW,
      ),
    ).toThrow(WorkEntityValidationError);
  });

  it('enforces the pairing at the SQL layer too, not only in the validator', () => {
    // The validator can only see what goes through it. The CHECK is what
    // protects the row from a direct write, and a half-populated pair
    // would surface as a MonetaryValue with an empty currency.
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${BOOKING_TABLE}
             (id, title, lifecycle_state, state_changed_at, created_at, updated_at,
              monetary_amount, monetary_currency, source_id, last_seen_at,
              sync_state, conflict_policy)
           VALUES ('b-x', 'Half money', 'confirmed', ?, ?, ?, '45.00', NULL,
                   'recued.booking', ?, 'live', 'source_wins')`,
        )
        .run(NOW, NOW, NOW, NOW),
    ).toThrow(/CHECK constraint failed/i);
  });
});

// ────────────────────────────────────────────────────────────────
// Kind membership — where booking does and does not belong
// ────────────────────────────────────────────────────────────────

describe('booking kind membership', () => {
  it('is a work-entity source kind', () => {
    expect(isWorkEntitySourceKind('booking')).toBe(true);
  });

  it('is NOT vendor-declarable — bookings are Recued-local', () => {
    // A booking is minted when the owner approves a reservation through
    // their own door. There is no upstream vendor record to push to, so
    // it must never reach the Source mirror substrate. This is the
    // predicate the write executor refuses on.
    expect(isWorkEntitySourceDeclarableKind('booking')).toBe(false);
    expect(isWorkEntitySourceDeclarableKind('task')).toBe(true);
  });
});
