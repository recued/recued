/** D-192 — Discord inbound interaction protocol (Ed25519).
 *
 *  The first ASYMMETRIC verification scheme in the messenger family. Slack and
 *  WhatsApp HMAC the body with a shared secret; Telegram compares a shared token.
 *  Discord signs `<X-Signature-Timestamp><raw body>` with its application's private
 *  key and gives you the matching PUBLIC key — so there is no shared secret here at
 *  all, and nothing to leak. (`MessengerIngress.secret_field` names the config KEY
 *  the verifier reads, which is why a public key fits the facet unchanged.)
 *
 *  ⚠ Discord VALIDATES YOUR VALIDATION. When you save an Interactions Endpoint URL
 *  it sends deliberately-INVALID signatures and requires a **401** back. An endpoint
 *  that verifies lazily — or that only checks the happy path — is rejected outright,
 *  so a permissive verifier here does not degrade quietly; it fails to register at
 *  all. That is a rare and welcome thing, and it is why every reject path below is
 *  as deliberate as the accept path.
 *
 *  No replay window: the signature covers a timestamp, but Discord does not specify
 *  a tolerance and interactions are one-shot (a stale replay could at most re-press a
 *  button the block's first-answer-wins dedup already ignores). The port's
 *  idempotency ledger keys on the interaction's unique snowflake `id`, which is the
 *  exact defence.
 */

import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** The two headers Discord signs with. */
export const DISCORD_SIGNATURE_HEADER = 'x-signature-ed25519';
export const DISCORD_TIMESTAMP_HEADER = 'x-signature-timestamp';

/** A raw Ed25519 public key is 32 bytes, presented as 64 lowercase hex chars. */
const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** An Ed25519 signature is 64 bytes → 128 hex chars. */
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

/** The fixed SPKI DER prefix for an Ed25519 public key (OID 1.3.101.112).
 *
 *  Node's `createPublicKey` will not take a bare 32-byte key — it wants a structured
 *  key — so the raw bytes are wrapped in the 12-byte header that makes them a
 *  well-formed SPKI document. This is a CONSTANT, not a computation: every Ed25519
 *  SPKI key has exactly these leading bytes, and only the trailing 32 differ. Doing
 *  it here keeps a third-party crypto dependency out of the tree for what is, in the
 *  end, a byte concatenation. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const isValidDiscordPublicKey = (key: unknown): key is string =>
  typeof key === 'string' && PUBLIC_KEY_PATTERN.test(key.trim().toLowerCase());

/** Verify a Discord interaction signature over the EXACT request bytes.
 *
 *  ⚠ The raw buffer, never a re-serialized string — the same trap as WhatsApp. A
 *  Discord message can carry any UTF-8 the user typed, and `JSON.stringify(JSON.parse(b))`
 *  produces different bytes for a great deal of it. Re-serializing passes every ASCII
 *  fixture and rejects real traffic.
 *
 *  Returns false — never throws — for a malformed key, a malformed signature, a
 *  missing header, or a bad signature. The caller renders that as a 401, which is
 *  precisely what Discord's endpoint validation demands. */
export const verifyDiscordSignature = (input: {
  raw_body: Buffer;
  signature_header: string | undefined;
  timestamp_header: string | undefined;
  public_key: string;
}): boolean => {
  if (!isValidDiscordPublicKey(input.public_key)) return false;
  if (typeof input.signature_header !== 'string') return false;
  if (typeof input.timestamp_header !== 'string' || input.timestamp_header.length === 0) {
    return false;
  }
  const signatureHex = input.signature_header.trim().toLowerCase();
  if (!SIGNATURE_PATTERN.test(signatureHex)) return false;
  // A timestamp that is not a plain integer is not something Discord sent. Refuse on
  // grammar before feeding it into the signed message.
  if (!/^[0-9]{1,20}$/.test(input.timestamp_header)) return false;

  let key;
  try {
    key = createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(input.public_key.trim().toLowerCase(), 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return false;
  }

  const message = Buffer.concat([
    Buffer.from(input.timestamp_header, 'utf8'),
    input.raw_body,
  ]);
  try {
    // Ed25519 verification is not a digest comparison — `crypto.verify` with a null
    // algorithm is the whole check, and it is constant-time by construction.
    return verify(null, message, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
};

/** Discord's endpoint-validation PING (`type: 1`) must be answered with a PONG
 *  (`{"type": 1}`) — and only AFTER the signature verifies, since the PING is exactly
 *  what Discord replays with a bad signature to check that you refuse it.
 *
 *  Exported as a constant rather than built inline so the provider and its tests
 *  cannot disagree about the one body Discord will accept. */
export const DISCORD_PONG_BODY = JSON.stringify({ type: 1 });

/** `DEFERRED_UPDATE_MESSAGE` — acknowledge a component press WITHOUT changing the
 *  message and without showing the user a loading state. The right ack for Recued:
 *  the press is recorded, and the message is edited later (buttons stripped) by
 *  `closeAsk` → `closePrompt`, which is a separate PATCH.
 *
 *  ⚠ Discord requires SOME response within 3 seconds or the user sees "This
 *  interaction failed" — even though the answer was recorded. See the provider. */
export const DISCORD_DEFERRED_ACK_BODY = JSON.stringify({ type: 6 });

/** Constant-time compare helper kept for symmetry with the other protocols; Ed25519
 *  needs none, but a future scheme added here should not have to rediscover it. */
export const constantTimeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
};
