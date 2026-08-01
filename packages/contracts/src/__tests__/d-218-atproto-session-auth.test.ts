/** D-218 slice 0 — the `atproto_session` auth type, and the vocabulary that
 *  now derives instead of being copied.
 *
 *  ⛔ **Slice 0 was specced as "add a case in 6 places" and the COMPILER found
 *  ZERO of them.** Widening `ConnectionAuth` produced no type error anywhere:
 *  three separate hand-kept copies of the vocabulary existed and all three
 *  typechecked while incomplete, because a subset is always assignable.
 *
 *  ⚠ **Two RUNTIME ratchets did fire** (`d-194-connection-requirements`,
 *  `d-125-phase-7-connections-page`), and they are the reason the gap was
 *  visible at all — worth saying plainly, because "nothing caught it" would be
 *  the more flattering story and it is not true. What no ratchet covered was
 *  the secret-redaction switch, which is where the real leak was. So the
 *  derivation the spec asked for had to be BUILT before it could be used, and
 *  these tests pin it — including the direction `satisfies` cannot express.
 *
 *  Spec: D-218 § 7.5, § 8.1.
 */

import { describe, it, expect } from 'vitest';
import {
  CONNECTION_AUTH_TYPES,
  CONNECTION_AUTH_DESCRIPTOR_TYPES,
  resolveBearerAccessToken,
  validateConnectionRequirementShape,
  type ConnectionAuth,
} from '../index.js';

/** The descriptor validator is internal; it is reached through the requirement
 *  shape check, which is the surface a pack actually goes through. Driving the
 *  real gate rather than the helper is the point — a pack never calls the
 *  helper. */
const requirementIssues = (auth: unknown): string[] =>
  validateConnectionRequirementShape({
    api_base: 'https://bsky.social',
    vendor: 'bluesky',
    auth,
  });

const session = (over: Partial<Record<string, unknown>> = {}): ConnectionAuth => ({
  type: 'atproto_session',
  identifier: 'alice.bsky.social',
  app_password: 'abcd-efgh-ijkl-mnop',
  ...over,
} as ConnectionAuth);

describe('D-218 — the closed vocabulary is ONE list, checked both ways', () => {
  it('carries every ConnectionAuth discriminant, atproto_session included', () => {
    expect(CONNECTION_AUTH_TYPES).toContain('atproto_session');
    // The seven that existed before must all survive — a derivation that
    // dropped one would be a silent enrollment regression.
    for (const t of [
      'none', 'bearer', 'basic', 'header', 'query',
      'oauth2_refresh', 'oauth2_client_credentials',
    ]) {
      expect(CONNECTION_AUTH_TYPES, t).toContain(t);
    }
    expect(new Set(CONNECTION_AUTH_TYPES).size).toBe(CONNECTION_AUTH_TYPES.length);
  });

  it('⛔ is the SAME list the pack-side descriptor vocabulary uses', () => {
    // These were two hand-kept copies that happened to agree. "Happened to" was
    // doing real work: widening the union left the descriptor list short and
    // nothing complained.
    expect([...CONNECTION_AUTH_DESCRIPTOR_TYPES]).toEqual([...CONNECTION_AUTH_TYPES]);
  });
});

describe('D-218 — resolveBearerAccessToken', () => {
  it('returns the exchanged accessJwt', () => {
    expect(resolveBearerAccessToken(session({ current_access_token: 'jwt-1' })))
      .toBe('jwt-1');
  });

  it('returns undefined before any exchange has run', () => {
    // ⚠ Not an error here — the dispatch path decides, exactly as it does for
    // an OAuth2 row that has not minted a token yet.
    expect(resolveBearerAccessToken(session())).toBeUndefined();
  });

  it('⛔ never returns the app password as a bearer', () => {
    // The one confusion this seam could plausibly make: the stored credential
    // is NOT the thing you send. Sending it as a bearer would put a reusable
    // account credential on every request.
    const auth = session({ current_access_token: '' });
    expect(resolveBearerAccessToken(auth)).toBeUndefined();
    expect(resolveBearerAccessToken(session())).not.toBe('abcd-efgh-ijkl-mnop');
  });
});

describe('D-218 — the descriptor carries no endpoint, deliberately', () => {
  it('accepts the bare descriptor through the real requirement gate', () => {
    expect(requirementIssues({ type: 'atproto_session' })).toEqual([]);
  });

  it('⛔ a pack cannot name where the app password is POSTed', () => {
    // § 7.5b — the session URLs derive from the connection's own api_base. A
    // descriptor field naming a credential-only destination is the highest-value
    // exfiltration primitive in the system, so the shape simply has no slot for
    // one: an extra key is ignored, never honoured.
    const d = { type: 'atproto_session', token_endpoint: 'https://evil.example.com/x' };
    expect(requirementIssues(d)).toEqual([]);
    // …and the descriptor type declares no such field, so nothing can read it.
    expect(Object.keys({ type: 'atproto_session' } as const)).toEqual(['type']);
  });

  it('still rejects a type outside the closed list', () => {
    const issues = requirementIssues({ type: 'atproto_password' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes('auth.type must be one of'))).toBe(true);
  });
});
