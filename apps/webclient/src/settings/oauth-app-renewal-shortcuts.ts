/** A shortcut reads the retained receipt again before opening an existing review. */
import { isOAuthAppsResponse, isOAuthAppRenewalVerification, type OAuthAppRenewalVerification, type OAuthAppRenewalResult } from '@recued/contracts';
import type { OAuthAppsCaller } from './oauth-apps-panel.js';
import { connectionsOAuthAppAddress, connectionsReviewAccessAddress, connectionsAccountAuthenticationAddress, connectionsRenewalRepairReturn } from '../connections/connections-navigation.js';

export type OAuthAppRenewalShortcut = { kind: 'app'; label: string }
  | { kind: 'connection'; label: string; name: string }
  | { kind: 'collection'; label: string; platform: 'mail' | 'calendar'; slug: string };

export const oauthAppRenewalShortcuts = (v: OAuthAppRenewalVerification, r: OAuthAppRenewalResult): OAuthAppRenewalShortcut[] => {
  if (v.status !== 'completed' || r.current !== 'yes' || r.status === 'passed') return [];
  if (r.reason === 'client_rejected' || r.reason === 'secret_mismatch' || r.reason === 'origin_unknown' || r.reason === 'shared_grant_conflict') {
    return [{ kind: 'app', label: r.reason === 'client_rejected' ? 'Review app credentials' : 'Review app usage' }];
  }
  if (r.reason !== 'grant_rejected' && r.reason !== 'missing_grant') return [];
  return [...r.connections.map(name => ({ kind: 'connection' as const, label: 'Re-authorize API: ' + name, name })),
    ...r.native_accounts.map(a => ({ kind: 'collection' as const, label: 'Re-authorize ' + (a.platform === 'mail' ? 'Mail' : 'Calendar') + ': ' + a.slug, platform: a.platform, slug: a.slug }))];
};

export const resolveOAuthAppRenewalShortcut = async (call: OAuthAppsCaller, original: OAuthAppRenewalVerification,
  selection: { grantId: string; index: number } | 'verify'): Promise<string> => {
  let reply: Awaited<ReturnType<OAuthAppsCaller>>;
  try { reply = await call({ action: 'renewal_status', id: original.id }); }
  catch { throw Error('The saved renewal result could not be read. Unlock Recued and refresh before opening this review.'); }
  if (!isOAuthAppsResponse(reply) || reply.action !== 'renewal_status') throw Error('The saved renewal result could not be confirmed. Refresh it before choosing a repair.');
  const v = reply.renewal_verification;
  if (!isOAuthAppRenewalVerification(v)
    || v.id !== original.id || v.issuer !== original.issuer || v.app_id !== original.app_id || v.app_revision !== original.app_revision
    || v.status !== 'completed') throw Error('The saved renewal result could not be confirmed. Refresh it before choosing a repair.');
  const app = reply.apps.find(a => a.issuer === v.issuer && a.id === v.app_id);
  if (!app) throw Error('This saved OAuth app is no longer available. Open saved apps and choose a current app.');
  // Verification deliberately reviews the current app after a repair changed its revision.
  if (selection === 'verify') return connectionsOAuthAppAddress({ issuer: app.issuer, id: app.id, view: 'renewal' }).hash;
  const before = original.results.find(r => r.id === selection.grantId);
  const current = v.results.find(r => r.id === selection.grantId);
  const shortcut = before && oauthAppRenewalShortcuts(original, before)[selection.index];
  const confirmed = current && oauthAppRenewalShortcuts(v, current)[selection.index];
  if (app.revision !== v.app_revision || !before || !current || before.revision !== current.revision || before.reason !== current.reason
    || !shortcut || JSON.stringify(shortcut) !== JSON.stringify(confirmed)) {
    throw Error('The app or authorization changed, or could not be compared. Refresh the result and review current authentication before repairing it.');
  }
  const href = shortcut.kind === 'app' ? connectionsOAuthAppAddress({ issuer: app.issuer, id: app.id, view: 'usage' }).hash
    : shortcut.kind === 'connection' ? connectionsReviewAccessAddress(shortcut.name).hash
    : connectionsAccountAuthenticationAddress(shortcut.platform, shortcut.slug).hash;
  return connectionsRenewalRepairReturn(href, app.issuer, app.id);
};
