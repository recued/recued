/** D-228 launch hardening — a downloaded catalog may not claim a server-owned
 * grant identity, and two catalog keys may not collapse onto one identity. */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';

import { validateIngredient } from '../validate.js';

const catalog = (
  operationIds: Record<string, string>,
  author = 'community-author',
): IngredientManifest => ({
  slug: 'operation-identity-fixture',
  name: 'Operation identity fixture',
  description: 'Catalog used to pin operation grant identity validation.',
  author,
  kind: 'connection',
  version: 1,
  category: 'action',
  risk_tier: 'write',
  supported_platforms: [],
  tags: [],
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: Object.fromEntries(Object.entries(operationIds).map(([key, operation_id]) => [
    key,
    { operation_id, risk_tier: 'read' as const },
  ])),
});

const issuesFor = (manifest: IngredientManifest, code: string) =>
  validateIngredient(manifest).issues.filter((issue) => issue.code === code);

describe('declared catalog operation grant identities', () => {
  it.each([
    'data.mail',
    'enrichment.embedding',
    'core.mail.send',
    'primitive.recipe.run',
    'ingredient.mail-send_01234567',
  ])('refuses the reserved namespace in %s', (operationId) => {
    const issues = issuesFor(catalog({ invoke: operationId }), 'CATALOG_OPERATION_ID_RESERVED');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('operations.invoke.operation_id');
    expect(validateIngredient(catalog({ invoke: operationId })).valid).toBe(false);
  });

  it('still permits genuine server ids at their own grant seam', () => {
    // A reviewed kernel manifest is the sole declaration owner of `core.*`.
    expect(issuesFor(catalog({ invoke: 'core.mail.send' }, 'recued'),
      'CATALOG_OPERATION_ID_RESERVED')).toEqual([]);
    // An ordinary pack-owned id is unaffected by the reservation.
    expect(issuesFor(catalog({ invoke: 'community-author.mail-pack.message.send' }),
      'CATALOG_OPERATION_ID_RESERVED')).toEqual([]);
  });

  it('refuses two lookup keys that collapse onto one authorization identity', () => {
    const manifest = catalog({
      first: 'community-author.mail-pack.message.send',
      second: 'community-author.mail-pack.message.send',
    });
    const issues = issuesFor(manifest, 'CATALOG_OPERATION_ID_DUPLICATE');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('operations.second.operation_id');
    expect(validateIngredient(manifest).valid).toBe(false);
  });

  it('refuses whitespace-only and padded identities instead of storing invisible keys', () => {
    for (const operationId of ['   ', ' community-author.mail-pack.read']) {
      const issues = issuesFor(catalog({ invoke: operationId }), 'CATALOG_OPERATION_INVALID');
      expect(issues, JSON.stringify(operationId)).toHaveLength(1);
    }
  });
});
