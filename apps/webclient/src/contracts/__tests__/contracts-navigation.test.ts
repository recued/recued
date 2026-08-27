import { describe, expect, it } from 'vitest';

import {
  contractDetailAddress,
  contractsListAddress,
  parseContractsAddress,
  unparentedContractDetailAddress,
} from '../contracts-navigation.js';
import { parseShellRoute } from '../../shell/route.js';

describe('Contracts hierarchical navigation contract', () => {
  it('keeps category ancestry without adding it to the detail URL', () => {
    expect(contractsListAddress('customer').hash)
      .toBe('#contracts/view/customer');
    const detail = contractDetailAddress('contract/1', 'customer', 'recipes');
    expect(detail.hash).toBe('#contracts/contract%2F1/recipes');
    expect(detail.levels.map((level) => level.key)).toEqual([
      'contracts-list:customer',
      'contract:contract/1',
      'contract-tab:recipes',
    ]);
  });

  it('seeds direct details until the loaded row supplies its category', () => {
    expect(unparentedContractDetailAddress('one', 'ops')).toMatchObject({
      hash: '#contracts/one/ops',
      levels: [
        { key: 'contract:one', segments: ['one'] },
        { key: 'contract-tab:ops', segments: ['ops'] },
      ],
    });
  });

  it('parses lists, detail previews, and optional detail tabs', () => {
    expect(parseContractsAddress(parseShellRoute('#contracts')))
      .toEqual({ kind: 'list', tab: 'built-in' });
    expect(parseContractsAddress(parseShellRoute('#contracts/view/others')))
      .toEqual({ kind: 'list', tab: 'others' });
    expect(parseContractsAddress(parseShellRoute('#contracts/c-1/connect')))
      .toEqual({ kind: 'detail', contractId: 'c-1', tab: 'connect' });
  });
});
