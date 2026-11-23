import type { ProposedEndpointConfig, ReceptionTemplateListResult } from '@recued/contracts';

/** Gallery replies share the inventory fixture's call recorder, holds and failures. */
export const installReceptionTemplatesFixture = (catalog: ReceptionTemplateListResult) => {
  const view = window as any, original = view.__receptionFixture;
  const state = view.__templates = { catalog, proposal: {
    version: '1.0.0', kind: 'intake_form', title: 'Speaker biographies',
    description: 'Collect speaker details for the conference.',
    form_definition: { form_definition_id: 'speaker-bios', fields: [
      { name: 'speaker_name', type: 'text', label: 'Speaker name', required: true },
      { name: 'biography', type: 'textarea', label: 'Biography', required: true },
      { name: 'secret', type: 'password', label: 'Secret', required: true },
    ] }, expiry_policy: { mode: 'rolling', rolling_days: 30 },
    exposure_intent: 'public_anonymous', source_path: 'intent',
  } satisfies ProposedEndpointConfig };
  view.__receptionFixture = async (method: string, args: unknown) => {
    const result = await original(method, args);
    if (result?.error) return result;
    if (method === 'reception.template.list') return { result: structuredClone(state.catalog) };
    if (method === 'reception.compose.propose') return { result: structuredClone(state.proposal) };
    return result;
  };
};
