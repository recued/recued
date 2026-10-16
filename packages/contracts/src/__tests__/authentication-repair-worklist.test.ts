import { describe, expect, it } from 'vitest';
import { isAuthenticationRepairWorklist, type AuthenticationRepairWorklist } from '../authentication-repair-worklist.js';
const fixture = (): AuthenticationRepairWorklist => ({ observed_at: 1234, unavailable: [], groups: [{ id: 'a'.repeat(64), kind: 'account', label: 'Work', authentication: 'direct_oauth', connection_names: ['work'], issues: [{ id: 'b'.repeat(64), code: 'credential_rejected', message: 'Recorded authentication failure.', observed_at: 1200 }], uses: [{ kind: 'file', id: 'google.work.file', label: 'Files' }], usage_available: true, targets: [{ kind: 'connection', name: 'work' }] }] });
describe('authentication repair wire boundary', () => {
  it('accepts empty, partial and complete local snapshots', () => {
    expect(isAuthenticationRepairWorklist(fixture())).toBe(true);
    expect(isAuthenticationRepairWorklist({ observed_at: 1, unavailable: ['Unlock to read credential details.'], groups: [] })).toBe(true);
  });
  it.each([null, [], {}, { ...fixture(), observed_at: NaN }, { ...fixture(), unavailable: ['bad\nlabel'] }, { ...fixture(), groups: [fixture().groups[0], fixture().groups[0]] }])('refuses malformed worklists %j', value => {
    expect(isAuthenticationRepairWorklist(value)).toBe(false);
  });
  it('rejects unknown actions, coerced discriminators, invalid dates and unsafe targets', () => {
    const original = fixture().groups[0]!;
    for (const patch of [{ authentication: ['broker'] }, { kind: 'vendor' }, { label: 'bad\0label' }, { issues: [{ ...original.issues[0], code: 'reauthorize_automatically' }] },
      { issues: [{ ...original.issues[0], secret_expires_on: '2026-02-30' }] }, { targets: [{ kind: 'url', href: 'https://evil.invalid' }] }, { uses: [{ kind: 'secret', id: 'token', label: 'private' }] }]) {
      expect(isAuthenticationRepairWorklist({ ...fixture(), groups: [{ ...original, ...patch }] })).toBe(false);
    }
  });
});
