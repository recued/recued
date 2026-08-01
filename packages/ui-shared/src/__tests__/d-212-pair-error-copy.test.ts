/** D-212 tail #6 — shared `/auth/pair` error presentation.
 *
 *  The defect this fences: both pairing clients carried a hand-copied
 *  "closed list" of four server error codes, each four codes behind the
 *  endpoint, and rendered everything they didn't recognise as *"The server
 *  returned an unexpected response. Check the URL and try again."* For
 *  `instance_revoked`, `realm_directory_conflict`,
 *  `encryption_enrollment_busy` and `database_encryption_not_configured`
 *  — every one of them reachable from `/auth/pair` today — the URL was the
 *  one thing that was right.
 *
 *  So the assertions below are about two properties, not about wording:
 *   1. the four codes that were mute now speak, and
 *   2. an UNMAPPED code degrades to the server's own attributed words —
 *      never to an instruction about something we didn't check. */

import { describe, expect, it } from 'vitest';

import {
  PAIR_SERVER_ERROR_COPY,
  PAIR_SERVER_MESSAGE_MAX_CHARS,
  PAIR_SERVER_REFUSED_COPY,
  describePairServerError,
  hasPairServerErrorCopy,
  sanitizeServerMessage,
} from '../pairing/index.js';

/** The codes `POST /auth/pair` can answer with today, read off
 *  `backend/server/src/server.ts` + `server-vault-enrollment.ts`'s outcome
 *  mapping. ⚠ Kept as data here on purpose: if the endpoint grows a code,
 *  this list is where a reviewer notices the client never learned it.
 *  (`packages/` cannot import `backend/` — the public boundary — so this
 *  cannot be derived by type. It is a tripwire, not a proof.) */
const PAIR_ENDPOINT_CODES_TODAY = [
  'bad_request',
  'invalid_code',
  'recovery_key_invalid',
  'server_not_configured',
  'instance_revoked',
  'database_encryption_not_configured',
  'encryption_enrollment_busy',
  'realm_directory_conflict',
] as const;

/** The four the hand-copied lists in both clients never learned. */
const THE_FOUR_THAT_WERE_MUTE = [
  'instance_revoked',
  'database_encryption_not_configured',
  'encryption_enrollment_busy',
  'realm_directory_conflict',
] as const;

describe('D-212 tail #6 — the codes that used to render as "check the URL"', () => {
  it('has tailored copy for every code /auth/pair can answer with today', () => {
    const missing = PAIR_ENDPOINT_CODES_TODAY.filter((c) => !hasPairServerErrorCopy(c));
    expect(missing).toEqual([]);
  });

  it('never tells a user to check the URL for a server that answered', () => {
    // The URL reached the right server in every one of these; sending the
    // user back to re-check it is the original defect, and it is the thing
    // most likely to creep back in during a copy edit.
    for (const code of THE_FOUR_THAT_WERE_MUTE) {
      const { copy } = describePairServerError(code, 'raw server text');
      expect(copy).not.toMatch(/check the url/i);
      expect(copy.length).toBeGreaterThan(20);
    }
    expect(PAIR_SERVER_REFUSED_COPY).not.toMatch(/check the url/i);
  });

  it('keeps "check the URL" for the one code where it IS the advice', () => {
    // Something answered but does not serve the endpoint — an old server,
    // or not a recued-server at all. Here the URL genuinely is the suspect,
    // and dropping this would over-correct the fix.
    expect(describePairServerError('not_found').copy).toMatch(/check the url/i);
  });

  it('treats a missing recovery verifier as server setup, not a code refresh', () => {
    const { copy } = describePairServerError(
      'server_not_configured',
      'Server has no recovery-key check store.',
    );

    expect(copy).toMatch(/not ready to verify a recovery key/i);
    expect(copy).toMatch(/check the server logs and configuration/i);
    expect(copy).toMatch(/fresh pairing code will not fix/i);
    expect(copy).not.toContain('recued-server pair');
  });

  it('does not quote the raw server message when it has tailored copy', () => {
    // The D-212 realm messages carry internal markers
    // (`D212_REALM_WOULD_ORPHAN_SIBLING`) that no user should have to read.
    const presented = describePairServerError(
      'realm_directory_conflict',
      'D212_REALM_WOULD_ORPHAN_SIBLING: /var/lib/recued/other.db',
    );
    expect(presented.tailored).toBe(true);
    expect(presented.serverSaid).toBeNull();
    expect(presented.copy).not.toContain('D212_');
  });
});

describe('D-212 tail #6 — an unmapped code degrades to the server’s own words', () => {
  it('quotes the server, attributes it, and claims nothing itself', () => {
    const presented = describePairServerError('some_future_code', 'Realm is sealed for maintenance.');
    expect(presented.tailored).toBe(false);
    expect(presented.copy).toBe(PAIR_SERVER_REFUSED_COPY);
    expect(presented.serverSaid).toBe('Realm is sealed for maintenance.');
    // ⚠ Separate fields, never one string: at the pairing screen nothing has
    // authenticated the host, so its words must stay visibly its own.
    expect(presented.copy).not.toContain('Realm is sealed');
    expect(presented.code).toBe('some_future_code');
  });

  it('says nothing on the server’s behalf when it sent no message', () => {
    for (const message of [undefined, '', '   ', null, 42, {}]) {
      const presented = describePairServerError('some_future_code', message);
      expect(presented.serverSaid).toBeNull();
      expect(presented.copy).toBe(PAIR_SERVER_REFUSED_COPY);
    }
  });

  it('treats a missing code as unmapped rather than as a match', () => {
    // `''` must not accidentally index the map or be reported as tailored.
    const presented = describePairServerError('', 'no code at all');
    expect(presented.tailored).toBe(false);
    expect(presented.serverSaid).toBe('no code at all');
  });

  it('does not let an inherited property masquerade as tailored copy', () => {
    // `hasOwnProperty`, not `in` / truthiness: `constructor`, `toString` and
    // friends are on every object's prototype, and a server that answered
    // `{"code":"toString"}` must not be handed `Function.toString` as copy.
    expect(hasPairServerErrorCopy('toString')).toBe(false);
    const presented = describePairServerError('constructor', 'nice try');
    expect(presented.tailored).toBe(false);
    expect(typeof presented.copy).toBe('string');
    expect(presented.copy).toBe(PAIR_SERVER_REFUSED_COPY);
  });
});

describe('D-212 tail #6 — sanitizing what an unauthenticated host sent', () => {
  it('strips control characters that could fake structure', () => {
    const sanitized = sanitizeServerMessage(
      'Pairing failed.\n\nRecued: enter your recovery key at evil.example',
    );
    expect(sanitized).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    // Content is preserved (the quote is honest about what was said) —
    // it is the FRAMING that the attribution + styling take care of.
    expect(sanitized).toContain('Pairing failed.');
  });

  it('collapses whitespace and caps length with an ellipsis', () => {
    expect(sanitizeServerMessage('a   \t  b')).toBe('a b');
    const long = 'x'.repeat(PAIR_SERVER_MESSAGE_MAX_CHARS + 50);
    const capped = sanitizeServerMessage(long)!;
    expect(capped.length).toBe(PAIR_SERVER_MESSAGE_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('returns null for anything with no content', () => {
    for (const raw of ['', '   ', '\n\t', undefined, null, 7, [], {}]) {
      expect(sanitizeServerMessage(raw)).toBeNull();
    }
  });
});

describe('D-212 tail #6 — one vocabulary, not two', () => {
  it('exposes every tailored code through the map the clients spread', () => {
    // Both hosts build their copy map as `{...client, ...PAIR_SERVER_ERROR_COPY}`.
    // If a code were reachable through `describePairServerError` but absent
    // from the map, a host would render `undefined` for it.
    for (const code of Object.keys(PAIR_SERVER_ERROR_COPY)) {
      const presented = describePairServerError(code, 'ignored');
      expect(presented.tailored).toBe(true);
      expect(presented.copy).toBe(
        PAIR_SERVER_ERROR_COPY[code as keyof typeof PAIR_SERVER_ERROR_COPY],
      );
      expect(presented.copy.trim().length).toBeGreaterThan(0);
    }
  });
});
