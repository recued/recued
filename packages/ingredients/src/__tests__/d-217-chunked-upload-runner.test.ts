/** D-217 slice 2b-ii-β — the SEQUENCER.
 *
 *  Two suites, and the split is deliberate:
 *
 *   1. **Through the REAL `connection.api` handler**, so every assertion is
 *      about what reached `fetch`. The whole design claim of this slice is that
 *      the walk COMPOSES the single-request path rather than re-deriving it —
 *      a test that stubbed the handler would pass just as happily with a second
 *      copy of auth injection and origin pinning, i.e. it could not see the
 *      property it exists to check.
 *   2. **`runChunkedUpload` driven by a spy**, where the dispatch INPUT each
 *      phase receives is observable. The negative properties live here: no
 *      phase carries the walk key (the recursion bound), and an APPEND carries
 *      a token and a range rather than bytes.
 *
 *  Spec: D-217 § 8a (+ amendment), § 8.1, § 9, § 10.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNKED_UPLOAD_WIRE_LENGTH_KEY,
  CHUNKED_UPLOAD_WIRE_OFFSET_KEY,
  CHUNKED_UPLOAD_WIRE_TOKEN_KEY,
  CHUNKED_UPLOAD_WIRE_FIELD_KEY,
  CHUNKED_UPLOAD_WIRE_WALK_KEY,
  type ChunkedUploadSpec,
  type ConnectionAuth,
  type ConnectionRow,
} from '@recued/contracts';
import {
  createConnectionApiHandler,
  type ConnectionApiHandlerDeps,
} from '../connection-api.js';
import { assertNoNestedWalk, runChunkedUpload } from '../chunked-upload-runner.js';
import { IngredientError } from '../types.js';
import { MAX_TIMEOUT_MS } from '../timeout.js';

const row: ConnectionRow = {
  pk: 'api:x-media',
  kind: 'api',
  name: 'x-media',
  display_name: 'X media',
  config_json: '{"base_url":"https://upload.example.com"}',
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const auth: ConnectionAuth = { type: 'bearer', token: 't0ken' } as unknown as ConnectionAuth;

const TOKEN = 'stg-a1b2c3';
const FILE_REF = 'file:9f2cvideo';
const TOTAL = 64;
const CHUNK = 16;
/** 64 bytes, every one distinguishable, so a wrong RANGE is visible. */
const STAGED = new Uint8Array(Array.from({ length: TOTAL }, (_, i) => i));
/** The handle the target hands back at INIT. Must never reach a step value. */
const SESSION = 'media-99887766';

const baseSpec = (): ChunkedUploadSpec => ({
  kind: 'chunked',
  arg: 'file',
  chunk_bytes: CHUNK,
  session_from: 'result.media_id',
  init: {
    method: 'POST',
    path: '/1.1/media/upload.json',
    query: { command: 'INIT', total_bytes: '{total_bytes}' },
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
});

const withStatus = (max_polls: number): ChunkedUploadSpec => ({
  ...baseSpec(),
  status: {
    method: 'GET',
    path: '/1.1/media/upload.json',
    query: { command: 'STATUS', media_id: '{session}' },
    max_polls,
    done: { path: 'result.state', equals: 'succeeded' },
  },
});

const requestBound = (spec: ChunkedUploadSpec, count = Math.ceil(TOTAL / spec.chunk_bytes)): number =>
  2 + count + (spec.status?.max_polls ?? 0);

const walkArg = (
  spec: ChunkedUploadSpec,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
    spec,
    file_ref: FILE_REF,
    total_bytes: TOTAL,
    count: Math.ceil(TOTAL / spec.chunk_bytes),
    request_bound: requestBound(spec),
    ...over,
  },
});

interface Sent {
  url: string;
  command: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Per-command scripted responses. `undefined` ⇒ the default 200. */
interface Script {
  init?: () => Response;
  append?: (n: number) => Response;
  finalize?: () => Response;
  status?: (n: number) => Response;
}

const ok = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface Staging {
  staged: Array<{ file_ref: string; expect_sha256?: string; max_bytes: number }>;
  disposed: string[];
}

const mk = (
  script: Script = {},
  extra: Partial<ConnectionApiHandlerDeps> = {},
  opts: { stagedSize?: number; stageFails?: string } = {},
): { deps: ConnectionApiHandlerDeps; sent: Sent[]; staging: Staging } => {
  const sent: Sent[] = [];
  const staging: Staging = { staged: [], disposed: [] };
  const live = new Set<string>();
  const stagedSize = opts.stagedSize ?? TOTAL;
  const { stageFails } = opts;
  let appends = 0;
  let polls = 0;
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    const command = new URL(url).searchParams.get('command') ?? '';
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    sent.push({ url, command, method: String(init?.method), body: init?.body, headers });
    if (command === 'INIT') return script.init?.() ?? ok({ media_id: SESSION });
    if (command === 'APPEND') { appends += 1; return script.append?.(appends) ?? ok({}); }
    if (command === 'FINALIZE') return script.finalize?.() ?? ok({ media_id: SESSION, size: TOTAL });
    if (command === 'STATUS') { polls += 1; return script.status?.(polls) ?? ok({ state: 'succeeded' }); }
    return ok({});
  }) as unknown as typeof fetch;

  return {
    sent,
    staging,
    deps: {
      decodeAuth: async () => auth,
      persistAuth: async () => {},
      fetchImpl,
      uploadStaging: {
        stage: async (input: { file_ref: string; expect_sha256?: string; max_bytes: number }) => {
          staging.staged.push(input);
          if (stageFails !== undefined) throw new Error(stageFails);
          live.add(TOKEN);
          return { token: TOKEN, size_bytes: stagedSize };
        },
        dispose: async (token: string) => { staging.disposed.push(token); live.delete(token); },
      },
      readUploadChunk: async (token: string, offset: number, length: number) => {
        // A disposed token reads NOTHING — the registry's own fail-closed rule,
        // mirrored here so a test can see a use-after-dispose rather than a
        // stub that happily serves bytes forever.
        if (!live.has(token)) throw new Error('upload-staging: unknown or disposed staging token');
        return { bytes: STAGED.slice(offset, offset + length), mime_type: 'video/mp4' };
      },
      ...extra,
    },
  };
};

const resolved = (output: Record<string, string> = {}): never =>
  ({ slug: 'x-media.upload', output, input: {}, risk_tier: 'write' } as never);

const run = async (
  deps: ConnectionApiHandlerDeps,
  params: Record<string, unknown>,
  output: Record<string, string> = {},
  ctx?: { setBytes(i: number, o: number): void },
): Promise<unknown> =>
  createConnectionApiHandler(deps)(row, params, resolved(output), ctx);

const refused = async (
  deps: ConnectionApiHandlerDeps,
  params: Record<string, unknown>,
  ctx?: { setBytes(i: number, o: number): void },
): Promise<IngredientError> => {
  try {
    await run(deps, params, {}, ctx);
  } catch (e) {
    if (e instanceof IngredientError) return e;
    throw e;
  }
  throw new Error('expected the walk to be refused');
};

// ────────────────────────────────────────────────────────────────
// 1 — through the real handler
// ────────────────────────────────────────────────────────────────

describe('D-217 — one act, N requests, and the order is the protocol', () => {
  it('walks INIT -> APPEND x N -> FINALIZE -> STATUS, addressing every request with the session', async () => {
    const { deps, sent } = mk();
    const out = await run(deps, walkArg(withStatus(3)));

    expect(sent.map((s) => s.command)).toEqual([
      'INIT', 'APPEND', 'APPEND', 'APPEND', 'APPEND', 'FINALIZE', 'STATUS',
    ]);
    // ⌈64/16⌉ = 4, computed before the first request and unchanged by anything
    // the target said (§ 10).
    expect((out as { upload: { chunks_sent: number } }).upload.chunks_sent).toBe(4);
    expect((out as { upload: { outcome: string } }).upload.outcome).toBe('committed');

    // Every post-INIT request addresses the handle INIT returned.
    for (const s of sent.slice(1)) {
      expect(new URL(s.url).searchParams.get('media_id')).toBe(SESSION);
    }
    // segment_index counts 0..N-1 in order — a chunk landing under the wrong
    // index corrupts the asset while every request still returns 200.
    expect(
      sent.filter((s) => s.command === 'APPEND')
        .map((s) => new URL(s.url).searchParams.get('segment_index')),
    ).toEqual(['0', '1', '2', '3']);
  });

  it('sends each chunk as its own RANGE of the staged file, in order', async () => {
    const { deps, sent } = mk();
    await run(deps, walkArg(baseSpec()));

    const bodies = sent.filter((s) => s.command === 'APPEND')
      .map((s) => new Uint8Array(s.body as Uint8Array));
    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toEqual(STAGED.slice(0, 16));
    expect(bodies[3]).toEqual(STAGED.slice(48, 64));
    // The staged file is never sent whole — that is what slice 0 exists for.
    for (const b of bodies) expect(b.byteLength).toBe(CHUNK);
  });

  it('carries the connection auth on every request in the walk, not just the first', async () => {
    // The composition claim: chunk 4 goes through the SAME auth injection as
    // INIT because it goes through the same handler. A re-derived request
    // builder is exactly what this would catch.
    const { deps, sent } = mk();
    await run(deps, walkArg(baseSpec()));
    expect(sent).toHaveLength(6);
    for (const s of sent) expect(s.headers.authorization).toBe('Bearer t0ken');
  });

  it('sizes the last chunk by what is LEFT, never by the declared chunk size', async () => {
    const spec = { ...baseSpec(), chunk_bytes: 25 };
    const { deps, sent } = mk();
    await run(deps, {
      [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
        spec, file_ref: FILE_REF, total_bytes: TOTAL, count: 3,
        request_bound: requestBound(spec, 3),
      },
    });
    const bodies = sent.filter((s) => s.command === 'APPEND')
      .map((s) => new Uint8Array(s.body as Uint8Array));
    expect(bodies.map((b) => b.byteLength)).toEqual([25, 25, 14]);
  });
});

describe('D-217 — fail closed: the commit request is unreachable after a bad chunk', () => {
  it('sends NO FINALIZE when an APPEND fails, and reports what LEFT', async () => {
    const { deps, sent } = mk({
      append: (n) => (n === 3 ? new Response('nope', { status: 403 }) : ok({})),
    });
    const e = await refused(deps, walkArg(baseSpec()));

    expect(sent.map((s) => s.command)).toEqual(['INIT', 'APPEND', 'APPEND', 'APPEND']);
    expect(sent.some((s) => s.command === 'FINALIZE')).toBe(false);
    // Chunk 4 is never attempted either — the walk stops, it does not skip.
    expect(sent.filter((s) => s.command === 'APPEND')).toHaveLength(3);
    expect(e.details?.chunks_sent).toBe(2);
    expect(e.details?.bytes_sent).toBe(32);
    // `requests` counts what was ATTEMPTED, including the one that failed —
    // otherwise the two numbers say the same thing and neither says how far
    // the walk actually got.
    expect(e.details?.requests).toBe(4);
    expect(e.message).toContain('no commit request was sent');
  });

  it('re-throws under the code the single request produced, not a flattened one', async () => {
    // A DIFFERENTIAL rather than a pinned literal: whatever the single-request
    // path calls this failure, the walk calls it the same thing. Pinning a
    // constant here would only assert my guess at `classifyHttpError`, and
    // would go stale the first time that mapping changed.
    const { deps: walkDeps } = mk({ append: () => new Response('nope', { status: 403 }) });
    const walkError = await refused(walkDeps, walkArg(baseSpec()));

    const { deps: oneDeps } = mk({ append: () => new Response('nope', { status: 403 }) });
    const oneError = await refused(oneDeps, {
      method: 'POST',
      path: '/1.1/media/upload.json',
      'query.command': 'APPEND',
    });

    expect(walkError.code).toBe(oneError.code);
    // …and it is a real classification, not the fallback the walk would use if
    // it had lost the underlying error entirely.
    expect(walkError.code).not.toBe('BAD_INPUT');
  });

  it('records the partial egress on the audit ctx BEFORE it throws', async () => {
    // § 6.3 — a failed upload is not a no-op. The adapter's emit closure reads
    // these on the error path, so setBytes must land before the throw.
    const seen: Array<[number, number]> = [];
    const { deps } = mk({ append: (n) => (n === 3 ? new Response('x', { status: 500 }) : ok({})) });
    await refused(deps, walkArg(baseSpec()), { setBytes: (i, o) => { seen.push([i, o]); } });

    expect(seen).toHaveLength(1);
    // Two whole chunks left the machine. Anything at or below one chunk would
    // mean the accumulation collapsed to a single request's measurement.
    expect(seen[0]![1]).toBeGreaterThanOrEqual(32);
  });

  it('a failed FINALIZE is UNCERTAIN, not a definite failure', async () => {
    // ⛔ The double-post hazard. Fail-closed guarantees "never created" for
    // every phase EXCEPT the commit request itself, which did go out.
    const { deps, sent } = mk({ finalize: () => new Response('x', { status: 500 }) });
    const e = await refused(deps, walkArg(baseSpec()));

    expect(sent.filter((s) => s.command === 'APPEND')).toHaveLength(4);
    expect(e.code).toBe('ACTION_DELIVERY_UNCERTAIN');
    expect(e.message).toContain('a retry may double-post');
    expect(e.message).not.toContain('nothing was created');
  });
});

describe('D-217 § 8.1 — a poll timeout is not a failure', () => {
  it('returns committed_unconfirmed rather than throwing when STATUS never settles', async () => {
    const { deps, sent } = mk({ status: () => ok({ state: 'in_progress' }) });
    const out = await run(deps, walkArg(withStatus(2))) as {
      upload: { outcome: string; message?: string };
    };

    expect(sent.filter((s) => s.command === 'STATUS')).toHaveLength(2);
    expect(out.upload.outcome).toBe('committed_unconfirmed');
    expect(out.upload.message).toContain('succeeded');
  });

  it('returns FINALIZE\'s response as the act\'s result even though STATUS ran last', async () => {
    // ⚠ The last request in the walk is not the one that answers the act. A
    // runner that captured "the most recent ok response" would pass every
    // no-poll test and quietly return the poll body here.
    const { deps } = mk({
      finalize: () => ok({ media_id: SESSION, size: 4242 }),
      status: () => ok({ state: 'succeeded' }),
    });
    const out = await run(deps, walkArg(withStatus(3))) as { result: { size?: number } };
    expect(out.result.size).toBe(4242);
  });

  it('stops polling the moment STATUS settles', async () => {
    const { deps, sent } = mk({
      status: (n) => ok({ state: n < 2 ? 'in_progress' : 'succeeded' }),
    });
    const out = await run(deps, walkArg(withStatus(9))) as { upload: { outcome: string } };
    expect(sent.filter((s) => s.command === 'STATUS')).toHaveLength(2);
    expect(out.upload.outcome).toBe('committed');
  });

  it('treats a FAILED status poll as unconfirmed too — the asset already exists', async () => {
    const { deps } = mk({ status: () => new Response('x', { status: 503 }) });
    const out = await run(deps, walkArg(withStatus(3))) as { upload: { outcome: string } };
    expect(out.upload.outcome).toBe('committed_unconfirmed');
  });

  it('surfaces an explicit target processing failure instead of polling to unconfirmed', async () => {
    const spec = withStatus(5);
    spec.status = {
      ...spec.status!,
      failed: { path: 'result.state', equals: 'failed' },
    };
    const { deps, sent } = mk({ status: () => ok({ state: 'failed' }) });
    const e = await refused(deps, walkArg(spec));
    expect(sent.filter((s) => s.command === 'STATUS')).toHaveLength(1);
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.message).toContain('terminal processing failure');
  });
});

describe('D-217 — the session is the walk\'s, and it does not escape', () => {
  it('never surfaces the INIT handle in the returned step value', async () => {
    // § 4.1 — the handle is credential-adjacent state the walk owns. The INIT
    // response is deliberately not the act's result.
    const { deps } = mk({ init: () => ok({ media_id: SESSION, secret_upload_url: 'https://x/y' }) });
    const out = await run(deps, walkArg(baseSpec()));
    expect(JSON.stringify(out)).not.toContain('secret_upload_url');
  });

  it('refuses a session carrying CR/LF at SUBSTITUTION time, before any chunk', async () => {
    // ⚠ `{session}` is the one value in this protocol the TARGET chooses, and
    // it flows into request construction. The refusal lives in
    // `buildChunkedPhaseInput` and must RUN here, per dispatch.
    const { deps, sent } = mk({
      init: () => ok({ media_id: 'ok\r\nX-Injected: 1' }),
    });
    const spec = baseSpec();
    spec.append = { ...spec.append, headers: { 'x-media-id': '{session}' } };
    const e = await refused(deps, walkArg(spec));

    expect(sent.map((s) => s.command)).toEqual(['INIT']);
    expect(e.message).toContain('CR/LF');
    // Nothing committed, and no bytes left.
    expect(e.details?.bytes_sent).toBe(0);
  });

  it('refuses a session that traverses out of the path it was substituted into', async () => {
    // ⚠ The session lands in the PATH of every later request, and the target
    // chooses it. The composition is what covers this — a phase goes through
    // the same `assertUrlSafe` as any other request — but "a guard upstream
    // handles it" is reasoning, and this is the test.
    const { deps, sent } = mk({ init: () => ok({ media_id: '../../admin/delete' }) });
    const spec = baseSpec();
    spec.append = { ...spec.append, path: '/1.1/media/{session}/append.json' };
    const e = await refused(deps, walkArg(spec));

    expect(sent.map((s) => s.command)).toEqual(['INIT']);
    expect(e.details?.bytes_sent).toBe(0);
  });

  it('refuses to send the owner\'s chunks to an origin the TARGET chose', async () => {
    // ⛔ The sharpest version of "the session is hostile data". A phase MAY
    // declare `path: '{session}'` — the spec allows it, because YouTube and
    // LinkedIn both hand back an upload URL at INIT. So a target that answers
    // with its own host would redirect the owner's file there, carrying the
    // connection's auth. The cross-origin guard refuses it, and refuses it
    // BEFORE the first chunk rather than after.
    const { deps, sent } = mk({ init: () => ok({ media_id: 'https://evil.example.com/steal' }) });
    const spec = baseSpec();
    spec.append = { ...spec.append, path: '{session}' };
    const e = await refused(deps, walkArg(spec));

    expect(sent.map((s) => s.command)).toEqual(['INIT']);
    expect(e.details?.bytes_sent).toBe(0);
    expect(e.message).toContain('evil.example.com');
  });

  it('fails the walk when INIT answers without a session, before sending a chunk', async () => {
    const { deps, sent } = mk({ init: () => ok({ nothing_useful: true }) });
    const e = await refused(deps, walkArg(baseSpec()));
    expect(sent.map((s) => s.command)).toEqual(['INIT']);
    expect(e.message).toContain('no commit request was sent');
  });
});

describe('D-217 — the approved count is the executable count', () => {
  it('refuses before any request when the approved count is not what the declaration produces', async () => {
    // 🔑 The number a reviewer saw and the number the adapter can send are
    // pinned to each other. One approval buys N requests, and only N.
    const { deps, sent } = mk();
    const e = await refused(deps, walkArg(baseSpec(), { count: 40 }));
    expect(sent).toHaveLength(0);
    expect(e.code).toBe('BAD_INPUT');
    expect(e.message).toContain('approved APPEND count');
  });

  it('refuses before any request when the approved TOTAL bound omits protocol phases', async () => {
    const { deps, sent } = mk();
    const e = await refused(deps, walkArg(baseSpec(), { request_bound: 4 }));
    expect(sent).toHaveLength(0);
    expect(e.code).toBe('BAD_INPUT');
    expect(e.message).toContain('approved total request bound');
  });

  it('refuses a declaration that fails the carve-out predicate at RUN time', async () => {
    // An installed pack may predate the predicate. `planChunkedUpload` re-runs
    // it rather than trusting that some install path validated.
    const spec = { ...baseSpec(), chunk_bytes: '{session}' } as unknown as ChunkedUploadSpec;
    const { deps, sent } = mk();
    const e = await refused(deps, { [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
      spec, file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6,
    } });
    expect(sent).toHaveLength(0);
    expect(e.message).toContain('§ 8a');
  });

  it('refuses a walk input that carries a chunk key as well', async () => {
    const { deps, sent } = mk();
    const e = await refused(deps, {
      ...walkArg(baseSpec()),
      [CHUNKED_UPLOAD_WIRE_TOKEN_KEY]: TOKEN,
    });
    expect(sent).toHaveLength(0);
    expect(e.message).toContain('exclusive');
  });

  it.each(['body_binary', 'body_raw', 'body_file.media'])(
    'refuses a walk input carrying %s rather than silently dropping it',
    async (key) => {
      // The walk returns before the body builder runs, so an ignored one-shot
      // body would be a caller shipping the wrong bytes and never learning.
      const { deps, sent } = mk();
      const e = await refused(deps, { ...walkArg(baseSpec()), [key]: 'ref-123' });
      expect(sent).toHaveLength(0);
      expect(e.message).toContain('exclusive');
    },
  );

  it('refuses a walk that names no file — the bytes are addressed by ref', async () => {
    const { deps, sent } = mk();
    const e = await refused(deps, { [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
      spec: baseSpec(), total_bytes: TOTAL, count: 4, request_bound: 6,
    } });
    expect(sent).toHaveLength(0);
    expect(e.message).toContain('names no file');
  });
});

describe('D-217 — the op\'s output mapping describes the ACT, not each phase', () => {
  it('maps FINALIZE\'s response, while session_from still reads the RAW INIT shape', async () => {
    // ⛔ Mapping every phase would rewrite the INIT response before
    // `session_from` — written against `{status, headers, result}` — could read
    // it, and the walk would fail for a reason no author could see.
    const { deps, sent } = mk({ finalize: () => ok({ media_id: SESSION, size: 64 }) });
    const out = await run(deps, walkArg(baseSpec()), { 'result.size': 'uploaded_bytes' });

    expect(sent.map((s) => s.command)).toContain('FINALIZE');
    expect(out).toMatchObject({ uploaded_bytes: 64 });
  });

  it('reports the walk telemetry alongside the result when no mapping is declared', async () => {
    const { deps } = mk();
    const out = await run(deps, walkArg(baseSpec())) as {
      upload: { outcome: string; requests: number; chunks_sent: number; bytes_sent: number };
    };
    expect(out.upload).toEqual({
      outcome: 'committed', requests: 6, chunks_sent: 4, bytes_sent: 64,
    });
  });
});

describe('D-217 — the audit row carries the whole walk, not the last request', () => {
  it('sums bytes across every request rather than letting each overwrite the last', async () => {
    // ⚠ `setBytes` OVERWRITES. Handing the real ctx to the phases would report
    // FINALIZE's few bytes as the act's egress; the accumulating ctx is what
    // makes § 6.3 land as ONE honest row.
    const seen: Array<[number, number]> = [];
    const { deps } = mk();
    await run(deps, walkArg(baseSpec()), {}, { setBytes: (i, o) => { seen.push([i, o]); } });

    expect(seen).toHaveLength(1);
    // Four 16-byte chunks at minimum. FINALIZE alone carries none of them.
    expect(seen[0]![1]).toBeGreaterThanOrEqual(TOTAL);
    expect(seen[0]![0]).toBeGreaterThan(0);
  });
});

describe('D-217 slice 4 — the X-shaped protocol, end to end', () => {
  /** X v2: INIT is a JSON POST, APPEND puts the session in the PATH and carries
   *  `segment_index` BESIDE the chunk, FINALIZE is a bare path POST, STATUS is a
   *  GET with query params. Every one of those was a gap in the substrate until
   *  slice 4 asked what the real pack needs. */
  const xSpec = (): ChunkedUploadSpec => ({
    kind: 'chunked',
    arg: 'file',
    chunk_bytes: CHUNK,
    chunk_encoding: 'multipart',
    chunk_field: 'media',
    session_from: 'result.data.id',
    init: {
      method: 'POST',
      path: '/2/media/upload/initialize',
      body: {
        media_type: '{media_type}',
        media_category: '{media_category}',
        total_bytes: '{total_bytes}',
      },
    },
    append: {
      method: 'POST',
      path: '/2/media/upload/{session}/append',
      body: { segment_index: '{segment_index}' },
    },
    finalize: { method: 'POST', path: '/2/media/upload/{session}/finalize' },
    status: {
      method: 'GET',
      path: '/2/media/upload',
      query: { command: 'STATUS', media_id: '{session}' },
      max_polls: 20,
      done: { path: 'result.data.processing_info.state', equals: 'succeeded' },
    },
  });

  const xFetch = (): { deps: ConnectionApiHandlerDeps; sent: Sent[] } => {
    const sent: Sent[] = [];
    const fetchImpl = (async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      const headers: Record<string, string> = {};
      if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
      sent.push({
        url, command: new URL(url).pathname, method: String(init?.method),
        body: init?.body, headers,
      });
      if (url.includes('/initialize')) {
        return ok({ data: { id: 'MEDIA-42' } });
      }
      if (url.includes('command=STATUS')) {
        return ok({ data: { processing_info: { state: 'succeeded' } } });
      }
      return ok({ data: { id: 'MEDIA-42' } });
    }) as unknown as typeof fetch;
    return {
      sent,
      deps: {
        decodeAuth: async () => auth,
        persistAuth: async () => {},
        fetchImpl,
        uploadStaging: {
          stage: async () => ({ token: TOKEN, size_bytes: TOTAL }),
          dispose: async () => {},
        },
        readUploadChunk: async (_t: string, offset: number, length: number) =>
          ({ bytes: STAGED.slice(offset, offset + length), mime_type: 'video/mp4' }),
      },
    };
  };

  it('runs INIT -> APPEND x4 -> FINALIZE -> STATUS against X\'s v2 shape', async () => {
    const { deps, sent } = xFetch();
    const out = await run(deps, {
      [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
        spec: xSpec(),
        file_ref: FILE_REF,
        total_bytes: TOTAL,
        count: 4,
        request_bound: requestBound(xSpec(), 4),
        args: { media_type: 'video/mp4', media_category: 'tweet_video' },
      },
    }) as { upload: { outcome: string } };

    expect(out.upload.outcome).toBe('committed');
    expect(sent.map((s) => `${s.method} ${s.command}`)).toEqual([
      'POST /2/media/upload/initialize',
      'POST /2/media/upload/MEDIA-42/append',
      'POST /2/media/upload/MEDIA-42/append',
      'POST /2/media/upload/MEDIA-42/append',
      'POST /2/media/upload/MEDIA-42/append',
      'POST /2/media/upload/MEDIA-42/finalize',
      'GET /2/media/upload',
    ]);
  });

  it('⛔ sends segment_index BESIDE the chunk, which used to be inexpressible', async () => {
    const { deps, sent } = xFetch();
    await run(deps, {
      [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
        spec: xSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4,
        request_bound: requestBound(xSpec(), 4),
        args: { media_type: 'video/mp4', media_category: 'tweet_video' },
      },
    });

    const appends = sent.filter((s) => s.command.endsWith('/append'));
    expect(appends).toHaveLength(4);
    const third = new TextDecoder().decode(appends[2]!.body as Uint8Array);
    expect(third).toContain('name="media"');
    expect(third).toContain('name="segment_index"');
    expect(third).toMatch(/name="segment_index"[\s\S]*?\r\n\r\n2\r\n/);
    expect(appends[2]!.headers['content-type']).toContain('multipart/form-data');
  });

  it('⛔ sends total_bytes as a JSON NUMBER, not a quoted string', async () => {
    // X's schema declares `total_bytes` an integer. A phase body could only
    // produce strings until slice 4 — so every chunked INIT would have sent
    // `"64"` against a schema wanting `64`.
    const { deps, sent } = xFetch();
    await run(deps, {
      [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
        spec: xSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4,
        request_bound: requestBound(xSpec(), 4),
        args: { media_type: 'video/mp4', media_category: 'tweet_video' },
      },
    });

    const init = JSON.parse(String(sent[0]!.body)) as Record<string, unknown>;
    expect(init.total_bytes).toBe(TOTAL);
    expect(typeof init.total_bytes).toBe('number');
    // …while a genuinely textual field stays text.
    expect(init.media_type).toBe('video/mp4');
    expect(init.media_category).toBe('tweet_video');
  });

  it('reads the session out of X\'s nested data.id', async () => {
    const { deps, sent } = xFetch();
    await run(deps, {
      [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
        spec: xSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4,
        request_bound: requestBound(xSpec(), 4),
        args: { media_type: 'video/mp4', media_category: 'tweet_video' },
      },
    });
    // The handle is in the PATH of every later request, and never in a step value.
    expect(sent[1]!.url).toContain('/MEDIA-42/append');
    expect(new URL(sent[6]!.url).searchParams.get('media_id')).toBe('MEDIA-42');
  });
});

describe('D-217 — staging lives BELOW the commit boundary', () => {
  it('stages the file the WIRE named, bounded, and never a token off the wire', async () => {
    // ⛔ The wire carries a `file_ref`, not a staging token. A per-attempt token
    // on the dispatch input would land in `canonical_payload_hash` and stop an
    // honest repeat matching its grant — failing CLOSED, so nothing would have
    // caught it. Everything on that input is stable; the handle is minted here.
    const { deps, staging } = mk();
    await run(deps, walkArg(baseSpec()));

    expect(staging.staged).toEqual([{ file_ref: FILE_REF, max_bytes: 512 * 1024 * 1024 }]);
    expect(staging.staged).toHaveLength(1);
  });

  it('honours a lower per-op ceiling when staging', async () => {
    const { deps, staging } = mk();
    await run(deps, walkArg({ ...baseSpec(), max_bytes: 1024 }));
    expect(staging.staged[0]!.max_bytes).toBe(1024);
  });

  it('forwards the content pin so a file swapped since planning is refused', async () => {
    const { deps, staging } = mk();
    await run(deps, walkArg(baseSpec(), { expect_sha256: 'deadbeef' }));
    expect(staging.staged[0]!.expect_sha256).toBe('deadbeef');
  });

  it.each([
    ['a clean walk', {}],
    ['a failed APPEND', { append: () => new Response('x', { status: 500 }) }],
    ['a failed INIT', { init: () => new Response('x', { status: 500 }) }],
  ])('disposes the staged plaintext after %s', async (_label, script) => {
    // ⚠ This is the owner's DECRYPTED file on disk. The boot sweep is the
    // backstop for a SIGKILL, not a substitute for disposing on every exit
    // path — including the ones that throw.
    const { deps, staging } = mk(script as Script);
    await run(deps, walkArg(baseSpec())).catch(() => {});
    expect(staging.disposed).toEqual([TOKEN]);
  });

  it('refuses when the host cannot stage at all', async () => {
    const { deps, sent } = mk();
    const { uploadStaging: _drop, ...noStaging } = deps;
    const e = await refused(noStaging as ConnectionApiHandlerDeps, walkArg(baseSpec()));
    expect(sent).toHaveLength(0);
    expect(e.code).toBe('SERVER_NOT_REACHABLE');
  });

  it('refuses a staged file whose size no longer matches the plan', async () => {
    // ⛔ The plan was sized off METADATA at plan time and the bytes were staged
    // later. A mismatch misaligns every chunk offset while each request still
    // returns 200 — a corrupt asset the target accepts and stores.
    const { deps, sent, staging } = mk({}, {}, { stagedSize: TOTAL + 1 });
    const e = await refused(deps, walkArg(baseSpec()));

    expect(sent).toHaveLength(0);
    expect(e.message).toContain('planned');
    // …and the handle is still released.
    expect(staging.disposed).toEqual([TOKEN]);
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
  ])('refuses %s as a content pin rather than staging unpinned', async (_label, bad) => {
    // ⚠ A pin that fails validation must REFUSE, never silently degrade to "no
    // pin" — that would stage whatever the record holds now while the caller
    // believes the bytes were verified.
    const { deps, sent, staging } = mk();
    const e = await refused(deps, walkArg(baseSpec(), { expect_sha256: bad }));
    expect(sent).toHaveLength(0);
    expect(staging.staged).toHaveLength(0);
    expect(e.message).toContain('content hash');
  });

  it('surfaces a content-pin mismatch as a refusal, with nothing sent', async () => {
    const { deps, sent } = mk({}, {}, { stageFails: 'content pin mismatch for blob' });
    const e = await refused(deps, walkArg(baseSpec(), { expect_sha256: 'deadbeef' }));
    expect(sent).toHaveLength(0);
    expect(e.message).toContain('content pin mismatch');
  });
});

describe('D-217 § 6.3 — the audit records what the act DID, not what was intended', () => {
  const walkCtx = (): {
    ctx: { setBytes(i: number, o: number): void; setChunkedUpload(x: unknown): void };
    seen: unknown[];
    bytes: Array<[number, number]>;
  } => {
    const seen: unknown[] = [];
    const bytes: Array<[number, number]> = [];
    return {
      seen,
      bytes,
      ctx: {
        setBytes: (i, o) => { bytes.push([i, o]); },
        setChunkedUpload: (x) => { seen.push(x); },
      },
    };
  };

  it('reports the completed walk with its approved multiplier', async () => {
    const { deps } = mk();
    const { ctx, seen } = walkCtx();
    await run(deps, walkArg(baseSpec()), {}, ctx);
    expect(seen).toEqual([{
      outcome: 'committed', chunks_sent: 4, chunk_count: 4, requests: 6,
      requests_succeeded: 6, requests_failed: 0,
    }]);
  });

  it('⛔ still reports on a FAILED walk — a partial egress is not a no-op', async () => {
    // The row that records "two chunks of this owner's file reached a third
    // party" is the ERROR row; a success row never happens. So the telemetry
    // has to land before the throw, in the same closure the emit reads.
    const { deps } = mk({ append: (n) => (n === 3 ? new Response('x', { status: 500 }) : ok({})) });
    const { ctx, seen } = walkCtx();
    await refused(deps, walkArg(baseSpec()), ctx);
    expect(seen).toEqual([{
      outcome: 'failed', chunks_sent: 2, chunk_count: 4, requests: 4,
      requests_succeeded: 3, requests_failed: 1,
    }]);
  });

  it('⛔ distinguishes committed_unconfirmed from committed, which status cannot', async () => {
    // Both are `status: 'ok'` rows — the act succeeded either way. § 8.1's whole
    // ruling lives in this field past the adapter boundary; without it a poll
    // that never settled is indistinguishable from one that confirmed, and the
    // reader who has to decide whether to retry has nothing to go on.
    const { deps } = mk({ status: () => ok({ state: 'in_progress' }) });
    const { ctx, seen } = walkCtx();
    await run(deps, walkArg(withStatus(2)), {}, ctx);
    expect((seen[0] as { outcome: string }).outcome).toBe('committed_unconfirmed');
  });

  it('reports chunks_sent BELOW chunk_count so the shortfall is legible', async () => {
    // The pair is the point: `bytes_out` alone cannot tell a complete upload
    // from an abandoned one that happened to move the same volume.
    const { deps } = mk({ append: (n) => (n === 2 ? new Response('x', { status: 500 }) : ok({})) });
    const { ctx, seen, bytes } = walkCtx();
    await refused(deps, walkArg(baseSpec()), ctx);
    const info = seen[0] as { chunks_sent: number; chunk_count: number };
    expect(info.chunks_sent).toBeLessThan(info.chunk_count);
    expect(info.chunks_sent).toBe(1);
    // …and the bytes agree with it: one 16-byte chunk left.
    expect(bytes[0]![1]).toBeGreaterThanOrEqual(CHUNK);
  });

  it('reports nothing for a walk refused before any request', async () => {
    // Nothing left, so there is no egress to be honest about — an all-zero row
    // would read as "an upload happened and moved nothing", which is a
    // different and false claim.
    const { deps } = mk();
    const { ctx, seen } = walkCtx();
    await refused(deps, walkArg(baseSpec(), { count: 40 }), ctx);
    expect(seen).toEqual([]);
  });

  it('leaves an ordinary single request untouched', async () => {
    const { deps } = mk();
    const { ctx, seen } = walkCtx();
    await run(deps, { method: 'POST', path: '/1.1/media/upload.json' }, {}, ctx);
    expect(seen).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// 2 — the runner, where each phase's dispatch INPUT is observable
// ────────────────────────────────────────────────────────────────

const spy = (): {
  inputs: Array<Record<string, unknown>>;
  performPhase: (p: Record<string, unknown>, c: { setBytes(i: number, o: number): void }) => Promise<unknown>;
} => {
  const inputs: Array<Record<string, unknown>> = [];
  return {
    inputs,
    performPhase: async (p, c) => {
      inputs.push(p);
      c.setBytes(2, 3);
      return { status: 200, headers: {}, result: { media_id: SESSION } };
    },
  };
};

describe('D-217 — what a phase actually receives', () => {
  it('never puts the walk key on a phase — the recursion is exactly two deep', async () => {
    // ⛔ An unbounded walk-inside-a-walk would rebuild the amplification
    // primitive the carve-out forbids, by a door none of its rules watch.
    const { inputs, performPhase } = spy();
    await runChunkedUpload({
      input: { spec: baseSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6 },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase,
    });
    expect(inputs).toHaveLength(6);
    for (const i of inputs) {
      expect(Object.hasOwn(i, CHUNKED_UPLOAD_WIRE_WALK_KEY)).toBe(false);
    }
  });

  it('refuses a phase input that carries the walk key, however it got there', async () => {
    // ⚠ The backstop, driven directly. Nothing can currently produce such an
    // input — a mutation sweep confirmed deleting the guard changes no
    // behaviour — so the guard is asserted here rather than left to a path
    // that does not exist. It is the fence for the next phase-input source,
    // and an untested fence is one nobody notices going down.
    expect(() => assertNoNestedWalk({ method: 'POST' }, 'append')).not.toThrow();
    expect(() => assertNoNestedWalk(
      { method: 'POST', [CHUNKED_UPLOAD_WIRE_WALK_KEY]: { spec: baseSpec() } },
      'append',
    )).toThrow(/a walk cannot start a walk/);
    // An INHERITED key is not an own key — a walk key on the prototype is not
    // something this phase carries, and treating it as one would refuse a
    // legitimate input.
    expect(() => assertNoNestedWalk(
      Object.create({ [CHUNKED_UPLOAD_WIRE_WALK_KEY]: 'inherited' }) as Record<string, unknown>,
      'append',
    )).not.toThrow();
  });

  it('gives an APPEND a token and a range, and no bytes', async () => {
    const { inputs, performPhase } = spy();
    await runChunkedUpload({
      input: { spec: baseSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6 },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase,
    });
    const appends = inputs.filter((i) => Object.hasOwn(i, CHUNKED_UPLOAD_WIRE_TOKEN_KEY));
    expect(appends).toHaveLength(4);
    expect(appends[2]).toMatchObject({
      [CHUNKED_UPLOAD_WIRE_TOKEN_KEY]: TOKEN,
      [CHUNKED_UPLOAD_WIRE_OFFSET_KEY]: 32,
      [CHUNKED_UPLOAD_WIRE_LENGTH_KEY]: 16,
    });
    // The commit gateway persists a dispatch input as `args` and hashes it —
    // a chunk's bytes there would write the owner's file into the commit log.
    expect(JSON.stringify(appends)).not.toContain('"0,1,2"');
    for (const a of appends) {
      for (const v of Object.values(a)) expect(v).not.toBeInstanceOf(Uint8Array);
    }
  });

  it('asks for the per-request timeout ceiling on APPENDs only', async () => {
    // ⚠ A chunk is up to 25 MB; the handler's 30s default would time out an
    // ordinary APPEND on a modest uplink and fail the whole act closed.
    const { inputs, performPhase } = spy();
    await runChunkedUpload({
      input: { spec: baseSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6 },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase,
    });
    const appends = inputs.filter((i) => Object.hasOwn(i, CHUNKED_UPLOAD_WIRE_TOKEN_KEY));
    for (const a of appends) expect(a.timeout_ms).toBe(MAX_TIMEOUT_MS);
    // INIT / FINALIZE carry small bodies and keep the connection default.
    expect(Object.hasOwn(inputs[0]!, 'timeout_ms')).toBe(false);
    expect(Object.hasOwn(inputs[5]!, 'timeout_ms')).toBe(false);
  });

  it('sets the multipart field only when the declaration asked for one', async () => {
    const binary = spy();
    await runChunkedUpload({
      input: { spec: baseSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6 },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase: binary.performPhase,
    });
    for (const i of binary.inputs) {
      expect(Object.hasOwn(i, CHUNKED_UPLOAD_WIRE_FIELD_KEY)).toBe(false);
    }

    const form = spy();
    await runChunkedUpload({
      input: {
        spec: { ...baseSpec(), chunk_encoding: 'multipart', chunk_field: 'media' },
        file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6,
      },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase: form.performPhase,
    });
    const appends = form.inputs.filter((i) => Object.hasOwn(i, CHUNKED_UPLOAD_WIRE_TOKEN_KEY));
    expect(appends).toHaveLength(4);
    for (const a of appends) expect(a[CHUNKED_UPLOAD_WIRE_FIELD_KEY]).toBe('media');
  });

  it('binds {chunk_length} at INIT to the DECLARED chunk size', async () => {
    // There is no chunk yet at INIT, so the only meaning available is the
    // uniform segment size a target asks for up front.
    const spec = baseSpec();
    spec.init = { ...spec.init, query: { command: 'INIT', seg: '{chunk_length}' } };
    const { inputs, performPhase } = spy();
    await runChunkedUpload({
      input: { spec, file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6 },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase,
    });
    expect(inputs[0]!['query.seg']).toBe(String(CHUNK));
  });

  it('substitutes the op\'s own args into a phase', async () => {
    const spec = baseSpec();
    spec.init = { ...spec.init, query: { command: 'INIT', media_category: '{category}' } };
    const { inputs, performPhase } = spy();
    await runChunkedUpload({
      input: {
        spec, file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6,
        args: { category: 'tweet_video' },
      },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase,
    });
    expect(inputs[0]!['query.media_category']).toBe('tweet_video');
  });
});

describe('D-217 — the overall walk bound', () => {
  it('waits the target-declared, manifest-clamped delay before polling', async () => {
    const spec = withStatus(2);
    spec.status = {
      ...spec.status!,
      retry_after: {
        path: 'result.check_after_secs',
        unit: 'seconds',
        default_ms: 1_000,
        max_ms: 5_000,
      },
    };
    const waits: number[] = [];
    const { inputs, performPhase } = spy();
    await runChunkedUpload({
      input: {
        spec,
        file_ref: FILE_REF,
        total_bytes: TOTAL,
        count: 4,
        request_bound: requestBound(spec),
      },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase: async (p, c) => {
        const response = await performPhase(p, c) as Record<string, unknown>;
        if (String(p['query.command']) === 'FINALIZE') {
          return { ...response, result: { media_id: SESSION, check_after_secs: 2 } };
        }
        if (String(p['query.command']) === 'STATUS') {
          return { ...response, result: { state: 'succeeded' } };
        }
        return response;
      },
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(inputs.some((i) => i['query.command'] === 'STATUS')).toBe(true);
    expect(waits).toEqual([2_000]);
  });

  it('stops the walk when the bound elapses, and sends no commit request', async () => {
    // ⚠ A per-request timeout does not bound a walk: 103 requests at the
    // per-call ceiling is hours. The deadline is checked BEFORE each dispatch,
    // so the request that would have crossed it never leaves.
    let clock = 0;
    const { inputs, performPhase } = spy();
    const out = await runChunkedUpload({
      input: { spec: baseSpec(), file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 6 },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase: async (p, c) => { clock += 400; return performPhase(p, c); },
      now: () => clock,
      maxWalkMs: 1_000,
    });
    // INIT at t=0, APPEND at 400, APPEND at 800; at 1200 the bound is past.
    expect(inputs).toHaveLength(3);
    expect(out.outcome).toBe('failed');
    expect(out.failed_phase).toBe('append');
    expect(out.failed_error?.code).toBe('STEP_TIMEOUT');
  });

  it('a bound blown AFTER finalize is unconfirmed, not failed', async () => {
    // The asset exists by then. Same § 8.1 argument as a poll that times out.
    let clock = 0;
    const inputs: Array<Record<string, unknown>> = [];
    const out = await runChunkedUpload({
      input: { spec: withStatus(5), file_ref: FILE_REF, total_bytes: TOTAL, count: 4, request_bound: 11 },
      staged: { token: TOKEN, size_bytes: TOTAL },
      connectionName: 'x-media',
      performPhase: async (p, c) => {
        inputs.push(p);
        // Only the FINALIZE request burns the remaining budget.
        if (String(p['query.command']) === 'FINALIZE') clock += 5_000;
        c.setBytes(1, 1);
        return { status: 200, headers: {}, result: { media_id: SESSION, state: 'pending' } };
      },
      now: () => clock,
      maxWalkMs: 1_000,
    });
    expect(inputs.map((i) => i['query.command'])).toEqual([
      'INIT', 'APPEND', 'APPEND', 'APPEND', 'APPEND', 'FINALIZE',
    ]);
    expect(out.outcome).toBe('committed_unconfirmed');
  });
});
