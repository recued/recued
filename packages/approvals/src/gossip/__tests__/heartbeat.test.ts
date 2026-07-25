/** D-113 — Heartbeat integration tests. */

import { describe, expect, it } from 'vitest';
import type { ApprovalChannelConfig } from '@recued/contracts';
import { randomBytes } from '@recued/crypto';
import {
  gossipActive,
  encryptRecord,
  decryptRecord,
  encryptContribution,
  decryptComposite,
} from '../heartbeat.js';
import { createLocalState, extractContribution } from '../data-plane.js';

const emptyConfig = (): ApprovalChannelConfig => ({
  extension: [],
  slack: [],
  telegram: [],
  email: [],
});

const mkPending = (id: string) => ({
  approval_id: id,
  initiator_instance: 'inst-A',
  recipe_id: 'r',
  step_id: 's',
  prompt: 'Do it?',
  created_at: 100,
  timeout_at: 1_000,
});

const mkAction = (id: string) => ({
  approval_id: id,
  created_by_instance: 'inst-A',
  kind: 'user_action' as const,
  decision: 'approve' as const,
  actor: { channel: 'extension' as const, identifier: 'me' },
  resolved_at: 200,
});

// ── gossipActive ────────────────────────────────────────────────

describe('gossipActive — solo opt-out', () => {
  it('returns false for the singleton extension + no channels + no server', () => {
    const config = emptyConfig();
    config.extension.push({ slug: 'self', permission: 'action', enabled: true });
    expect(gossipActive({ config, server_paired: false })).toBe(false);
  });

  it('returns true when a second extension is enabled', () => {
    const config = emptyConfig();
    config.extension.push(
      { slug: 'laptop', permission: 'action', enabled: true },
      { slug: 'phone', permission: 'read', enabled: true },
    );
    expect(gossipActive({ config, server_paired: false })).toBe(true);
  });

  it('disabled extensions do not count toward the threshold', () => {
    const config = emptyConfig();
    config.extension.push(
      { slug: 'laptop', permission: 'action', enabled: true },
      { slug: 'phone', permission: 'action', enabled: false },
    );
    expect(gossipActive({ config, server_paired: false })).toBe(false);
  });

  it('returns true when any slack channel is enabled', () => {
    const config = emptyConfig();
    config.extension.push({ slug: 'self', permission: 'action', enabled: true });
    config.slack.push({ slug: 'ws', permission: 'action', enabled: true });
    expect(gossipActive({ config, server_paired: false })).toBe(true);
  });

  it('returns true when any telegram channel is enabled', () => {
    const config = emptyConfig();
    config.extension.push({ slug: 'self', permission: 'action', enabled: true });
    config.telegram.push({ slug: 'chat', permission: 'action', enabled: true });
    expect(gossipActive({ config, server_paired: false })).toBe(true);
  });

  it('returns true when any email channel is enabled', () => {
    const config = emptyConfig();
    config.extension.push({ slug: 'self', permission: 'action', enabled: true });
    config.email.push({
      slug: 'e', permission: 'action', enabled: true, to_address: 'x@y',
    });
    expect(gossipActive({ config, server_paired: false })).toBe(true);
  });

  it('returns true when paired server exists (acts as audit peer)', () => {
    const config = emptyConfig();
    config.extension.push({ slug: 'self', permission: 'action', enabled: true });
    expect(gossipActive({ config, server_paired: true })).toBe(true);
  });

  it('returns false when all channels disabled and no server', () => {
    const config = emptyConfig();
    config.slack.push({ slug: 'ws', permission: 'action', enabled: false });
    config.telegram.push({ slug: 'ch', permission: 'action', enabled: false });
    expect(gossipActive({ config, server_paired: false })).toBe(false);
  });
});

// ── Encrypt / decrypt round trip ────────────────────────────────

describe('encrypt/decrypt round trip', () => {
  it('preserves pending records through encrypt → decrypt', async () => {
    const dek = randomBytes(32);
    const pending = mkPending('ap-1');
    const blob = await encryptRecord(dek, pending, 'inst-A');
    expect(blob.from).toBe('inst-A');
    const back = await decryptRecord<typeof pending>(dek, blob);
    expect(back).toEqual(pending);
  });

  it('preserves action records through encrypt → decrypt', async () => {
    const dek = randomBytes(32);
    const action = mkAction('ap-1');
    const blob = await encryptRecord(dek, action, 'inst-B');
    const back = await decryptRecord<typeof action>(dek, blob);
    expect(back).toEqual(action);
  });

  it('uses a fresh IV per encryption (ciphertext varies)', async () => {
    const dek = randomBytes(32);
    const p = mkPending('ap-1');
    const a = await encryptRecord(dek, p, 'inst-A');
    const b = await encryptRecord(dek, p, 'inst-A');
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('rejects decryption under the wrong key', async () => {
    const dek = randomBytes(32);
    const dekOther = randomBytes(32);
    const p = mkPending('ap-1');
    const blob = await encryptRecord(dek, p, 'inst-A');
    await expect(decryptRecord(dekOther, blob)).rejects.toThrow();
  });
});

// ── Contribution round trip ─────────────────────────────────────

describe('encryptContribution + decryptComposite', () => {
  it('round-trips a full local.state snapshot', async () => {
    const dek = randomBytes(32);
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));
    state.pending.set('ap-2', mkPending('ap-2'));
    state.action.set('ap-1', [mkAction('ap-1')]);
    const contribution = extractContribution(state);

    const payload = await encryptContribution(dek, contribution, 'inst-A');
    expect(payload.pending).toHaveLength(2);
    expect(payload.actions).toHaveLength(1);
    // Every blob stamped with the sender id.
    expect(payload.pending.every((b) => b.from === 'inst-A')).toBe(true);

    const back = await decryptComposite(dek, payload);
    expect(back.pending.map((p) => p.approval_id).sort()).toEqual(['ap-1', 'ap-2']);
    expect(back.action).toHaveLength(1);
    expect(back.action[0]!.approval_id).toBe('ap-1');
  });

  it('silently skips blobs that fail AEAD (wrong key, tampered)', async () => {
    const dek = randomBytes(32);
    const dekOther = randomBytes(32);
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));

    const payload = await encryptContribution(dekOther, extractContribution(state), 'inst-A');
    const back = await decryptComposite(dek, payload);
    // Can't decrypt (wrong key) → drops silently, returns empty.
    expect(back.pending).toEqual([]);
    expect(back.action).toEqual([]);
  });

  it('partial decrypt: valid blobs survive even if one is corrupted', async () => {
    const dek = randomBytes(32);
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));
    state.pending.set('ap-2', mkPending('ap-2'));
    const payload = await encryptContribution(
      dek, extractContribution(state), 'inst-A',
    );
    // Corrupt one blob's ciphertext.
    payload.pending[0] = { ...payload.pending[0]!, ciphertext: 'AAAA' };
    const back = await decryptComposite(dek, payload);
    // Only the second survives.
    expect(back.pending).toHaveLength(1);
    expect(back.pending[0]!.approval_id).toBe('ap-2');
  });

  it('empty contribution yields empty payload', async () => {
    const dek = randomBytes(32);
    const payload = await encryptContribution(
      dek, { pending: [], action: [] }, 'inst-A',
    );
    expect(payload.pending).toEqual([]);
    expect(payload.actions).toEqual([]);
    const back = await decryptComposite(dek, payload);
    expect(back.pending).toEqual([]);
    expect(back.action).toEqual([]);
  });
});
