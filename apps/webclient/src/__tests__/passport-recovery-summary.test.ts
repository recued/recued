import { describe, expect, it } from 'vitest';
import { buildPassportRecoverySummary } from '../settings/passport-recovery-summary.js';

const drill = (extra: Record<string, unknown> = {}) => ({ phase: 'completed', current_configuration: true, owner_reported_alert: true, resumption_ping_acknowledged: true, ...extra });
const monitor = (extra: Record<string, unknown> = {}) => ({ configured: true, enabled: true, state: 'acknowledged', drill: drill(), ...extra });
const passport = (extra: Record<string, unknown> = {}) => ({ passport_version: '1', profile: 'support_redacted', exported_at: 1_700_000_000_000,
  recovery: { backup_status: 'configured', backup_evidence: { monitoring: 'active', backup_state: 'current', recovery_test_state: 'current',
    integrity: { monitoring: 'active', state: 'completed' }, watchdog: monitor(), ...extra } } });
const details = (value: unknown) => Object.fromEntries(buildPassportRecoverySummary(value).rows.map(row => [row.id, row.detail]));

describe('Passport recovery snapshot summary', () => {
  it('keeps historical recovery, selected-copy scans, owner reports and ping proof distinct', () => {
    const value = passport(), result = details(value);
    expect(buildPassportRecoverySummary(value).exportedAt).toBe(1_700_000_000_000);
    expect(result.backup).toContain('at export'); expect(result.recovery).toContain('earlier copy');
    expect(result.integrity).toContain('selected copies'); expect(result.monitor).toContain('does not prove alert delivery');
    expect(result.alert).toContain('owner reported'); expect(result.alert).toContain('not independently verified'); expect(result.ping).toContain('after the pause');
  });

  it('keeps partial and empty scans distinct from passing verification, even while checks are paused', () => {
    expect(details(passport({ integrity: { monitoring: 'paused', state: 'partial' } })).integrity).toContain('partial');
    expect(details(passport({ integrity: { monitoring: 'active', state: 'empty' } })).integrity).toContain('does not prove');
    expect(details(passport({ integrity: { monitoring: 'paused', state: 'failed' } })).integrity).toContain('failed');
  });

  it('does not reuse an ordinary ping or an owner report as completed drill proof', () => {
    const value = details(passport({ watchdog: monitor({ drill: drill({ phase: 'resuming', resumption_ping_acknowledged: false }) }) }));
    expect(value.drill).toContain('waiting'); expect(value.alert).toContain('owner reported'); expect(value.ping).toContain('No ping acknowledgment');
    const waitingOwner = details(passport({ watchdog: monitor({ drill: drill({ phase: 'awaiting_confirmation', owner_reported_alert: false }) }) }));
    expect(waitingOwner.alert).toContain('had not reported'); expect(waitingOwner.ping).toContain('fresh ping');
  });

  it('scopes every drill fact to its earlier monitor setup and preserves cancellation', () => {
    const old = details(passport({ watchdog: monitor({ drill: drill({ current_configuration: false }) }) }));
    for (const id of ['drill', 'alert', 'ping']) expect(old[id]).toMatch(/^Earlier monitor setup:/);
    const cancelled = details(passport({ watchdog: monitor({ drill: drill({ phase: 'cancelled', owner_reported_alert: false, resumption_ping_acknowledged: false }) }) }));
    expect(cancelled.drill).toContain('without a completed'); expect(cancelled.alert).toContain('had not reported');
  });

  it.each([
    { phase: 'completed', owner_reported_alert: false }, { phase: 'completed', resumption_ping_acknowledged: false },
    { phase: 'paused' }, { phase: 'resuming' }, { phase: 'awaiting_confirmation' },
    { owner_reported_alert: 'yes' }, { resumption_ping_acknowledged: 1 }, { current_configuration: undefined }, { phase: 'private-unknown-phase' },
  ])('makes inconsistent or malformed drill proof unavailable: %j', change => {
    const value = details(passport({ watchdog: monitor({ drill: drill(change) }) }));
    expect(value.drill).toContain('unavailable'); expect(value.alert).toContain('unavailable'); expect(value.ping).toContain('unavailable');
    expect(value.monitor).toContain('last ping');
  });

  it('omits stale drill success for an unavailable or contradictory monitor', () => {
    for (const change of [{ state: 'unavailable' }, { enabled: false }, { configured: false }, { state: 'private-monitor-state' }]) {
      const value = details(passport({ watchdog: monitor(change) }));
      expect(value.monitor).toContain('unavailable'); expect(value.drill).toContain('unavailable'); expect(value.ping).toContain('unavailable');
    }
  });

  it('does not turn configuration, missing old evidence, unknown fields or paused monitoring into a pass', () => {
    const legacy = details({ profile: 'support_redacted', recovery: { backup_status: 'configured' } });
    expect(legacy.backup).toContain('alone does not prove'); expect(legacy.recovery).toContain('not included'); expect(legacy.monitor).toContain('not included');
    const paused = details(passport({ monitoring: 'paused' })); expect(paused.backup).toContain('No current backup age'); expect(paused.recovery).toContain('No current test age');
    const missing = details(passport({ recovery_test_state: undefined, watchdog: undefined })); expect(missing.recovery).toContain('unavailable'); expect(missing.monitor).toContain('not included');
    expect(details(passport({ monitoring: 'unavailable' })).backup).toContain('unavailable');
  });

  it('never renders unknown data, IDs, URLs, provider errors or markup, and handles malformed JSON values safely', () => {
    const value = passport({ backup_state: 'private-unknown-state', integrity: { monitoring: { toString: 'private-text' }, state: 'completed' },
      watchdog: monitor({ issue: '<script>private-words</script>', ping_url: 'https://private.example/token', drill: { ...drill(), operation_id: 'private-id' } }) });
    const summary = JSON.stringify(buildPassportRecoverySummary(value)); expect(summary).not.toContain('private'); expect(summary).not.toContain('<script>');
    expect(details(value).backup).toContain('unavailable'); expect(details(value).integrity).toContain('unavailable');
    for (const malformed of [null, [], 1, 'private-text', { profile: 'support_redacted', recovery: [] }, { profile: 'migration_full', recovery: value.recovery }, { ...value, passport_version: 'future' }]) {
      expect(() => buildPassportRecoverySummary(malformed)).not.toThrow(); expect(details(malformed).backup).not.toContain('Within');
    }
  });
});
