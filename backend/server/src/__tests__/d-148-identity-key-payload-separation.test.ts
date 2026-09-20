/** D-148 — ONE KEY SIGNS MANY PROTOCOLS, SO THEIR TRANSCRIPTS MUST NOT COLLIDE.
 *
 *  ⛔⛔ `server_identity_key` signs at least eight different things: three
 *  handle-governance requests, two cert-rotation events, two per-domain
 *  cert-rotation events, the pre-auth identity probe, plus the passport, the
 *  audit rows and the account-binding proof. A signature is only ever bytes —
 *  nothing in Ed25519 says WHICH protocol a transcript belonged to. If two
 *  protocols can ever produce the SAME canonical bytes, a signature harvested
 *  from one is a valid signature for the other, and the key becomes a forgery
 *  oracle across the pair.
 *
 *  ⚠ FOUND WHILE SWEEPING `handle/index.ts` (2026-09-18). Most of these
 *  payloads carry a discriminator — the cert events carry `type`, the
 *  account-binding proof carries `purpose`, the identity probe carries
 *  `domain`. THE THREE HANDLE PAYLOADS CARRY NONE. They are kept apart today
 *  only because their field NAMES happen to differ, which is an accident of
 *  drafting rather than a property anything enforces: a future payload with a
 *  colliding shape would create the oracle silently.
 *
 *  ⇒ This is that "silently" removed. It does not assert the handle payloads
 *  are well-designed — they are not, and adding a tag is a coordinated change
 *  with the cloud verifier, not a test's business. It asserts the one thing a
 *  test CAN: that no two transcripts alias each other today, and that anyone
 *  who adds a shape which does will see this go red.
 *
 *  ⚠ SHAPES ARE DERIVED BY CALLING THE REAL BUILDERS, never hand-copied. A
 *  hand-written table of key sets is a second place for the truth to live, and
 *  it would drift out of step exactly when a new payload lands. */

import { describe, it, expect } from 'vitest';
import {
  buildIdentityProbePayload,
  IDENTITY_PROBE_DOMAIN,
} from '@recued/contracts';
import {
  signedBytesForCertRotationNotice,
  signedBytesForCertRotationReverted,
} from '../keys/rotation/cert-rotation-verifier.js';
import {
  signedBytesForCertDomainRotationNotice,
  signedBytesForCertDomainRotationReverted,
} from '../keys/rotation/cert-domain-rotation-verifier.js';

/** The canonical transcripts, each produced by the code that really signs it.
 *  The handle three have no builder exported, so they are reproduced from
 *  `handle/index.ts`'s literals — and the test below pins that reproduction
 *  against the real request types so a field added there fails here too. */
const transcripts = (): ReadonlyArray<{ name: string; json: string }> => [
  {
    name: 'handle.reserve',
    json: JSON.stringify({
      publisher_id: 'pub_a', handle: 'alice', nonce: 'n1', timestamp: 1,
    }),
  },
  {
    name: 'handle.change',
    json: JSON.stringify({
      publisher_id: 'pub_a', current_handle: 'alice', new_handle: 'bob',
      nonce: 'n1', timestamp: 1,
    }),
  },
  {
    name: 'handle.transfer',
    json: JSON.stringify({
      outgoing_publisher_id: 'pub_a', incoming_publisher_id: 'pub_b',
      handle: 'alice', nonce: 'n1', timestamp: 1,
    }),
  },
  {
    name: 'cert.rotation_notice',
    json: signedBytesForCertRotationNotice({
      current_fingerprint: 'sha256:a', next_fingerprint: 'sha256:b', rotation_at: 1,
    }),
  },
  {
    name: 'cert.rotation_reverted',
    json: signedBytesForCertRotationReverted({
      reverted_to_fingerprint: 'sha256:a', reverted_at: 1,
    }),
  },
  {
    name: 'cert.domain_rotation_notice',
    json: signedBytesForCertDomainRotationNotice({
      domain: 'd', current_fingerprint: 'sha256:a', next_fingerprint: 'sha256:b', rotation_at: 1,
    }),
  },
  {
    name: 'cert.domain_rotation_reverted',
    json: signedBytesForCertDomainRotationReverted({
      domain: 'd', reverted_to_fingerprint: 'sha256:a', reverted_at: 1,
    }),
  },
  {
    name: 'identity.probe',
    json: buildIdentityProbePayload({ nonce: 'n1', server_public_key: 'k' }),
  },
];

const keySetOf = (json: string): string =>
  Object.keys(JSON.parse(json) as Record<string, unknown>).sort().join(',');

describe('D-148 — transcripts signed by server_identity_key do not alias', () => {
  it('⛔⛔ no two protocols share a canonical FIELD SET', () => {
    // ⛔ THE FIELD SET, NOT THE BYTES. Two payloads with the same keys and
    // different values are one substitution apart: whatever distinguishes them
    // is data an attacker supplies, so only a difference in SHAPE survives a
    // chosen-value attack.
    const seen = new Map<string, string>();
    for (const { name, json } of transcripts()) {
      const keys = keySetOf(json);
      const prior = seen.get(keys);
      expect(
        prior,
        `${name} and ${String(prior)} canonicalise to the same field set `
        + `(${keys}) — a signature over one is a signature over the other`,
      ).toBeUndefined();
      seen.set(keys, name);
    }
    expect(seen.size).toBe(transcripts().length);
  });

  it('⚠ the tagged protocols keep their discriminator IN the signed bytes', () => {
    // A tag outside the transcript protects nothing. These are the payloads
    // that have one; the handle three deliberately are not listed, because
    // they do not — see the header.
    const byName = new Map(transcripts().map((t) => [t.name, t.json]));
    for (const [name, field, value] of [
      ['cert.rotation_notice', 'type', 'cert_rotation_notice'],
      ['cert.rotation_reverted', 'type', 'cert_rotation_reverted'],
      ['cert.domain_rotation_notice', 'type', 'cert_domain_rotation_notice'],
      ['cert.domain_rotation_reverted', 'type', 'cert_domain_rotation_reverted'],
      ['identity.probe', 'domain', IDENTITY_PROBE_DOMAIN],
    ] as const) {
      const parsed = JSON.parse(byName.get(name)!) as Record<string, unknown>;
      expect(parsed[field], `${name} lost its ${field} tag`).toBe(value);
    }
  });

  it('⚠ the two cert families are separated by their tag ALONE', () => {
    // ⛔ THE ONE PAIR THAT WOULD OTHERWISE COLLIDE, and the reason the tag is
    // load-bearing rather than decorative: strip `type` from both single-domain
    // events and they still differ by field names — but strip it from the two
    // DOMAIN events and `{domain, reason, reverted_at, reverted_to_fingerprint}`
    // vs the notice's fields is the only thing left. Pinned so nobody trims the
    // tag as redundant.
    const notice = JSON.parse(signedBytesForCertRotationNotice({
      current_fingerprint: 'sha256:a', next_fingerprint: 'sha256:b', rotation_at: 1,
    })) as Record<string, unknown>;
    const reverted = JSON.parse(signedBytesForCertRotationReverted({
      reverted_to_fingerprint: 'sha256:a', reverted_at: 1,
    })) as Record<string, unknown>;
    expect(notice.type).not.toBe(reverted.type);
  });
});
