import { describe, expect, it } from 'vitest';
import { isRecipePageBinding } from '../value-hint.js';

describe('recipe page binding contract', () => {
  it('admits local and API object bindings with own field paths', () => {
    expect(isRecipePageBinding({ kind: 'invoice', field: 'id' })).toBe(true);
    expect(isRecipePageBinding({ kind: 'sales-order', field: 'customer.address_id', platform: 'vendor_api' })).toBe(true);
  });
  it('refuses unknown members, inherited required fields and unsafe paths', () => {
    const inherited = Object.assign(Object.create({ kind: 'invoice' }), { field: 'id' });
    for (const value of [null, [], inherited, { kind: 'invoice', field: 'id', feild: 'id' }, { kind: 'invoice' },
      { kind: 'invoice', field: '' }, { kind: 'invoice', field: 'customer.constructor.id' }, { kind: 'invoice', field: 'prototype' },
      { kind: 'invoice', field: 'id', platform: '' }, { kind: 'invoice', field: 'id', platform: 1 }]) expect(isRecipePageBinding(value)).toBe(false);
  });
});
