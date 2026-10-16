import { describe, expect, it } from 'vitest';
import { accountSetupEnrollment, createAccountSetupContinuity } from '../connections/account-setup-continuity.js';

describe('account setup handoff', () => {
  it('retains only an allowlist of nonsecret choices and consumes the correct lane once', () => {
    const continuity = createAccountSetupContinuity();
    continuity.save({ lane: 'mail', providerId: 'gmail', destination: 'connection', values: {
      name: 'work', auth_method: 'managed_oauth', send_enabled: 'true', password: 'do-not-retain',
      client_secret: 'do-not-retain', refresh_token: 'do-not-retain', 'auth.scopes': 'unexpected',
      server_url: 'https://untrusted.example.test',
    } });
    const draft = continuity.read()!;
    expect(draft.values).toEqual({ name: 'work', auth_method: 'managed_oauth', send_enabled: 'true' });
    draft.values.name = 'changed'; expect(continuity.read()?.values.name).toBe('work');
    expect(continuity.take('calendar')).toBeUndefined(); expect(continuity.take('mail')?.values.name).toBe('work');
    expect(continuity.take('mail')).toBeUndefined();
  });
  it('derives Gmail permissions from its choices without borrowing Drive or spreadsheet defaults', () => {
    expect(accountSetupEnrollment({ lane: 'mail', providerId: 'gmail', destination: 'connection', values: { name: 'work', send_enabled: 'true' } }))
      .toEqual({ name: 'work-api', vendor: 'google', base_url: 'https://gmail.googleapis.com', scopes: [
        'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send',
      ] });
  });
  it('includes both Microsoft send permissions and keeps read-only calendars minimal', () => {
    expect(accountSetupEnrollment({ lane: 'mail', providerId: 'graph', destination: 'connection', values: { send_enabled: 'true' } }).scopes)
      .toEqual(['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access']);
    expect(accountSetupEnrollment({ lane: 'calendar', providerId: 'gcal', destination: 'connection', values: {} }).scopes)
      .toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
  });
});
