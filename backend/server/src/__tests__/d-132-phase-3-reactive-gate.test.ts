/** D-132 Phase 3 — reactive producer trust gate.
 *
 *  Verifies the pure `shouldFireReactive` semantics:
 *    - No trust store wired → always fire (back-compat for harnesses
 *      that don't thread the P3 substrate).
 *    - Trust state controls fire: `'auto'` runs; `'off'` / `'manual'`
 *      block. Reactive `'manual'` means "block until promoted" — there
 *      is no reactive Run-Now equivalent.
 *    - AI-surface producers honour the global pause-AI window;
 *      deterministic producers ignore it.
 *
 *  Plus the "no-op verification" against today's three deterministic
 *  reactive producers — they fire under the registry-default trust
 *  state (`'auto'` for `producer_kind: 'reactive'`) without needing a
 *  persisted row, even with the pause-AI window active. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EnrichmentTopic } from '@recued/contracts';

import {
  createTrustStore,
  type TrustStore,
} from '../housekeeping/trust-store.js';
import { shouldFireReactive } from '../housekeeping/reactive-gate.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';

// ────────────────────────────────────────────────────────────────
// Fixture
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
let dir: string;
let db: Database.Database;
let trustStore: TrustStore;
let now = NOW;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-132-p3-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureHousekeepingSchema(db);
  // Seed singleton config row so trust-store helpers can read it. P2's
  // bootstrap path does the same; without the row, `isAiPaused` short-
  // circuits and the pause-window assertions can't run.
  db.prepare(
    `INSERT INTO housekeeping_config (
       id, preset, cycle_budget_ms, cycle_interval_minutes, updated_at
     ) VALUES ('singleton', 'balanced', 60000, 15, ?)`,
  ).run(NOW);
  trustStore = createTrustStore(db);
  now = NOW;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const setPauseUntil = (deadline: number): void => {
  db.prepare(
    `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
  ).run(deadline);
};

// ────────────────────────────────────────────────────────────────
// Pure gate semantics
// ────────────────────────────────────────────────────────────────

describe('D-132 P3 — shouldFireReactive (gate semantics)', () => {
  it('no trust store wired → always fires (back-compat fallback)', () => {
    setPauseUntil(now + 60_000); // even with pause active
    expect(
      shouldFireReactive('contact_timeline_rollup' as EnrichmentTopic, {
        db,
        now,
        isAiSurface: true,
      }),
    ).toBe(true);
  });

  it('trust state "off" → blocks reactive fire (deterministic)', () => {
    trustStore.write(
      'contact_timeline_rollup' as EnrichmentTopic,
      { trust_state: 'off' },
      now,
    );
    expect(
      shouldFireReactive('contact_timeline_rollup' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(false);
  });

  it('trust state "off" → blocks reactive fire (AI surface)', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'off' }, now);
    expect(
      shouldFireReactive('purpose' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: true,
      }),
    ).toBe(false);
  });

  it('trust state "manual" → blocks reactive fire (no Run-Now equivalent on reactive path)', () => {
    trustStore.write(
      'contact_timeline_rollup' as EnrichmentTopic,
      { trust_state: 'manual' },
      now,
    );
    expect(
      shouldFireReactive('contact_timeline_rollup' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(false);
  });

  it('trust state "auto" + deterministic + no pause → fires', () => {
    trustStore.write(
      'contact_timeline_rollup' as EnrichmentTopic,
      { trust_state: 'auto' },
      now,
    );
    expect(
      shouldFireReactive('contact_timeline_rollup' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(true);
  });

  it('trust state "auto" + deterministic + pause active → still fires (pause is AI-only)', () => {
    trustStore.write(
      'contact_timeline_rollup' as EnrichmentTopic,
      { trust_state: 'auto' },
      now,
    );
    setPauseUntil(now + 60_000);
    expect(
      shouldFireReactive('contact_timeline_rollup' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(true);
  });

  it('trust state "auto" + AI surface + no pause → fires', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    expect(
      shouldFireReactive('purpose' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: true,
      }),
    ).toBe(true);
  });

  it('trust state "auto" + AI surface + pause active → blocks fire', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    setPauseUntil(now + 60_000);
    expect(
      shouldFireReactive('purpose' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: true,
      }),
    ).toBe(false);
  });

  it('trust state "auto" + AI surface + pause elapsed → fires (pause window expired)', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    setPauseUntil(now - 60_000);
    expect(
      shouldFireReactive('purpose' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: true,
      }),
    ).toBe(true);
  });

  it('absent trust row + AI-surface caller → registry default applies (housekeeping AI defaults manual → blocks)', () => {
    // No write — default for `purpose` (housekeeping AI surface) is
    // 'manual' per `resolveEnrichmentTrustDefault`.
    expect(
      shouldFireReactive('purpose' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: true,
      }),
    ).toBe(false);
  });

  it('absent trust row + deterministic caller on a reactive topic → registry default "auto" → fires', () => {
    // No write — default for reactive topics is always 'auto' regardless
    // of the AI flag (per `resolveEnrichmentTrustDefault`'s reactive
    // shortcut). The fire proceeds.
    expect(
      shouldFireReactive('contact_timeline_rollup' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// No-op verification against today's three deterministic reactive
// producers. Each defaults to trust_state 'auto' via
// `resolveEnrichmentTrustDefault`'s reactive shortcut, so no persisted
// row is needed — the gate accepts the fire even with pause-AI active.
// ────────────────────────────────────────────────────────────────

describe('D-132 P3 — no-op verification (today\'s 3 deterministic reactive producers)', () => {
  it('contact_timeline_rollup fires with isAiSurface=false (registry default auto)', () => {
    setPauseUntil(now + 60_000); // pause active — must not affect deterministic
    expect(
      shouldFireReactive('contact_timeline_rollup' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(true);
  });

  it('calendar_event_rollup fires with isAiSurface=false (registry default auto)', () => {
    setPauseUntil(now + 60_000);
    expect(
      shouldFireReactive('calendar_event_rollup' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(true);
  });

  it('meeting_reschedule_pattern fires with isAiSurface=false (registry default auto)', () => {
    setPauseUntil(now + 60_000);
    expect(
      shouldFireReactive('meeting_reschedule_pattern' as EnrichmentTopic, {
        db,
        trustStore,
        now,
        isAiSurface: false,
      }),
    ).toBe(true);
  });

  it('all three remain unaffected by deterministic-side trust writes (trust=auto explicit)', () => {
    // Defensive — even after an explicit auto write (which equates to
    // the registry default), all three still fire.
    for (const t of [
      'contact_timeline_rollup',
      'calendar_event_rollup',
      'meeting_reschedule_pattern',
    ] as EnrichmentTopic[]) {
      trustStore.write(t, { trust_state: 'auto' }, now);
      expect(
        shouldFireReactive(t, {
          db,
          trustStore,
          now,
          isAiSurface: false,
        }),
      ).toBe(true);
    }
  });
});
