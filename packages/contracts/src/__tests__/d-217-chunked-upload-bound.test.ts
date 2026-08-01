/** D-217 slice 1 — the Invariant 1 carve-out predicate.
 *
 *  ⛔ **This is the security boundary of the whole D, so it is tested as an
 *  ATTACK SURFACE, not as a shape check.** `followPagination` refuses to
 *  re-dispatch a write op because a response cursor is attacker-influenced and
 *  following one with a write is an amplification primitive. A chunk walk is
 *  permitted instead of forbidden only while
 *
 *    the number of requests is fixed before the first dispatch and is
 *    independent of every value the target returns.
 *
 *  Every test below is a way a third-party pack could try to make the count
 *  depend on the target. The predicate runs over UNTRUSTED JSON (`unknown`) —
 *  checking the narrowed TS type would be a tautology, since the type is what
 *  we wish had arrived rather than what did.
 */

import { describe, expect, it } from 'vitest';

import {
  CHUNKED_UPLOAD_MAX_POLLS_CEILING,
  HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
  chunkedUploadBoundViolations,
} from '../op-model.js';

/** X's media protocol, as a pack would declare it. Admissible. */
const X_MEDIA = {
  kind: 'chunked',
  arg: 'media',
  chunk_bytes: 5 * 1024 * 1024,
  max_bytes: 512 * 1024 * 1024,
  session_from: 'media_id_string',
  init: {
    method: 'POST',
    path: '/1.1/media/upload.json',
    query: { command: 'INIT', total_bytes: '{total_bytes}', media_type: 'video/mp4' },
  },
  append: {
    method: 'POST',
    path: '/1.1/media/upload.json',
    query: {
      command: 'APPEND',
      media_id: '{session}',
      segment_index: '{segment_index}',
    },
  },
  finalize: {
    method: 'POST',
    path: '/1.1/media/upload.json',
    query: { command: 'FINALIZE', media_id: '{session}' },
  },
  status: {
    method: 'GET',
    path: '/1.1/media/upload.json',
    query: { command: 'STATUS', media_id: '{session}' },
    max_polls: 20,
    done: { path: 'processing_info.state', equals: 'succeeded' },
  },
};

const withSpec = (patch: Record<string, unknown>): Record<string, unknown> =>
  ({ ...X_MEDIA, ...patch });
const withPhase = (
  phase: 'init' | 'append' | 'finalize' | 'status',
  patch: Record<string, unknown>,
): Record<string, unknown> =>
  ({ ...X_MEDIA, [phase]: { ...(X_MEDIA as never as Record<string, Record<string, unknown>>)[phase], ...patch } });

const fields = (v: unknown): string[] =>
  chunkedUploadBoundViolations(v).map((x) => x.field);

// ════════════════════════════════════════════════════════════════════
// The admissible case — and it must NOT be vacuous
// ════════════════════════════════════════════════════════════════════

describe('the carve-out admits a real protocol', () => {
  it('accepts X media unchanged', () => {
    expect(chunkedUploadBoundViolations(X_MEDIA)).toEqual([]);
  });

  it('accepts a declaration with no status poll at all', () => {
    const { status: _drop, ...noPoll } = X_MEDIA;
    expect(chunkedUploadBoundViolations(noPoll)).toEqual([]);
  });

  it('accepts a lowered max_bytes, and omitted max_bytes', () => {
    expect(chunkedUploadBoundViolations(withSpec({ max_bytes: 1024 }))).toEqual([]);
    const { max_bytes: _drop, ...noCap } = X_MEDIA;
    expect(chunkedUploadBoundViolations(noCap)).toEqual([]);
  });

  it('lets an op reference its OWN args — only engine tokens are reserved', () => {
    // `{media_type}` is an op arg, not an engine token; rejecting it would make
    // the predicate unusable rather than safe.
    expect(chunkedUploadBoundViolations(
      withPhase('init', { query: { command: 'INIT', media_type: '{media_type}' } }),
    )).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 1. the divisor — the whole attack in one field
// ════════════════════════════════════════════════════════════════════

describe('chunk_bytes must be a literal', () => {
  it('⛔ rejects a TEMPLATE chunk_bytes — a response value setting the count', () => {
    expect(fields(withSpec({ chunk_bytes: '{session}' }))).toContain('chunk_bytes');
  });

  it('⛔ rejects a numeric STRING — the shape a JSON manifest smuggles it as', () => {
    expect(fields(withSpec({ chunk_bytes: '5242880' }))).toContain('chunk_bytes');
  });

  it('rejects zero, negative, fractional and non-finite divisors', () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(fields(withSpec({ chunk_bytes: v })), String(v)).toContain('chunk_bytes');
    }
  });

  it('rejects a missing chunk_bytes rather than defaulting one', () => {
    const { chunk_bytes: _drop, ...noDivisor } = X_MEDIA;
    expect(fields(noDivisor)).toContain('chunk_bytes');
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. closed key sets — no SYNTAX for a response-driven loop
// ════════════════════════════════════════════════════════════════════

describe('closed key sets leave a response value nowhere to bind', () => {
  it('⛔ rejects a server-directed resume offset on the spec', () => {
    // YouTube's true resumable protocol asks the server for the committed
    // offset. That is precisely a response value driving the loop, so it is
    // deliberately inexpressible here.
    expect(fields(withSpec({ next_offset_from: 'headers.Range' })))
      .toContain('next_offset_from');
  });

  it('⛔ rejects a repeat_while / until / count key on the spec', () => {
    for (const key of ['repeat_while', 'until', 'count', 'max_requests']) {
      expect(fields(withSpec({ [key]: 'x' })), key).toContain(key);
    }
  });

  it('⛔ rejects an unknown key on a PHASE', () => {
    expect(fields(withPhase('append', { repeat_until: 'done' })))
      .toContain('append.repeat_until');
    expect(fields(withPhase('append', { next_offset_from: 'body.offset' })))
      .toContain('append.next_offset_from');
  });

  it('rejects a phase that is not an object at all', () => {
    expect(fields(withSpec({ append: 'POST /x' }))).toContain('append');
    expect(fields(withSpec({ append: ['POST'] }))).toContain('append');
    expect(fields(withSpec({ append: null }))).toContain('append');
  });

  it('reports EVERY violation, not just the first', () => {
    const v = chunkedUploadBoundViolations(withSpec({
      chunk_bytes: '{session}',
      next_offset_from: 'x',
      session_from: '',
    }));
    expect(v.map((x) => x.field).sort())
      .toEqual(['chunk_bytes', 'next_offset_from', 'session_from']);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. the token set — {session} where it belongs, nowhere else
// ════════════════════════════════════════════════════════════════════

describe('per-phase token availability', () => {
  it('⛔ rejects {session} in INIT — there is no session before INIT answers', () => {
    expect(fields(withPhase('init', { query: { command: 'INIT', id: '{session}' } })))
      .toContain('init.query.id');
    expect(fields(withPhase('init', { path: '/upload/{session}' })))
      .toContain('init.path');
  });

  it('⛔ rejects a per-chunk token outside APPEND', () => {
    // `{segment_index}` in FINALIZE would mean the commit request varies per
    // chunk, which is not a shape this protocol has.
    expect(fields(withPhase('finalize', { query: { i: '{segment_index}' } })))
      .toContain('finalize.query.i');
    expect(fields(withPhase('init', { query: { o: '{chunk_offset}' } })))
      .toContain('init.query.o');
    expect(fields(withPhase('status', { query: { i: '{segment_index}' } })))
      .toContain('status.query.i');
  });

  it('accepts every engine token in APPEND, which is where they apply', () => {
    expect(chunkedUploadBoundViolations(withPhase('append', {
      query: {
        i: '{segment_index}', o: '{chunk_offset}', l: '{chunk_length}',
        n: '{chunk_count}', t: '{total_bytes}', m: '{session}',
      },
    }))).toEqual([]);
  });

  it('scans headers and body, not only path and query', () => {
    expect(fields(withPhase('init', { headers: { 'X-Id': '{session}' } })))
      .toContain('init.headers.X-Id');
    expect(fields(withPhase('init', { body: { id: '{session}' } })))
      .toContain('init.body.id');
  });

  it('rejects a non-string value in a token bag rather than ignoring it', () => {
    expect(fields(withPhase('append', { query: { n: 7 } })))
      .toContain('append.query.n');
    expect(fields(withPhase('append', { headers: 'x-a: b' })))
      .toContain('append.headers');
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. the poll — the ONE response-driven loop, bounded twice
// ════════════════════════════════════════════════════════════════════

describe('the status poll is doubly bounded', () => {
  it('⛔ rejects a poll with no max_polls', () => {
    const { max_polls: _drop, ...noBound } = X_MEDIA.status;
    expect(fields(withSpec({ status: noBound }))).toContain('status.max_polls');
  });

  it('⛔ rejects a TEMPLATE max_polls — the bound itself must not be response-derived', () => {
    expect(fields(withPhase('status', { max_polls: '{session}' })))
      .toContain('status.max_polls');
  });

  it('rejects a max_polls above the hard ceiling', () => {
    expect(fields(withPhase('status', { max_polls: CHUNKED_UPLOAD_MAX_POLLS_CEILING + 1 })))
      .toContain('status.max_polls');
    expect(chunkedUploadBoundViolations(
      withPhase('status', { max_polls: CHUNKED_UPLOAD_MAX_POLLS_CEILING }),
    )).toEqual([]);
  });

  it('requires a done condition — an unterminated poll is not a bound', () => {
    expect(fields(withPhase('status', { done: undefined }))).toContain('status.done');
    expect(fields(withPhase('status', { done: { path: 'x' } }))).toContain('status.done');
    expect(fields(withPhase('status', { done: 'succeeded' }))).toContain('status.done');
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. the byte ceiling — lower-only, and separate from the one-shot one
// ════════════════════════════════════════════════════════════════════

describe('max_bytes is lower-only against the CHUNKED ceiling', () => {
  it('accepts exactly the ceiling', () => {
    expect(chunkedUploadBoundViolations(
      withSpec({ max_bytes: HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING }),
    )).toEqual([]);
  });

  it('⛔ rejects one byte over it', () => {
    expect(fields(withSpec({ max_bytes: HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING + 1 })))
      .toContain('max_bytes');
  });

  it('is a DIFFERENT ceiling from the one-shot 25 MB — 512 MB is the point', () => {
    expect(HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING).toBe(512 * 1024 * 1024);
    expect(chunkedUploadBoundViolations(withSpec({ max_bytes: 100 * 1024 * 1024 })))
      .toEqual([]);
  });

  it('rejects a template max_bytes', () => {
    expect(fields(withSpec({ max_bytes: '{session}' }))).toContain('max_bytes');
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. shape guards
// ════════════════════════════════════════════════════════════════════

describe('shape', () => {
  it('refuses a non-object declaration', () => {
    for (const v of [null, undefined, 'chunked', 42, ['chunked']]) {
      expect(chunkedUploadBoundViolations(v).length, String(v)).toBeGreaterThan(0);
    }
  });

  it('reports a non-chunked kind rather than silently passing it', () => {
    expect(fields({ kind: 'multipart', arg: 'f', field: 'file' })).toEqual(['kind']);
  });

  it('requires arg and session_from', () => {
    expect(fields(withSpec({ arg: '' }))).toContain('arg');
    expect(fields(withSpec({ session_from: 42 }))).toContain('session_from');
  });

  it.each(['body_file.file', 'body_file.source', 'body_binary'])(
    'refuses %s as a chunked arg — that is the ONE-SHOT wire slot',
    (arg) => {
      // ⚠ D-216's `arg` is a wire key because the one-shot body builder reads
      // the file out of that exact slot. A chunked walk builds each request's
      // body from the plan, so the same key would put a one-shot body shape on
      // a walk's dispatch input — which the adapter refuses as exclusive, at
      // RUN time, on the one op an author could least afford to see fail there.
      // Refused at authoring instead.
      expect(fields(withSpec({ arg }))).toContain('arg');
    },
  );

  it('admits a plain arg key, so the rule constrains without crippling', () => {
    // The inverse pin. A chunked op wants an ordinary arg (`file`) — it stays
    // authority-bearing exactly where `affects_target` expects it.
    expect(fields(withSpec({ arg: 'file' }))).toEqual([]);
    // …and a key that merely CONTAINS the prefix elsewhere is not a wire slot.
    expect(fields(withSpec({ arg: 'my_body_file.thing' }))).toEqual([]);
  });

  it('requires method and path on every phase', () => {
    expect(fields(withPhase('append', { method: '' }))).toContain('append.method');
    expect(fields(withPhase('finalize', { path: undefined }))).toContain('finalize.path');
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. locked headers — a declaration may not own auth
// ════════════════════════════════════════════════════════════════════

describe('engine-locked headers', () => {
  it('⛔ rejects Authorization on any phase — the CONNECTION owns auth', () => {
    // A phase's headers come from a third-party manifest and never pass
    // through `buildApiDispatchInput`'s locked-key strip, which filters RECIPE
    // args. Without this rule a pack could send the owner's file under a
    // credential it chose.
    for (const phase of ['init', 'append', 'finalize'] as const) {
      expect(fields(withPhase(phase, { headers: { Authorization: 'Bearer x' } })), phase)
        .toContain(`${phase}.headers.Authorization`);
    }
  });

  it('is case-insensitive — HTTP header names are', () => {
    for (const name of ['authorization', 'AUTHORIZATION', 'Cookie', 'cookie', 'Host', ' host ']) {
      expect(fields(withPhase('append', { headers: { [name]: 'x' } })), name)
        .toContain(`append.headers.${name}`);
    }
  });

  it('covers the status phase too', () => {
    expect(fields(withPhase('status', { headers: { Cookie: 'a=b' } })))
      .toContain('status.headers.Cookie');
  });

  it('leaves ordinary headers alone', () => {
    expect(chunkedUploadBoundViolations(
      withPhase('append', { headers: { 'X-Client': 'recued', 'Content-Range': 'bytes 0-1/2' } }),
    )).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// Per-chunk encoding — ORTHOGONAL to how many requests there are
// ════════════════════════════════════════════════════════════════════
//
// 🔑 `chunked` is not a peer of `multipart` / `binary`. `HttpUploadSpec.kind`
//  answers HOW MANY REQUESTS; `chunk_encoding` answers HOW THE BYTES SIT IN
//  EACH ONE. The first cut of slice 2b-ii-α collapsed the two and made every
//  chunked protocol raw-only — which would have been discovered at slice 4,
//  against the one pack this D exists to unblock.

describe('chunk_encoding is orthogonal to the request count', () => {
  it('defaults to binary — an absent encoding is admissible', () => {
    // Nothing already shipped may start failing because a field was added.
    expect(chunkedUploadBoundViolations(X_MEDIA)).toEqual([]);
    expect((X_MEDIA as Record<string, unknown>).chunk_encoding).toBeUndefined();
  });

  it('admits multipart WITH a field name', () => {
    expect(chunkedUploadBoundViolations(
      withSpec({ chunk_encoding: 'multipart', chunk_field: 'media' }),
    )).toEqual([]);
  });

  it('admits an explicit binary encoding', () => {
    expect(chunkedUploadBoundViolations(withSpec({ chunk_encoding: 'binary' }))).toEqual([]);
  });

  it('⛔ refuses multipart with NO field name', () => {
    // A form part with no name is accepted and then IGNORED by most targets —
    // a chunk silently dropped, which is the failure this D exists to prevent.
    expect(fields(withSpec({ chunk_encoding: 'multipart' }))).toContain('chunk_field');
  });

  it.each([
    ['an empty field name', ''],
    ['a whitespace-only field name', '   '],
    ['a non-string field name', 42],
  ])('⛔ refuses multipart with %s', (_name, chunk_field) => {
    expect(fields(withSpec({ chunk_encoding: 'multipart', chunk_field })))
      .toContain('chunk_field');
  });

  it('⛔ refuses a field name under a BINARY encoding rather than ignoring it', () => {
    // Ignoring it would leave the author believing a form part was sent.
    expect(fields(withSpec({ chunk_field: 'media' }))).toContain('chunk_field');
    expect(fields(withSpec({ chunk_encoding: 'binary', chunk_field: 'media' })))
      .toContain('chunk_field');
  });

  it.each([
    ['an unknown encoding', 'base64'],
    ['a templated encoding', '{session}'],
    ['a non-string encoding', 1],
    ['null', null],
  ])('⛔ refuses %s', (_name, chunk_encoding) => {
    expect(fields(withSpec({ chunk_encoding }))).toContain('chunk_encoding');
  });

  it('⛔ keeps the spec key set CLOSED — a near-miss key is still refused', () => {
    // The two new keys widened the closed set. That set is half of the § 8a
    // carve-out (no syntax for a response value), so widening it must not
    // become "the set is open now".
    expect(fields(withSpec({ chunk_encoding_mode: 'multipart' })))
      .toContain('chunk_encoding_mode');
    expect(fields(withSpec({ chunk_fields: ['media'] }))).toContain('chunk_fields');
  });
});
