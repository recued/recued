/** D-217 slice 2a — the chunk plan + the walk state machine.
 *
 *  The walk is driven END TO END here with fake responses, so the assertions
 *  are on the REQUEST SEQUENCE and the terminal outcome, not on shapes. Three
 *  properties carry the D:
 *
 *   1. **The request count is fixed before the first dispatch** (§ 8a). The
 *      plan is computed once; no transition can lengthen it, and no response
 *      value is read for anything but the session handle and the poll's
 *      done-condition.
 *   2. **Fail-closed** (§ 8c): after ANY chunk error the walk must be unable to
 *      reach FINALIZE. `failed` is defined as "the asset was never created",
 *      so a reachable commit would make the word false.
 *   3. **Three outcomes, not two** (§ 8.1): a poll that never confirms is
 *      `committed_unconfirmed`, because FINALIZE already succeeded. Reporting
 *      it as `failed` would invite a retry that double-posts.
 */

import { describe, expect, it } from 'vitest';
import type { ChunkedUploadSpec } from '@recued/contracts';
import {
  CHUNKED_UPLOAD_MAX_POLLS_CEILING,
  HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
} from '@recued/contracts';

import {
  ChunkedPhaseInputError,
  ChunkedUploadPlanError,
  advanceChunkedWalk,
  buildChunkedPhaseInput,
  nextChunkedAction,
  planChunkedUpload,
  startChunkedWalk,
  type ChunkedWalkAction,
  type ChunkedWalkResult,
} from '../chunked-upload-walk.js';

const SPEC: ChunkedUploadSpec = {
  kind: 'chunked',
  arg: 'media',
  chunk_bytes: 100,
  session_from: 'media_id_string',
  init: { method: 'POST', path: '/upload', query: { command: 'INIT', total_bytes: '{total_bytes}' } },
  append: { method: 'POST', path: '/upload', query: { command: 'APPEND', media_id: '{session}', segment_index: '{segment_index}' } },
  finalize: { method: 'POST', path: '/upload', query: { command: 'FINALIZE', media_id: '{session}' } },
  status: {
    method: 'GET',
    path: '/upload',
    query: { command: 'STATUS', media_id: '{session}' },
    max_polls: 3,
    done: { path: 'processing_info.state', equals: 'succeeded' },
  },
};

const noPoll = (): ChunkedUploadSpec => {
  const { status: _drop, ...rest } = SPEC;
  return rest as ChunkedUploadSpec;
};

const INIT_OK = { ok: true as const, response: { media_id_string: 'MID-1' } };
const OK = { ok: true as const, response: {} };
const DONE = { ok: true as const, response: { processing_info: { state: 'succeeded' } } };
const PENDING = { ok: true as const, response: { processing_info: { state: 'in_progress' } } };

/** Drive the whole walk, recording every action, answering via `reply`. */
const drive = (
  spec: ChunkedUploadSpec,
  total: number,
  reply: (a: ChunkedWalkAction, step: number) => ChunkedWalkResult,
): { actions: ChunkedWalkAction[]; final: ChunkedWalkAction & { kind: 'done' } } => {
  let state = startChunkedWalk(spec, planChunkedUpload({ spec, total_bytes: total }));
  const actions: ChunkedWalkAction[] = [];
  for (let step = 0; step < 500; step += 1) {
    const action = nextChunkedAction(state);
    actions.push(action);
    if (action.kind === 'done') {
      return { actions, final: action };
    }
    state = advanceChunkedWalk(state, reply(action, step));
  }
  throw new Error('walk did not terminate within 500 steps');
};

const kinds = (as: ChunkedWalkAction[]): string[] => as.map((a) => a.kind);

// ════════════════════════════════════════════════════════════════════
// 1. the plan — the count, fixed before anything is dispatched
// ════════════════════════════════════════════════════════════════════

describe('planChunkedUpload', () => {
  it('slices exactly, with a short final chunk', () => {
    const plan = planChunkedUpload({ spec: SPEC, total_bytes: 250 });
    expect(plan.count).toBe(3);
    expect(plan.chunks).toEqual([
      { index: 0, offset: 0, length: 100 },
      { index: 1, offset: 100, length: 100 },
      { index: 2, offset: 200, length: 50 },
    ]);
  });

  it('covers the file exactly — no gap, no overlap, no overrun', () => {
    for (const total of [1, 99, 100, 101, 999, 1000]) {
      const plan = planChunkedUpload({ spec: SPEC, total_bytes: total });
      expect(plan.chunks.reduce((n, c) => n + c.length, 0), `total ${total}`).toBe(total);
      plan.chunks.forEach((c, i) => {
        expect(c.offset, `total ${total} chunk ${i}`).toBe(i === 0 ? 0 : plan.chunks[i - 1]!.offset + plan.chunks[i - 1]!.length);
        expect(c.length).toBeGreaterThan(0);
      });
      expect(plan.chunks.at(-1)!.offset + plan.chunks.at(-1)!.length).toBe(total);
    }
  });

  it('an exact multiple produces no trailing empty chunk', () => {
    const plan = planChunkedUpload({ spec: SPEC, total_bytes: 300 });
    expect(plan.count).toBe(3);
    expect(plan.chunks.at(-1)).toEqual({ index: 2, offset: 200, length: 100 });
  });

  it('a file smaller than one chunk is a single request', () => {
    expect(planChunkedUpload({ spec: SPEC, total_bytes: 7 }).chunks)
      .toEqual([{ index: 0, offset: 0, length: 7 }]);
  });

  it('⛔ re-runs the § 8a bound check at RUN time, not just at authoring', () => {
    // An installed pack may predate the rule or have arrived through a path
    // that skipped validation. Trusting that it did is how a declared guard
    // becomes an unbacked one.
    const smuggled = { ...SPEC, chunk_bytes: '{session}' } as unknown as ChunkedUploadSpec;
    expect(() => planChunkedUpload({ spec: smuggled, total_bytes: 250 }))
      .toThrow(ChunkedUploadPlanError);
    expect(() => planChunkedUpload({ spec: smuggled, total_bytes: 250 }))
      .toThrow(/§ 8a request-count bound/);
  });

  it('⛔ refuses an over-ceiling file BEFORE any request is planned', () => {
    expect(() => planChunkedUpload({
      spec: SPEC, total_bytes: HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING + 1,
    })).toThrow(/refused before any request is sent/);
  });

  it("honours an op's LOWERED max_bytes", () => {
    const tight = { ...SPEC, max_bytes: 150 };
    expect(() => planChunkedUpload({ spec: tight, total_bytes: 200 })).toThrow(/over the 150-byte/);
    expect(planChunkedUpload({ spec: tight, total_bytes: 150 }).count).toBe(2);
  });

  it('refuses a non-positive or non-integer total', () => {
    for (const t of [0, -1, 1.5, Number.NaN]) {
      expect(() => planChunkedUpload({ spec: SPEC, total_bytes: t }), String(t))
        .toThrow(/positive safe integer/);
    }
  });

  it('states the multiplier one approval buys', () => {
    // § 6.1 — the approval surface says "up to N requests", not "an upload".
    expect(planChunkedUpload({ spec: SPEC, total_bytes: 10_000 }).count).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. the happy walk — exact request sequence
// ════════════════════════════════════════════════════════════════════

describe('the walk sequence', () => {
  it('runs INIT → APPEND×N → FINALIZE → STATUS, in that order', () => {
    const { actions, final } = drive(SPEC, 250, (a) => {
      if (a.kind === 'init') return INIT_OK;
      if (a.kind === 'status') return DONE;
      return OK;
    });
    expect(kinds(actions)).toEqual([
      'init', 'append', 'append', 'append', 'finalize', 'status', 'done',
    ]);
    expect(final.outcome).toBe('committed');
    expect(final.chunks_sent).toBe(3);
    expect(final.bytes_sent).toBe(250);
  });

  it('appends in ASCENDING index order, each exactly once', () => {
    const { actions } = drive(SPEC, 450, (a) => (a.kind === 'init' ? INIT_OK : a.kind === 'status' ? DONE : OK));
    const appends = actions.filter((a): a is ChunkedWalkAction & { kind: 'append' } => a.kind === 'append');
    expect(appends.map((a) => a.chunk.index)).toEqual([0, 1, 2, 3, 4]);
    expect(appends.map((a) => a.chunk.offset)).toEqual([0, 100, 200, 300, 400]);
  });

  it('sends exactly ceil(size/chunk) appends — the count the plan fixed', () => {
    for (const [total, expected] of [[1, 1], [100, 1], [101, 2], [250, 3], [1000, 10]] as const) {
      const { actions } = drive(SPEC, total, (a) => (a.kind === 'init' ? INIT_OK : a.kind === 'status' ? DONE : OK));
      expect(actions.filter((a) => a.kind === 'append'), `total ${total}`).toHaveLength(expected);
    }
  });

  it('⛔ a target that keeps answering cannot lengthen the walk', () => {
    // The carve-out in one test: every response carries fields that LOOK like
    // cursors. The walk must be exactly as long as the plan said.
    const { actions } = drive(SPEC, 250, (a) => {
      if (a.kind === 'init') return { ok: true, response: { media_id_string: 'MID-1', next: 'more', has_more: true, total_segments: 999 } };
      if (a.kind === 'status') return DONE;
      return { ok: true, response: { next_segment: 42, has_more: true, resume_from: 0 } };
    });
    expect(actions.filter((a) => a.kind === 'append')).toHaveLength(3);
  });

  it('skips STATUS entirely when the declaration has no poll', () => {
    const { actions, final } = drive(noPoll(), 250, (a) => (a.kind === 'init' ? INIT_OK : OK));
    expect(kinds(actions)).toEqual(['init', 'append', 'append', 'append', 'finalize', 'done']);
    expect(final.outcome).toBe('committed');
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. fail-closed — FINALIZE must be UNREACHABLE after a chunk error
// ════════════════════════════════════════════════════════════════════

describe('fail-closed', () => {
  it('⛔ a failed APPEND stops the walk and NEVER sends FINALIZE', () => {
    const { actions, final } = drive(SPEC, 450, (a) => {
      if (a.kind === 'init') return INIT_OK;
      if (a.kind === 'append' && a.chunk.index === 2) return { ok: false, message: 'upstream 502' };
      return OK;
    });
    expect(kinds(actions)).toEqual(['init', 'append', 'append', 'append', 'done']);
    expect(actions.some((a) => a.kind === 'finalize')).toBe(false);
    expect(final.outcome).toBe('failed');
    expect(final.message).toBe('upstream 502');
  });

  it('reports what actually LEFT, not what was intended (§ 6.3)', () => {
    // Two chunks landed before the third failed; the audit must not say zero.
    const { final } = drive(SPEC, 450, (a) => {
      if (a.kind === 'init') return INIT_OK;
      if (a.kind === 'append' && a.chunk.index === 2) return { ok: false, message: 'x' };
      return OK;
    });
    expect(final.bytes_sent).toBe(200);
    expect(final.chunks_sent).toBe(2);
  });

  it('a failed INIT sends nothing at all', () => {
    const { actions, final } = drive(SPEC, 250, () => ({ ok: false, message: 'auth' }));
    expect(kinds(actions)).toEqual(['init', 'done']);
    expect(final.outcome).toBe('failed');
    expect(final.bytes_sent).toBe(0);
  });

  it('⛔ an INIT with no session refuses BEFORE any bytes are sent', () => {
    const { actions, final } = drive(SPEC, 250, (a) =>
      (a.kind === 'init' ? { ok: true, response: { unexpected: 'shape' } } : OK));
    expect(kinds(actions)).toEqual(['init', 'done']);
    expect(final.outcome).toBe('failed');
    expect(final.message).toMatch(/no session at 'media_id_string'/);
    expect(final.bytes_sent).toBe(0);
  });

  it('a failed FINALIZE is a failure — the asset was not committed', () => {
    const { final } = drive(SPEC, 100, (a) =>
      (a.kind === 'init' ? INIT_OK : a.kind === 'finalize' ? { ok: false, message: 'rejected' } : OK));
    expect(final.outcome).toBe('failed');
  });

  it('⛔ a late FAILURE cannot flip an already-COMMITTED walk to failed', () => {
    // ⚠ The identity check on an `ok:true` late result passes even with the
    // done-guard deleted (the reducer's `default` returns the same state), so
    // it proved nothing — a mutation caught that. The real risk is a stray
    // late ERROR rewriting a successful upload's outcome, which would report a
    // published asset as failed and invite a re-post.
    let state = startChunkedWalk(SPEC, planChunkedUpload({ spec: SPEC, total_bytes: 100 }));
    state = advanceChunkedWalk(state, INIT_OK);
    state = advanceChunkedWalk(state, OK); // the single append
    state = advanceChunkedWalk(state, OK); // finalize
    state = advanceChunkedWalk(state, DONE); // status confirms
    expect(nextChunkedAction(state)).toMatchObject({ outcome: 'committed' });

    const after = advanceChunkedWalk(state, { ok: false, message: 'late socket error' });
    expect(nextChunkedAction(after)).toMatchObject({ outcome: 'committed' });
    expect(after).toBe(state);
  });

  it('a late SUCCESS after a failed walk changes nothing either', () => {
    let state = startChunkedWalk(SPEC, planChunkedUpload({ spec: SPEC, total_bytes: 100 }));
    state = advanceChunkedWalk(state, { ok: false, message: 'dead' });
    const after = advanceChunkedWalk(state, INIT_OK);
    expect(nextChunkedAction(after)).toMatchObject({ outcome: 'failed' });
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. the third outcome — § 8.1
// ════════════════════════════════════════════════════════════════════

describe('committed-but-not-confirmed', () => {
  it('⛔ a poll that never confirms is NOT a failure — the asset exists', () => {
    const { actions, final } = drive(SPEC, 100, (a) =>
      (a.kind === 'init' ? INIT_OK : a.kind === 'status' ? PENDING : OK));
    expect(actions.filter((a) => a.kind === 'status')).toHaveLength(3); // max_polls
    expect(final.outcome).toBe('committed_unconfirmed');
    expect(final.outcome).not.toBe('failed');
    expect(final.message).toMatch(/within 3 poll/);
  });

  it('⛔ a poll that ERRORS is also not a failure — FINALIZE already succeeded', () => {
    const { final } = drive(SPEC, 100, (a) =>
      (a.kind === 'init' ? INIT_OK : a.kind === 'status' ? { ok: false, message: 'timeout' } : OK));
    expect(final.outcome).toBe('committed_unconfirmed');
    expect(final.message).toBe('timeout');
  });

  it('confirms as soon as the done-condition matches, without exhausting polls', () => {
    let polls = 0;
    const { actions, final } = drive(SPEC, 100, (a) => {
      if (a.kind === 'init') return INIT_OK;
      if (a.kind === 'status') { polls += 1; return polls >= 2 ? DONE : PENDING; }
      return OK;
    });
    expect(actions.filter((a) => a.kind === 'status')).toHaveLength(2);
    expect(final.outcome).toBe('committed');
  });

  it('numbers the poll attempts from 1', () => {
    const { actions } = drive(SPEC, 100, (a) =>
      (a.kind === 'init' ? INIT_OK : a.kind === 'status' ? PENDING : OK));
    expect(actions.filter((a): a is ChunkedWalkAction & { kind: 'status' } => a.kind === 'status')
      .map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it('⛔ the hard ceiling wins over a declaration that outran it', () => {
    // The declaration is validated, but the walk must not depend on that having
    // happened — same reasoning as the run-time bound re-check.
    const greedy = {
      ...SPEC,
      status: { ...SPEC.status!, max_polls: CHUNKED_UPLOAD_MAX_POLLS_CEILING + 500 },
    } as ChunkedUploadSpec;
    const plan = planChunkedUpload({ spec: { ...greedy, status: SPEC.status }, total_bytes: 100 });
    let state = startChunkedWalk(greedy, plan);
    let polls = 0;
    for (let i = 0; i < 2000; i += 1) {
      const a = nextChunkedAction(state);
      if (a.kind === 'done') break;
      if (a.kind === 'status') polls += 1;
      state = advanceChunkedWalk(state, a.kind === 'init' ? INIT_OK : a.kind === 'status' ? PENDING : OK);
    }
    expect(polls).toBe(CHUNKED_UPLOAD_MAX_POLLS_CEILING);
    expect(nextChunkedAction(state)).toMatchObject({ outcome: 'committed_unconfirmed' });
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. the session path is read safely
// ════════════════════════════════════════════════════════════════════

describe('session extraction', () => {
  it('reads a nested dotted path', () => {
    const nested = { ...SPEC, session_from: 'data.upload.id' } as ChunkedUploadSpec;
    const { final } = drive(nested, 100, (a) =>
      (a.kind === 'init'
        ? { ok: true, response: { data: { upload: { id: 'S-9' } } } }
        : a.kind === 'status' ? DONE : OK));
    expect(final.outcome).toBe('committed');
  });

  it('⛔ never resolves through the prototype chain', () => {
    // ⚠ `constructor.name` does NOT exercise this: the walk-off happens at the
    // `typeof cur !== 'object'` check (a constructor is a function), so that
    // path passes even with the own-property guard deleted — a mutation caught
    // it. An INHERITED STRING is the real case: the path comes from a
    // third-party manifest, and a prototype-sourced session would let a
    // polluted prototype address every APPEND.
    const inherited = Object.create({ upload_id: 'FROM-PROTOTYPE' }) as Record<string, unknown>;
    expect(inherited.upload_id).toBe('FROM-PROTOTYPE'); // reachable by ordinary read…
    const evil = { ...SPEC, session_from: 'upload_id' } as ChunkedUploadSpec;
    const { final } = drive(evil, 100, (a) =>
      (a.kind === 'init' ? { ok: true, response: inherited } : OK));
    expect(final.outcome).toBe('failed'); // …and NOT by the walk
    expect(final.message).toMatch(/no session/);
  });

  it('⛔ a nested own-path is not defeated by an inherited leaf', () => {
    const leaf = Object.create({ id: 'FROM-PROTOTYPE' }) as Record<string, unknown>;
    const nested = { ...SPEC, session_from: 'data.id' } as ChunkedUploadSpec;
    const { final } = drive(nested, 100, (a) =>
      (a.kind === 'init' ? { ok: true, response: { data: leaf } } : OK));
    expect(final.outcome).toBe('failed');
  });

  it('rejects a non-string or empty session', () => {
    for (const v of [42, '', null, { id: 1 }]) {
      const { final } = drive(SPEC, 100, (a) =>
        (a.kind === 'init' ? { ok: true, response: { media_id_string: v } } : OK));
      expect(final.outcome, String(v)).toBe('failed');
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. slice 2b — phase → dispatch input
// ════════════════════════════════════════════════════════════════════

describe('buildChunkedPhaseInput', () => {
  const TOKENS = {
    session: 'MID-1',
    segment_index: 2,
    chunk_offset: 200,
    chunk_length: 50,
    chunk_count: 3,
    total_bytes: 250,
  };
  const build = (
    phase: Record<string, unknown>,
    over: { phaseName?: 'init' | 'append' | 'finalize' | 'status'; tokens?: Record<string, unknown>; opArgs?: Record<string, unknown> } = {},
  ): Record<string, unknown> =>
    buildChunkedPhaseInput({
      phase: phase as never,
      phaseName: over.phaseName ?? 'append',
      tokens: (over.tokens ?? TOKENS) as never,
      opArgs: over.opArgs ?? {},
      connectionName: 'x',
    });

  it('substitutes engine tokens into the path and the query', () => {
    const input = build({
      method: 'POST',
      path: '/upload/{session}/{segment_index}',
      query: { media_id: '{session}', i: '{segment_index}', n: '{chunk_count}' },
    });
    expect(input.method).toBe('POST');
    expect(input.path).toBe('/upload/MID-1/2');
    expect(input['query.media_id']).toBe('MID-1');
    expect(input['query.i']).toBe('2');
    expect(input['query.n']).toBe('3');
    expect(input.connection).toBe('x');
  });

  it("substitutes the op's own args too", () => {
    expect(build(
      { method: 'POST', path: '/p', query: { t: '{media_type}' } },
      { opArgs: { media_type: 'video/mp4' } },
    )['query.t']).toBe('video/mp4');
  });

  it('⛔ THROWS on an unresolved token rather than shipping the literal text', () => {
    // Leaving `{session}` in place would send a well-formed request that
    // addresses nothing, and read as a success.
    expect(() => build(
      { method: 'POST', path: '/upload/{session}' },
      { phaseName: 'init', tokens: { chunk_count: 1, total_bytes: 10 } },
    )).toThrow(ChunkedPhaseInputError);
    expect(() => build({ method: 'POST', path: '/p', query: { x: '{nope}' } }))
      .toThrow(/\{nope\}, which is not available/);
  });

  it('⛔ an op arg never resolves through the PROTOTYPE chain', () => {
    // Same class as the session-path guard: the token name comes from a
    // third-party manifest, so a polluted prototype must not become a
    // substituted value. An inherited key reads fine by ordinary access and
    // must still be unavailable here.
    const inherited = Object.create({ sneaky: 'PWNED' }) as Record<string, unknown>;
    expect(inherited.sneaky).toBe('PWNED');
    expect(() => build(
      { method: 'POST', path: '/p', query: { x: '{sneaky}' } },
      { opArgs: inherited },
    )).toThrow(/\{sneaky\}, which is not available/);
  });

  it('an OWN op arg with a falsy-but-present value still substitutes', () => {
    // `hasOwnProperty` rather than `!== undefined` matters here too: an arg
    // legitimately set to 0 or '' must not read as absent.
    expect(build(
      { method: 'POST', path: '/p', query: { n: '{count}' } },
      { opArgs: { count: 0 } },
    )['query.n']).toBe('0');
  });

  it('refuses a non-scalar substitution', () => {
    expect(() => build(
      { method: 'POST', path: '/p', query: { x: '{obj}' } },
      { opArgs: { obj: { a: 1 } } },
    )).toThrow(/not a scalar/);
  });

  it('⛔ refuses an engine-LOCKED header — the connection owns auth', () => {
    // A phase's headers come from a third-party manifest and never pass through
    // buildApiDispatchInput's locked-key strip (which filters recipe args).
    for (const name of ['Authorization', 'authorization', 'Cookie', 'Host']) {
      expect(() => build({ method: 'POST', path: '/p', headers: { [name]: 'x' } }), name)
        .toThrow(/engine-locked/);
    }
  });

  it('refuses an engine-owned __ prefixed wire key', () => {
    expect(() => build({ method: 'POST', path: '/p', query: { __rc_capture: '1' } }))
      .toThrow(/engine-owned/);
  });

  it('⛔ refuses CR/LF in a header value — {session} is TARGET-controlled', () => {
    // The session arrives in the INIT response, so the target chooses it. A
    // CR/LF would append headers of its choosing to our authenticated request.
    expect(() => build(
      { method: 'POST', path: '/p', headers: { 'X-Id': '{session}' } },
      { tokens: { ...TOKENS, session: 'a\r\nX-Evil: 1' } },
    )).toThrow(/CR\/LF/);
    expect(() => build(
      { method: 'POST', path: '/p', headers: { 'X-Id': '{session}' } },
      { tokens: { ...TOKENS, session: 'a\nX-Evil: 1' } },
    )).toThrow(/CR\/LF/);
  });

  it('allows an ordinary header through', () => {
    expect(build({ method: 'POST', path: '/p', headers: { 'X-Id': '{session}' } })['header.X-Id'])
      .toBe('MID-1');
  });

  it('maps each bag to its wire prefix', () => {
    const input = build({
      method: 'PUT', path: '/p',
      query: { q: '1' }, headers: { H: '2' }, body: { b: '3' },
    });
    expect(input['query.q']).toBe('1');
    expect(input['header.H']).toBe('2');
    expect(input['body.b']).toBe('3');
  });

  it('produces a null-prototype input', () => {
    expect(Object.getPrototypeOf(build({ method: 'POST', path: '/p' }))).toBeNull();
  });
});
