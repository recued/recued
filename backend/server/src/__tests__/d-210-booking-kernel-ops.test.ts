/** D-210 — the `booking` kernel op surface, driven end-to-end.
 *
 *  ⚠ WHY THIS EXISTS AS AN INTEGRATION TEST, not a unit one.
 *
 *  The booking dispatchers reach the kernel adapter through a SPREAD:
 *  `...(deps.workEntityDispatchers ?? {})` in `wire-executor-config.ts`,
 *  `satisfies KernelDispatchers`. TypeScript's excess-property check does NOT
 *  apply to a spread, so a key mismatch across that seam is silently dropped
 *  and the slug arm throws `SERVER_NOT_REACHABLE` for every caller.
 *
 *  Measured, because the two sides are NOT equally protected:
 *    - Renaming the PRODUCER key (`createWorkEntityDispatchers`) reds tsc — but
 *      only incidentally, because `work-entity-crud-handler` derives its type
 *      from that same return shape and references the key directly.
 *    - Renaming the CONSUMER field (`KernelDispatchers` in `kernel.ts`) leaves
 *      backend tsc at ZERO errors and breaks every booking dispatch. Nothing
 *      but this test sees it.
 *
 *  A call site is not a wired seam; only driving the real adapter over the real
 *  dispatchers proves the names meet.
 *
 *  This also pins the op-registry ↔ manifest ↔ slug-arm triangle: an op with no
 *  manifest is unreachable, and a manifest with no arm throws
 *  INGREDIENT_NOT_FOUND. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelAdapter } from '@recued/ingredients';
import {
  KERNEL_OP_REGISTRY,
  kernelOpBackingSlug,
  type Booking,
} from '@recued/contracts';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let adapter: ReturnType<typeof createKernelAdapter>;

/** ⚠ A CONTROLLABLE clock, not `Date.now()`.
 *
 *  With the real clock this suite's `state_changed_at` assertions PASSED
 *  against a deliberately broken dispatcher (`state_changed_at: now`
 *  unconditionally): create and update both landed in the same millisecond, so
 *  "preserved" and "re-stamped" produced identical values and the test proved
 *  nothing. The mutation survived until the clock was made to move.
 *  [[feedback_fixture_value_coincidence_masks_field_confusion]] */
let clock = 1_700_000_000_000;
const advance = (ms: number): void => {
  clock += ms;
};

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'write' as const,
  input,
  output: {},
  manifest_version: 1,
});

const BOOKING_OPS = [
  'core.work-entity.booking.create',
  'core.work-entity.booking.update',
  'core.work-entity.booking.delete',
] as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd210-booking-ops-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  store.registerSource({
    id: 'recued.booking',
    top_tier_kind: 'booking',
    source_kind: 'builtin',
    source_label: 'Recued built-in (bookings)',
    write_capable: true,
  });
  // The SAME composer production uses — a hand-rolled dispatcher object here
  // would prove nothing about what actually ships.
  clock = 1_700_000_000_000;
  const dispatchers = createWorkEntityDispatchers({
    store,
    resolver: createWorkEntityResolver(store),
    now: () => clock,
  });
  adapter = createKernelAdapter(dispatchers);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// The triangle: op ↔ manifest ↔ slug arm
// ────────────────────────────────────────────────────────────────

describe('booking op surface is complete', () => {
  it('every booking op is registered and names a backing slug', () => {
    for (const op of BOOKING_OPS) {
      const entry = KERNEL_OP_REGISTRY.find((e) => e.op === op);
      expect(entry, op).toBeDefined();
      expect(kernelOpBackingSlug(op), op).toBeDefined();
    }
  });

  it('every backing slug has a manifest — an op without one is unreachable', () => {
    for (const op of BOOKING_OPS) {
      const slug = kernelOpBackingSlug(op)!;
      const manifest = KERNEL_MANIFESTS.find((m) => m.slug === slug);
      expect(manifest, slug).toBeDefined();
      expect(manifest?.kind).toBe('storage');
    }
  });

  it('delete is destructive; create/update are write', () => {
    const risk = (op: string) => KERNEL_OP_REGISTRY.find((e) => e.op === op)?.risk;
    expect(risk('core.work-entity.booking.create')).toBe('write');
    expect(risk('core.work-entity.booking.update')).toBe('write');
    expect(risk('core.work-entity.booking.delete')).toBe('destructive');
  });
});

// ────────────────────────────────────────────────────────────────
// The wiring the spread cannot typecheck
// ────────────────────────────────────────────────────────────────

describe('booking slugs dispatch through the real kernel adapter', () => {
  it('booking-create mints a row and stamps it canonically', async () => {
    const out = (await adapter(
      mkCall('booking-create', {
        title: 'Dinner for four',
        monetary_value: { amount: '120.00', currency: 'EUR' },
        counterparty_contact_id: 'contact-9',
      }),
    )) as { booking: Booking & { _id: string; _collection: string } };

    expect(out.booking.title).toBe('Dinner for four');
    // The kernel adapter's stamping discipline — recipes read `_collection`
    // to dispatch on kind, so a wrong stamp routes the row to the wrong
    // consumer while looking perfectly healthy.
    expect(out.booking._collection).toBe('booking');
    expect(out.booking._id).toBe(out.booking.id);
    // Born confirmed, not `BOOKING_LIFECYCLE_STATES[0]`.
    expect(out.booking.lifecycle_state).toBe('confirmed');
    // And it really landed in storage, not just in the return value.
    expect(store.readBooking(out.booking.id)?.title).toBe('Dinner for four');
  });

  it('booking-update moves the lifecycle and re-stamps state_changed_at', async () => {
    const created = (await adapter(
      mkCall('booking-create', { title: 'Haircut' }),
    )) as { booking: Booking };

    advance(60_000);
    const moved = (await adapter(
      mkCall('booking-update', { id: created.booking.id, lifecycle_state: 'no_show' }),
    )) as { booking: Booking };

    expect(moved.booking.lifecycle_state).toBe('no_show');
    // STRICTLY greater — `toBeGreaterThanOrEqual` would pass on a dispatcher
    // that never re-stamps at all.
    expect(moved.booking.state_changed_at).toBeGreaterThan(
      created.booking.state_changed_at,
    );
    expect(store.readBooking(created.booking.id)?.lifecycle_state).toBe('no_show');
  });

  it('a metadata-only update does NOT re-stamp state_changed_at', async () => {
    // `state_changed_at` must keep meaning "when this booking reached its
    // current state". If a title edit moved it, "when did this become a
    // no-show?" silently becomes "when was it last touched".
    const created = (await adapter(
      mkCall('booking-create', { title: 'Before' }),
    )) as { booking: Booking };

    advance(60_000);
    const renamed = (await adapter(
      mkCall('booking-update', { id: created.booking.id, title: 'After' }),
    )) as { booking: Booking };

    expect(renamed.booking.title).toBe('After');
    // The clock HAS moved, so this only holds if the dispatcher genuinely
    // preserved the old stamp rather than writing `now`.
    expect(renamed.booking.state_changed_at).toBe(created.booking.state_changed_at);
    expect(renamed.booking.updated_at).toBeGreaterThan(created.booking.updated_at);
  });

  // ──────────────────────────────────────────────────────────────
  // D-210 A.2 slice 3 — rescheduling is a PAIR move
  // ──────────────────────────────────────────────────────────────

  it('booking-update reschedules when both slot fields move together', async () => {
    const created = (await adapter(
      mkCall('booking-create', {
        title: 'Consult',
        slot_start_at: 1_700_000_000_000,
        slot_end_at: 1_700_003_600_000,
      }),
    )) as { booking: Booking };
    expect(created.booking.slot_start_at).toBe(1_700_000_000_000);

    const moved = (await adapter(
      mkCall('booking-update', {
        id: created.booking.id,
        slot_start_at: 1_700_007_200_000,
        slot_end_at: 1_700_010_800_000,
      }),
    )) as { booking: Booking };

    expect(moved.booking.slot_start_at).toBe(1_700_007_200_000);
    expect(moved.booking.slot_end_at).toBe(1_700_010_800_000);
  });

  it('booking-update REFUSES a half-supplied slot rather than silently resizing', async () => {
    // 🔑 The failure this exists to stop is SILENT, not loud. With plain
    // `?? existing` preserve-on-omit, moving only the start against a kept
    // end turns a 60-minute booking into a 30-minute one and reports
    // success — the owner sees a confirmed booking of the wrong length and
    // the customer is told the wrong finish time.
    const created = (await adapter(
      mkCall('booking-create', {
        title: 'Sixty minutes',
        slot_start_at: 1_700_000_000_000,
        slot_end_at: 1_700_003_600_000,
      }),
    )) as { booking: Booking };

    await expect(
      adapter(
        mkCall('booking-update', {
          id: created.booking.id,
          slot_start_at: 1_700_001_800_000,
        }),
      ),
    ).rejects.toThrow(/together|reschedule/i);

    // And the refusal is TOTAL — the row still holds its original hour.
    const after = (await adapter(
      mkCall('booking-update', { id: created.booking.id, title: 'Untouched' }),
    )) as { booking: Booking };
    expect(after.booking.slot_start_at).toBe(1_700_000_000_000);
    expect(after.booking.slot_end_at).toBe(1_700_003_600_000);
  });

  it('an omitted slot is preserved, exactly like every other field', async () => {
    const created = (await adapter(
      mkCall('booking-create', {
        title: 'Keeps its time',
        slot_start_at: 1_700_000_000_000,
        slot_end_at: 1_700_003_600_000,
      }),
    )) as { booking: Booking };

    const patched = (await adapter(
      mkCall('booking-update', { id: created.booking.id, title: 'Renamed' }),
    )) as { booking: Booking };

    expect(patched.booking.slot_start_at).toBe(1_700_000_000_000);
    expect(patched.booking.slot_end_at).toBe(1_700_003_600_000);
  });

  it('an omitted field is preserved, not cleared', async () => {
    const created = (await adapter(
      mkCall('booking-create', {
        title: 'Keeps its money',
        monetary_value: { amount: '80.00', currency: 'GBP' },
        counterparty_contact_id: 'contact-3',
      }),
    )) as { booking: Booking };

    const patched = (await adapter(
      mkCall('booking-update', { id: created.booking.id, title: 'Renamed' }),
    )) as { booking: Booking };

    expect(patched.booking.monetary_value).toEqual({ amount: '80.00', currency: 'GBP' });
    expect(patched.booking.counterparty_contact_id).toBe('contact-3');
    // ⚠ `reception_record_id` is deliberately NOT exercised here — a kernel
    // caller cannot set it at all (see the strip test above), so the
    // write-once behaviour is pinned at the STORE layer instead, where the
    // reception mint path actually writes it.
  });

  it('booking-delete tombstones by default', async () => {
    const created = (await adapter(
      mkCall('booking-create', { title: 'Doomed' }),
    )) as { booking: Booking };

    const res = (await adapter(
      mkCall('booking-delete', { id: created.booking.id }),
    )) as { ok: true; id: string; tombstoned: boolean };

    expect(res).toEqual({ ok: true, id: created.booking.id, tombstoned: true });
    expect(store.readBooking(created.booking.id)?.sync_state).toBe('tombstoned');
  });

  it('STRIPS caller-supplied reception provenance', async () => {
    // `reception_record_id` is an authority claim — "this booking came from
    // that visitor's request" — and nothing at this layer can verify it: no
    // existence check, no reception-origin check. Any holder of
    // `core.work-entity.booking.create` (a recipe, a chat turn, an MCP door)
    // could otherwise mint a booking that CLAIMS to be a real reservation,
    // and every downstream reader would treat it as evidence.
    //
    // Stripped at the ARM, not merely omitted from the manifest: the engine
    // does not filter `call.input` by the manifest's declared keys, so an
    // undeclared field still arrives at the dispatcher.
    const out = (await adapter(
      mkCall('booking-create', {
        title: 'Claims to be a reservation',
        reception_record_id: 'req-forged',
      }),
    )) as { booking: Booking };

    expect(out.booking.reception_record_id).toBeUndefined();
    expect(Object.hasOwn(out.booking, 'reception_record_id')).toBe(false);
    expect(store.readBooking(out.booking.id)?.reception_record_id).toBeUndefined();
  });

  it('refuses a create with no title rather than minting a blank booking', async () => {
    await expect(adapter(mkCall('booking-create', {}))).rejects.toThrow(/title is required/);
  });

  it('refuses an update with no id', async () => {
    await expect(
      adapter(mkCall('booking-update', { title: 'Orphan' })),
    ).rejects.toThrow(/id is required/);
  });
});
