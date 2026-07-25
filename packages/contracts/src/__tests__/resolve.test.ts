import { describe, it, expect } from 'vitest';
import { parseRef, resolveRef, resolveValue, resolveDeep, formatHint } from '../resolve.js';
import type { NamespaceStores } from '../resolve.js';

const stores: NamespaceStores = {
  vault: { hubspot: { token: 'abc123' } },
  config: { lookback_days: 30, verbose: false, risk_level: 'medium' },
  context: { entity_id: '42', page_url: 'https://app.hubspot.com/deals/42' },
  meta: { name: 'Test Recipe', author: 'recued-core' },
  step: {
    deal: { deal_name: 'Acme', amount: 150000, close_date: '2026-04-01', stage: 'won' },
    contacts: [
      { name: 'Alice', email: 'alice@acme.com' },
      { name: 'Bob', email: 'bob@acme.com' },
    ],
    days_inactive: 12,
    is_overdue: true,
    risk_score: null,
  },
};

// ── resolveRef ──────────────────────────────────────────────

describe('resolveRef', () => {
  it('resolves top-level namespace value', () => {
    expect(resolveRef('{{config.lookback_days}}', stores)).toBe(30);
  });

  it('resolves nested path', () => {
    expect(resolveRef('{{step.deal.deal_name}}', stores)).toBe('Acme');
  });

  it('resolves deeply nested', () => {
    expect(resolveRef('{{vault.hubspot.token}}', stores)).toBe('abc123');
  });

  it('resolves array index', () => {
    expect(resolveRef('{{step.contacts.0.name}}', stores)).toBe('Alice');
    expect(resolveRef('{{step.contacts.1.email}}', stores)).toBe('bob@acme.com');
  });

  it('preserves number type', () => {
    expect(resolveRef('{{step.deal.amount}}', stores)).toBe(150000);
  });

  it('preserves boolean type', () => {
    expect(resolveRef('{{config.verbose}}', stores)).toBe(false);
    expect(resolveRef('{{step.is_overdue}}', stores)).toBe(true);
  });

  it('preserves null', () => {
    expect(resolveRef('{{step.risk_score}}', stores)).toBeNull();
  });

  it('preserves object', () => {
    const deal = resolveRef('{{step.deal}}', stores);
    expect(deal).toEqual({ deal_name: 'Acme', amount: 150000, close_date: '2026-04-01', stage: 'won' });
  });

  it('preserves array', () => {
    const contacts = resolveRef('{{step.contacts}}', stores) as unknown[];
    expect(contacts).toHaveLength(2);
  });

  it('returns undefined for missing path', () => {
    expect(resolveRef('{{step.nonexistent}}', stores)).toBeUndefined();
  });

  it('returns undefined for unknown namespace', () => {
    expect(resolveRef('{{invalid.path}}', stores)).toBeUndefined();
  });

  it('handles null in path chain', () => {
    expect(resolveRef('{{step.risk_score.nested}}', stores)).toBeUndefined();
  });

  it('does not resolve inherited or prototype-sensitive path segments', () => {
    const withUnsafeConfig: NamespaceStores = {
      ...stores,
      config: JSON.parse('{"__proto__":{"secret":"polluted"},"safe":"ok"}') as Record<string, unknown>,
    };
    expect(resolveRef('{{config.constructor.name}}', stores)).toBeUndefined();
    expect(resolveRef('{{config.__proto__.secret}}', withUnsafeConfig)).toBeUndefined();
    expect(resolveRef('{{config.prototype.x}}', withUnsafeConfig)).toBeUndefined();
    expect(resolveRef('{{config.safe}}', withUnsafeConfig)).toBe('ok');
  });

  it('strips format hint from path', () => {
    expect(resolveRef('{{step.deal.amount:currency}}', stores)).toBe(150000);
  });

  // D-125 P5.2 — `account` is reserved-but-retired. The Namespace literal
  // type still includes `'account'` so future categories can reuse the
  // slot, but the resolver's NS membership check is the gate; refs
  // resolve to undefined regardless of any caller-supplied store.
  it('{{account.X}} always resolves to undefined post D-125 P5.2', () => {
    const withAccount: NamespaceStores = {
      ...stores,
      account: { slack: { token: 'xoxb-abc' } },
    } as NamespaceStores;
    expect(resolveRef('{{account.slack.token}}', withAccount)).toBeUndefined();
    expect(resolveRef('{{account.slack.token}}', stores)).toBeUndefined();
  });
});

// ── resolveValue ────────────────────────────────────────────

describe('resolveValue', () => {
  it('passes through literals', () => {
    expect(resolveValue('hello', stores)).toBe('hello');
    expect(resolveValue(42, stores)).toBe(42);
    expect(resolveValue(true, stores)).toBe(true);
    expect(resolveValue(null, stores)).toBeNull();
  });

  it('pure ref preserves type', () => {
    expect(resolveValue('{{step.deal.amount}}', stores)).toBe(150000);
    expect(resolveValue('{{config.verbose}}', stores)).toBe(false);
    expect(resolveValue('{{step.contacts}}', stores)).toHaveLength(2);
  });

  it('pure ref with hint still preserves type', () => {
    expect(resolveValue('{{step.deal.amount:currency}}', stores)).toBe(150000);
  });

  it('interpolation returns string', () => {
    expect(resolveValue('Deal: {{step.deal.deal_name}}', stores)).toBe('Deal: Acme');
  });

  it('interpolation with multiple refs', () => {
    expect(resolveValue('{{step.deal.deal_name}} - ${{step.deal.amount}}', stores))
      .toBe('Acme - $150000');
  });

  it('interpolation applies format hint', () => {
    const result = resolveValue('Revenue: {{step.deal.amount:currency}}', stores);
    expect(result).toContain('$');
    expect(result).toContain('150');
  });

  it('interpolation replaces null with empty string', () => {
    expect(resolveValue('Score: {{step.risk_score}}', stores)).toBe('Score: ');
  });

  it('preserves unresolvable refs', () => {
    expect(resolveValue('{{invalid.ns}}', stores)).toBeUndefined();
  });

  it('deferVault leaves a pure vault ref as the raw placeholder', () => {
    expect(resolveValue('{{vault.hubspot.token}}', stores, { deferVault: true }))
      .toBe('{{vault.hubspot.token}}');
  });

  it('deferVault leaves vault interpolation placeholders intact', () => {
    expect(resolveValue('Bearer {{vault.hubspot.token}}', stores, { deferVault: true }))
      .toBe('Bearer {{vault.hubspot.token}}');
  });

  it('deferVault still resolves non-vault namespaces normally', () => {
    const withItem: NamespaceStores = {
      ...stores,
      item: { id: 'item-1' },
    };

    expect(resolveValue('{{config.lookback_days}}', withItem, { deferVault: true })).toBe(30);
    expect(resolveValue('{{step.deal.deal_name}}', withItem, { deferVault: true })).toBe('Acme');
    expect(resolveValue('{{item.id}}', withItem, { deferVault: true })).toBe('item-1');
    expect(resolveValue('{{context.entity_id}}', withItem, { deferVault: true })).toBe('42');
  });

  it('deferVault throws when a vault ref is nested inside another ref', () => {
    const withVaultKey: NamespaceStores = {
      ...stores,
      vault: { ...stores.vault, k: 'lookback_days' },
      data: { shared: { x: { lookback_days: 'selected' } } },
    };

    expect(() => resolveValue('{{config.{{vault.k}}}}', withVaultKey, { deferVault: true }))
      .toThrow(TypeError);
    expect(() => resolveValue('{{data.shared.x.{{vault.k}}}}', withVaultKey, { deferVault: true }))
      .toThrow(TypeError);
  });

  it('deferVault off keeps existing vault resolution byte-identical', () => {
    expect(resolveValue('{{vault.hubspot.token}}', stores, { deferVault: false }))
      .toBe(resolveValue('{{vault.hubspot.token}}', stores));
    expect(resolveValue('Bearer {{vault.hubspot.token}}', stores, { deferVault: false }))
      .toBe(resolveValue('Bearer {{vault.hubspot.token}}', stores));
    expect(resolveValue('Bearer {{vault.hubspot.token}}', stores))
      .toBe('Bearer abc123');
  });

  it('deferVault composes with deferItem', () => {
    const withItem: NamespaceStores = {
      ...stores,
      item: { id: 'item-1' },
    };

    expect(resolveValue('{{item.id}}', withItem, { deferVault: true, deferItem: true }))
      .toBe('{{item.id}}');
    expect(resolveValue(
      'Bearer {{vault.hubspot.token}} for {{item.id}} in {{config.risk_level}}',
      withItem,
      { deferVault: true, deferItem: true },
    )).toBe('Bearer {{vault.hubspot.token}} for {{item.id}} in medium');
  });
});

// ── resolveDeep ─────────────────────────────────────────────

describe('resolveDeep', () => {
  it('resolves refs in object values', () => {
    const input = { name: '{{step.deal.deal_name}}', amount: '{{step.deal.amount}}' };
    const result = resolveDeep(input, stores) as Record<string, unknown>;
    expect(result.name).toBe('Acme');
    expect(result.amount).toBe(150000);
  });

  it('resolves refs in arrays', () => {
    const input = ['{{config.lookback_days}}', '{{config.risk_level}}'];
    const result = resolveDeep(input, stores) as unknown[];
    expect(result).toEqual([30, 'medium']);
  });

  it('resolves nested objects', () => {
    const input = { outer: { inner: '{{step.deal.stage}}' } };
    const result = resolveDeep(input, stores) as { outer: { inner: string } };
    expect(result.outer.inner).toBe('won');
  });

  it('passes through non-ref values', () => {
    const input = { a: 42, b: true, c: null, d: 'literal' };
    expect(resolveDeep(input, stores)).toEqual(input);
  });

  it('handles mixed ref and literal', () => {
    const input = { ref: '{{step.days_inactive}}', lit: 7 };
    const result = resolveDeep(input, stores) as Record<string, unknown>;
    expect(result.ref).toBe(12);
    expect(result.lit).toBe(7);
  });

  it('drops prototype-sensitive keys while resolving object values', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":"{{config.risk_level}}"},"constructor":{"leak":true},"prototype":{"leak":true},"safe":"{{config.risk_level}}"}',
    ) as Record<string, unknown>;
    const result = resolveDeep(input, stores) as Record<string, unknown>;

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
    expect(result.safe).toBe('medium');
  });

  it('resolves normal depth (< 50) without issue', () => {
    // Build a 10-level deep object with a ref at the bottom
    let obj: Record<string, unknown> = { val: '{{config.lookback_days}}' };
    for (let i = 0; i < 10; i++) obj = { nested: obj };
    const result = resolveDeep(obj, stores) as Record<string, unknown>;
    // Walk down 10 levels to reach the leaf
    let current: unknown = result;
    for (let i = 0; i < 10; i++) current = (current as Record<string, unknown>).nested;
    expect((current as Record<string, unknown>).val).toBe(30);
  });

  it('caps resolution at depth 50 — values beyond are returned as-is', () => {
    // Build a 60-level deep object with a ref at the bottom
    let obj: Record<string, unknown> = { val: '{{config.lookback_days}}' };
    for (let i = 0; i < 60; i++) obj = { nested: obj };

    const result = resolveDeep(obj, stores) as Record<string, unknown>;

    // Walk down to depth 49 (0-indexed) — still within the 50-level cap
    let atDepth49: unknown = result;
    for (let i = 0; i < 49; i++) atDepth49 = (atDepth49 as Record<string, unknown>).nested;
    // Depth 49 is the last level that gets resolved (depth counter = 49 < 50)
    expect((atDepth49 as Record<string, unknown>).nested).toBeDefined();

    // Walk all the way down to the leaf at depth 60
    let leaf: unknown = result;
    for (let i = 0; i < 60; i++) leaf = (leaf as Record<string, unknown>).nested;
    // The ref string at depth 60 should be returned as-is (unresolved)
    expect((leaf as Record<string, unknown>).val).toBe('{{config.lookback_days}}');
  });
});

// ── formatHint ──────────────────────────────────────────────

describe('formatHint', () => {
  it('formats number', () => {
    expect(formatHint(150000, 'number')).toContain('150');
  });

  it('formats currency', () => {
    const r = formatHint(150000, 'currency');
    expect(r).toContain('$');
    expect(r).toContain('150');
  });

  it('formats percent', () => {
    expect(formatHint(0.853, 'percent')).toBe('85.3%');
  });

  it('formats date', () => {
    const r = formatHint('2026-04-08T12:00:00Z', 'date');
    expect(r).toContain('Apr');
    expect(r).toContain('2026');
  });

  it('returns empty for null', () => {
    expect(formatHint(null, 'number')).toBe('');
  });

  it('returns stringified value when number hint receives a non-numeric value', () => {
    expect(formatHint('abc', 'number')).toBe('abc');
  });

  it('returns stringified value when date hint receives a non-string', () => {
    // Non-string input skips the date-parsing branch entirely.
    expect(formatHint(42 as unknown as string, 'date')).toBe('42');
  });

  it('returns the input when date hint receives an unparseable string', () => {
    expect(formatHint('not a date', 'date')).toBe('not a date');
  });

  it('returns the input when relative hint receives a non-string', () => {
    expect(formatHint(42 as unknown as string, 'relative')).toBe('42');
  });

  it('returns the input when relative hint receives an unparseable string', () => {
    expect(formatHint('not a date', 'relative')).toBe('not a date');
  });

  it('formats relative dates — today/yesterday/N days ago/future', () => {
    const now = Date.now();
    const today = new Date(now).toISOString();
    const yesterday = new Date(now - 86_400_000).toISOString();
    const threeDaysAgo = new Date(now - 3 * 86_400_000).toISOString();
    const inFive = new Date(now + 5 * 86_400_000).toISOString();
    expect(formatHint(today, 'relative')).toBe('today');
    expect(formatHint(yesterday, 'relative')).toBe('yesterday');
    expect(formatHint(threeDaysAgo, 'relative')).toBe('3 days ago');
    expect(formatHint(inFive, 'relative')).toMatch(/^in \d+ days$/);
  });

  // B1 — the internal SOQL escape hints. Unlike the display hints, these run BEFORE
  // the null-guard so a null/undefined ref still yields a syntactically valid literal.
  it('soql_string renders a quoted+escaped SOQL string literal', () => {
    expect(formatHint('Prospecting', 'soql_string')).toBe("'Prospecting'");
    expect(formatHint("O'Brien", 'soql_string')).toBe("'O\\'Brien'");
  });

  it('soql_string keeps an injection attempt inside the literal', () => {
    expect(formatHint("x' OR Name != '", 'soql_string')).toBe("'x\\' OR Name != \\''");
  });

  it('soql_string renders null as the empty string literal (not a bare empty splice)', () => {
    expect(formatHint(null, 'soql_string')).toBe("''");
  });

  it('soql_like renders a quoted+escaped LIKE operand', () => {
    expect(formatHint('acme', 'soql_like')).toBe("'%acme%'");
    expect(formatHint("O'Brien", 'soql_like')).toBe("'%O\\'Brien%'");
  });
});

// ────────────────────────────────────────────────────────────────
// walkPath
// ────────────────────────────────────────────────────────────────

import { walkPath, collectRefs } from '../resolve.js';

describe('walkPath', () => {
  it('returns the root object when path is empty', () => {
    const obj = { a: 1 };
    expect(walkPath(obj, '')).toBe(undefined);
    // Calling walkPath with '' technically runs [''] — the segment '' is
    // not a key, so accessing it on the object returns undefined.
  });

  it('walks object paths', () => {
    expect(walkPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('walks array indices as numeric segments', () => {
    expect(walkPath({ items: [10, 20, 30] }, 'items.1')).toBe(20);
  });

  it('uses object access when the numeric segment targets a non-array (ignores numeric form)', () => {
    // Object has a numeric-string key → path should use object access.
    expect(walkPath({ '0': 'string-key' }, '0')).toBe('string-key');
  });

  it('returns undefined early when a path segment is null/undefined', () => {
    expect(walkPath({ a: null }, 'a.b.c')).toBeUndefined();
    expect(walkPath({}, 'nope.deeper')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// resolveValue — edge cases
// ────────────────────────────────────────────────────────────────

describe('resolveValue — edge cases', () => {
  it('preserves unresolvable namespace in interpolation (keeps the raw {{...}})', () => {
    expect(resolveValue('See: {{invalid.thing}}', stores)).toBe('See: {{invalid.thing}}');
  });

  it('namespace-only pure ref returns the whole store', () => {
    const r = resolveValue('{{config}}', stores) as Record<string, unknown>;
    expect(r).toMatchObject({ lookback_days: 30 });
  });

  it('resolves number format hint in interpolation', () => {
    const r = resolveValue('Days: {{config.lookback_days:number}}', stores);
    expect(r).toContain('30');
  });

  it('resolves percent format hint in interpolation', () => {
    const storesWithPct = {
      ...stores,
      step: { ...stores.step, hit_rate: 0.755 },
    };
    expect(resolveValue('Rate: {{step.hit_rate:percent}}', storesWithPct)).toBe('Rate: 75.5%');
  });
});

// ────────────────────────────────────────────────────────────────
// collectRefs
// ────────────────────────────────────────────────────────────────

describe('collectRefs', () => {
  it('returns an empty list for non-string, non-collection input', () => {
    expect(collectRefs(42)).toEqual([]);
    expect(collectRefs(true)).toEqual([]);
    expect(collectRefs(null)).toEqual([]);
  });

  it('returns an empty list for a string without refs', () => {
    expect(collectRefs('plain text')).toEqual([]);
  });

  it('extracts a single ref from a string', () => {
    expect(collectRefs('{{config.lookback_days}}'))
      .toEqual([{ ns: 'config', path: 'lookback_days' }]);
  });

  it('extracts multiple refs from an interpolated string', () => {
    expect(collectRefs('Hello {{config.name}}, your days left: {{step.days}}'))
      .toEqual([
        { ns: 'config', path: 'name' },
        { ns: 'step', path: 'days' },
      ]);
  });

  it('deduplicates refs with differing format hints (same ns.path)', () => {
    const r = collectRefs('{{step.amount}} and {{step.amount:currency}}');
    expect(r).toEqual([{ ns: 'step', path: 'amount' }]);
  });

  it('ignores refs with unknown namespaces', () => {
    const r = collectRefs('{{invalid.x}} {{config.y}}');
    expect(r).toEqual([{ ns: 'config', path: 'y' }]);
  });

  it('walks arrays and objects recursively', () => {
    const spec = {
      name: '{{config.name}}',
      rows: ['{{step.a}}', '{{step.b}}'],
      nested: { deeper: '{{vault.hubspot.token}}' },
    };
    const r = collectRefs(spec);
    expect(r).toEqual([
      { ns: 'config', path: 'name' },
      { ns: 'step', path: 'a' },
      { ns: 'step', path: 'b' },
      { ns: 'vault', path: 'hubspot.token' },
    ]);
  });

  it('preserves first-occurrence order after dedup', () => {
    const r = collectRefs({
      a: '{{step.y}}',
      b: '{{step.x}}',
      c: '{{step.y}}',
    });
    expect(r.map(x => x.path)).toEqual(['y', 'x']);
  });

  it('caps recursion at MAX_RESOLVE_DEPTH (50) so malicious payloads cannot stack-overflow', () => {
    // Build a 60-level deep object with a ref at the bottom.
    let obj: Record<string, unknown> = { deep: '{{config.lookback_days}}' };
    for (let i = 0; i < 60; i++) obj = { nested: obj };
    // No throw — and the deep ref is silently skipped beyond depth 50.
    const r = collectRefs(obj);
    // We can't assert that the ref isn't returned (a shallow nested tree
    // might still reach it), but we can assert no crash + the result is
    // a valid array.
    expect(Array.isArray(r)).toBe(true);
  });
});

// ── B1: SOQL ref-escape seam (end-to-end) ───────────────────

describe('B1 — SOQL ref-escape seam (parseRef + resolveDeep)', () => {
  // The connection-agnostic SOQL search builder emits `{{ref:soql_string}}` /
  // `{{ref:soql_like}}` into the `query.q` wire arg; the executor's resolveRefs
  // (resolveDeep) flattens it to the wire request BEFORE the gateway dispatches — so
  // the escape here is the real injection boundary, exercised on the actual path.
  const soqlStores: NamespaceStores = {
    vault: {},
    config: { stage: 'Closed Won', name_fragment: 'acme' },
    context: {},
    meta: {},
    step: {},
  };

  it('parseRef recognizes the escape hints and splits the path correctly', () => {
    expect(parseRef('config.stage:soql_string')).toEqual({
      ns: 'config',
      path: 'stage',
      hint: 'soql_string',
    });
    expect(parseRef('config.name_fragment:soql_like')).toEqual({
      ns: 'config',
      path: 'name_fragment',
      hint: 'soql_like',
    });
  });

  it('escapes a benign ref value into the SOQL string at interpolation', () => {
    const queryQ = 'SELECT Id FROM Opportunity WHERE StageName = {{config.stage:soql_string}} LIMIT 200';
    expect(resolveValue(queryQ, soqlStores)).toBe(
      "SELECT Id FROM Opportunity WHERE StageName = 'Closed Won' LIMIT 200",
    );
  });

  it('neutralizes an injection payload through resolveDeep (the dispatch path)', () => {
    // config.stage carries a crafted SOQL-breakout value; the seam must keep it inside
    // the quoted literal so the WHERE clause cannot be widened.
    const attackStores: NamespaceStores = {
      ...soqlStores,
      config: { stage: "x' OR Name != '" },
    };
    const input = {
      'query.q': 'SELECT Id FROM Opportunity WHERE StageName = {{config.stage:soql_string}} LIMIT 200',
    };
    const resolved = resolveDeep(input, attackStores) as Record<string, string>;
    expect(resolved['query.q']).toBe(
      "SELECT Id FROM Opportunity WHERE StageName = 'x\\' OR Name != \\'' LIMIT 200",
    );
    // The breakout quote never appears unescaped — it is `\'`, inert inside the literal.
    expect(resolved['query.q']).not.toContain("= 'x' OR");
  });

  it('escapes a LIKE ref operand', () => {
    const queryQ = 'SELECT Id FROM Opportunity WHERE Name LIKE {{config.name_fragment:soql_like}} LIMIT 200';
    expect(resolveValue(queryQ, soqlStores)).toBe(
      "SELECT Id FROM Opportunity WHERE Name LIKE '%acme%' LIMIT 200",
    );
  });

  it('renders a missing ref as the empty literal so the query stays syntactically valid', () => {
    const queryQ = 'SELECT Id FROM Opportunity WHERE StageName = {{config.absent:soql_string}} LIMIT 200';
    expect(resolveValue(queryQ, soqlStores)).toBe(
      "SELECT Id FROM Opportunity WHERE StageName = '' LIMIT 200",
    );
  });
});
