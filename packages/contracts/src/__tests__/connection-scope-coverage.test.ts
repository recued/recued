/** granted-scope coverage — unit tests for the pure helpers bridging a
 *  pack's per-op `required_scopes` to a connection's vendor-granted set.
 *
 *  `requiredScopesByConnection` — union of required scopes per connection
 *  slot, across ops / ingredients / compositions; cli/ai ops (no connection)
 *  contribute nothing.
 *  `scopeCoverage` — covered / missing / unknown semantics (a `granted` of
 *  `undefined` is "unknown", never "missing everything"). */

import { describe, it, expect } from 'vitest';
import {
  requiredScopesByConnection,
  declaredConnectionSlots,
  unionRequiredScopesForConnection,
  scopeCoverage,
  type BulkPackManifest,
  type IngredientRow,
  type PackOperationRow,
} from '../index.js';

const op = (
  opId: string,
  ingredient: string,
  required_scopes?: string[],
): PackOperationRow => ({
  op: opId,
  ingredient,
  risk: 'read',
  approval: 'never',
  bind: { method: 'GET', path: '/' },
  ...(required_scopes !== undefined ? { required_scopes } : {}),
});

const httpIngredient = (slug: string, connection?: string): IngredientRow => ({
  slug,
  kind: 'http',
  http: { base: 'https://x', ...(connection !== undefined ? { connection } : {}) },
});

const connectionIngredient = (slug: string, connection: string): IngredientRow => ({
  slug,
  kind: 'connection',
  connection: { connection },
});

const mcpIngredient = (slug: string, connection: string): IngredientRow => ({
  slug,
  kind: 'mcp',
  mcp: { connection },
});

const cliIngredient = (slug: string): IngredientRow => ({ slug, kind: 'cli' });

// Minimal manifest carrying only what the helper reads (contents →
// composition → ingredients/operations). The `as unknown` cast keeps the
// fixture focused — the helper touches no other manifest field.
const manifestOf = (
  ...compositions: ReadonlyArray<{
    ingredients: IngredientRow[];
    operations: PackOperationRow[];
  }>
): BulkPackManifest =>
  ({
    contents: compositions.map((c) => ({
      type: 'composition',
      composition: {
        schema_version: 1,
        slug: 'pack-catalog',
        ingredients: c.ingredients,
        operations: c.operations,
      },
    })),
  }) as unknown as BulkPackManifest;

describe('requiredScopesByConnection', () => {
  it('unions per-op required_scopes per connection slot (sorted, de-duped)', () => {
    const manifest = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot')],
      operations: [
        op('deal.read', 'hs', ['crm.objects.deals.read']),
        op('deal.create', 'hs', ['crm.objects.deals.write', 'crm.objects.deals.read']),
        op('contact.read', 'hs', ['crm.objects.contacts.read']),
      ],
    });
    expect(requiredScopesByConnection(manifest)).toEqual({
      hubspot: [
        'crm.objects.contacts.read',
        'crm.objects.deals.read',
        'crm.objects.deals.write',
      ],
    });
  });

  it('attributes scopes to the right slot when ops span multiple connections', () => {
    const manifest = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot'), connectionIngredient('sl', 'slack')],
      operations: [
        op('deal.read', 'hs', ['crm.objects.deals.read']),
        op('message.send', 'sl', ['chat:write']),
      ],
    });
    expect(requiredScopesByConnection(manifest)).toEqual({
      hubspot: ['crm.objects.deals.read'],
      slack: ['chat:write'],
    });
  });

  it('detects the connection slot for connection- and mcp-kind ingredients', () => {
    const manifest = manifestOf({
      ingredients: [connectionIngredient('c', 'conn'), mcpIngredient('m', 'mcpserver')],
      operations: [op('a', 'c', ['s1']), op('b', 'm', ['s2'])],
    });
    expect(requiredScopesByConnection(manifest)).toEqual({
      conn: ['s1'],
      mcpserver: ['s2'],
    });
  });

  it('contributes nothing for an op whose ingredient binds no connection (cli)', () => {
    const manifest = manifestOf({
      ingredients: [cliIngredient('whisper')],
      operations: [op('transcribe', 'whisper', ['ignored.scope'])],
    });
    expect(requiredScopesByConnection(manifest)).toEqual({});
  });

  it('unions across multiple compositions into the same slot', () => {
    const manifest = manifestOf(
      {
        ingredients: [httpIngredient('hs', 'hubspot')],
        operations: [op('deal.read', 'hs', ['crm.objects.deals.read'])],
      },
      {
        ingredients: [httpIngredient('hs2', 'hubspot')],
        operations: [op('contact.read', 'hs2', ['crm.objects.contacts.read'])],
      },
    );
    expect(requiredScopesByConnection(manifest)).toEqual({
      hubspot: ['crm.objects.contacts.read', 'crm.objects.deals.read'],
    });
  });

  it('skips ops with no required_scopes + drops empties/whitespace', () => {
    const manifest = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot')],
      operations: [
        op('a', 'hs'),
        op('b', 'hs', ['  ', '']),
        op('c', 'hs', [' x ']),
      ],
    });
    expect(requiredScopesByConnection(manifest)).toEqual({ hubspot: ['x'] });
  });

  it('omits a slot whose ops carry only whitespace/empty scopes', () => {
    const manifest = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot')],
      operations: [op('a', 'hs', ['  ', '']), op('b', 'hs')],
    });
    expect(requiredScopesByConnection(manifest)).toEqual({});
  });

  it('returns {} for a v1 pack with no contents', () => {
    expect(requiredScopesByConnection({} as unknown as BulkPackManifest)).toEqual({});
  });
});

describe('declaredConnectionSlots', () => {
  it('emits a NO-SCOPE slot for an API-key connection (the Stripe case)', () => {
    // An http connection whose ops declare no required_scopes — the difference
    // vs requiredScopesByConnection, which omits it.
    const manifest = manifestOf({
      ingredients: [httpIngredient('stripe-billing', 'stripe')],
      operations: [op('invoice.read', 'stripe-billing'), op('invoice.create', 'stripe-billing')],
    });
    expect(declaredConnectionSlots(manifest)).toEqual({ stripe: [] });
    // Contrast: the scope-only helper drops it entirely.
    expect(requiredScopesByConnection(manifest)).toEqual({});
  });

  it('carries the scope union for a scope-bearing slot AND a `[]` for a no-scope slot', () => {
    const manifest = manifestOf({
      ingredients: [
        httpIngredient('hs', 'hubspot'),
        httpIngredient('stripe-billing', 'stripe'),
      ],
      operations: [
        op('deal.read', 'hs', ['crm.objects.deals.read']),
        op('invoice.read', 'stripe-billing'),
      ],
    });
    expect(declaredConnectionSlots(manifest)).toEqual({
      hubspot: ['crm.objects.deals.read'],
      stripe: [],
    });
  });

  it('detects the slot for connection- and mcp-kind ingredients too', () => {
    const manifest = manifestOf({
      ingredients: [connectionIngredient('sl', 'slack'), mcpIngredient('mp', 'notion')],
      operations: [op('post', 'sl'), op('query', 'mp')],
    });
    expect(declaredConnectionSlots(manifest)).toEqual({ slack: [], notion: [] });
  });

  it('contributes nothing for a pure-cli pack (no connection bound)', () => {
    const manifest = manifestOf({
      ingredients: [cliIngredient('age')],
      operations: [op('age', 'age')],
    });
    expect(declaredConnectionSlots(manifest)).toEqual({});
  });

  it('returns {} for a v1 pack with no contents', () => {
    expect(declaredConnectionSlots({} as unknown as BulkPackManifest)).toEqual({});
  });
});

describe('unionRequiredScopesForConnection', () => {
  it('unions one slot across multiple installed-pack manifests (sorted, de-duped)', () => {
    const packA = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot')],
      operations: [op('deal.read', 'hs', ['crm.objects.deals.read'])],
    });
    const packB = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot')],
      operations: [
        op('deal.write', 'hs', ['crm.objects.deals.write', 'crm.objects.deals.read']),
      ],
    });
    expect(unionRequiredScopesForConnection([packA, packB], 'hubspot')).toEqual([
      'crm.objects.deals.read',
      'crm.objects.deals.write',
    ]);
  });

  it('ignores packs that declare a different vendor on that slot', () => {
    const hs = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot')],
      operations: [op('deal.read', 'hs', ['crm.objects.deals.read'])],
    });
    const sf = manifestOf({
      ingredients: [httpIngredient('sf', 'salesforce')],
      operations: [op('opp.read', 'sf', ['api'])],
    });
    expect(unionRequiredScopesForConnection([hs, sf], 'hubspot')).toEqual([
      'crm.objects.deals.read',
    ]);
  });

  it('returns [] when no manifest needs the slot (fresh enroll = seed only)', () => {
    const hs = manifestOf({
      ingredients: [httpIngredient('hs', 'hubspot')],
      operations: [op('deal.read', 'hs', ['crm.objects.deals.read'])],
    });
    expect(unionRequiredScopesForConnection([hs], 'slack')).toEqual([]);
    expect(unionRequiredScopesForConnection([], 'hubspot')).toEqual([]);
  });
});

describe('scopeCoverage', () => {
  it('is unknown (soft) when the granted set is undefined', () => {
    expect(scopeCoverage(['a', 'b'], undefined)).toEqual({
      known: false,
      covered: false,
      missing: [],
    });
  });

  it('is covered when every needed scope is granted', () => {
    expect(scopeCoverage(['a', 'b'], ['a', 'b', 'c'])).toEqual({
      known: true,
      covered: true,
      missing: [],
    });
  });

  it('reports the sorted missing diff when under-scoped', () => {
    expect(scopeCoverage(['write', 'read', 'admin'], ['read'])).toEqual({
      known: true,
      covered: false,
      missing: ['admin', 'write'],
    });
  });

  it('an empty needed set is trivially covered (when known)', () => {
    expect(scopeCoverage([], ['a'])).toEqual({ known: true, covered: true, missing: [] });
  });

  it('trims both sides before comparing', () => {
    expect(scopeCoverage([' a ', 'b'], ['a', ' b '])).toEqual({
      known: true,
      covered: true,
      missing: [],
    });
  });

  it('treats a known-empty granted set as missing everything (defensive)', () => {
    expect(scopeCoverage(['a'], [])).toEqual({
      known: true,
      covered: false,
      missing: ['a'],
    });
  });
});
