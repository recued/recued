import { describe, expect, it } from 'vitest';
import { resolveDeep, resolveRef, resolveValue } from '../resolve.js';
import type { NamespaceStores } from '../resolve.js';

const stores: NamespaceStores = {
  vault: {},
  config: { x: 'CONFIG', y: 'VALUE' },
  context: {},
  meta: {},
  step: { x: 'STEP' },
  data: { shared: { k: { row_1: 'MATCHED' } } },
};

describe('resolver deferItem option', () => {
  it('keeps default item resolution byte-identical when deferItem is off', () => {
    const withEmptyItem: NamespaceStores = { ...stores, item: {} };

    expect(resolveRef('{{item.x}}', withEmptyItem)).toBeUndefined();
    expect(resolveValue('{{item.x}}', withEmptyItem)).toBeUndefined();
    expect(resolveValue('prefix {{item.x}} suffix', withEmptyItem)).toBe('prefix  suffix');
  });

  it('returns a pure top-level item ref raw when deferItem is on', () => {
    expect(resolveRef('{{item.x}}', stores, { deferItem: true })).toBe('{{item.x}}');
    expect(resolveValue('{{item.x}}', stores, { deferItem: true })).toBe('{{item.x}}');
  });

  it('keeps item fragments raw in interpolation while resolving config refs', () => {
    expect(resolveValue('{{item.x}} and {{config.y}}', stores, { deferItem: true }))
      .toBe('{{item.x}} and VALUE');
  });

  it('still resolves config and step refs when deferItem is on', () => {
    expect(resolveRef('{{config.x}}', stores, { deferItem: true })).toBe('CONFIG');
    expect(resolveValue('{{step.x}}', stores, { deferItem: true })).toBe('STEP');
    expect(resolveValue('{{config.x}}/{{step.x}}', stores, { deferItem: true }))
      .toBe('CONFIG/STEP');
  });

  it('does not change nested dynamic-key behavior or leave dangling braces', () => {
    const withItem: NamespaceStores = { ...stores, item: { id: 'row_1' } };
    expect(resolveValue('{{data.shared.k.{{item.id}}}}', withItem))
      .toBe(resolveValue('{{data.shared.k.{{item.id}}}}', withItem, { deferItem: true }));
    expect(resolveValue('{{data.shared.k.{{item.id}}}}', withItem, { deferItem: true }))
      .toBe('MATCHED');

    const withMissingItem: NamespaceStores = { ...stores, item: {} };
    const interpolated = resolveValue(
      'nested={{data.shared.k.{{item.id}}}}',
      withMissingItem,
      { deferItem: true },
    );
    expect(interpolated).toBe('nested=');
    expect(String(interpolated)).not.toContain('{{');
    expect(String(interpolated)).not.toContain('}}');
  });

  it('threads deferItem through resolveDeep arrays', () => {
    expect(resolveDeep(
      ['{{item.a}}', 'name={{item.name}}', '{{config.y}}'],
      stores,
      { deferItem: true },
    )).toEqual(['{{item.a}}', 'name={{item.name}}', 'VALUE']);
  });

  it('threads deferItem through resolveDeep objects', () => {
    expect(resolveDeep(
      {
        pure: '{{item.a}}',
        interpolated: '{{item.name}}/{{config.y}}',
        config: '{{config.x}}',
      },
      stores,
      { deferItem: true },
    )).toEqual({
      pure: '{{item.a}}',
      interpolated: '{{item.name}}/VALUE',
      config: 'CONFIG',
    });
  });

  it('defers a key by brackets too (D-402 slice B4: a browser sequence\'s data step over a table column)', () => {
    expect(resolveDeep(
      { pure: '{{item["Last Name"]}}', interpolated: '{{item["First Name"]}} {{item.age}}', spaced: '{{item ["x"]}}', config: '{{config.y}}' },
      stores,
      { deferItem: true },
    )).toEqual({ pure: '{{item["Last Name"]}}', interpolated: '{{item["First Name"]}} {{item.age}}', spaced: '{{item ["x"]}}', config: 'VALUE' });
    // Not deferring, a bracketed key is no namespace the resolver knows, as before.
    expect(resolveDeep({ pure: '{{item["Last Name"]}}' }, stores)).toEqual({ pure: undefined });
    // Only `item`: a namespace that merely begins with it is not one.
    expect(resolveDeep({ other: '{{items["x"]}}' }, stores, { deferItem: true })).toEqual({ other: undefined });
  });
});

