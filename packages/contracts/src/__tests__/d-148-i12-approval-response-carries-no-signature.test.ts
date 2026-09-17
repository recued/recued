/** D-148 I-12 — an approval response carries a NONCE, never a SIGNATURE.
 *
 *  ⛔ THE SPEC CLAIMED A LINT THAT DOES NOT EXIST. I-12's enforcement cell reads
 *  *"P4: nonce-replay test + nonce-binding test; no `signature` field in
 *  `ApprovalResponse` (lint)"*. The two nonce tests are real. The `(lint)`
 *  names nothing — found 2026-09-17 while spot-checking the invariant table
 *  after I-15's enforcement turned out to be fictional too.
 *
 *  ⚠ THE PROPERTY HOLDS TODAY. Neither shape carries a signature. That is
 *  exactly the state worth guarding: "true now" and "defended" look identical
 *  from the code and differ entirely under the next edit.
 *
 *  ── Why the rule exists ─────────────────────────────────────────────────
 *  D-148 § A.4.3 binds an approval decision with a SERVER-ISSUED, SINGLE-USE
 *  NONCE that the server verifies against `(approval_id, responder_client_id)`.
 *  A client-side `signature` would be a second, weaker authenticator on the
 *  same decision — one the client mints, so a replay of it is indistinguishable
 *  from a fresh answer, and one whose presence invites a verifier to accept it
 *  INSTEAD of consuming the nonce. Two authenticators on one decision is how a
 *  single-use guarantee quietly becomes reusable.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Read an interface body out of the source. ⚠ Source-level on purpose: a
 *  TYPE has no runtime representation to assert against, so the declaration is
 *  the only artifact there is. */
const interfaceBody = (file: string, name: string): string => {
  const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf-8');
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `${name} not found in ${file} — has it been renamed?`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('D-148 I-12 — no signature on an approval response', () => {
  it('⛔ ApprovalResponse declares no signature field', () => {
    const body = interfaceBody('approval.ts', 'ApprovalResponse');
    expect(body).not.toMatch(/^\s*(readonly\s+)?signature\??:/m);
  });

  it('⛔ ApprovalResponseWire declares no signature field', () => {
    // The WIRE shape is the one that matters most: it is what a client sends,
    // so a field here is a field a server would have to decide whether to
    // trust.
    const body = interfaceBody('webclient.ts', 'ApprovalResponseWire');
    expect(body).not.toMatch(/^\s*(readonly\s+)?signature\??:/m);
  });

  it('⚠ nor any adjacent name that would serve the same purpose', () => {
    // A denylist of one word is evaded by calling it something else. These are
    // the names a second authenticator would plausibly arrive under.
    for (const [file, name] of [
      ['approval.ts', 'ApprovalResponse'],
      ['webclient.ts', 'ApprovalResponseWire'],
    ] as const) {
      const body = interfaceBody(file, name);
      for (const banned of ['signature', 'signed', 'sig', 'mac', 'hmac', 'proof', 'attestation']) {
        expect(body, `${name} gained a \`${banned}\` field — see the header`)
          .not.toMatch(new RegExp(`^\\s*(readonly\\s+)?${banned}\\??:`, 'mi'));
      }
    }
  });

  it('✅ and the nonce — the authenticator that IS specified — is still there', () => {
    // ⚠ The half that makes the rule coherent. Asserting only an ABSENCE would
    // pass just as happily if the whole shape were gutted, which is a different
    // and worse failure than the one this file guards.
    expect(interfaceBody('webclient.ts', 'ApprovalResponseWire')).toMatch(/^\s*nonce:\s*string;/m);
  });
});
