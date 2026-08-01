/** D-217 slice 1 — the chunked declaration AT THE VALIDATOR SEAM.
 *
 *  ⚠ `d-217-chunked-upload-bound.test.ts` proves the predicate decides
 *  correctly. That proves nothing about whether the validator CALLS it —
 *  a predicate wired to nothing is a comment with a test suite. These tests
 *  drive `validateComposition` over a whole pack manifest, which is the only
 *  place a third-party author's JSON is actually stopped.
 *
 *  Two seams matter here and neither is visible from the predicate's own file:
 *
 *   1. **`kind: 'chunked'` reaches the bound check at all.** D-216's `kind`
 *      rule was a closed PAIR; widening it and forgetting to dispatch would
 *      leave every chunked declaration unvalidated while still looking wired.
 *   2. **The 25 MB one-shot ceiling must NOT be applied to a chunked op.**
 *      The two paths have different memory models (D-217 § 8b), so running
 *      D-216's rule here would reject every upload this D exists for — a
 *      "safe" failure that silently kills the feature.
 */

import { describe, expect, it } from 'vitest';
import {
  HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
  HTTP_UPLOAD_MAX_BYTES_CEILING,
  type CompositionIngredient,
  type PackOperationRow,
} from '@recued/contracts';
import { validateComposition } from '../index.js';

const CHUNKED = {
  kind: 'chunked',
  arg: 'media',
  chunk_bytes: 5 * 1024 * 1024,
  session_from: 'media_id_string',
  init: { method: 'POST', path: '/1.1/media/upload.json', query: { command: 'INIT', total_bytes: '{total_bytes}' } },
  append: { method: 'POST', path: '/1.1/media/upload.json', query: { command: 'APPEND', media_id: '{session}', segment_index: '{segment_index}' } },
  finalize: { method: 'POST', path: '/1.1/media/upload.json', query: { command: 'FINALIZE', media_id: '{session}' } },
};

const composition = (
  upload: unknown,
  opts: { risk?: string } = {},
): CompositionIngredient => ({
  schema_version: 1,
  slug: 'x-media',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'x-media',
      kind: 'connection',
      http: { base: 'https://upload.twitter.com', connection: 'x' },
    } as unknown as CompositionIngredient['ingredients'][number],
  ],
  operations: [
    {
      op: 'media.upload',
      ingredient: 'x-media',
      risk: (opts.risk ?? 'write') as PackOperationRow['risk'],
      approval: 'always',
      args: [{ key: 'media', type: 'file_ref', required: true }] as never,
      bind: {
        kind: 'rest',
        method: 'POST',
        path: '/1.1/media/upload.json',
        ...(upload !== undefined ? { upload } : {}),
      } as unknown as PackOperationRow['bind'],
      description: 'Upload one video in chunks.',
    },
  ],
} as unknown as CompositionIngredient);

const codes = (c: CompositionIngredient): string[] =>
  validateComposition(c).issues
    .filter((i) => i.code.startsWith('composition_http_upload'))
    .map((i) => i.code);

const paths = (c: CompositionIngredient): string[] =>
  validateComposition(c).issues
    .filter((i) => i.code === 'composition_http_upload_chunked_bound')
    .map((i) => i.path);

describe('D-217 — chunked reaches the validator', () => {
  it("accepts 'chunked' as a kind — D-216's closed pair is widened", () => {
    expect(codes(composition(CHUNKED))).not.toContain('composition_http_upload_kind');
  });

  it('accepts a well-formed chunked declaration with no issues at all', () => {
    expect(codes(composition(CHUNKED))).toEqual([]);
  });

  it('⛔ a bad bound is reported THROUGH the validator, not just by the predicate', () => {
    expect(codes(composition({ ...CHUNKED, chunk_bytes: '{session}' })))
      .toContain('composition_http_upload_chunked_bound');
  });

  it('reports the issue at the upload-scoped path so an author can find it', () => {
    expect(paths(composition({ ...CHUNKED, chunk_bytes: '{session}' })))
      .toContain('operations[0].bind.upload.chunk_bytes');
  });

  it('reports a spec-level violation at the upload path itself', () => {
    // A non-object upload has no field to qualify — the path must still point
    // at the upload rather than at an empty suffix.
    const p = validateComposition(composition({ kind: 'chunked' })).issues
      .filter((i) => i.code === 'composition_http_upload_chunked_bound')
      .map((i) => i.path);
    expect(p.every((x) => x.startsWith('operations[0].bind.upload'))).toBe(true);
    expect(p).not.toContain('operations[0].bind.upload.');
  });

  it('⛔ still applies the risk floor — a read-tier chunked op under-gates', () => {
    expect(codes(composition(CHUNKED, { risk: 'read' })))
      .toContain('composition_http_upload_risk');
  });

  it('⛔ still applies the file_ref arg rule', () => {
    expect(codes(composition({ ...CHUNKED, arg: 'not_an_arg' })))
      .toContain('composition_http_upload_arg');
  });
});

describe('D-217 — the chunked path uses its OWN byte ceiling', () => {
  it('⛔ accepts a max_bytes far above the 25 MB one-shot ceiling', () => {
    // This is the whole point of the D. If D-216's rule leaked onto this path,
    // every real video upload would be rejected — a failure that looks safe.
    const big = HTTP_UPLOAD_MAX_BYTES_CEILING * 4;
    expect(big).toBeGreaterThan(HTTP_UPLOAD_MAX_BYTES_CEILING);
    expect(codes(composition({ ...CHUNKED, max_bytes: big }))).toEqual([]);
  });

  it('accepts exactly the chunked ceiling', () => {
    expect(codes(composition({
      ...CHUNKED, max_bytes: HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
    }))).toEqual([]);
  });

  it('⛔ rejects one byte over the chunked ceiling', () => {
    expect(codes(composition({
      ...CHUNKED, max_bytes: HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING + 1,
    }))).toContain('composition_http_upload_chunked_bound');
  });

  it('leaves the one-shot ceiling exactly where it was', () => {
    // A regression here would silently widen D-216's egress bound.
    expect(codes(composition({
      kind: 'binary', arg: 'media', max_bytes: HTTP_UPLOAD_MAX_BYTES_CEILING + 1,
    }))).toContain('composition_http_upload_max_bytes');
    expect(HTTP_UPLOAD_MAX_BYTES_CEILING).toBe(25 * 1024 * 1024);
  });
});

describe('D-217 — the one-shot forms are untouched', () => {
  it('still accepts multipart and binary', () => {
    expect(codes(composition({ kind: 'multipart', arg: 'media', field: 'file' }))).toEqual([]);
    expect(codes(composition({ kind: 'binary', arg: 'media' }))).toEqual([]);
  });

  it('still rejects an unknown kind', () => {
    expect(codes(composition({ kind: 'streaming', arg: 'media' })))
      .toContain('composition_http_upload_kind');
  });

  it('does not run the chunked bound check on a one-shot declaration', () => {
    expect(codes(composition({ kind: 'multipart', arg: 'media', field: 'file' })))
      .not.toContain('composition_http_upload_chunked_bound');
  });
});
