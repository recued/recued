/** D-113 — Heartbeat integration for the gossip protocol.
 *
 *  Three responsibilities:
 *
 *  1. **Encrypt / decrypt plumbing.** Contributions flow from the
 *     data-plane as plaintext records. Before a contribution rides
 *     the heartbeat outbound, each record is serialised + AES-GCM-
 *     encrypted with the account's approval sub-DEK and wrapped in
 *     an EncryptedBlob. On inbound, the symmetric decrypt restores
 *     the plaintext records for the data plane to merge. The
 *     heartbeat relay + cloud Worker see only opaque blobs.
 *
 *  2. **Solo-config opt-out.** When a user has only one action
 *     surface (their single extension, no server, no channels) the
 *     gossip is a noop — there's no other peer to converge with.
 *     `gossipActive` returns false in that case and callers omit
 *     the `approvals` field from the heartbeat entirely, keeping
 *     the wire slim for the common single-instance Pro user.
 *
 *  3. **Adapter-friendly types.** `HeartbeatContributionBuilder`
 *     wraps the extract-encrypt-wrap pipeline so the caller writes
 *     `await builder.build(state)` instead of orchestrating five
 *     helper calls.
 */

import { encrypt, decrypt, bytesToBase64, base64ToBytes } from '@recued/crypto';
import {
  type ApprovalChannelConfig,
  type ApprovalPendingRecord,
  type ApprovalResolutionRecord,
  type EncryptedBlob,
  type HeartbeatApprovalsPayload,
} from '@recued/contracts';
import type { RemoteContribution } from './data-plane.js';

// ── Solo-config opt-out ─────────────────────────────────────────

export interface GossipActiveContext {
  /** Every active channel, across all families. `extension` counts
   *  only enabled entries; the singleton "I'm my only surface" case
   *  has one enabled extension and is the opt-out trigger. */
  config: ApprovalChannelConfig;
  /** True when the current runtime has a paired server. A paired
   *  server is itself a gossip peer (it writes audit records) so
   *  it counts toward "needs gossip" even if no other action
   *  surface is enabled. */
  server_paired: boolean;
}

/** Return true when the outbound heartbeat should include an
 *  encrypted approvals payload. False when the instance is the
 *  only action surface — no gossip peer to converge with. */
export const gossipActive = (ctx: GossipActiveContext): boolean => {
  const enabledExtensions = ctx.config.extension.filter((c) => c.enabled).length;
  if (enabledExtensions > 1) return true;
  if (ctx.config.slack.some((c) => c.enabled)) return true;
  if (ctx.config.telegram.some((c) => c.enabled)) return true;
  if (ctx.config.email.some((c) => c.enabled)) return true;
  if (ctx.server_paired) return true;
  return false;
};

// ── Encrypt / decrypt round trip ────────────────────────────────

/** Sub-DEK bytes for the account-scoped approval domain. 32 bytes
 *  for AES-256-GCM. Derivation lives in the crypto package; this
 *  module just consumes the already-derived key. */
export type ApprovalDEK = Uint8Array;

/** Serialise one pending record to bytes for AEAD encryption. */
const encodeRecord = (record: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(record));

const decodeRecord = <T>(bytes: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(bytes)) as T;

/** Encrypt one plaintext record into the wire blob shape. */
export const encryptRecord = async (
  dek: ApprovalDEK,
  record: ApprovalPendingRecord | ApprovalResolutionRecord,
  from: string,
): Promise<EncryptedBlob> => {
  const plaintext = encodeRecord(record);
  const { iv, ct } = await encrypt(dek, plaintext);
  return {
    ciphertext: bytesToBase64(ct),
    iv: bytesToBase64(iv),
    from,
  };
};

/** Decrypt one wire blob into its plaintext record. Throws on AEAD
 *  tag failure (tampered blob or wrong key). */
export const decryptRecord = async <T>(
  dek: ApprovalDEK,
  blob: EncryptedBlob,
): Promise<T> => {
  const iv = base64ToBytes(blob.iv);
  const ct = base64ToBytes(blob.ciphertext);
  const plaintext = await decrypt(dek, { iv, ct });
  return decodeRecord<T>(plaintext);
};

/** Encrypt an entire contribution (local.pending + local.action)
 *  into the wire payload. Each record gets its own blob so partial
 *  decrypts on the receiving side still yield usable subsets. */
export const encryptContribution = async (
  dek: ApprovalDEK,
  contribution: RemoteContribution,
  from: string,
): Promise<HeartbeatApprovalsPayload> => {
  const pending = await Promise.all(
    contribution.pending.map((p) => encryptRecord(dek, p, from)),
  );
  const actions = await Promise.all(
    contribution.action.map((a) => encryptRecord(dek, a, from)),
  );
  return { pending, actions };
};

/** Decrypt an inbound heartbeat composite into plaintext records the
 *  data plane merges. Skips blobs that fail AEAD — a bad blob from
 *  one peer shouldn't poison the rest of the round. */
export const decryptComposite = async (
  dek: ApprovalDEK,
  payload: HeartbeatApprovalsPayload,
): Promise<RemoteContribution> => {
  const pending = await decryptArray<ApprovalPendingRecord>(dek, payload.pending);
  const action = await decryptArray<ApprovalResolutionRecord>(dek, payload.actions);
  return { pending, action };
};

const decryptArray = async <T>(
  dek: ApprovalDEK,
  blobs: readonly EncryptedBlob[],
): Promise<T[]> => {
  const out: T[] = [];
  for (const blob of blobs) {
    try {
      out.push(await decryptRecord<T>(dek, blob));
    } catch {
      // Skip — malformed / tampered / foreign-key blobs are dropped
      // silently so one bad peer doesn't break the round.
    }
  }
  return out;
};
