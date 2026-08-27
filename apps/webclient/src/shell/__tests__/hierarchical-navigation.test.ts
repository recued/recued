import { describe, expect, it, vi } from 'vitest';

import {
  createHierarchicalHistory,
  hierarchicalAddress,
  hierarchicalAddressFromHash,
  hierarchicalHistoryMode,
  hierarchicalLevel,
  isHierarchicalAncestor,
} from '../hierarchical-navigation.js';

const recipes = () => hierarchicalAddress('recipes');
const recipe = (id: string) => hierarchicalAddress(
  'recipes',
  hierarchicalLevel(`recipe:${id}`, id),
);
const seller = () => hierarchicalAddress(
  'settings',
  hierarchicalLevel('seller', 'seller'),
);
const sellerOrders = () => hierarchicalAddress(
  'settings',
  hierarchicalLevel('seller', 'seller'),
  hierarchicalLevel('orders', 'orders'),
);
const sellerOrdersPage = (page: number) => hierarchicalAddress(
  'settings',
  hierarchicalLevel('seller', 'seller'),
  hierarchicalLevel('orders', 'orders'),
  hierarchicalLevel(`page:${page}`, 'page', String(page)),
);

describe('hierarchical addresses', () => {
  it('serializes grouped semantic levels through the shell route contract', () => {
    const address = sellerOrdersPage(3);
    expect(address.hash).toBe('#settings/seller/orders/page/3');
    expect(address.levels.map((level) => level.key)).toEqual([
      'seller',
      'orders',
      'page:3',
    ]);
  });

  it('keeps dynamic identifiers encoded while comparing stable level keys', () => {
    const address = recipe('publisher/list work');
    expect(address.hash).toBe('#recipes/publisher%2Flist%20work');
    expect(isHierarchicalAncestor(recipes(), address)).toBe(true);
  });

  it('attaches hierarchy to a richer serializer while canonicalizing its hash', () => {
    const address = hierarchicalAddressFromHash(
      'data',
      '#/data/mail/item/message%2F1/return/logs/run-1',
      hierarchicalLevel('data-tab:mail', 'mail'),
      hierarchicalLevel('data-detail:message/1', 'item', 'message/1'),
    );
    expect(address.hash).toBe('#data/mail/item/message%2F1/return/logs/run-1');
    expect(address.levels.map((level) => level.key)).toEqual([
      'data-tab:mail',
      'data-detail:message/1',
    ]);
    expect(() => hierarchicalAddressFromHash('logs', '#data/mail'))
      .toThrow(/expected logs/);
  });

  it('recognizes only strict, same-surface semantic ancestors', () => {
    expect(isHierarchicalAncestor(seller(), sellerOrders())).toBe(true);
    expect(isHierarchicalAncestor(sellerOrders(), seller())).toBe(false);
    expect(isHierarchicalAncestor(sellerOrders(), sellerOrders())).toBe(false);
    expect(isHierarchicalAncestor(recipes(), sellerOrders())).toBe(false);
  });

  it('rejects empty dynamic keys and segments', () => {
    expect(() => hierarchicalLevel('', 'orders')).toThrow(/key/);
    expect(() => hierarchicalLevel('orders')).toThrow(/segments/);
    expect(() => hierarchicalLevel('orders', '')).toThrow(/segments/);
  });
});

describe('hierarchical History controller', () => {
  it('pushes when entering a descendant and replaces sideways/closing moves', () => {
    expect(hierarchicalHistoryMode(seller(), sellerOrders())).toBe('push');
    expect(hierarchicalHistoryMode(sellerOrders(), sellerOrdersPage(2))).toBe('push');
    expect(hierarchicalHistoryMode(sellerOrdersPage(2), sellerOrdersPage(3))).toBe('replace');
    expect(hierarchicalHistoryMode(sellerOrdersPage(2), sellerOrders())).toBe('replace');
  });

  it('writes, commits the comparison baseline, and notifies only after success', () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const onCommit = vi.fn();
    const history = createHierarchicalHistory({
      initial: recipes(),
      history: { pushState, replaceState },
      onCommit,
    });

    expect(history.navigate(recipe('one'))).toMatchObject({
      committed: true,
      mode: 'push',
    });
    expect(pushState).toHaveBeenCalledWith(null, '', '#recipes/one');
    expect(history.current().hash).toBe('#recipes/one');

    expect(history.navigate(recipe('two'))).toMatchObject({
      committed: true,
      mode: 'replace',
    });
    expect(replaceState).toHaveBeenCalledWith(null, '', '#recipes/two');
    expect(onCommit).toHaveBeenNthCalledWith(1, recipe('one'), 'push');
    expect(onCommit).toHaveBeenNthCalledWith(2, recipe('two'), 'replace');
  });

  it('does not duplicate a hydrated deep link and can adopt browser-owned state', () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const history = createHierarchicalHistory({
      initial: recipe('one'),
      history: { pushState, replaceState },
    });

    expect(history.navigate(recipe('one')).mode).toBe('none');
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();

    history.adopt(recipe('two'));
    expect(history.current().hash).toBe('#recipes/two');
    expect(history.navigate(recipes()).mode).toBe('replace');
  });

  it('supports an explicit semantic override and falls back to replace', () => {
    const replaceState = vi.fn();
    const history = createHierarchicalHistory({
      initial: sellerOrdersPage(2),
      history: { replaceState },
    });

    const result = history.navigate(
      hierarchicalAddress(
        'settings',
        hierarchicalLevel('seller', 'seller'),
        hierarchicalLevel('orders', 'orders'),
        hierarchicalLevel('detail:order-1', 'detail', 'order-1'),
      ),
      { intent: 'push', state: { returnPage: 2 } },
    );

    expect(result.mode).toBe('replace');
    expect(replaceState).toHaveBeenCalledWith(
      { returnPage: 2 },
      '',
      '#settings/seller/orders/detail/order-1',
    );
  });

  it('keeps the previous committed baseline when History is absent or throws', () => {
    const onCommit = vi.fn();
    const missing = createHierarchicalHistory({ initial: recipes(), onCommit });
    expect(missing.navigate(recipe('one')).committed).toBe(false);
    expect(missing.current().hash).toBe('#recipes');

    const throwing = createHierarchicalHistory({
      initial: recipes(),
      history: {
        pushState: () => { throw new Error('denied'); },
        replaceState: vi.fn(),
      },
      onCommit,
    });
    expect(throwing.navigate(recipe('one')).committed).toBe(false);
    expect(throwing.current().hash).toBe('#recipes');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('contains a throwing History provider without moving its baseline', () => {
    const history = createHierarchicalHistory({
      initial: recipes(),
      history: () => { throw new Error('window closed'); },
    });

    expect(() => history.navigate(recipe('one'))).not.toThrow();
    expect(history.navigate(recipe('one'))).toMatchObject({
      committed: false,
      mode: 'push',
    });
    expect(history.current().hash).toBe('#recipes');
  });

  it('keeps a successful commit successful when its observer throws', () => {
    const pushState = vi.fn();
    const history = createHierarchicalHistory({
      initial: recipes(),
      history: { pushState, replaceState: vi.fn() },
      onCommit: () => { throw new Error('stale shell disposed'); },
    });

    expect(() => history.navigate(recipe('one'))).not.toThrow();
    expect(history.current().hash).toBe('#recipes/one');
    expect(pushState).toHaveBeenCalledWith(null, '', '#recipes/one');
  });
});
