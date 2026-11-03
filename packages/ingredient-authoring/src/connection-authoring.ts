import { APPLICABLE_GUIDE_FIELD_KEYS, CONNECTION_AUTH_TYPES, canApplyConnectionSetupGuideSuggestion, type ConnectionHint } from '@recued/contracts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The same explicit slots and first-party front-door names accepted by pack validation. */
export const packConnectionNames = (pack: unknown): string[] => {
  const names = new Set<string>(); if (!object(pack)) return [];
  for (const content of Array.isArray(pack.contents) ? pack.contents : []) {
    if (!object(content) || content.type !== 'composition' || !object(content.composition) || !Array.isArray(content.composition.ingredients)) continue;
    for (const ingredient of content.composition.ingredients) {
      if (!object(ingredient)) continue;
      for (const kind of ['http', 'connection', 'mcp']) {
        const block = ingredient[kind]; if (object(block) && typeof block.connection === 'string' && block.connection.length > 0) names.add(block.connection);
      }
    }
  }
  // Vendor descriptors admit underscore and hyphen spellings at the canonical hint boundary.
  for (const requirement of Array.isArray(pack.connection_requirements) ? pack.connection_requirements : []) {
    if (!object(requirement) || typeof requirement.vendor !== 'string') continue;
    const vendor = requirement.vendor.trim(); if (!vendor) continue;
    names.add(vendor); names.add(vendor.replace(/_/gu, '-')); names.add(vendor.replace(/-/gu, '_'));
  }
  return [...names];
};
const hintFields: Record<keyof ConnectionHint, string> = {
  connection: 'An explicit connection name used by this pack, or a connection declared by its requirements. This is source metadata, not an installed connection ID.',
  values: 'Visible, editable setup suggestions. Only the shared pre-fillable field keys are admitted; each value must pass the shared admission rule.',
  setup_url: 'Public HTTPS URL where the owner creates a credential, with no embedded credentials. Displayed as a setup link.',
};
export const connectionHintFields = () => Object.entries(hintFields).map(([key, description]) => ({ key, description }));
const valueHelp: Record<string, string> = {
  'config.base_url': 'Suggested public HTTPS API base URL.',
  'auth.type': 'Suggested auth method from the generic connection form; admitted choices come from the shared hint validator.',
  subresource_path: 'Suggested subresource path, such as an account or project path.',
  'auth.param_name': 'Name of a query parameter used for authentication; the credential is supplied during setup.',
  'auth.token_endpoint': 'Suggested public HTTPS token endpoint.',
  'auth.scope': 'Suggested OAuth scope string.',
  'auth.authorize_url': 'Suggested public HTTPS OAuth authorization URL.',
  'auth.scopes': 'Suggested OAuth scopes.',
};
export const connectionHintValueFields = () => [...APPLICABLE_GUIDE_FIELD_KEYS].map(key => ({ key, description: valueHelp[key] ?? 'A visible setup suggestion admitted by the shared connection hint contract.' }));
export const connectionHintAuthChoices = () => CONNECTION_AUTH_TYPES.filter(value => canApplyConnectionSetupGuideSuggestion('auth.type', value));
