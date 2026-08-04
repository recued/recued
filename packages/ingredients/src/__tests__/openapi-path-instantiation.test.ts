/** A wire path may INSTANTIATE a documented parameter — opt-in via `openapi_path`.
 *
 *  Zoho CRM documents `/{module}`, `/{module}/{recordID}`, `/{module}/upsert`
 *  and callers reach them by substituting a constant, so a pack that reads deals
 *  binds the literal `/Deals`. Those are the documented operations, but no
 *  relation in the prover saw it: `normalizePathTemplate` collapses only BRACED
 *  segments, so a literal never meets a parameter. 98 shipped operations across
 *  two Zoho packs were unprovable on exactly that.
 *
 *  The relaxation is reachable ONLY through a per-op `openapi_path`, so the
 *  author must name the documented route they mean. These tests pin both halves:
 *  what it now admits, and — the half that matters — everything it still refuses.
 *
 *  ⚠ It deliberately does NOT check that the substituted value is a real module.
 *  The prover establishes `(method, path)` and nothing about values (guide §6);
 *  `/{module}` genuinely admits any segment. A test asserting otherwise would be
 *  asserting a guarantee the substrate does not make. */

import { describe, expect, it } from 'vitest';

import { crossCheckCatalogOpenApi } from '../validate.js';

const DOC = {
  openapi: '3.1.0',
  paths: {
    '/{module}': { get: {}, post: {} },
    '/{module}/{recordID}': { get: {}, put: {} },
    '/{module}/upsert': { post: {} },
    '/org': { get: {} },
    '/tickets/{id}/comments': { get: {} },
  },
};

const manifest = (opKey: string, method: string, pathTemplate: string, openapiPath?: string) => ({
  surfaces: {
    api: {
      openapi_source: { url: 'https://example.test/o.json', sha256: 'a'.repeat(64) },
      executes: {
        [opKey]: {
          kind: 'rest',
          method,
          path_template: pathTemplate,
          ...(openapiPath !== undefined ? { openapi_path: openapiPath } : {}),
        },
      },
    },
  },
});

const errorsFor = (m: unknown): string[] =>
  crossCheckCatalogOpenApi(m as never, DOC).issues
    .filter((i) => i.severity === 'error')
    .map((i) => i.code);

describe('a wire literal may instantiate a documented parameter', () => {
  it('⛔ WITHOUT the override it is still refused — the relaxation is opt-in', () => {
    // The control the whole design rests on. If a bare literal proved against a
    // documented parameter with no declaration, this would be a silent widening
    // of every pack in the corpus rather than an author's explicit claim.
    expect(errorsFor(manifest('deal.list', 'GET', '/Deals'))).toEqual(['CATALOG_OPENAPI_MISMATCH']);
  });

  it('with `openapi_path` naming the documented route, it proves', () => {
    expect(errorsFor(manifest('deal.list', 'GET', '/Deals', '/{module}'))).toEqual([]);
    expect(errorsFor(manifest('deal.read', 'GET', '/Deals/{{deal_id}}', '/{module}/{recordID}'))).toEqual([]);
    expect(errorsFor(manifest('deal.upsert', 'POST', '/Deals/upsert', '/{module}/upsert'))).toEqual([]);
  });

  it('the METHOD is still checked against the documented route', () => {
    // Instantiation reconciles the PATH. It must not smuggle a method the
    // document does not define on it.
    expect(errorsFor(manifest('deal.wipe', 'DELETE', '/Deals', '/{module}')))
      .toEqual(['CATALOG_OPENAPI_MISMATCH']);
  });

  it('⛔ the reverse direction is refused — a wire param may not claim a doc literal', () => {
    // `/{module}` reaching a documented `/org` would be the pack claiming a
    // breadth the document does not grant: one documented operation used as a
    // licence for every module.
    expect(errorsFor(manifest('org.read', 'GET', '/{{module}}', '/org')))
      .toEqual(['CATALOG_OPENAPI_MISMATCH']);
  });

  it('⛔ an unrelated path of the same shape is refused', () => {
    // Same segment count, but the literal segments disagree — this is a
    // re-point, which is what the override guard exists to prevent.
    expect(errorsFor(manifest('bad', 'GET', '/Deals/comments', '/{module}/upsert')))
      .toEqual(['CATALOG_OPENAPI_MISMATCH']);
  });

  it('⛔ a differing segment COUNT is refused', () => {
    // Length differences are the interior-expansion relation's business, and it
    // anchors both ends. Instantiation must not become a second, looser way in.
    expect(errorsFor(manifest('bad', 'GET', '/Deals/x/y', '/{module}')))
      .toEqual(['CATALOG_OPENAPI_MISMATCH']);
  });

  it('the pre-existing interior-expansion relation still works', () => {
    // The new rule is an OR arm; a regression here would be silent.
    expect(errorsFor(manifest('comment.list', 'GET', '/tickets/{{id}}/comments', '/tickets/{id}/comments')))
      .toEqual([]);
  });

  it('a documented literal path with no override still proves verbatim', () => {
    expect(errorsFor(manifest('org.read', 'GET', '/org'))).toEqual([]);
  });
});
