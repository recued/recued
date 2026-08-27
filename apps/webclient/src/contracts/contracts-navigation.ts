/** Typed hierarchical addresses for Contracts list, preview, and detail tabs. */

import {
  hierarchicalAddress,
  hierarchicalAddressFromHash,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import { serializeShellRoute, type ShellRoute } from '../shell/route.js';

export const CONTRACTS_LIST_TABS = ['built-in', 'customer', 'others'] as const;
export type ContractsListTab = (typeof CONTRACTS_LIST_TABS)[number];

export const isContractsListTab = (
  value: unknown,
): value is ContractsListTab =>
  typeof value === 'string'
  && (CONTRACTS_LIST_TABS as readonly string[]).includes(value);

export type ContractsAddress =
  | {
      readonly kind: 'list';
      readonly tab: ContractsListTab;
    }
  | {
      readonly kind: 'detail';
      readonly contractId: string;
      readonly tab: string | null;
    };

export const contractsListAddress = (
  tab: ContractsListTab,
): HierarchicalAddress => hierarchicalAddress(
  'contracts',
  hierarchicalLevel(`contracts-list:${tab}`, 'view', tab),
);

/** The parent category is semantic history state rather than a positional URL
 * segment. This lets `#contracts/<id>` remain stable while native Back still
 * understands which category list owns the preview. */
export const contractDetailAddress = (
  contractId: string,
  parentTab: ContractsListTab,
  tab?: string | null,
): HierarchicalAddress => hierarchicalAddressFromHash(
  'contracts',
  serializeShellRoute('contracts', contractId, tab),
  hierarchicalLevel(`contracts-list:${parentTab}`, 'view', parentTab),
  hierarchicalLevel(`contract:${contractId}`, contractId),
  ...(tab === undefined || tab === null || tab.trim().length === 0
    ? []
    : [hierarchicalLevel(`contract-tab:${tab}`, tab)]),
);

/** Seed a direct detail before its server row reveals the owning category. */
export const unparentedContractDetailAddress = (
  contractId: string,
  tab?: string | null,
): HierarchicalAddress => hierarchicalAddressFromHash(
  'contracts',
  serializeShellRoute('contracts', contractId, tab),
  hierarchicalLevel(`contract:${contractId}`, contractId),
  ...(tab === undefined || tab === null || tab.trim().length === 0
    ? []
    : [hierarchicalLevel(`contract-tab:${tab}`, tab)]),
);

export const parseContractsAddress = (
  route: ShellRoute,
): ContractsAddress | null => {
  if (route.surface !== 'contracts') return null;
  if (route.segments[0] === 'view') {
    return {
      kind: 'list',
      tab: isContractsListTab(route.segments[1])
        ? route.segments[1]
        : 'built-in',
    };
  }
  const contractId = route.segments[0];
  if (contractId === undefined || contractId.trim().length === 0) {
    return { kind: 'list', tab: 'built-in' };
  }
  const tab = route.segments[1];
  return {
    kind: 'detail',
    contractId,
    tab: typeof tab === 'string' && tab.trim().length > 0 ? tab : null,
  };
};
