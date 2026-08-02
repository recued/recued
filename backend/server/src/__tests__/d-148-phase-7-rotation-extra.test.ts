/** D-148 P7 — rotation engine: extra coverage.
 *
 *  Concurrency, error propagation, partial failure, idempotency.
 *  Complements the spec-acceptance file with substrate-level
 *  invariants reviewers regularly probe.
 */

import { describe, it, expect } from 'vitest';
import {
  generateEd25519Keypair,
  hashBearerToken,
  type Ed25519Keypair,
} from '../keys/index.js';
import {
  createInMemoryClientTokenStore,
  createInMemoryCompromiseLedger,
  createRotationEngine,
  type CompromiseLedger,
  type RotationSideEffects,
} from '../keys/rotation/index.js';
import type { KeyClass, KeyRotationEvent, RotationOp } from '@recued/contracts';

const makeEffects = () => {
  const audits: Array<{ op: RotationOp; key_class: KeyClass; compromise: boolean }> = [];
  const broadcasts: KeyRotationEvent[] = [];
  const certNotices: unknown[] = [];
  const certReverts: unknown[] = [];
  const effects: RotationSideEffects = {
    recordAudit: async (e) =>
      void audits.push({ op: e.op, key_class: e.key_class, compromise: e.compromise }),
    broadcast: async (e) => void broadcasts.push(e),
    broadcastCertRotationNotice: async (e) => void certNotices.push(e),
    broadcastCertRotationReverted: async (e) => void certReverts.push(e),
  };
  return { effects, audits, broadcasts, certNotices, certReverts };
};

describe('D-148 P7 + D-169 P0 Slice 2B — rotation engine concurrency + idempotency', () => {
  // ⚠ Explicit budget, not a default. This case hashes three bearers with
  // argon2id, which is deliberately expensive — and vitest's default 5s is NOT an
  // assertion here: the claim is that concurrent rotations do not interfere, never
  // that they finish quickly. Under a loaded machine the KDF alone exceeds it, and
  // it did: the 26.8.2 release gate (clean npm ci + build + ~2,500 files, docker
  // running alongside) failed on this and nothing else, while the file passes 9/9
  // in isolation. A gate that goes red for a reason unrelated to what it checks is
  // a gate people learn to re-run until green.
  it('per-client paired-client rotations are independent (different clients can rotate concurrently)', async () => {
    const { effects } = makeEffects();
    const tokens = createInMemoryClientTokenStore();
    await tokens.store({
      client_id: 'c1',
      hash: await hashBearerToken('seed-1'),
      issued_at: 0,
    });
    await tokens.store({
      client_id: 'c2',
      hash: await hashBearerToken('seed-2'),
      issued_at: 0,
    });
    const engine = createRotationEngine({
      webclient_tokens: tokens,
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const [a, b] = await Promise.all([
      engine.rotateWebclientToken({ client_id: 'c1', triggered_by_client_id: 'admin' }),
      engine.rotateWebclientToken({ client_id: 'c2', triggered_by_client_id: 'admin' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  }, 30_000);

  it('per-vendor webhook rotations are independent', async () => {
    const { effects } = makeEffects();
    const known = new Set(['slack', 'telegram']);
    const engine = createRotationEngine({
      webhook_secrets: {
        rotate: async ({ vendor }) => ({ existed: known.has(vendor) }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const [a, b] = await Promise.all([
      engine.rotateWebhookSecret({ vendor: 'slack', triggered_by_client_id: 'admin' }),
      engine.rotateWebhookSecret({ vendor: 'telegram', triggered_by_client_id: 'admin' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('master_dek rotation re-encryption error surfaces (caller decides retry)', async () => {
    const { effects } = makeEffects();
    const engine = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: {
        // Stands in for a complete implementation: the substrate refuses to
        // rotate unless the reencryptor declares it rekeys the realm database.
        rekeysRealmDatabase: true,
        rotate: async () => {
          throw new Error('blob-store offline');
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    await expect(
      engine.rotateMasterDek({ triggered_by_client_id: 'admin' }),
    ).rejects.toThrow(/blob-store offline/);
  });

  it('clearing compromise after successful rotation is idempotent', async () => {
    const { effects } = makeEffects();
    const ledger = createInMemoryCompromiseLedger();
    await ledger.mark({
      key_class: 'master_dek',
      marked_at: 0,
      triggered_by_client_id: 'admin',
    });
    const engine = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: { rekeysRealmDatabase: true, rotate: async ({ installNewMaster }) => { await installNewMaster(); return { reencrypted_blob_count: 0 }; } },
      compromise_ledger: ledger,
      effects,
    });
    const r = await engine.rotateMasterDek({ triggered_by_client_id: 'admin' });
    expect(r.ok).toBe(true);
    expect(await ledger.isMarked('master_dek')).toBe(false);
    // Re-rotate cleanly when no compromise flag exists.
    const r2 = await engine.rotateMasterDek({ triggered_by_client_id: 'admin' });
    expect(r2.ok).toBe(true);
  });

  it('mark_compromised on webclient_token records the flag without auto-rotating (selector required, post-D-169 P0 Slice 2B unification)', async () => {
    const { effects, audits, broadcasts } = makeEffects();
    const ledger = createInMemoryCompromiseLedger();
    const engine = createRotationEngine({
      compromise_ledger: ledger,
      effects,
    });
    const r = await engine.markCompromised({
      key_class: 'webclient_token',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // No webclient_tokens hook → no auto-rotation; just the audit + broadcast.
    expect(r.dependents).toEqual([]);
    expect(audits.some((a) => a.op === 'mark_compromised')).toBe(true);
    expect(
      broadcasts.some(
        (b) =>
          b.op === 'mark_compromised' && b.key_class === 'webclient_token' && b.repair_required,
      ),
    ).toBe(true);
    expect(await ledger.isMarked('webclient_token')).toBe(true);
  });

  it('rotation result for ok=true carries new_fingerprint when the op generates a key', async () => {
    const { effects } = makeEffects();
    const engine = createRotationEngine({
      server_identity: {
        load: async () => generateEd25519Keypair('server_identity_key'),
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const r = await engine.rotateServerIdentity({ triggered_by_client_id: 'admin' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.new_fingerprint).toMatch(/^sha256:/);
  });

  it('audit row records reason field when provided', async () => {
    const { effects, audits } = makeEffects();
    const engine = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: { rekeysRealmDatabase: true, rotate: async ({ installNewMaster }) => { await installNewMaster(); return { reencrypted_blob_count: 0 }; } },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const reason = 'incident-2026-05-07';
    await engine.rotateMasterDek({ triggered_by_client_id: 'admin', reason });
    expect(audits).toHaveLength(1);
    // reason isn't in the audits projection but should be wired through;
    // re-fetch via a specific spy.
    const spied = makeEffects();
    let captured: unknown;
    spied.effects.recordAudit = async (entry) => {
      captured = entry;
    };
    const engine2 = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: { rekeysRealmDatabase: true, rotate: async ({ installNewMaster }) => { await installNewMaster(); return { reencrypted_blob_count: 0 }; } },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects: spied.effects,
    });
    await engine2.rotateMasterDek({ triggered_by_client_id: 'admin', reason });
    expect((captured as { reason: string }).reason).toBe(reason);
  });

  it('rotation result includes rotated_at timestamp', async () => {
    const { effects } = makeEffects();
    const fixed = 1_700_000_000_000;
    const engine = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: { rekeysRealmDatabase: true, rotate: async ({ installNewMaster }) => { await installNewMaster(); return { reencrypted_blob_count: 0 }; } },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
      clock: () => fixed,
    });
    const r = await engine.rotateMasterDek({ triggered_by_client_id: 'admin' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.rotated_at).toBe(fixed);
  });
});

describe('master_dek rotation refuses when the realm database would be orphaned', () => {
  /** D-212 derives the realm DATABASE key from the Master DEK
   *  (`deriveSubDEK(masterDEK, 'database')`), and this substrate does not know
   *  that. A rotation that re-wraps both bundle wraps to a new Master DEK while
   *  the file stays encrypted under the OLD `database` sub-DEK leaves it
   *  readable by neither the keyfile nor the 24-word recovery key — the whole
   *  realm, unrecoverable.
   *
   *  Unreachable today (no composition supplies a reencryptor), which is why
   *  the guard is code rather than a comment: `wire-cert-stack.ts` invites a
   *  future slice to wire one, and the webclient already tells users rotation
   *  re-encrypts the whole warehouse. */
  it('refuses a reencryptor that does not declare it rekeys the database', async () => {
    const { effects } = makeEffects();
    let rotateCalled = false;
    const engine = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: {
        // No `rekeysRealmDatabase` — the omission must be refused, not assumed.
        rotate: async ({ installNewMaster }) => {
          rotateCalled = true;
          await installNewMaster();
          return { reencrypted_blob_count: 0 };
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });

    const result = await engine.rotateMasterDek({ triggered_by_client_id: 'admin' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('database_rekey_unsupported');
    // Refused BEFORE any key material moved — nothing to roll back.
    expect(rotateCalled).toBe(false);
  });
});
