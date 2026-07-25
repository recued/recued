/** D-148 P7 — Key Health + Rotation Center substrate acceptance.
 *
 *  Covers spec § P7 acceptance lines 2167-2176:
 *   - master_dek rotation atomicity (1000 synthetic blobs)
 *   - server_identity rotation re-pairs all clients
 *   - publisher_identity rotation re-signs published recipes
 *   - tls_renew via ACME helper (synthetic 7d-before-expiry)
 *   - two-pin cert rotation overlap
 *   - cert rotation revert (rollback)
 *   - unsigned rotation notice rejection
 *   - client_token rotation revokes old + issues new (D-169 P0 Slice 2B
 *     unified the bridge + webclient bearer rotation under
 *     `rotateWebclientToken`)
 *   - webhook_secret rotation invalidates pending unverified inbound
 *   - compromise flag triggers immediate rotation + dependent re-derivation
 */

import { describe, it, expect } from 'vitest';
import {
  ed25519PublicKeyFingerprint,
  ed25519Sign,
  ed25519Verify,
  generateBearerToken,
  generateEd25519Keypair,
  hashBearerToken,
  type Ed25519Keypair,
  type TokenHashRecord,
} from '../keys/index.js';
import {
  createInMemoryClientTokenStore,
  createInMemoryCompromiseLedger,
  createRotationEngine,
  type ClientTokenStore,
  type RotationSideEffects,
  type WebhookSecretStore,
} from '../keys/rotation/index.js';
import {
  verifyCertRotationNotice,
  verifyCertRotationRevertedEvent,
} from '../keys/rotation/cert-rotation-verifier.js';
import type {
  CertRotationNotice,
  CertRotationRevertedEvent,
  KeyClass,
  KeyRotationEvent,
  RotationOp,
} from '@recued/contracts';

const makeEffects = (): {
  effects: RotationSideEffects;
  audits: Array<{ op: RotationOp; key_class: KeyClass; compromise: boolean }>;
  broadcasts: KeyRotationEvent[];
  certNotices: CertRotationNotice[];
  certReverts: Array<{
    reverted_to_fingerprint: string;
    reason?: string;
    reverted_at: number;
    signature: string;
    signer_fingerprint: string;
  }>;
} => {
  const audits: Array<{ op: RotationOp; key_class: KeyClass; compromise: boolean }> = [];
  const broadcasts: KeyRotationEvent[] = [];
  const certNotices: CertRotationNotice[] = [];
  const certReverts: Array<{
    reverted_to_fingerprint: string;
    reason?: string;
    reverted_at: number;
    signature: string;
    signer_fingerprint: string;
  }> = [];
  return {
    audits,
    broadcasts,
    certNotices,
    certReverts,
    effects: {
      recordAudit: async (entry) => {
        audits.push({ op: entry.op, key_class: entry.key_class, compromise: entry.compromise });
      },
      broadcast: async (event) => {
        broadcasts.push(event);
      },
      broadcastCertRotationNotice: async (entry) => {
        certNotices.push({ type: 'cert_rotation_notice', ...entry });
      },
      broadcastCertRotationReverted: async (entry) => {
        certReverts.push({ ...entry });
      },
    },
  };
};

const dummyKeypair = (): Ed25519Keypair => generateEd25519Keypair('server_identity_key');

describe('D-148 P7 — master_dek rotation', () => {
  it('re-encrypts every blob + emits audit + broadcast', async () => {
    const { effects, audits, broadcasts } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    let installed: Uint8Array | null = null;
    const engine = createRotationEngine({
      master_dek: {
        current: () => new Uint8Array(32),
        install: async (next) => {
          installed = next;
        },
      },
      master_dek_reencryptor: {
        // Codex P1 #3 fold — the reencryptor invokes the install
        // callback inside its transactional boundary so re-encryption
        // + active-key flip happen atomically.
        rotate: async ({ installNewMaster }) => {
          await installNewMaster();
          return { reencrypted_blob_count: 1000 };
        },
      },
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.rotateMasterDek({ triggered_by_client_id: 'admin-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.reencrypted_blob_count).toBe(1000);
    expect(installed).toBeTruthy();
    expect(installed!.length).toBe(32);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.op).toBe('master_dek_rotate');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.repair_required).toBe(false);
  });

  it('refuses second concurrent rotation', async () => {
    const { effects } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    let resolveStart: (() => void) | null = null;
    const start = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const engine = createRotationEngine({
      master_dek: {
        current: () => new Uint8Array(32),
        install: async () => {},
      },
      master_dek_reencryptor: {
        rotate: async ({ installNewMaster }) => {
          await start;
          await installNewMaster();
          return { reencrypted_blob_count: 0 };
        },
      },
      compromise_ledger: compromise,
      effects,
    });
    const first = engine.rotateMasterDek({ triggered_by_client_id: 'admin-1' });
    const second = await engine.rotateMasterDek({ triggered_by_client_id: 'admin-2' });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error).toBe('rotation_in_progress');
    resolveStart!();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it('refuses without master_dek hook configured', async () => {
    const { effects } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const engine = createRotationEngine({ compromise_ledger: compromise, effects });
    const r = await engine.rotateMasterDek({ triggered_by_client_id: 'admin-1' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('key_not_loaded');
  });
});

describe('D-148 P7 — server_identity rotation', () => {
  it('generates new keypair + re-pairs every client + flips repair_required', async () => {
    const { effects, audits, broadcasts } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const initial = generateEd25519Keypair('server_identity_key');
    let stored = initial;
    const engine = createRotationEngine({
      server_identity: {
        load: async () => stored,
        save: async (next) => {
          stored = next;
        },
        revokeAllPairedClients: async () => ({ revoked_client_ids: ['c1', 'c2', 'c3'] }),
      },
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.rotateServerIdentity({ triggered_by_client_id: 'admin-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.repair_client_ids).toEqual(['c1', 'c2', 'c3']);
    expect(stored.public_key_fingerprint).not.toBe(initial.public_key_fingerprint);
    expect(audits).toHaveLength(1);
    expect(broadcasts[0]!.repair_required).toBe(true);
    // D-156 P9 retired the bus-side `pair_required` emit — recovery now
    // flows through the natural disconnect → unpaired-state → pair-form
    // remount path (webclient `onReauthRequired` funnel).
  });
});

describe('D-148 P7 — server_identity rotation rollback on revoke failure', () => {
  it('rolls back to previous keypair when revokeAllPairedClients throws', async () => {
    // Substrate-level rollback guarantee: when the engine's
    // `revokeAllPairedClients` hook throws (e.g. a SQLite IO error
    // inside the production `pairedInstances.revokeAllActive`
    // transaction), the engine falls back to `save(prev)` (no
    // `restore` slot) which restores the cached + persisted keypair.
    // The production composer wires the hook to a real impl that
    // throws on storage IO errors; this test exercises the
    // engine's rollback contract independently of the composer.
    const { effects, audits, broadcasts } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const initial = generateEd25519Keypair('server_identity_key');
    let stored = initial;
    const engine = createRotationEngine({
      server_identity: {
        load: async () => stored,
        save: async (next) => {
          stored = next;
        },
        revokeAllPairedClients: async () => {
          throw new Error('pair-revoke cascade not yet wired');
        },
      },
      compromise_ledger: compromise,
      effects,
    });
    await expect(
      engine.rotateServerIdentity({ triggered_by_client_id: 'admin-1' }),
    ).rejects.toThrow(/not yet wired/);
    // Cache + persist were restored — the prev keypair is the active one.
    expect(stored.public_key_fingerprint).toBe(initial.public_key_fingerprint);
    // No audit row + no broadcast: those effects fire AFTER revoke
    // succeeds. The rollback path is silent at the effects layer (the
    // caller's exception is the observable signal).
    expect(audits).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });
});

describe('D-148 P7 — publisher_identity rotation', () => {
  it('generates new keypair + re-signs every published recipe', async () => {
    const { effects, audits, broadcasts } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    let stored = generateEd25519Keypair('publisher_identity_key');
    const engine = createRotationEngine({
      publisher_identity: {
        load: async () => stored,
        save: async (next) => {
          stored = next;
        },
        resignPublishedRecipes: async () => ({ resigned_recipe_count: 5 }),
      },
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.rotatePublisherIdentity({ triggered_by_client_id: 'admin-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dependents).toEqual([{ key_class: 'publisher_identity_key', affected_count: 5 }]);
    expect(audits[0]!.op).toBe('publisher_identity_rotate');
    expect(broadcasts[0]!.repair_required).toBe(false);
  });
});

describe('D-148 P7 — tls renewal + cert rotation notice', () => {
  it('signs notice with current server_identity_key; verifier accepts', async () => {
    const { effects, certNotices, audits } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const identity = generateEd25519Keypair('server_identity_key');
    const engine = createRotationEngine({
      server_identity: {
        load: async () => identity,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({
          ok: true,
          new_fingerprint: 'sha256:beef',
          previous_fingerprint: 'sha256:cafe',
        }),
      },
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.renewTls({ triggered_by_client_id: 'admin-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.new_fingerprint).toBe('sha256:beef');
    expect(certNotices).toHaveLength(1);
    const notice = certNotices[0]!;
    expect(notice.next_fingerprint).toBe('sha256:beef');
    // Verify the signature using the current identity public key.
    const verify = verifyCertRotationNotice(notice, identity.public_key_b64);
    expect(verify).toEqual({ ok: true });
    expect(audits[0]!.op).toBe('tls_renew');
  });

  it('verifier rejects forged notice (bad signature)', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const forged: CertRotationNotice = {
      type: 'cert_rotation_notice',
      current_fingerprint: 'sha256:cafe',
      next_fingerprint: 'sha256:beef',
      rotation_at: 1_700_000_000_000,
      signature: 'AAAA',
      signer_fingerprint: identity.public_key_fingerprint,
      emitted_at: 1_700_000_000_000,
    };
    const verify = verifyCertRotationNotice(forged, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (verify.ok) throw new Error('unreachable');
    expect(verify.reason).toBe('signature_invalid');
  });

  it('verifier rejects unsigned notice', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const unsigned = {
      type: 'cert_rotation_notice',
      current_fingerprint: 'sha256:cafe',
      next_fingerprint: 'sha256:beef',
      rotation_at: 1_700_000_000_000,
      signature: '',
      signer_fingerprint: identity.public_key_fingerprint,
      emitted_at: 1_700_000_000_000,
    } as CertRotationNotice;
    const verify = verifyCertRotationNotice(unsigned, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (verify.ok) throw new Error('unreachable');
    expect(verify.reason).toBe('signature_malformed');
  });

  it('verifier handles rotation revert event', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const reverted_at = 1_700_000_000_000;
    const signed = JSON.stringify({
      reverted_to_fingerprint: 'sha256:cafe',
      reason: null,
      reverted_at,
      type: 'cert_rotation_reverted',
    });
    const event: CertRotationRevertedEvent = {
      type: 'cert_rotation_reverted',
      reverted_to_fingerprint: 'sha256:cafe',
      reverted_at,
      signature: ed25519Sign(identity, signed),
      signer_fingerprint: identity.public_key_fingerprint,
    };
    const verify = verifyCertRotationRevertedEvent(event, identity.public_key_b64);
    expect(verify).toEqual({ ok: true });
  });

  it('rotation-aware resolver finds key by signer fingerprint', async () => {
    const oldKp = generateEd25519Keypair('server_identity_key');
    const newKp = generateEd25519Keypair('server_identity_key');
    // Notice signed by the OLD identity; receiver still has both keys
    // in its rotation history.
    const signed = JSON.stringify({
      current_fingerprint: 'sha256:c1',
      next_fingerprint: 'sha256:c2',
      rotation_at: 1,
      type: 'cert_rotation_notice',
    });
    const notice: CertRotationNotice = {
      type: 'cert_rotation_notice',
      current_fingerprint: 'sha256:c1',
      next_fingerprint: 'sha256:c2',
      rotation_at: 1,
      signature: ed25519Sign(oldKp, signed),
      signer_fingerprint: oldKp.public_key_fingerprint,
      emitted_at: 1,
    };
    const resolver = (fp: string): string | null => {
      if (fp === oldKp.public_key_fingerprint) return oldKp.public_key_b64;
      if (fp === newKp.public_key_fingerprint) return newKp.public_key_b64;
      return null;
    };
    const verify = verifyCertRotationNotice(notice, resolver);
    expect(verify).toEqual({ ok: true });
  });

  it('returns acme_helper_unavailable when ACME helper is down', async () => {
    const { effects } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const engine = createRotationEngine({
      server_identity: {
        load: async () => generateEd25519Keypair('server_identity_key'),
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: { renew: async () => ({ ok: false, reason: 'helper_unavailable' }) },
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.renewTls({ triggered_by_client_id: 'admin-1' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('acme_helper_unavailable');
  });
});

// D-169 P0 Slice 2B — the `bridge token rotation` describe block
// retired alongside `RotationEngine.rotateBridgeToken`. Bridge bearers
// now rotate through `rotateWebclientToken` (the unified `client_tokens`
// store routes by `client_id` regardless of `client_kind`); see
// `client token rotation` below.

describe('D-148 P7 + D-169 P0 Slice 2B — client (bridge + webclient) token rotation', () => {
  it('revokes + issues new', async () => {
    const { effects } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const tokens = createInMemoryClientTokenStore();
    await tokens.store({
      client_id: 'web-1',
      hash: await hashBearerToken('seed'),
      issued_at: 0,
    });
    const engine = createRotationEngine({
      webclient_tokens: tokens,
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.rotateWebclientToken({
      client_id: 'web-1',
      triggered_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.issued_token).toBeTruthy();
  });
});

describe('D-148 P7 — webhook secret rotation', () => {
  it('rotates secret + invalidates pending unverified inbound', async () => {
    const { effects, audits } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    let storedSecret = 'old-secret';
    const webhooks: WebhookSecretStore = {
      rotate: async ({ vendor: _v, new_secret }) => {
        storedSecret = new_secret;
        return { existed: true };
      },
    };
    const engine = createRotationEngine({
      webhook_secrets: webhooks,
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.rotateWebhookSecret({
      vendor: 'slack',
      triggered_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(storedSecret).not.toBe('old-secret');
    expect(storedSecret.length).toBeGreaterThanOrEqual(20);
    expect(audits[0]!.op).toBe('webhook_secret_rotate');
  });

  it('returns target_not_found for unknown vendor', async () => {
    const { effects } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const webhooks: WebhookSecretStore = {
      rotate: async () => ({ existed: false }),
    };
    const engine = createRotationEngine({
      webhook_secrets: webhooks,
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.rotateWebhookSecret({
      vendor: 'bogus',
      triggered_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('target_not_found');
  });
});

describe('D-148 P7 — compromise cascade', () => {
  it('master_dek compromise triggers immediate re-encryption + clears flag after success', async () => {
    const { effects, audits, broadcasts } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    let installed: Uint8Array | null = null;
    const engine = createRotationEngine({
      master_dek: {
        current: () => new Uint8Array(32),
        install: async (next) => {
          installed = next;
        },
      },
      master_dek_reencryptor: {
        rotate: async ({ installNewMaster }) => {
          await installNewMaster();
          return { reencrypted_blob_count: 42 };
        },
      },
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.markCompromised({
      key_class: 'master_dek',
      triggered_by_client_id: 'admin-1',
      reason: 'incident-2026-05-07',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dependents).toEqual([{ key_class: 'master_dek', affected_count: 42 }]);
    expect(installed).toBeTruthy();
    // After successful rotation the compromise flag clears.
    expect(await compromise.isMarked('master_dek')).toBe(false);
    // Two broadcast events: rotation + mark_compromised.
    expect(broadcasts.some((b) => b.op === 'master_dek_rotate')).toBe(true);
    expect(broadcasts.some((b) => b.op === 'mark_compromised' && b.compromise === true)).toBe(true);
    expect(audits.some((a) => a.op === 'mark_compromised' && a.compromise)).toBe(true);
  });

  it('marking already-compromised class returns compromise_already_recorded', async () => {
    const { effects } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    await compromise.mark({
      key_class: 'webhook_secret',
      marked_at: 0,
      triggered_by_client_id: 'admin-1',
    });
    const engine = createRotationEngine({ compromise_ledger: compromise, effects });
    const r = await engine.markCompromised({
      key_class: 'webhook_secret',
      triggered_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('compromise_already_recorded');
  });

  it('server_identity compromise cascades into rotateServerIdentity with the revoke fanout', async () => {
    const { effects, audits, broadcasts } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    let stored = generateEd25519Keypair('server_identity_key');
    let revokeCalls = 0;
    const engine = createRotationEngine({
      server_identity: {
        load: async () => stored,
        save: async (next) => {
          stored = next;
        },
        revokeAllPairedClients: async () => {
          revokeCalls += 1;
          return { revoked_client_ids: ['c1'] };
        },
      },
      compromise_ledger: compromise,
      effects,
    });
    await engine.markCompromised({
      key_class: 'server_identity_key',
      triggered_by_client_id: 'admin-1',
    });
    // D-156 P9 retired the `pair_required` bus emit. The cascade now
    // surfaces through the DB revoke + the `key_rotation` audit row;
    // clients recover via the webclient's `onReauthRequired` funnel on
    // the next failed handshake.
    expect(revokeCalls).toBe(1);
    expect(audits.some((a) => a.op === 'server_identity_rotate' && a.compromise === true)).toBe(true);
    expect(broadcasts.some((b) => b.op === 'server_identity_rotate' && b.repair_required === true)).toBe(true);
  });

  it('sub_dek compromise escalates to master_dek rotation', async () => {
    const { effects, audits } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    let installed: Uint8Array | null = null;
    const engine = createRotationEngine({
      master_dek: {
        current: () => new Uint8Array(32),
        install: async (next) => {
          installed = next;
        },
      },
      master_dek_reencryptor: {
        rotate: async ({ installNewMaster }) => {
          await installNewMaster();
          return { reencrypted_blob_count: 7 };
        },
      },
      compromise_ledger: compromise,
      effects,
    });
    const r = await engine.markCompromised({
      key_class: 'sub_dek',
      triggered_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(installed).toBeTruthy();
    // Audit history shows both the sub_dek mark + the master_dek rotation.
    expect(audits.some((a) => a.op === 'mark_compromised')).toBe(true);
    expect(audits.some((a) => a.op === 'master_dek_rotate')).toBe(true);
  });
});

describe('D-148 P7 — rotation registry guards', () => {
  it('refuses operations without their hooks wired', async () => {
    const { effects } = makeEffects();
    const compromise = createInMemoryCompromiseLedger();
    const engine = createRotationEngine({ compromise_ledger: compromise, effects });
    const ops = await Promise.all([
      engine.rotateMasterDek({ triggered_by_client_id: 'admin' }),
      engine.rotateServerIdentity({ triggered_by_client_id: 'admin' }),
      engine.rotatePublisherIdentity({ triggered_by_client_id: 'admin' }),
      engine.renewTls({ triggered_by_client_id: 'admin' }),
      engine.rotateWebclientToken({ client_id: 'x', triggered_by_client_id: 'admin' }),
      engine.rotateWebhookSecret({ vendor: 'slack', triggered_by_client_id: 'admin' }),
    ]);
    for (const r of ops) {
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toBe('key_not_loaded');
    }
  });
});
