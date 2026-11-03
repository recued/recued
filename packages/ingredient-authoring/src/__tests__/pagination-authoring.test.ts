import { describe, expect, it } from 'vitest';
import { operationPaginationFields, authoredCollectionResultPath, paginationSelectionAllowed, paginationIncrementAllowed } from '../pagination-authoring.js';
import { validateComposition } from '../validators.js';
import { decomposeComposition } from '../decomposer.js';
import type { CompositionIngredient } from '@recued/contracts';

const composition = (): CompositionIngredient => ({ schema_version: 1, slug: 'collection-api', catalog_kind: 'official',
  ingredients: [{ slug: 'collection-api', kind: 'http', http: { base: 'https://api.example.com', result_path: 'items' } }],
  operations: [{ op: 'item.list', ingredient: 'collection-api', risk: 'read', approval: 'never', bind: { kind: 'rest', method: 'GET', path_template: '/items' } }],
});
describe('shared pagination authoring metadata', () => {
  it('distinguishes GraphQL variables from REST wire parameters and offset page-size requirements', () => {
    expect(operationPaginationFields('graphql_relay', ['page_size']).map(field => field.key)).toEqual(['variable', 'value']);
    expect(operationPaginationFields('query_token', ['page_size']).map(field => field.key)).toEqual(['placement', 'param', 'value', 'max']);
    expect(operationPaginationFields('offset', [], 'by_page_size').find(field => field.key === 'page_size')!.required).toBe(true);
    expect(operationPaginationFields('offset', [], 'page').find(field => field.key === 'page_size')!.required).toBe(false);
    expect(operationPaginationFields('single_page', ['token_to'])).toEqual([]);
    expect(operationPaginationFields('unknown').map(field => field.key)).toEqual(['style']);
  });
  it('shares the selector and increment vocabulary used by canonical pagination validation', () => {
    expect(paginationSelectionAllowed('first')).toBe(true); expect(paginationSelectionAllowed('frist')).toBe(false);
    expect(paginationIncrementAllowed('by_page_size')).toBe(true); expect(paginationIncrementAllowed('by_page_sze')).toBe(false);
    const body = composition(); body.operations[0]!.pagination = { style: 'offset', param: { placement: 'query', param: 'page' }, start: 0, increment: 'page' };
    expect(validateComposition(body).valid).toBe(true);
    body.operations[0]!.pagination.increment = 'by_page_size';
    expect(validateComposition(body).issues.some(issue => issue.code === 'composition_operation_pagination_offset_page_size')).toBe(true);
  });
  it('retains empty overrides through lowering and explains their inherited mapping without trimming paths', () => {
    const body = composition(); body.operations[0]!.result_path = '';
    const catalog = decomposeComposition[1](body).catalog!;
    expect(catalog.operations!['item.list']!.result_path).toBe(''); expect(catalog.surfaces!.api!.result_path).toBe('items');
    expect(authoredCollectionResultPath('', 'items')).toEqual({ mode: 'inherited', path: 'items' });
    expect(authoredCollectionResultPath(undefined, 'items')).toEqual({ mode: 'inherited', path: 'items' });
    expect(authoredCollectionResultPath(' ', 'items')).toEqual({ mode: 'override', path: ' ' });
    expect(authoredCollectionResultPath(undefined, undefined)).toEqual({ mode: 'root', path: '' });
  });
  it('rejects malformed per-operation result metadata instead of describing it as inheritance', () => {
    const body = composition(); (body.operations[0] as any).result_path = 42;
    expect(validateComposition(body).issues).toContainEqual(expect.objectContaining({ code: 'composition_operation_result_path_shape', path: 'operations[0].result_path' }));
    expect(authoredCollectionResultPath(42, 'items')).toBeUndefined(); expect(authoredCollectionResultPath('', null)).toBeUndefined();
  });
});
