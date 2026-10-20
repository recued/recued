import type { AuthenticationAccessCheck, AuthenticationAccessResult } from '@recued/contracts';

export const authenticationAccessCheckLabels = { api_read: 'Protected API read', collection_read: 'Account and selected folders/calendars', file_metadata: 'File metadata',
  file_download: 'Chosen file download/export', write_permissions: 'Sending, editing and other writes' } as const;
const reasons: Record<NonNullable<AuthenticationAccessCheck['reason']>, string> = {
  not_checked: 'Waiting for this check', unsupported: 'This saved account has no supported check', resource_required: 'Choose a resource to check',
  access_rejected: 'The saved account was refused access', unavailable: 'The check could not finish; unlock Recued or try again',
  inconclusive: 'The response did not prove protected access', changed: 'Authentication or configuration changed; review again',
  interrupted: 'The server restarted before this check finished', permission_evidence_missing: 'Vendor permission evidence is unavailable',
  not_executed: 'This operation was not performed',
};
export const authenticationAccessCheckText = (check: AuthenticationAccessCheck | undefined, current: AuthenticationAccessResult['current']): string =>
  !check ? 'Not checked in this attempt' : (check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Unconfirmed')
    + (check.reason ? ' · ' + reasons[check.reason] : '') + (current !== 'yes' && check.status === 'passed' ? ' (historical result)' : '');
export const appendAuthenticationAccessResult = (doc: Document, parent: HTMLElement, result: AuthenticationAccessResult, heading = true): void => {
  const add = (tag: 'p' | 'h4', text: string): void => { const n = doc.createElement(tag); n.textContent = text; parent.appendChild(n); };
  if (heading) add('h4', result.label);
  if (result.current === 'no') add('p', 'Superseded · The saved authentication or source changed after this check.');
  else if (result.current === 'unknown') add('p', 'Current authentication could not be compared. Refresh before relying on this result.');
  for (const check of result.checks) add('p', authenticationAccessCheckLabels[check.kind] + ': ' + authenticationAccessCheckText(check, result.current));
};
