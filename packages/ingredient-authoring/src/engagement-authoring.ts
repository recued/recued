import { ENGAGEMENT_CAPABILITY_VALUES, ENGAGEMENT_SYNC_KINDS, type EngagementEntityFacet } from '@recued/contracts';
const fields = {
  capability: { type: 'string', required: true, description: 'Explicit always-present or probe-gated activity capability. A declaration does not perform a provider capability probe.' },
  sync_kind: { type: 'string', required: true, description: 'Declared engagement sync class: poll, delta_cursor or stream. Cross-entity vendor consistency is checked at registry lift, not by this single-facet editor.' },
  exclusive_group: { type: 'string', description: 'Non-empty group of probe-gated alternatives; an always-present entity cannot be a pick-one alternative. Group names remain authored.' },
  daily_budget: { type: 'number', description: 'Optional positive integer daily API-call budget. It is an author claim, not a measured quota; omission retains the existing runtime default.' },
} satisfies Record<keyof EngagementEntityFacet, { type: 'string' | 'number'; description: string; required?: boolean }>;
export const engagementAuthoringFields = () => Object.entries(fields).map(([key, field]) => ({ key, ...field, required: 'required' in field && field.required }));
export const engagementAuthoringChoices = (key: string): readonly string[] => key === 'capability' ? ENGAGEMENT_CAPABILITY_VALUES : key === 'sync_kind' ? ENGAGEMENT_SYNC_KINDS : [];
