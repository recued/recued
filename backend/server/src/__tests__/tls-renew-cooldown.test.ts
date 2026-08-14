/** Shared TLS-renewal cooldown — the gate the "Renew now" button never had.
 *
 *  Settings → Server → Certificates → "Renew now" reached
 *  `RotationEngine.renewTls(...)` past only an in-flight mutex, which releases
 *  the instant a renewal finishes. The `tls-cert-renewal` housekeeping task
 *  had a 30-day window AND a 6h cooldown; the operator button had neither, so
 *  repeat clicks issued repeat certificates. The cloud's
 *  `ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY` (12/publisher/day) is the wrong shape
 *  to catch it — a CA's duplicate-certificate allowance is counted per
 *  identical name set per WEEK, so an operator stays under the daily ceiling
 *  and still exhausts the weekly one, after which AUTOMATIC renewal fails too.
 *
 *  ⛔ THE LOAD-BEARING TEST IS THE JOIN, not either half. Two callers each
 *  obeying "a" cooldown is exactly the bug shape this replaces; what has to
 *  hold is that they obey THE SAME ONE — a manual renew defers the scheduler
 *  and a scheduled renew defers the button. A suite that only drove the rpc
 *  and only drove the task would pass against two independent clocks. */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TLS_RENEW_COOLDOWN_MS,
  createInMemoryCompromiseLedger,
  createRotationEngine,
  type RotationEngine,
  type RotationSideEffects,
  type TlsRenewCooldownStore,
  type TlsRenewalFailureReason,
} from '../keys/rotation/index.js';
import { createInMemoryTlsRenewCooldownStore } from '../keys/rotation/tls-renew-cooldown-store.js';
import { generateEd25519Keypair } from '../keys/index.js';
import {
  buildTlsCertRenewalTask,
  TLS_AUTO_RENEW_TRIGGER_ID,
} from '../housekeeping/tasks/tls-cert-renewal.js';
import type { CertSource } from '../pairing/cert-source.js';
import type {
  HousekeepingAuditRow,
  HousekeepingContext,
} from '../housekeeping/registry.js';
import type { HousekeepingCursor } from '@recued/contracts';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const noopEffects = (): RotationSideEffects =>
  ({
    recordAudit: async () => {},
    broadcast: async () => {},
    broadcastCertRotationNotice: async () => {},
  }) as unknown as RotationSideEffects;

interface EngineHarness {
  engine: RotationEngine;
  cooldown: TlsRenewCooldownStore;
  /** How many times the renewal hook actually ran — i.e. how many times we
   *  would have reached the CA. The number the gate exists to hold down. */
  renewCalls: () => number;
  setNow: (ms: number) => void;
}

const buildEngine = (
  opts: {
    cooldown?: TlsRenewCooldownStore | null;
    renewResult?:
      | { ok: true; new_fingerprint: string; previous_fingerprint?: string }
      | { ok: false; reason: TlsRenewalFailureReason };
  } = {},
): EngineHarness => {
  let now = NOW;
  let calls = 0;
  const cooldown =
    opts.cooldown === null
      ? undefined
      : (opts.cooldown ?? createInMemoryTlsRenewCooldownStore());
  const identity = generateEd25519Keypair('server_identity_key');
  const engine = createRotationEngine({
    clock: () => now,
    server_identity: {
      load: async () => identity,
      save: async () => {},
      revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
    },
    tls: {
      renew: async () => {
        calls += 1;
        return (
          opts.renewResult ?? {
            ok: true,
            new_fingerprint: `sha256:beef${calls}`,
            previous_fingerprint: 'sha256:cafe',
          }
        );
      },
    },
    compromise_ledger: createInMemoryCompromiseLedger(),
    ...(cooldown !== undefined ? { tls_renew_cooldown: cooldown } : {}),
    effects: noopEffects(),
  });
  return {
    engine,
    cooldown: cooldown ?? createInMemoryTlsRenewCooldownStore(),
    renewCalls: () => calls,
    setNow: (ms) => {
      now = ms;
    },
  };
};

const operatorRenew = (engine: RotationEngine, offset = 1000) =>
  engine.renewTls({
    triggered_by_client_id: 'client-operator',
    reason: 'operator clicked Renew now',
    rotation_at_offset_ms: offset,
  });

// ──────────────────────────────────────────────────────────────────
// The button's own gate
// ──────────────────────────────────────────────────────────────────

describe('renewTls — operator cooldown', () => {
  it('⛔ a second click is refused rather than issuing a second certificate', async () => {
    const h = buildEngine();

    const first = await operatorRenew(h.engine);
    expect(first.ok).toBe(true);
    expect(h.renewCalls()).toBe(1);

    const second = await operatorRenew(h.engine);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('renew_cooldown');
    // The assertion that matters: we never reached the CA a second time.
    expect(h.renewCalls()).toBe(1);
  });

  it('carries a `message` so a webclient older than this server still explains itself', async () => {
    const h = buildEngine();
    await operatorRenew(h.engine);
    const blocked = await operatorRenew(h.engine);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    // `renew_cooldown` is a NEW RotationErrorCode member. An older panel has
    // no copy for it and renders `result.message` verbatim; empty here would
    // show a blank remediation.
    expect(blocked.message).toBeTruthy();
    expect(blocked.message).toMatch(/renewal/i);
  });

  it('unblocks once the window passes — anchored to the FLIP, not the request', async () => {
    // Success anchors `not_before` to `rotated_at` (request + lead), because
    // until the staged cert flips the cert source still reports the old one.
    const lead = 1000;
    const h = buildEngine();
    await operatorRenew(h.engine, lead);

    h.setNow(NOW + lead + DEFAULT_TLS_RENEW_COOLDOWN_MS - 1);
    const tooEarly = await operatorRenew(h.engine, lead);
    expect(tooEarly.ok).toBe(false);
    expect(h.renewCalls()).toBe(1);

    h.setNow(NOW + lead + DEFAULT_TLS_RENEW_COOLDOWN_MS);
    const due = await operatorRenew(h.engine, lead);
    expect(due.ok).toBe(true);
    expect(h.renewCalls()).toBe(2);
  });

  it('a cloud 429 backs off AND surfaces as itself, not as "helper unreachable"', async () => {
    const h = buildEngine({ renewResult: { ok: false, reason: 'rate_limited' } });

    const first = await operatorRenew(h.engine);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toBe('renew_rate_limited');
    expect(first.message).toBeTruthy();

    // Backed off: retrying now would just spend a round trip being refused.
    const second = await operatorRenew(h.engine);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('renew_cooldown');
    expect(h.renewCalls()).toBe(1);
  });

  it('🔑 a failure that never reached the CA leaves the operator able to retry', async () => {
    // The opposite call from `rate_limited`. `helper_unavailable` means Pro
    // auth / the helper was not ready — no certificate quota was spent. An
    // operator who fixes the cause must not be locked out for 6h, or they
    // learn to restart the server to clear it.
    const h = buildEngine({ renewResult: { ok: false, reason: 'helper_unavailable' } });

    const first = await operatorRenew(h.engine);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toBe('acme_helper_unavailable');

    const retry = await operatorRenew(h.engine);
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.error).toBe('acme_helper_unavailable');
    // Reached the hook again — NOT swallowed by a cooldown.
    expect(h.renewCalls()).toBe(2);
  });

  it('composes with the in-flight mutex rather than overlapping it', async () => {
    // The two gates answer different questions and BOTH are needed. The
    // cooldown cannot catch a concurrent pair — both read `not_before` before
    // either writes it — and the mutex cannot catch a sequential pair, since
    // it releases the moment a renewal finishes. Drive the concurrent case
    // explicitly so a future simplification that deletes one is caught here.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const identity = generateEd25519Keypair('server_identity_key');
    const cooldown = createInMemoryTlsRenewCooldownStore();
    const engine = createRotationEngine({
      clock: () => NOW,
      server_identity: {
        load: async () => identity,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => {
          calls += 1;
          await held;
          return { ok: true, new_fingerprint: 'sha256:beef', previous_fingerprint: 'sha256:cafe' };
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      tls_renew_cooldown: cooldown,
      effects: noopEffects(),
    });

    const a = operatorRenew(engine);
    const b = operatorRenew(engine);
    release();
    const [first, second] = await Promise.all([a, b]);

    // Exactly one reached the hook; the loser was refused by the mutex.
    expect(calls).toBe(1);
    const outcomes = [first, second].map((r) => (r.ok ? 'ok' : r.error)).sort();
    expect(outcomes).toEqual(['ok', 'rotation_in_progress']);

    // ⛔ AND THE LOSER DID NOT CONSUME THE CLOCK. `rotation_in_progress`
    // never reached the CA, so the window belongs to the winner's outcome.
    const third = await operatorRenew(engine);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error).toBe('renew_cooldown');
    expect(calls).toBe(1);
  });

  it('⛔⛔ a COMPROMISED tls key is exempt — the cooldown must never block an emergency reissue', async () => {
    // `markCompromised` cascades into `renewTls` for `tls_private_key`. If the
    // cooldown applied there, marking a burned key compromised would be
    // REFUSED whenever a routine renewal had run recently — and it would land
    // quietly in `cascade_failures`, not as anything loud. A rate limit that
    // can block an incident response is a security bug, not a rate limit.
    const ledger = createInMemoryCompromiseLedger();
    let calls = 0;
    const identity = generateEd25519Keypair('server_identity_key');
    const engine = createRotationEngine({
      clock: () => NOW,
      server_identity: {
        load: async () => identity,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => {
          calls += 1;
          return { ok: true, new_fingerprint: `sha256:beef${calls}` };
        },
      },
      compromise_ledger: ledger,
      tls_renew_cooldown: createInMemoryTlsRenewCooldownStore(),
      effects: noopEffects(),
    });

    // Burn the window with a routine renewal, and prove it is really shut.
    await operatorRenew(engine);
    const blocked = await operatorRenew(engine);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toBe('renew_cooldown');
    expect(calls).toBe(1);

    // Now the key is declared burned. The SAME call must go through.
    await ledger.mark({
      key_class: 'tls_private_key',
      marked_at: NOW,
      triggered_by_client_id: 'client-operator',
    });
    const emergency = await operatorRenew(engine);
    expect(emergency.ok).toBe(true);
    expect(calls).toBe(2);

    // …and the exemption does not linger. A successful compromise rotation
    // clears the mark, so the next renewal is throttled normally again.
    const after = await operatorRenew(engine);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error).toBe('renew_cooldown');
    expect(calls).toBe(2);
  });

  it('no cooldown store wired ⇒ unchanged behaviour (dbless / test harnesses)', async () => {
    const h = buildEngine({ cooldown: null });
    expect((await operatorRenew(h.engine)).ok).toBe(true);
    expect((await operatorRenew(h.engine)).ok).toBe(true);
    expect(h.renewCalls()).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// The join — one clock, both callers
// ──────────────────────────────────────────────────────────────────

const stubCertSource = (valid_until: number): CertSource => ({
  getCurrentCert: () => ({ fingerprint: 'sha256:old', valid_until }),
});

const stubCtx = (
  now: number,
): { ctx: HousekeepingContext; audit: HousekeepingAuditRow[] } => {
  const audit: HousekeepingAuditRow[] = [];
  return {
    audit,
    ctx: {
      db: {} as never,
      bus: {} as never,
      enrichmentStore: {} as never,
      recipeStore: {} as never,
      now: () => now,
      emitAuditRow: (row) => {
        audit.push(row);
      },
    },
  };
};

/** A cursor that is PAST its own cooldown, so the housekeeping task's own
 *  pre-filter cannot be what stops it — anything that blocks the task in
 *  these tests has to be the shared engine clock. */
const READY_CURSOR: HousekeepingCursor = { kind: 'time', last_seen_at: 0 };

describe('renewTls — the join between the button and the scheduler', () => {
  it('⛔ an operator renew DEFERS the auto-renewal task', async () => {
    const h = buildEngine();
    const task = buildTlsCertRenewalTask({
      engine: h.engine,
      // Cert is deep inside the 30-day window, so the task genuinely wants
      // to renew — only the shared clock can stop it.
      certSource: stubCertSource(NOW + 5 * DAY_MS),
    });

    await operatorRenew(h.engine);
    expect(h.renewCalls()).toBe(1);

    const { ctx, audit } = stubCtx(NOW);
    const result = await task.step(ctx, READY_CURSOR, 1000);

    expect(h.renewCalls()).toBe(1);
    expect(result.status).toBe('complete');
    // Cursor untouched + no audit row: the task did not spend an attempt, so
    // it must not record one. Advancing here would stack its 6h on the
    // engine's and silently cost the scheduler a cycle it never used.
    expect(result.cursor).toEqual(READY_CURSOR);
    expect(audit).toHaveLength(0);
  });

  it('⛔ an auto-renewal DEFERS the operator button', async () => {
    const h = buildEngine();
    const task = buildTlsCertRenewalTask({
      engine: h.engine,
      certSource: stubCertSource(NOW + 5 * DAY_MS),
    });

    const { ctx } = stubCtx(NOW);
    await task.step(ctx, READY_CURSOR, 1000);
    expect(h.renewCalls()).toBe(1);

    const clicked = await operatorRenew(h.engine);
    expect(clicked.ok).toBe(false);
    if (clicked.ok) return;
    expect(clicked.error).toBe('renew_cooldown');
    expect(h.renewCalls()).toBe(1);
  });

  it('the task still emits its audit row when it DOES renew', async () => {
    // Guard against "fixed the cooldown, broke the audit trail" — the task's
    // reporting path has to survive the new early-return branch.
    const h = buildEngine();
    const task = buildTlsCertRenewalTask({
      engine: h.engine,
      certSource: stubCertSource(NOW + 5 * DAY_MS),
    });
    const { ctx, audit } = stubCtx(NOW);

    const result = await task.step(ctx, READY_CURSOR, 1000);

    expect(h.renewCalls()).toBe(1);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('tls_auto_renew_attempted');
    expect(result.cursor.kind).toBe('time');
  });

  it('the task passes its own trigger id through, unchanged by the gate', async () => {
    const h = buildEngine();
    const seen: string[] = [];
    const wrapped: RotationEngine = {
      ...h.engine,
      renewTls: async (args) => {
        seen.push(args.triggered_by_client_id);
        return h.engine.renewTls(args);
      },
    };
    const task = buildTlsCertRenewalTask({
      engine: wrapped,
      certSource: stubCertSource(NOW + 5 * DAY_MS),
    });
    const { ctx } = stubCtx(NOW);
    await task.step(ctx, READY_CURSOR, 1000);
    expect(seen).toEqual([TLS_AUTO_RENEW_TRIGGER_ID]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Durability
// ──────────────────────────────────────────────────────────────────

describe('the cooldown survives a restart', () => {
  it('a fresh engine over the SAME store stays blocked', async () => {
    // A cooldown a restart clears is a cooldown an impatient operator clears,
    // and the CA's weekly allowance does not reset when the process does.
    const shared = createInMemoryTlsRenewCooldownStore();
    const first = buildEngine({ cooldown: shared });
    await operatorRenew(first.engine);

    const rebooted = buildEngine({ cooldown: shared });
    const afterRestart = await operatorRenew(rebooted.engine);

    expect(afterRestart.ok).toBe(false);
    if (afterRestart.ok) return;
    expect(afterRestart.error).toBe('renew_cooldown');
    expect(rebooted.renewCalls()).toBe(0);
  });

  it('a fresh install with no row is never blocked', async () => {
    const h = buildEngine({ cooldown: createInMemoryTlsRenewCooldownStore() });
    expect((await operatorRenew(h.engine)).ok).toBe(true);
  });
});
