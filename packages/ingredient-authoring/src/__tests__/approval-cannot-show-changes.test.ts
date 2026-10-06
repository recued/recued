/** An action that can be held for approval but declares neither reviewable fields
 *  nor request fields gets a write-time hint: its approval card can name the action
 *  and nothing it would change (2026-10-04 — 536 shipped actions in 79 packs). */

import { describe, expect, it } from 'vitest';
import type { CompositionIngredient } from '@recued/contracts';
import { validateComposition } from '../validators.js';

const composition = (operation: Record<string, unknown>): CompositionIngredient => ({
  schema_version: 1,
  slug: 'approval-hint-fixture',
  catalog_kind: 'private_byo',
  ingredients: [{ slug: 'approval-hint-fixture', kind: 'http',
    http: { base: 'https://fixture.invalid', connection: 'fixture-provider' } }],
  operations: [{
    op: 'door.unlock', ingredient: 'approval-hint-fixture', risk: 'admin', approval: 'always',
    args: [{ key: 'body.entity_id', type: 'string', required: true, affects_target: true }],
    bind: { kind: 'rest', method: 'POST', path_template: '/unlock' },
    cache_ttl_ms: 0,
    ...operation,
  }],
} as never);

const hints = (operation: Record<string, unknown>) => validateComposition(composition(operation)).issues
  .filter((issue) => issue.code === 'approval_cannot_show_changes');

describe('approval_cannot_show_changes', () => {
  it('flags a holdable action that declares nothing an approval could show — as info, never blocking', () => {
    const found = hints({});
    expect(found).toEqual([expect.objectContaining({ severity: 'info', path: 'operations[0]' })]);
    expect(validateComposition(composition({})).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('is quiet when the action declares reviewable fields, or request fields the card can show', () => {
    expect(hints({ editable_args: [{ key: 'body.entity_id', type: 'string', label: 'Device' }] })).toEqual([]);
    expect(hints({ request_schema: { type: 'object', additionalProperties: false,
      properties: { 'body.entity_id': { type: 'string', maxLength: 255 } } } })).toEqual([]);
  });

  it('is quiet for an action that is never held, or that takes no arguments', () => {
    expect(hints({ risk: 'read', approval: 'never' })).toEqual([]);
    expect(hints({ args: [] })).toEqual([]);
  });
});
