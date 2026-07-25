/** D-148 P7 — Codex review fold validation.
 *
 *  Each test pins one fold's behavior so future regressions surface
 *  immediately. Findings + fold rationale are documented in the
 *  P7 changelog entry; this file is the executable form of that
 *  fold-back.
 *
 *  Codex findings folded:
 *   - P1 #1 — exposure transitions emit audit BEFORE listener apply.
 *   - P1 #2 — `markCompromised` reports cascade failure as ok=false.
 *   - P1 #3 — master_dek install + re-encrypt are atomic via
 *             `installNewMaster` callback inside reencryptor.rotate.
 *   - P2 #4 — public-MCP sub-toggle gates DDNS via resolved-port table.
 *   - P2 #5 — TLS renewal schedules `rotation_at` lead time.
 *   - P2 #6 — server/publisher identity rotations roll back to prev
 *             on dependent-work failure.
 *   - P2 #7 — bridge / webclient / webhook rotations invoke active
 *             invalidation hooks (close session / fence pending).
 *   - P2 #8 — `applyCertRotationNotice` + `applyCertRotationRevertedEvent`
 *             enforce pin-state transitions, not just signature.
 */

import { describe, it, expect } from 'vitest';
import {
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  type ExposureChangedEvent,
} from '@recued/contracts';
import {
  createExposureStateMachine,
  createInMemoryExposureStore,
  type ExposureSideEffects,
  type PathListenerCoordinator,
} from '../exposure/index.js';
import {
  generateEd25519Keypair,
  ed25519Sign,
  hashBearerToken,
  type Ed25519Keypair,
} from '../keys/index.js';
import {
  createInMemoryClientTokenStore,
  createInMemoryCompromiseLedger,
  createRotationEngine,
  DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS,
  type ClientTokenStore,
  type RotationSideEffects,
} from '../keys/rotation/index.js';
import {
  applyCertRotationNotice,
  applyCertRotationRevertedEvent,
} from '../keys/rotation/cert-rotation-verifier.js';

// ────────────────────────────────────────────────────────────────
// P1 #1 — exposure transitions emit audit BEFORE listener apply
// ────────────────────────────────────────────────────────────────

describe('Codex P1 #1 — exposure audit precedes listener apply (carried forward to W3.5 per-path)', () => {
  it('audit fails → listener never applies, state never persists', async () => {
    const callOrder: string[] = [];
    const listener: PathListenerCoordinator = {
      apply: async () => {
        callOrder.push('listener');
        return {
          lan: { listening: true, bind_address: '10.0.0.1' },
          public: { listening: true, bind_address: '0.0.0.0' },
        };
      },
    };
    const effects: ExposureSideEffects = {
      recordAudit: async () => {
        callOrder.push('audit');
        throw new Error('audit store down');
      },
      broadcast: async () => {
        callOrder.push('broadcast');
      },
    };
    const machine = createExposureStateMachine({
      store: createInMemoryExposureStore(),
      listener,
      effects,
      ddns: { isConfigured: async () => true },
      bind_addresses: { lan: '10.0.0.1', public: '0.0.0.0' },
    });
    await expect(
      machine.applyPreset({
        preset: 'public',
        changed_by_client_id: 'admin',
      }),
    ).rejects.toThrow(/audit store down/);
    // Audit was attempted FIRST. Listener never invoked → no public
    // listener bound under a missing audit row.
    expect(callOrder).toEqual(['audit']);
    const state = await machine.current();
    expect(state.derived_preset_label).toBe('lan_only');
  });

  it('listener fails → audit row persists (intent recorded); transition still raises so operator sees it', async () => {
    const order: string[] = [];
    const listener: PathListenerCoordinator = {
      apply: async () => {
        order.push('listener');
        throw new Error('bind error');
      },
    };
    const audits: unknown[] = [];
    const effects: ExposureSideEffects = {
      recordAudit: async (e) => {
        order.push('audit');
        audits.push(e);
      },
      broadcast: async () => {
        order.push('broadcast');
      },
    };
    const machine = createExposureStateMachine({
      store: createInMemoryExposureStore(),
      listener,
      effects,
      ddns: { isConfigured: async () => true },
      bind_addresses: { lan: '10.0.0.1', public: '0.0.0.0' },
    });
    await expect(
      machine.applyPreset({
        preset: 'public',
        changed_by_client_id: 'admin',
      }),
    ).rejects.toThrow(/bind error/);
    // Audit fired BEFORE listener so the operator sees the intent
    // even when listener failed. § A.7.4 makes audit signed-record-of-
    // intent; bind failure surfaces in listener-set status not by
    // missing the audit row.
    expect(order[0]).toBe('audit');
    expect(audits).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// P1 #2 — markCompromised reports cascade failure
// ────────────────────────────────────────────────────────────────

describe('Codex P1 #2 — markCompromised cascade failure surfacing', () => {
  it('cascade rotation failure returns ok=false and keeps compromise active', async () => {
    const ledger = createInMemoryCompromiseLedger();
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async () => {},
      broadcastCertRotationReverted: async () => {},
    };
    const engine = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: {
        rotate: async () => {
          throw new Error('blob-store down');
        },
      },
      compromise_ledger: ledger,
      effects,
    });
    await expect(
      engine.markCompromised({ key_class: 'master_dek', triggered_by_client_id: 'admin' }),
    ).rejects.toThrow(/blob-store down/);
    // Compromise stays marked; operator runs rotateMasterDek manually.
    expect(await ledger.isMarked('master_dek')).toBe(true);
  });

  it('selector-required class records cascade_pending', async () => {
    const ledger = createInMemoryCompromiseLedger();
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async () => {},
      broadcastCertRotationReverted: async () => {},
    };
    const engine = createRotationEngine({ compromise_ledger: ledger, effects });
    const r = await engine.markCompromised({
      key_class: 'webhook_secret',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.cascade_pending).toEqual([
      { key_class: 'webhook_secret', reason: 'selector_required' },
    ]);
    // Compromise stays marked until operator runs the per-vendor rotation.
    expect(await ledger.isMarked('webhook_secret')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// P1 #3 — master_dek install + reencrypt atomic
// ────────────────────────────────────────────────────────────────

describe('Codex P1 #3 — master_dek install atomicity', () => {
  it('install runs inside reencryptor; reencryptor controls commit/rollback', async () => {
    let installed: Uint8Array | null = null;
    let installCalledBy = '';
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async () => {},
      broadcastCertRotationReverted: async () => {},
    };
    const engine = createRotationEngine({
      master_dek: {
        current: () => new Uint8Array(32),
        install: async (next) => {
          installed = next;
          installCalledBy = 'install-hook';
        },
      },
      master_dek_reencryptor: {
        rotate: async ({ installNewMaster }) => {
          // Simulate transactional flow: re-encrypt blobs + commit
          // active key flip via the install callback inside the same
          // pause/resume window.
          await installNewMaster();
          return { reencrypted_blob_count: 1 };
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const r = await engine.rotateMasterDek({ triggered_by_client_id: 'admin' });
    expect(r.ok).toBe(true);
    expect(installed).toBeTruthy();
    expect(installCalledBy).toBe('install-hook');
  });

  it('install failure aborts the rotation (substrate surfaces throw)', async () => {
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async () => {},
      broadcastCertRotationReverted: async () => {},
    };
    const engine = createRotationEngine({
      master_dek: {
        current: () => new Uint8Array(32),
        install: async () => {
          throw new Error('keyring write failed');
        },
      },
      master_dek_reencryptor: {
        rotate: async ({ installNewMaster }) => {
          // Simulated production path: reencryptor catches install
          // failure and rolls back re-encryption; the substrate
          // observes the thrown error.
          try {
            await installNewMaster();
          } catch (err) {
            throw err;
          }
          return { reencrypted_blob_count: 0 };
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    await expect(
      engine.rotateMasterDek({ triggered_by_client_id: 'admin' }),
    ).rejects.toThrow(/keyring write failed/);
  });
});

// ────────────────────────────────────────────────────────────────
// P2 #4 — public-MCP DDNS gating via resolved ports
// ────────────────────────────────────────────────────────────────

describe('Codex P2 #4 — public-MCP DDNS gating (carried forward to W3.5)', () => {
  it('ack on a resolution with no public bits succeeds even without DDNS (ack alone does not bind public)', async () => {
    const effects: ExposureSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
    };
    const machine = createExposureStateMachine({
      store: createInMemoryExposureStore(),
      listener: {
        apply: async () => ({
          lan: { listening: true, bind_address: '10.0.0.1' },
          public: { listening: false, bind_address: null },
        }),
      },
      effects,
      ddns: { isConfigured: async () => false },
      bind_addresses: { lan: '10.0.0.1', public: '0.0.0.0' },
    });
    // Apply lan_only first — no public bits anywhere.
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    // Ack alone does NOT promote mcp.public; the resolution stays
    // lan-only so the DDNS gate does not fire. The ack record is
    // recorded; only a subsequent setPathResolution('mcp', public)
    // would consult DDNS.
    const r = await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.public_mcp_acknowledgement.acknowledged).toBe(true);
    expect(r.state.resolution.mcp.public).toBe(false);
  });

  it('ack on a resolution that already has public bits + no DDNS rejects', async () => {
    const machine = createExposureStateMachine({
      store: createInMemoryExposureStore(),
      listener: {
        apply: async () => ({
          lan: { listening: true, bind_address: '10.0.0.1' },
          public: { listening: true, bind_address: '0.0.0.0' },
        }),
      },
      effects: { recordAudit: async () => {}, broadcast: async () => {} },
      ddns: { isConfigured: async () => true },
      bind_addresses: { lan: '10.0.0.1', public: '0.0.0.0' },
    });
    // Build a public resolution first (requires DDNS true at this step).
    await machine.applyPreset({ preset: 'public', changed_by_client_id: 'admin' });
    // Now flip DDNS off and try acknowledging — the existing public
    // bits make the resolved table public-reachable, so the gate fires.
    const noDdnsMachine = createExposureStateMachine({
      store: createInMemoryExposureStore({
        resolution: {
          health: { lan: true, public: true },
          ws: { lan: true, public: true },
          mcp: { lan: true, public: false },
          llm_gateway: { lan: true, public: true },
          webhooks: { lan: true, public: true },
          reception: { lan: true, public: true },
          oauth: { lan: false, public: false },
          ask: { lan: false, public: false },
          webclient: { lan: true, public: false },
        },
        derived_preset_label: 'public',
        public_mcp_acknowledgement: { acknowledged: false },
        last_changed_at: 0,
        changed_by_client_id: 'admin',
      }),
      listener: {
        apply: async () => ({
          lan: { listening: true, bind_address: '10.0.0.1' },
          public: { listening: true, bind_address: '0.0.0.0' },
        }),
      },
      effects: { recordAudit: async () => {}, broadcast: async () => {} },
      ddns: { isConfigured: async () => false },
      bind_addresses: { lan: '10.0.0.1', public: '0.0.0.0' },
    });
    const r = await noDdnsMachine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('preset_unachievable_no_ddns');
  });
});

// ────────────────────────────────────────────────────────────────
// P2 #5 — TLS rotation_at lead time
// ────────────────────────────────────────────────────────────────

describe('Codex P2 #5 — TLS rotation_at lead', () => {
  it('default lead is 7 days; emitted_at is now', async () => {
    let captured: { rotation_at: number; emitted_at: number } | null = null;
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async (e) => {
        captured = { rotation_at: e.rotation_at, emitted_at: e.emitted_at };
      },
      broadcastCertRotationReverted: async () => {},
    };
    const fixed = 1_700_000_000_000;
    const engine = createRotationEngine({
      server_identity: {
        load: async () => generateEd25519Keypair('server_identity_key'),
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({
          ok: true,
          new_fingerprint: 'sha256:next',
          previous_fingerprint: 'sha256:current',
        }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
      clock: () => fixed,
    });
    const r = await engine.renewTls({ triggered_by_client_id: 'admin' });
    expect(r.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.emitted_at).toBe(fixed);
    expect(captured!.rotation_at).toBe(fixed + DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS);
  });

  it('rotation_at_offset_ms = 0 produces synchronous flip semantics', async () => {
    let captured: { rotation_at: number; emitted_at: number } | null = null;
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async (e) => {
        captured = { rotation_at: e.rotation_at, emitted_at: e.emitted_at };
      },
      broadcastCertRotationReverted: async () => {},
    };
    const fixed = 1_700_000_000_000;
    const engine = createRotationEngine({
      server_identity: {
        load: async () => generateEd25519Keypair('server_identity_key'),
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({ ok: true, new_fingerprint: 'sha256:next' }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
      clock: () => fixed,
    });
    const r = await engine.renewTls({
      triggered_by_client_id: 'admin',
      rotation_at_offset_ms: 0,
    });
    expect(r.ok).toBe(true);
    expect(captured!.emitted_at).toBe(fixed);
    expect(captured!.rotation_at).toBe(fixed);
  });
});

// ────────────────────────────────────────────────────────────────
// P2 #6 — identity rotation rollback
// ────────────────────────────────────────────────────────────────

describe('Codex P2 #6 — server_identity rollback on dependent failure', () => {
  it('revokeAllPairedClients failure restores previous identity', async () => {
    const prev = generateEd25519Keypair('server_identity_key');
    let stored = prev;
    const restored: string[] = [];
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async () => {},
      broadcastCertRotationReverted: async () => {},
    };
    const engine = createRotationEngine({
      server_identity: {
        load: async () => stored,
        save: async (next) => {
          stored = next;
        },
        restore: async (key) => {
          stored = key;
          restored.push(key.public_key_fingerprint);
        },
        revokeAllPairedClients: async () => {
          throw new Error('revocation store down');
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    await expect(
      engine.rotateServerIdentity({ triggered_by_client_id: 'admin' }),
    ).rejects.toThrow(/revocation store down/);
    // Identity restored to the previous keypair.
    expect(stored.public_key_fingerprint).toBe(prev.public_key_fingerprint);
    expect(restored).toEqual([prev.public_key_fingerprint]);
  });

  it('publisher_identity rollback on resign failure', async () => {
    const prev = generateEd25519Keypair('publisher_identity_key');
    let stored = prev;
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: async () => {},
      broadcastCertRotationReverted: async () => {},
    };
    const engine = createRotationEngine({
      publisher_identity: {
        load: async () => stored,
        save: async (next) => {
          stored = next;
        },
        // No `restore` hook → fallback path uses `save(prev)`.
        resignPublishedRecipes: async () => {
          throw new Error('marketplace upload failed');
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    await expect(
      engine.rotatePublisherIdentity({ triggered_by_client_id: 'admin' }),
    ).rejects.toThrow(/marketplace upload failed/);
    expect(stored.public_key_fingerprint).toBe(prev.public_key_fingerprint);
  });
});

// ────────────────────────────────────────────────────────────────
// P2 #7 — active session close + webhook fence
// ────────────────────────────────────────────────────────────────

describe('Codex P2 #7 — active invalidation hooks', () => {
  it('client (bridge + webclient) token rotation invokes closeActiveSessions before storing new token (D-169 P0 Slice 2B unification)', async () => {
    const order: string[] = [];
    let issuedTokenAfterClose = false;
    const tokens: ClientTokenStore = {
      revoke: async () => {
        order.push('revoke');
        return { existed: true };
      },
      closeActiveSessions: async () => {
        order.push('closeActiveSessions');
        return { closed_session_count: 1 };
      },
      store: async () => {
        order.push('store');
        if (order.includes('closeActiveSessions')) {
          issuedTokenAfterClose = true;
        }
      },
    };
    const engine = createRotationEngine({
      webclient_tokens: tokens,
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects: {
        recordAudit: async () => {},
        broadcast: async () => {},
        broadcastCertRotationNotice: async () => {},
        broadcastCertRotationReverted: async () => {},
      },
    });
    const r = await engine.rotateWebclientToken({
      client_id: 'c1',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    // Order: revoke → close → store. New token issuance happens
    // AFTER the rotated client's WS session is closed.
    expect(order).toEqual(['revoke', 'closeActiveSessions', 'store']);
    expect(issuedTokenAfterClose).toBe(true);
  });

  it('webhook_secret rotation invokes fencePendingVerifications', async () => {
    const fenced: string[] = [];
    const engine = createRotationEngine({
      webhook_secrets: {
        rotate: async () => ({ existed: true }),
        fencePendingVerifications: async ({ vendor }) => {
          fenced.push(vendor);
          return { fenced_count: 2 };
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects: {
        recordAudit: async () => {},
        broadcast: async () => {},
          broadcastCertRotationNotice: async () => {},
      broadcastCertRotationReverted: async () => {},
      },
    });
    const r = await engine.rotateWebhookSecret({
      vendor: 'slack',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    expect(fenced).toEqual(['slack']);
  });
});

// ────────────────────────────────────────────────────────────────
// P2 #8 — state-aware cert rotation verifier
// ────────────────────────────────────────────────────────────────

describe('Codex P2 #8 — applyCertRotationNotice + applyCertRotationRevertedEvent', () => {
  const mintNotice = (
    identity: Ed25519Keypair,
    args: { current: string; next: string; rotation_at: number },
  ) => {
    const payload = JSON.stringify({
      current_fingerprint: args.current,
      next_fingerprint: args.next,
      rotation_at: args.rotation_at,
      type: 'cert_rotation_notice',
    });
    return {
      type: 'cert_rotation_notice' as const,
      current_fingerprint: args.current,
      next_fingerprint: args.next,
      rotation_at: args.rotation_at,
      signature: ed25519Sign(identity, payload),
      signer_fingerprint: identity.public_key_fingerprint,
      emitted_at: args.rotation_at - 1000,
    };
  };

  const mintRevert = (
    identity: Ed25519Keypair,
    args: { reverted_to: string; reverted_at: number },
  ) => {
    const payload = JSON.stringify({
      reverted_to_fingerprint: args.reverted_to,
      reason: null,
      reverted_at: args.reverted_at,
      type: 'cert_rotation_reverted',
    });
    return {
      type: 'cert_rotation_reverted' as const,
      reverted_to_fingerprint: args.reverted_to,
      reverted_at: args.reverted_at,
      signature: ed25519Sign(identity, payload),
      signer_fingerprint: identity.public_key_fingerprint,
    };
  };

  it('applyCertRotationNotice produces nextPinned with staged fingerprint', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const now = 1_000_000_000_000;
    const notice = mintNotice(identity, {
      current: 'sha256:current',
      next: 'sha256:next',
      rotation_at: now + 7 * 24 * 60 * 60 * 1000,
    });
    const out = applyCertRotationNotice({
      notice,
      pinned: { current_fingerprint: 'sha256:current', current_valid_until: now },
      resolver: identity.public_key_b64,
      now,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.nextPinned.next_fingerprint).toBe('sha256:next');
    expect(out.nextPinned.current_fingerprint).toBe('sha256:current');
  });

  it('applyCertRotationNotice rejects current_fingerprint mismatch', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const now = 1_000_000_000_000;
    const notice = mintNotice(identity, {
      current: 'sha256:wrong-lineage',
      next: 'sha256:next',
      rotation_at: now + 1000,
    });
    const out = applyCertRotationNotice({
      notice,
      pinned: { current_fingerprint: 'sha256:current', current_valid_until: now },
      resolver: identity.public_key_b64,
      now,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('current_fingerprint_mismatch');
  });

  it('applyCertRotationNotice rejects rotation_at in the past', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const now = 1_000_000_000_000;
    const notice = mintNotice(identity, {
      current: 'sha256:current',
      next: 'sha256:next',
      rotation_at: now - 1,
    });
    const out = applyCertRotationNotice({
      notice,
      pinned: { current_fingerprint: 'sha256:current', current_valid_until: now },
      resolver: identity.public_key_b64,
      now,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('rotation_at_in_past');
  });

  it('applyCertRotationRevertedEvent restores prev fingerprint when matches current', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const event = mintRevert(identity, {
      reverted_to: 'sha256:cafe',
      reverted_at: 1_000_000_000_000,
    });
    const out = applyCertRotationRevertedEvent({
      event,
      pinned: { current_fingerprint: 'sha256:cafe', current_valid_until: 0 },
      resolver: identity.public_key_b64,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.nextPinned.current_fingerprint).toBe('sha256:cafe');
  });

  it('applyCertRotationRevertedEvent rejects unknown revert target', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const event = mintRevert(identity, {
      reverted_to: 'sha256:bogus',
      reverted_at: 1_000_000_000_000,
    });
    const out = applyCertRotationRevertedEvent({
      event,
      pinned: { current_fingerprint: 'sha256:cafe', current_valid_until: 0 },
      resolver: identity.public_key_b64,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('pin_unknown_revert_target');
  });
});
