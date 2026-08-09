/** D-148 § A.6.5 — `tls-cert-renewal` housekeeping task tests.
 *
 *  Verifies the lifecycle scheduler hook that auto-renews the TLS
 *  cert via `engine.renewTls(...)` when the cert is in the renewal
 *  window. Stubs both the cert source and the rotation engine so
 *  the task's policy logic (threshold + cooldown + result handling)
 *  is exercised in isolation from the real ACME helper. */

import { describe, expect, it } from 'vitest';

import {
  buildTlsCertRenewalTask,
  RENEWAL_COOLDOWN_MS,
  RENEWAL_THRESHOLD_MS,
  TLS_AUTO_RENEW_TRIGGER_ID,
} from '../housekeeping/tasks/tls-cert-renewal.js';
import type { RotationResult } from '@recued/contracts';
import type { RotationEngine } from '../keys/rotation/index.js';
import type { CertSource } from '../pairing/cert-source.js';
import type {
  HousekeepingAuditRow,
  HousekeepingContext,
} from '../housekeeping/registry.js';
import type { HousekeepingCursor } from '@recued/contracts';

interface EngineCallLog {
  triggered_by_client_id: string;
  reason?: string;
  rotation_at_offset_ms?: number;
}

const stubEngine = (
  result: RotationResult,
): { engine: RotationEngine; calls: EngineCallLog[] } => {
  const calls: EngineCallLog[] = [];
  const engine: Partial<RotationEngine> = {
    renewTls: async (args) => {
      calls.push({ ...args });
      return result;
    },
  };
  return { engine: engine as RotationEngine, calls };
};

const stubCertSource = (
  cert: { fingerprint: string; valid_until: number } | null,
): CertSource => ({
  getCurrentCert: () => cert,
});

const stubCtx = (
  now: number,
): { ctx: HousekeepingContext; audit: HousekeepingAuditRow[] } => {
  const audit: HousekeepingAuditRow[] = [];
  const ctx: HousekeepingContext = {
    db: {} as never,
    bus: {} as never,
    enrichmentStore: {} as never,
    recipeStore: {} as never,
    now: () => now,
    emitAuditRow: (row) => {
      audit.push(row);
    },
  };
  return { ctx, audit };
};

const COMPLETE_CURSOR: HousekeepingCursor = { kind: 'complete' };
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('tls-cert-renewal — metadata', () => {
  it('declares core kind, interruptible, and a stable id', () => {
    const { engine } = stubEngine({
      ok: false,
      op: 'tls_renew',
      error: 'key_not_loaded',
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource(null),
    });
    expect(task.meta.id).toBe('tls-cert-renewal');
    expect(task.meta.kind).toBe('core');
    expect(task.meta.interruptible).toBe(true);
    expect(task.meta.depends_on).toBeUndefined();
    expect(task.meta.tags).toEqual([
      'kind:core',
      'domain:tls',
      'surface:deterministic',
    ]);
  });
});

describe('tls-cert-renewal — gate: no cert source value', () => {
  it('completes without calling engine when cert source returns null', async () => {
    const { engine, calls } = stubEngine({
      ok: false,
      op: 'tls_renew',
      error: 'key_not_loaded',
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource(null),
    });
    const { ctx, audit } = stubCtx(NOW);

    const result = await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(result.status).toBe('complete');
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
  });
});

describe('tls-cert-renewal — gate: cert outside renewal window', () => {
  it('completes without calling engine when valid_until is beyond threshold', async () => {
    const { engine, calls } = stubEngine({
      ok: false,
      op: 'tls_renew',
      error: 'key_not_loaded',
    });
    const task = buildTlsCertRenewalTask({
      engine,
      // 60d ahead, threshold is 30d → no renewal.
      certSource: stubCertSource({
        fingerprint: 'sha256:abc',
        valid_until: NOW + 60 * DAY_MS,
      }),
    });
    const { ctx } = stubCtx(NOW);

    const result = await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual(COMPLETE_CURSOR);
    expect(calls).toEqual([]);
  });
});

describe('tls-cert-renewal — gate: cooldown still active', () => {
  it('completes without calling engine when last attempt is within cooldown', async () => {
    const { engine, calls } = stubEngine({
      ok: false,
      op: 'tls_renew',
      error: 'key_not_loaded',
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:abc',
        valid_until: NOW + 7 * DAY_MS, // inside threshold
      }),
    });
    const { ctx } = stubCtx(NOW);

    // Last attempt 1 hour ago — well inside the 6-hour cooldown.
    const cursor: HousekeepingCursor = {
      kind: 'time',
      last_seen_at: NOW - 60 * 60 * 1000,
    };
    const result = await task.step(ctx, cursor, 60_000);

    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual(cursor);
    expect(calls).toEqual([]);
  });
});

describe('tls-cert-renewal — fire: cert inside renewal window', () => {
  it('calls engine.renewTls with sentinel trigger id + cert valid_until in reason', async () => {
    const staged_rotated_at = NOW + 7 * DAY_MS;
    const { engine, calls } = stubEngine({
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:new',
      rotated_at: staged_rotated_at,
    });
    const cert_valid_until = NOW + 7 * DAY_MS;
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:old',
        valid_until: cert_valid_until,
      }),
    });
    const { ctx, audit } = stubCtx(NOW);

    const result = await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(calls).toEqual([
      {
        triggered_by_client_id: TLS_AUTO_RENEW_TRIGGER_ID,
        reason: `auto-renew (cert valid_until=${cert_valid_until})`,
      },
    ]);
    expect(result.status).toBe('complete');
    // Codex P2 #1 fold — on success, anchor the cooldown to the staged
    // `rotated_at` so the next cycle's cooldown gate suppresses retries
    // until the cert actually flips.
    expect(result.cursor).toEqual({
      kind: 'time',
      last_seen_at: staged_rotated_at,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      ts: NOW,
      event_at: NOW,
      action: 'tls_auto_renew_attempted',
      target: 'tls_private_key',
      run_mode: 'live',
      detail: {
        ok: true,
        new_fingerprint: 'sha256:new',
        rotated_at: staged_rotated_at,
        cert_valid_until,
      },
    });
  });
});

describe('tls-cert-renewal — Codex P2 #1: staged-window suppression', () => {
  it('does NOT re-fire while the staged cert is scheduled but not yet active', async () => {
    // Simulate the state 6h after a successful renewal: cooldown has
    // ELAPSED, but the cert source still returns the OLD cert because
    // the engine's scheduled flip is still 7d - 6h away.
    const staged_rotated_at = NOW + 7 * DAY_MS;
    const cert_valid_until = NOW + 7 * DAY_MS;
    const { engine, calls } = stubEngine({
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:new',
      rotated_at: staged_rotated_at + 7 * DAY_MS, // would be the NEXT flip
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:old',
        valid_until: cert_valid_until,
      }),
    });
    const { ctx } = stubCtx(NOW + 6 * 60 * 60 * 1000); // 6h after the renew

    // Cursor anchored to the staged flip time (what the prior cycle wrote).
    const cursor: HousekeepingCursor = {
      kind: 'time',
      last_seen_at: staged_rotated_at,
    };
    const result = await task.step(ctx, cursor, 60_000);

    expect(calls).toEqual([]); // no re-fire during the staged window
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual(cursor); // cursor unchanged
  });

  it('resumes probing once the staged flip + cooldown have elapsed', async () => {
    const staged_rotated_at = NOW; // cert flipped at NOW
    // Cert source now returns the FRESH cert with far-future valid_until.
    const { engine, calls } = stubEngine({
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:next',
      rotated_at: NOW + 90 * DAY_MS,
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:new',
        valid_until: NOW + 90 * DAY_MS, // ~90d ahead, outside threshold
      }),
    });
    // 7h after the flip → cooldown elapsed.
    const { ctx } = stubCtx(NOW + 7 * 60 * 60 * 1000);

    const cursor: HousekeepingCursor = {
      kind: 'time',
      last_seen_at: staged_rotated_at,
    };
    const result = await task.step(ctx, cursor, 60_000);

    // Cert is now outside the renewal window → no renew.
    expect(calls).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual(cursor);
  });
});

describe('tls-cert-renewal — fire: cooldown expired (error-path anchor)', () => {
  it('re-fires after the standard cooldown when the prior attempt errored', async () => {
    const { engine, calls } = stubEngine({
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:new',
      rotated_at: NOW + 7 * DAY_MS,
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:old',
        valid_until: NOW + 7 * DAY_MS,
      }),
    });
    const { ctx } = stubCtx(NOW);

    // Prior attempt errored, so cursor was anchored to `now` (not a
    // staged flip time) — exactly RENEWAL_COOLDOWN_MS ago.
    const cursor: HousekeepingCursor = {
      kind: 'time',
      last_seen_at: NOW - RENEWAL_COOLDOWN_MS,
    };
    const result = await task.step(ctx, cursor, 60_000);

    expect(calls).toHaveLength(1);
    // Success this time → cursor anchors to the staged flip time.
    expect(result.cursor).toEqual({
      kind: 'time',
      last_seen_at: NOW + 7 * DAY_MS,
    });
  });
});

describe('tls-cert-renewal — engine error: rotation_in_progress', () => {
  it('completes without advancing cursor (no cooldown burn) when another rotation is in flight', async () => {
    const { engine, calls } = stubEngine({
      ok: false,
      op: 'tls_renew',
      error: 'rotation_in_progress',
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:old',
        valid_until: NOW + 7 * DAY_MS,
      }),
    });
    const { ctx, audit } = stubCtx(NOW);

    const result = await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(calls).toHaveLength(1);
    expect(result.status).toBe('complete');
    // Cursor stays put — no cooldown burn so the next cycle retries.
    expect(result.cursor).toEqual(COMPLETE_CURSOR);
    // No audit row for in-flight; the operator-initiated caller emits its own.
    expect(audit).toEqual([]);
  });
});

describe('tls-cert-renewal — engine error: acme_helper_unavailable', () => {
  it('advances cursor + emits audit row on helper-unavailable', async () => {
    const { engine, calls } = stubEngine({
      ok: false,
      op: 'tls_renew',
      error: 'acme_helper_unavailable',
    });
    const cert_valid_until = NOW + 7 * DAY_MS;
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:old',
        valid_until: cert_valid_until,
      }),
    });
    const { ctx, audit } = stubCtx(NOW);

    const result = await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(calls).toHaveLength(1);
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: NOW });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'tls_auto_renew_attempted',
      target: 'tls_private_key',
      detail: {
        ok: false,
        error: 'acme_helper_unavailable',
        cert_valid_until,
      },
    });
  });
});

describe('tls-cert-renewal — exact threshold boundary', () => {
  it('does NOT fire when valid_until is exactly threshold + now (strict inequality)', async () => {
    const { engine, calls } = stubEngine({
      ok: false,
      op: 'tls_renew',
      error: 'key_not_loaded',
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:abc',
        valid_until: NOW + RENEWAL_THRESHOLD_MS + 1,
      }),
    });
    const { ctx } = stubCtx(NOW);

    const result = await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(calls).toEqual([]);
    expect(result.status).toBe('complete');
  });

  it('fires when valid_until is exactly threshold + now (boundary inclusive)', async () => {
    const { engine, calls } = stubEngine({
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:new',
      rotated_at: NOW,
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:abc',
        valid_until: NOW + RENEWAL_THRESHOLD_MS,
      }),
    });
    const { ctx } = stubCtx(NOW);

    await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(calls).toHaveLength(1);
  });
});

describe('tls-cert-renewal — K=12 cycles against a persistently failing helper', () => {
  /** ⛔ EVERY OTHER CASE IN THIS FILE RUNS ONE CYCLE against a hand-built
   *  cursor. That verifies each BRANCH in isolation and says nothing about what
   *  the task does over TIME — which is the whole question for a renewal, because
   *  the cert has a deadline and the failure mode is silent.
   *
   *  ⚠ THE SCENARIO IS THE COMMON ONE, not an exotic error. A free self-hosted
   *  server has no Pro slot, so the hook returns `acme_helper_unavailable` /
   *  `subscription_required` on EVERY cycle, indefinitely. The task registers
   *  regardless (the composer gates only on a domain store), so this path runs
   *  forever on the majority deployment. Two ways it could be wrong, neither
   *  visible in a single-cycle test:
   *
   *    - fire once per CYCLE rather than once per cooldown ⇒ an audit row every
   *      housekeeping tick, forever, on every free server;
   *    - stall the cursor ⇒ the cooldown never elapses and the renewal never
   *      re-attempts, so a cert that becomes renewable later is never renewed
   *      and the server goes unreachable at expiry.
   *
   *  Asserted as PROGRESS across cycles, not as invocation. */
  it('⛔ fires once per cooldown — not once per cycle — and the cursor advances monotonically', async () => {
    const CYCLE_MS = 60 * 60_000;                    // an hour between probes
    const CYCLES = 12;
    const { engine, calls } = stubEngine({
      ok: false,
      op: 'tls_renew',
      // The failure shape carries `error: RotationErrorCode` — `acme_helper_
      // unavailable` is a real member, and it is what this stub already meant
      // by the free-text `reason` it used to pass.
      error: 'acme_helper_unavailable',
      key_class: 'tls_private_key',
    } as RotationResult);
    const task = buildTlsCertRenewalTask({
      engine,
      // Inside the renewal window for the whole run, so eligibility never
      // stops being true — any suppression must come from the cooldown.
      certSource: stubCertSource({
        fingerprint: 'sha256:old',
        valid_until: NOW + RENEWAL_THRESHOLD_MS - DAY_MS,
      }),
    });

    let cursor: HousekeepingCursor = { kind: 'time', last_seen_at: 0 };
    const seen: number[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const { ctx } = stubCtx(NOW + cycle * CYCLE_MS);
      const result = await task.step(ctx, cursor, 60_000);
      cursor = result.cursor as HousekeepingCursor;
      seen.push((cursor as { last_seen_at: number }).last_seen_at);
    }

    // 12 hours elapsed against a 6h cooldown ⇒ a small number of attempts, and
    // emphatically not one per cycle. The bound is stated in cooldown terms so
    // it stays true if the constant is retuned.
    const expectedMax = Math.ceil((CYCLES * CYCLE_MS) / RENEWAL_COOLDOWN_MS) + 1;
    expect(calls.length, 'fired every cycle — the cooldown is not suppressing')
      .toBeLessThanOrEqual(expectedMax);
    expect(calls.length, 'never fired at all — eligibility or the cursor is stuck')
      .toBeGreaterThan(0);

    // PROGRESS: the cursor must never move backwards, and must have moved off
    // its initial value. A stalled cursor is the failure that silently prevents
    // every future renewal.
    expect(seen[seen.length - 1], 'cursor never advanced off its initial value')
      .toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `cursor went backwards at cycle ${String(i)}`)
        .toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });
});

describe('tls-cert-renewal — override knobs', () => {
  it('honours custom threshold_ms', async () => {
    const { engine, calls } = stubEngine({
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:new',
      rotated_at: NOW,
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:abc',
        valid_until: NOW + 10 * DAY_MS, // 10d ahead
      }),
      threshold_ms: 7 * DAY_MS, // tighter 7d window — 10d is outside it
    });
    const { ctx } = stubCtx(NOW);

    const result = await task.step(ctx, COMPLETE_CURSOR, 60_000);

    expect(calls).toEqual([]);
    expect(result.status).toBe('complete');
  });

  it('honours custom cooldown_ms', async () => {
    const { engine, calls } = stubEngine({
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:new',
      rotated_at: NOW,
    });
    const task = buildTlsCertRenewalTask({
      engine,
      certSource: stubCertSource({
        fingerprint: 'sha256:abc',
        valid_until: NOW + 7 * DAY_MS,
      }),
      cooldown_ms: 30 * 60 * 1000, // 30min cooldown
    });
    const { ctx } = stubCtx(NOW);

    // Last attempt 1 hour ago — outside the 30min override cooldown.
    const cursor: HousekeepingCursor = {
      kind: 'time',
      last_seen_at: NOW - 60 * 60 * 1000,
    };
    await task.step(ctx, cursor, 60_000);

    expect(calls).toHaveLength(1);
  });
});
