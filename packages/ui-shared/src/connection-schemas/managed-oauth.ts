/** D-322 — managed OAuth is an API credential transport, independent of the pack. */
import type { ConnectionSchema } from './types.js';

export const withManagedOAuthSchema = (schema: ConnectionSchema, authType?: string): ConnectionSchema => {
  if (schema.kind !== 'api' || authType === undefined) return schema;
  const selector = schema.fields.find((field) => field.key === 'auth.type');
  if (!selector?.options?.some((type) => type === 'oauth2_refresh' || type === 'bearer' || type === 'managed_oauth')) return schema;
  const authSelector = { ...selector, hidden: false,
    options: [...new Set([...selector.options, 'managed_oauth'])],
    optionLabels: { managed_oauth: 'Managed OAuth', oauth2_refresh: 'Your own OAuth app', bearer: 'Bearer token', ...selector.optionLabels } };
  if (authType !== 'managed_oauth') {
    if (selector.options.includes('managed_oauth')) return schema;
    return { ...schema, fields: schema.fields.map((field) => field.key === 'auth.type' ? authSelector : field) };
  }
  return { ...schema, label: 'Managed OAuth connection', description: 'Authorize through your saved OAuth broker. The broker holds vendor credentials and sees requests and responses.',
    onboarding: undefined, probe: undefined,
    fields: [
      ...schema.fields.filter((field) => !field.key.startsWith('auth.')).map((field) =>
        field.key === 'config.base_url' ? { ...field, hidden: false, readonly: false,
          label: 'Vendor API base URL', help: 'Prefilled from the pack service. Check this URL before authorizing; the vendor origin is bound to this authorization.' } : field),
      { ...authSelector, help: 'The selected broker manages vendor sign-in and token refresh.' },
      { key: 'auth.scopes', label: 'Required scopes', type: 'text', optional: true,
        help: 'Prefilled from your packs. A broker shared app can only grant the permissions it supports.' },
      { key: 'auth.broker_profile_id', label: 'Broker profile', type: 'text', hidden: true },
      { key: 'auth.integration_id', label: 'Broker integration', type: 'text', hidden: true },
      { key: 'auth.connection_id', label: 'Authorized account', type: 'text', hidden: true, autofilled: true },
      { key: 'auth.target_origin', label: 'Authorized vendor', type: 'text', hidden: true, autofilled: true },
      { key: 'auth.requested_scopes', label: 'Requested broker scopes', type: 'json', hidden: true, autofilled: true },
      { key: 'auth.required_scopes', label: 'Saved scope needs', type: 'json', hidden: true, autofilled: true, optional: true },
      { key: 'auth.imported', label: 'Existing account scope history', type: 'json', hidden: true, autofilled: true, optional: true },
      { key: 'auth.authorization_receipt', label: 'Authorization', type: 'text', hidden: true, autofilled: true },
    ] };
};
