import { describe, expect, it } from 'vitest';
import { resolveValue, type NamespaceStores } from '../index.js';

const mkStores = (overrides: Partial<NamespaceStores>): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
  ...overrides,
});

describe('nested template interpolation (D-103)', () => {
  it('resolves dynamic key lookup — pure ref outer preserves type', () => {
    const stores = mkStores({
      step: { item: { id: '123' } },
      data: { shared: { deal: { '123': { stage: 'closed_won', amount: 5000 } } } },
    });
    // `{{data.shared.deal.{{step.item.id}}}}` → data.shared.deal.123 object.
    const out = resolveValue('{{data.shared.deal.{{step.item.id}}}}', stores);
    expect(out).toEqual({ stage: 'closed_won', amount: 5000 });
  });

  it('preserves number type when outer is pure ref after nested substitution', () => {
    const stores = mkStores({
      step: { key: 'deal_count' },
      config: { deal_count: 42 },
    });
    expect(resolveValue('{{config.{{step.key}}}}', stores)).toBe(42);
  });

  it('interpolates nested refs inside a surrounding string', () => {
    const stores = mkStores({
      step: { name: 'Alice' },
      config: { greeting: 'Hello' },
    });
    expect(resolveValue('{{config.greeting}}, {{step.name}}!', stores)).toBe('Hello, Alice!');
  });

  it('handles deeper nesting (3 levels)', () => {
    const stores = mkStores({
      step: { a: 'b', b: 'c', c: 42 },
    });
    // Resolve innermost {{step.a}} → "b", then {{step.b}} → "c", then {{step.c}} → 42.
    expect(resolveValue('{{step.{{step.{{step.a}}}}}}', stores)).toBe(42);
  });

  it('leaves unknown namespace refs untouched in an interpolation context', () => {
    const stores = mkStores({});
    // Text outside the outer ref ⇒ interpolation path; unknown outer
    // namespace is left as-is, inner empty vault value substitutes as
    // ''.
    const out = resolveValue('prefix {{nope.x.{{vault.y}}}} suffix', stores);
    expect(out).toBe('prefix {{nope.x.}} suffix');
  });

  it('pure ref with unknown outer namespace resolves to undefined', () => {
    const stores = mkStores({ step: { id: 'x' } });
    // Preserves the original semantics: pure ref against an unknown
    // namespace resolves to undefined.
    expect(resolveValue('{{nope.{{step.id}}}}', stores)).toBeUndefined();
  });

  it('continues to support the non-nested interpolation path unchanged', () => {
    const stores = mkStores({ step: { a: 1, b: 2 } });
    expect(resolveValue('{{step.a}}-{{step.b}}', stores)).toBe('1-2');
    expect(resolveValue('{{step.a}}', stores)).toBe(1);
  });

  it('can route through shared.* refs when shared store is populated', () => {
    const stores = mkStores({
      step: { id: '7' },
      shared: { 'deal': { '7': { stage: 'open' } } },
    });
    // Nested build: {{shared.deal.{{step.id}}.stage}}
    // Inner → "7"; outer → "{{shared.deal.7.stage}}" → "open"
    expect(resolveValue('{{shared.deal.{{step.id}}.stage}}', stores)).toBe('open');
  });
});
