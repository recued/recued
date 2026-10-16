import { collectionPermissionScopes, GRAPH_OFFLINE_SCOPE, GRAPH_USER_READ_SCOPE } from '@recued/contracts';

export interface AccountSetupDraft {
  lane: 'mail' | 'calendar';
  providerId: 'gmail' | 'gcal' | 'graph';
  destination: 'apps' | 'connection';
  values: Record<string, string>;
}
const fields = ['name', 'auth_method', 'send_enabled', 'mutation_enabled', 'write_enabled', 'calendar_enabled', 'connection_name', 'oauth_app_id'] as const;

/** Boot-owned, memory-only return context. No passwords, client secrets or tokens. */
export const createAccountSetupContinuity = () => {
  let draft: AccountSetupDraft | undefined;
  return {
    save(value: AccountSetupDraft) {
      draft = { lane: value.lane, providerId: value.providerId, destination: value.destination,
        values: Object.fromEntries(fields.filter(key => typeof value.values[key] === 'string')
          .map(key => [key, value.values[key]!.slice(0, 256)])) };
    },
    read: () => draft ? structuredClone(draft) : undefined,
    take(lane: string) { if (draft?.lane !== lane) return undefined; const value = structuredClone(draft); draft = undefined; return value; },
    clear() { draft = undefined; },
  };
};
export type AccountSetupContinuity = ReturnType<typeof createAccountSetupContinuity>;

export const accountSetupEnrollment = (draft: AccountSetupDraft) => ({
  vendor: draft.providerId === 'graph' ? 'microsoft' : 'google',
  base_url: draft.providerId === 'graph' ? 'https://graph.microsoft.com/v1.0' : draft.lane === 'mail' ? 'https://gmail.googleapis.com' : 'https://www.googleapis.com/calendar/v3',
  name: (draft.values.name || (draft.lane === 'mail' ? 'mail' : 'calendar')) + '-api',
  scopes: [...new Set([...collectionPermissionScopes(draft.providerId, draft.lane === 'mail'
    ? { platform: 'mail', slug: draft.values.name || 'work', read: true, send: draft.values.send_enabled === 'true', organize: draft.values.mutation_enabled === 'true' }
    : { platform: 'calendar', slug: draft.values.name || 'work', read: true, edit_events: draft.values.write_enabled === 'true' }),
    // Native Microsoft consumers verify /me and need a refreshable sign-in.
    ...(draft.providerId === 'graph' ? [GRAPH_USER_READ_SCOPE, GRAPH_OFFLINE_SCOPE] : [])])].sort(),
});
