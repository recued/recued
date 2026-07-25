/** D-148 P6 — webhook idempotency-ledger / replay window. */

import { describe, expect, it } from 'vitest';
import {
  createIdempotencyLedger,
  WEBHOOK_LEDGER_MAX_ENTRIES,
  WEBHOOK_REPLAY_WINDOW_MS,
} from '../ports/webhook/idempotency-ledger.js';

const BUCKET_SIZE_MS = 60 * 1000;

describe('createIdempotencyLedger', () => {
  it('first record is fresh; same key inside window is a replay', () => {
    let t = 0;
    const ledger = createIdempotencyLedger({ now: () => t });
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(true);
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(false);
  });

  it('separate vendors do not collide on the same event_id', () => {
    let t = 0;
    const ledger = createIdempotencyLedger({ now: () => t });
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(true);
    expect(ledger.record('salesforce', 'evt-1').fresh).toBe(true);
  });

  it('separate event_ids are independent', () => {
    let t = 0;
    const ledger = createIdempotencyLedger({ now: () => t });
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(true);
    expect(ledger.record('hubspot', 'evt-2').fresh).toBe(true);
  });

  it('window expiry: same key past WEBHOOK_REPLAY_WINDOW_MS is fresh again', () => {
    let t = 0;
    const ledger = createIdempotencyLedger({ now: () => t });
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(true);
    t = WEBHOOK_REPLAY_WINDOW_MS + 1;
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(true);
  });

  it('window not yet elapsed: still a replay', () => {
    let t = 0;
    const ledger = createIdempotencyLedger({ now: () => t });
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(true);
    t = WEBHOOK_REPLAY_WINDOW_MS - 1;
    expect(ledger.record('hubspot', 'evt-1').fresh).toBe(false);
  });

  it('size() reports current tracked-key count + clear() drops everything', () => {
    let t = 0;
    const ledger = createIdempotencyLedger({ now: () => t });
    ledger.record('hubspot', 'a');
    ledger.record('hubspot', 'b');
    ledger.record('salesforce', 'c');
    expect(ledger.size()).toBe(3);
    ledger.clear();
    expect(ledger.size()).toBe(0);
    expect(ledger.record('hubspot', 'a').fresh).toBe(true);
  });

  it('eviction sweeps stale buckets', () => {
    let t = 0;
    const ledger = createIdempotencyLedger({ now: () => t });
    for (let i = 0; i < 5; i += 1) ledger.record('hubspot', `e${i}`);
    expect(ledger.size()).toBe(5);
    t = WEBHOOK_REPLAY_WINDOW_MS + 60_001;
    // Calling record sweeps; insert one fresh entry.
    ledger.record('hubspot', 'fresh');
    // Old 5 are evicted; only the fresh entry remains.
    expect(ledger.size()).toBe(1);
  });

  it('caps total tracked keys with oldest-first eviction under a unique-delivery flood', () => {
    let t = 0;
    // max_entries=3, one key per minute-bucket so eviction is the cap
    // (not the 24h window — all 5 land well inside the replay window).
    const ledger = createIdempotencyLedger({ now: () => t, max_entries: 3 });
    for (let i = 0; i < 5; i += 1) {
      t = i * BUCKET_SIZE_MS;
      ledger.record('hubspot', `e${i}`);
    }
    // Never exceeds the cap.
    expect(ledger.size()).toBe(3);
    // The two oldest (e0, e1) were evicted → replaying them is "fresh"
    // again (the memory bound is traded for replay coverage under flood).
    expect(ledger.record('hubspot', 'e4').fresh).toBe(false); // newest survives
    expect(ledger.record('hubspot', 'e0').fresh).toBe(true); // oldest evicted
  });

  it('caps within a SINGLE bucket (sub-minute flood) by evicting oldest keys', () => {
    // All keys arrive at the same instant → one minute-bucket. The cap
    // must still hold by evicting the bucket's oldest individual keys,
    // not wait for a second bucket to roll.
    const ledger = createIdempotencyLedger({ now: () => 0, max_entries: 3 });
    for (let i = 0; i < 5; i += 1) ledger.record('hubspot', `e${i}`);
    expect(ledger.size()).toBe(3);
    expect(ledger.record('hubspot', 'e4').fresh).toBe(false); // newest survives
    expect(ledger.record('hubspot', 'e0').fresh).toBe(true); // oldest evicted
  });

  it('default cap constant is a sane positive ceiling', () => {
    expect(WEBHOOK_LEDGER_MAX_ENTRIES).toBeGreaterThan(1000);
  });
});
