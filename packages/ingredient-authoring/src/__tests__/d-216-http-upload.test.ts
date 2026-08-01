/** D-216 slice 0 — the `bind.upload` declaration validator.
 *
 *  Declaring `upload` is what lets a pack op send BYTES rather than values,
 *  so the manifest alone answers "can this op reach the network with a file".
 *  The rules exist because each one, unenforced, fails SILENTLY:
 *
 *   - a `read`-tier upload op under-gates rather than mislabels (the D-209
 *     floor clamp only ever RAISES approval, so nothing downstream catches it);
 *   - a non-`file_ref` arg would turn the handler into an arbitrary-file-read
 *     primitive pointed at the network;
 *   - a raised `max_bytes` would defeat the only bound on a resolved Buffer.
 *
 *  Spec: D-216 § 4, § 5.
 */

import { describe, expect, it } from 'vitest';
import {
  HTTP_UPLOAD_MAX_BYTES_CEILING,
  type CompositionIngredient,
  type PackOperationRow,
} from '@recued/contracts';
import { validateComposition } from '../index.js';

const composition = (
  upload: unknown,
  opts: { risk?: string; args?: unknown[] } = {},
): CompositionIngredient => ({
  schema_version: 1,
  slug: 'mastodon',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'mastodon',
      kind: 'connection',
      http: { base: 'https://example.social', connection: 'mastodon' },
    } as unknown as CompositionIngredient['ingredients'][number],
  ],
  operations: [
    {
      op: 'media.create',
      ingredient: 'mastodon',
      risk: (opts.risk ?? 'write') as PackOperationRow['risk'],
      approval: 'always',
      args: (opts.args ?? [{ key: 'file', type: 'file_ref', required: true }]) as never,
      bind: {
        kind: 'rest',
        method: 'POST',
        path: '/api/v2/media',
        ...(upload !== undefined ? { upload } : {}),
      } as unknown as PackOperationRow['bind'],
      description: 'Upload one media attachment.',
    },
  ],
} as unknown as CompositionIngredient);

const codes = (c: CompositionIngredient): string[] =>
  validateComposition(c).issues
    .filter((i) => i.code.startsWith('composition_http_upload'))
    .map((i) => i.code);

describe('D-216 — bind.upload accepted shapes', () => {
  it('accepts a multipart upload naming a file_ref arg and a field', () => {
    expect(codes(composition({ kind: 'multipart', arg: 'file', field: 'file' }))).toEqual([]);
  });

  it('accepts a binary upload with no field', () => {
    expect(codes(composition({ kind: 'binary', arg: 'file' }))).toEqual([]);
  });

  it('is inert when no upload is declared — every existing pack is unaffected', () => {
    expect(codes(composition(undefined))).toEqual([]);
  });

  it.each(['body_binary', 'body_file.file'])(
    'rejects undeclared byte-egress wire arg %s',
    (key) => {
      expect(codes(composition(undefined, {
        args: [{ key, type: 'file_ref', required: true }],
      }))).toContain('composition_http_upload_declaration_required');
    },
  );

  it('accepts a max_bytes that LOWERS the ceiling', () => {
    expect(codes(composition({
      kind: 'binary', arg: 'file', max_bytes: 1024,
    }))).toEqual([]);
  });
});

describe('D-216 — the risk floor (the rule that fails silently)', () => {
  it('⛔ REJECTS a read-tier op that declares an upload', () => {
    // Not a mislabel: the D-209 clamp only ever raises approval, so a `read`
    // upload op is never caught downstream — it just ships files quietly.
    expect(codes(composition({ kind: 'binary', arg: 'file' }, { risk: 'read' })))
      .toContain('composition_http_upload_risk');
  });

  it.each(['write', 'admin', 'destructive'] as const)(
    'allows risk %s',
    (risk) => {
      expect(codes(composition({ kind: 'binary', arg: 'file' }, { risk })))
        .not.toContain('composition_http_upload_risk');
    },
  );
});

describe('D-216 — the arg must be a declared file_ref', () => {
  it('⛔ rejects an arg that is not declared on the op at all', () => {
    expect(codes(composition({ kind: 'binary', arg: 'nope' })))
      .toContain('composition_http_upload_arg');
  });

  it('⛔ rejects a declared arg of the wrong type', () => {
    expect(codes(composition(
      { kind: 'binary', arg: 'file' },
      { args: [{ key: 'file', type: 'string', required: true }] },
    ))).toContain('composition_http_upload_arg_type');
  });

  it('⛔ rejects a bare-string arg — implicitly `string`, not a ref', () => {
    // The shorthand form is easy to reach for and would otherwise pass the
    // "is it declared?" check while being the wrong type.
    expect(codes(composition({ kind: 'binary', arg: 'file' }, { args: ['file'] })))
      .toContain('composition_http_upload_arg_type');
  });

  it('rejects a missing arg name', () => {
    expect(codes(composition({ kind: 'binary' }))).toContain('composition_http_upload_arg');
  });
});

describe('D-216 — kind / field coherence', () => {
  it('rejects an unknown kind', () => {
    // ⚠ This example was `'chunked'` until D-217 slice 1 made that a REAL kind,
    // and the test caught it — which is the test doing its job, not a
    // regression. A kind-vocabulary example must be a name the union will
    // never take; `'streaming'` is not on any roadmap here.
    expect(codes(composition({ kind: 'streaming', arg: 'file' })))
      .toContain('composition_http_upload_kind');
  });

  it('⛔ multipart REQUIRES a field name', () => {
    expect(codes(composition({ kind: 'multipart', arg: 'file' })))
      .toContain('composition_http_upload_field');
  });

  it('⛔ binary FORBIDS a field — the file IS the body', () => {
    expect(codes(composition({ kind: 'binary', arg: 'file', field: 'file' })))
      .toContain('composition_http_upload_field');
  });

  it('rejects a non-object upload', () => {
    expect(codes(composition('multipart'))).toContain('composition_http_upload_shape');
  });
});

describe('D-216 — max_bytes lowers only', () => {
  it('⛔ rejects a max_bytes that RAISES the handler ceiling', () => {
    expect(codes(composition({
      kind: 'binary', arg: 'file', max_bytes: HTTP_UPLOAD_MAX_BYTES_CEILING + 1,
    }))).toContain('composition_http_upload_max_bytes');
  });

  it('accepts exactly the ceiling', () => {
    expect(codes(composition({
      kind: 'binary', arg: 'file', max_bytes: HTTP_UPLOAD_MAX_BYTES_CEILING,
    }))).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-positive / non-finite max_bytes (%s)',
    (v) => {
      expect(codes(composition({ kind: 'binary', arg: 'file', max_bytes: v })))
        .toContain('composition_http_upload_max_bytes');
    },
  );
});
