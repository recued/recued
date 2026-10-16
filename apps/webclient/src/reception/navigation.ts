/** Typed hierarchy for Reception sections and the nested Endpoints workspace. */

import {
  isReceptionEndpointKind,
  type ReceptionEndpointKind,
} from '@recued/contracts';
import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import type { ShellRoute } from '../shell/route.js';
import {
  resolveReceptionSection,
  type ReceptionSection,
} from './sections.js';

export const CUSTOMER_JOB_TABS = ['overview','activity','billing','followups','closeout'] as const;
export type CustomerJobTab = (typeof CUSTOMER_JOB_TABS)[number];

export type ReceptionAddress =
  | { readonly kind: 'section'; readonly section: ReceptionSection }
  | { readonly kind: 'customer-job';readonly jobId: string;readonly tab: CustomerJobTab }
  | { readonly kind: 'signoff';readonly signoffId: string }
  | { readonly kind: 'inbox-target';readonly targetId: string }
  | { readonly kind: 'endpoint-detail'; readonly endpointId: string }
  | {
      readonly kind: 'endpoint-authoring';
      readonly mode: 'new' | 'edit';
      readonly endpointKind: Exclude<ReceptionEndpointKind, 'status_link'>;
    }
  | { readonly kind: 'endpoint-setup' }
  | { readonly kind: 'endpoint-pair'; readonly endpointId: string };

const receptionSectionLevel = (section: ReceptionSection) =>
  hierarchicalLevel(`reception-section:${section}`, section);

export const receptionSectionAddress = (
  section: ReceptionSection,
): HierarchicalAddress => hierarchicalAddress(
  'reception',
  receptionSectionLevel(section),
);

export const receptionCustomerJobAddress = (jobId: string,tab: CustomerJobTab = 'overview'): HierarchicalAddress =>
  hierarchicalAddress('reception',receptionSectionLevel('jobs'),
    hierarchicalLevel(`customer-job:${jobId}`,jobId),hierarchicalLevel(`customer-job-tab:${tab}`,tab));
export const receptionSignoffAddress = (signoffId: string): string =>
  hierarchicalAddress('reception',receptionSectionLevel('signoffs'),hierarchicalLevel(`signoff:${signoffId}`,signoffId)).hash;
export const receptionInboxTargetAddress = (targetId: string): string =>
  hierarchicalAddress('reception',receptionSectionLevel('inbox'),hierarchicalLevel(`target:${targetId}`,targetId)).hash;

export const receptionEndpointDetailAddress = (
  endpointId: string,
): HierarchicalAddress => hierarchicalAddress(
  'reception',
  receptionSectionLevel('endpoints'),
  hierarchicalLevel(`reception-endpoint:${endpointId}`, endpointId),
);

export const receptionEndpointAuthoringAddress = (
  mode: 'new' | 'edit',
  endpointKind: Exclude<ReceptionEndpointKind, 'status_link'>,
): HierarchicalAddress => hierarchicalAddress(
  'reception',
  receptionSectionLevel('endpoints'),
  hierarchicalLevel(`reception-authoring:${mode}`, mode),
  hierarchicalLevel(`reception-endpoint-kind:${endpointKind}`, endpointKind),
);

export const receptionEndpointSetupAddress = (): HierarchicalAddress =>
  hierarchicalAddress(
    'reception',
    receptionSectionLevel('endpoints'),
    hierarchicalLevel('reception-flow:setup', 'setup'),
  );

export const receptionEndpointPairAddress = (
  endpointId: string,
): HierarchicalAddress => hierarchicalAddress(
  'reception',
  receptionSectionLevel('endpoints'),
  hierarchicalLevel('reception-flow:pair', 'pair'),
  hierarchicalLevel(`reception-endpoint:${endpointId}`, endpointId),
);

export const receptionHierarchicalAddress = (
  address: ReceptionAddress,
): HierarchicalAddress => {
  if (address.kind === 'customer-job') return receptionCustomerJobAddress(address.jobId,address.tab);
  if (address.kind === 'signoff' || address.kind === 'inbox-target') return hierarchicalAddress('reception',
    receptionSectionLevel(address.kind === 'signoff' ? 'signoffs' : 'inbox'),
    hierarchicalLevel('selected',address.kind === 'signoff' ? address.signoffId : address.targetId));
  if (address.kind === 'endpoint-detail') {
    return receptionEndpointDetailAddress(address.endpointId);
  }
  if (address.kind === 'endpoint-authoring') {
    return receptionEndpointAuthoringAddress(
      address.mode,
      address.endpointKind,
    );
  }
  if (address.kind === 'endpoint-setup') return receptionEndpointSetupAddress();
  if (address.kind === 'endpoint-pair') {
    return receptionEndpointPairAddress(address.endpointId);
  }
  return receptionSectionAddress(address.section);
};

export const parseReceptionAddress = (
  route: ShellRoute,
): ReceptionAddress | null => {
  if (route.surface !== 'reception') return null;
  const section = resolveReceptionSection(route.segments[0]);
  const selected = route.segments[1];
  if (section === 'jobs' && selected) return { kind: 'customer-job',jobId: selected,
    tab: CUSTOMER_JOB_TABS.includes(route.segments[2] as CustomerJobTab) ? route.segments[2] as CustomerJobTab : 'overview' };
  if (section === 'signoffs' && selected) return { kind: 'signoff',signoffId: selected };
  if (section === 'inbox' && selected) return { kind: 'inbox-target',targetId: selected };
  if (section !== 'endpoints') return { kind: 'section', section };
  const subview = route.segments[1];
  const value = route.segments[2];
  if (subview === undefined) return { kind: 'section', section: 'endpoints' };
  if (subview === 'setup') return { kind: 'endpoint-setup' };
  if (subview === 'pair' && typeof value === 'string' && value.length > 0) {
    return { kind: 'endpoint-pair', endpointId: value };
  }
  if (
    (subview === 'new' || subview === 'edit')
    && isReceptionEndpointKind(value)
    && value !== 'status_link'
    && (subview === 'new' || value === 'reception_page')
  ) {
    return {
      kind: 'endpoint-authoring',
      mode: subview,
      endpointKind: value,
    };
  }
  if (subview === 'new' || subview === 'edit' || subview === 'pair') {
    return { kind: 'section', section: 'endpoints' };
  }
  return { kind: 'endpoint-detail', endpointId: subview };
};

export const receptionAddressSelection = (
  address: ReceptionAddress,
): {
  readonly section: ReceptionSection;
  readonly subview: string | null;
  readonly value: string | null;
} => {
  if (address.kind === 'customer-job') return { section: 'jobs',subview: address.jobId,value: address.tab };
  if (address.kind === 'signoff') return { section: 'signoffs',subview: address.signoffId,value: null };
  if (address.kind === 'inbox-target') return { section: 'inbox',subview: address.targetId,value: null };
  if (address.kind === 'section') {
    return { section: address.section, subview: null, value: null };
  }
  if (address.kind === 'endpoint-detail') {
    return { section: 'endpoints', subview: address.endpointId, value: null };
  }
  if (address.kind === 'endpoint-authoring') {
    return {
      section: 'endpoints',
      subview: address.mode,
      value: address.endpointKind,
    };
  }
  if (address.kind === 'endpoint-pair') {
    return {
      section: 'endpoints',
      subview: 'pair',
      value: address.endpointId,
    };
  }
  return { section: 'endpoints', subview: 'setup', value: null };
};
