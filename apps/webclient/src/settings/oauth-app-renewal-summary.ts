import type { OAuthAppRenewalReason, OAuthAppRenewalResult } from '@recued/contracts';

export const OAUTH_APP_RENEWAL_REASONS: Record<OAuthAppRenewalReason, string> = {
  origin_unknown: 'This copy has no confirmed saved-app origin. Review its usage and saved app first.',
  secret_mismatch: 'This copy has a different secret. Review usage and coordinate its secret before checking.',
  shared_grant_conflict: 'Copies sharing this authorization have conflicting app or credential settings. Repair them together first.',
  missing_grant: 'No refresh token is saved. Re-authorize this account first.', paused: 'An authentication change or permission cleanup is in progress. Finish it first.',
  unavailable: 'Renewal could not be confirmed. Unlock Recued, check storage and network access, then review again.',
  changed: 'The saved app or authorization changed. Review a new check.',
  client_rejected: 'The vendor rejected the app credentials. Check the saved Client ID and secret before signing in again.',
  grant_rejected: 'The vendor rejected this authorization. Re-authorize the affected account.',
  persistence_failed: 'The renewed credential could not be saved and confirmed. Check storage before trying again.',
  interrupted: 'The server restarted before this check finished. Its outcome is unknown.',
  not_selected: 'This authorization was excluded from the check.', not_checked: 'Waiting for renewal.',
};
export const oauthAppRenewalResultText = (r: OAuthAppRenewalResult): string =>
  (r.status === 'passed' ? 'Passed · A new access token was received and saved.' : r.status === 'failed' ? 'Failed' : 'Unconfirmed')
  + (r.reason ? ' · ' + OAUTH_APP_RENEWAL_REASONS[r.reason] : '');
export const oauthAppRenewalCurrentText = (r: OAuthAppRenewalResult): string => r.current === 'no'
  ? 'Superseded · The saved app or authorization has changed. This is a historical result.' : r.current === 'unknown'
    ? 'The current sign-in could not be compared. Unlock Recued and refresh before relying on this result.' : '';
