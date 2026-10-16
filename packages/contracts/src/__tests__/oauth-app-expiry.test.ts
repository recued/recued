import { describe, expect, it } from 'vitest';
import { isOAuthAppSecretExpiryDate, oauthAppSecretExpiry, isSavedOAuthApp, isOAuthAppsResponse,
  isOAuthAppSecretRotationOutcome, type SavedOAuthApp } from '../index.js';

const app: SavedOAuthApp = { id: 'default', issuer: 'microsoft', label: 'Work', client_id: 'client', has_secret: true, revision: 1 };
const today = new Date(2026, 9, 15, 12).getTime();
describe('saved OAuth app secret expiry', () => {
  it.each(['2026-10-15', '2028-02-29', '0001-01-01', '9999-12-31'])('accepts the real calendar date %s', value => {
    expect(isOAuthAppSecretExpiryDate(value)).toBe(true);
  });
  it.each(['2026-02-29', '2026-04-31', '0000-01-01', '2026-10-15T12:00:00Z', '2026-1-1', '', ' 2026-10-15', '2026-10-15 ', null, 123])(
    'rejects an invalid or non-date value %s', value => { expect(isOAuthAppSecretExpiryDate(value)).toBe(false); });
  it.each([
    ['2026-11-15', 'scheduled', 31], ['2026-11-14', 'due_soon', 30], ['2026-10-16', 'due_soon', 1],
    ['2026-10-15', 'due_today', 0], ['2026-10-14', 'past_due', -1],
  ] as const)('classifies %s using calendar days, without claiming vendor expiry', (date, status, days) => {
    expect(oauthAppSecretExpiry({ secret_expires_on: date }, today)).toEqual({ status, date, days_remaining: days });
  });
  it('stays unknown for absent dates and invalid clocks', () => {
    expect(oauthAppSecretExpiry({}, today)).toEqual({ status: 'unknown' });
    expect(oauthAppSecretExpiry({ secret_expires_on: '2026-02-29' }, today)).toEqual({ status: 'unknown' });
    expect(oauthAppSecretExpiry({ secret_expires_on: '2026-10-15' }, NaN)).toEqual({ status: 'unknown' });
  });
  it('keeps the whole recorded date due today and crosses month, leap and daylight-saving dates correctly', () => {
    expect(oauthAppSecretExpiry({ secret_expires_on: '2026-10-15' }, new Date(2026, 9, 15, 23, 59, 59).getTime())).toMatchObject({ status: 'due_today' });
    expect(oauthAppSecretExpiry({ secret_expires_on: '2026-11-02' }, new Date(2026, 9, 31, 12).getTime())).toMatchObject({ days_remaining: 2 });
    expect(oauthAppSecretExpiry({ secret_expires_on: '2028-03-01' }, new Date(2028, 1, 28, 12).getTime())).toMatchObject({ days_remaining: 2 });
  });
  it('accepts legacy responses and validates new metadata and capability flags', () => {
    expect(isSavedOAuthApp(app)).toBe(true);
    expect(isSavedOAuthApp({ ...app, secret_expires_on: '2026-10-15' })).toBe(true);
    expect(isSavedOAuthApp({ ...app, secret_expires_on: '2026-02-29' })).toBe(false);
    expect(isOAuthAppsResponse({ action: 'list', apps: [app] })).toBe(true);
    expect(isOAuthAppsResponse({ action: 'list', apps: [app], secret_expiry_supported: true })).toBe(true);
    expect(isOAuthAppsResponse({ action: 'list', apps: [app], secret_expiry_supported: 'true' })).toBe(false);
    const outcome = { attempt_id: 'a'.repeat(43), issuer: 'microsoft', app_id: 'default', status: 'applied',
      selected_names: [], skipped_names: [], native_accounts: [], verification: 'not_checked' };
    expect(isOAuthAppSecretRotationOutcome(outcome)).toBe(true);
    expect(isOAuthAppSecretRotationOutcome({ ...outcome, secret_expires_on: '2027-01-01' })).toBe(true);
    expect(isOAuthAppSecretRotationOutcome({ ...outcome, secret_expires_on: '2027-02-29' })).toBe(false);
  });
});
