import { describe, expect, it } from 'vitest';
import { isAuthenticationIncidentHistoryPage, isAuthenticationIncidentHistoryQuery, isAuthenticationIncidentScope,
  isAuthenticationRepairAction, isAuthenticationIncidentHistoryFilters, authenticationIncidentHistoryFilters, authenticationHistoryEntryOutcome, authenticationHistoryEntryMatches,
  type AuthenticationRepairAction, type AuthenticationIncidentHistoryPage, type AuthenticationRenewalHistory } from '../authentication-incident-history.js';
import type { AuthenticationAccessVerification } from '../authentication-access-verification.js';

const page = (): AuthenticationIncidentHistoryPage => ({ scope: { kind: 'all' }, observed_at: 200, retention_days: 90,
  incidents: [{ id: '12345678-1234-4123-8123-123456789abc', status: 'open', started_at: 100, last_problem_at: 150, history_started_at: 100,
    currently_reported: true, level: 'rejected', events_truncated: false, details_truncated: false, events: [{ kind: 'opened', at: 100, level: 'rejected' }],
    group: { id: 'a'.repeat(64), kind: 'account', label: 'Work', authentication: 'direct_oauth', connection_names: ['work'], issues: [], uses: [], targets: [{ kind: 'connection', name: 'work' }], usage_available: false } }] });

describe('connection incident history wire boundary', () => {
  const renewal = (): AuthenticationRenewalHistory => ({ id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 2,
    app_label: 'Work', started_at: 100, history_started_at: 180, finished_at: 150, status: 'completed', incomplete: false,
    results: [{ id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Work API', connections: ['work'], native_accounts: [], eligible: true, status: 'passed', current: 'yes' }] });
  const repair = (): AuthenticationRepairAction => ({ id: 'repair-' + 'd'.repeat(64), action: 'reauthorize', status: 'applied', started_at: 110, finished_at: 120,
    from: { type: 'direct_oauth', app_id: 'work' }, to: { type: 'broker', broker_profile_id: 'team' }, targets: [{ kind: 'connection', name: 'work' }],
    targets_truncated: false, incidents: [], incidents_truncated: false });
  const access = (): AuthenticationAccessVerification => ({ id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: 'a'.repeat(64) },
    started_at: 100, finished_at: 120, status: 'completed', results: [{ id: 'e'.repeat(64), label: 'École 100%_ reports', target: { kind: 'collection', platform: 'calendar', slug: 'team' },
      authentication_revision: 'f'.repeat(64), current: 'no', checks: [{ kind: 'collection_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }],
    targets_truncated: false, uses: [{ kind: 'pack', id: 'work-pack', label: 'Daily planning' }], usage_available: true });
  it.each([null, [], { search: 'x'.repeat(129) }, { search: '\u0344'.repeat(65) }, { search: '\ud800' }, { search: '\udfff' }, { search: 'line\nbreak' }, { search: 1 }, { type: ['incident'] }, { type: 'all' },
    { outcome: 'healthy' }, { from: '2026-02-30' }, { through: '2026-2-03' }, { from: '2026-10-17', through: '2026-10-16' }, { token: 'secret' }])('refuses invalid filters %j at request and response boundaries', filters => {
    expect(isAuthenticationIncidentHistoryFilters(filters)).toBe(false);
    expect(isAuthenticationIncidentHistoryQuery({ scope: { kind: 'all' }, filters })).toBe(false);
    expect(isAuthenticationIncidentHistoryPage({ ...page(), filters })).toBe(false);
  });
  it('canonicalizes empty search, Unicode and field order while accepting inclusive leap dates', () => {
    expect(authenticationIncidentHistoryFilters({ through: '2028-02-29', search: '  E\u0301cole  ', type: 'verification' })).toEqual({ search: 'École', type: 'verification', through: '2028-02-29' });
    expect(authenticationIncidentHistoryFilters({ search: '  ' })).toEqual({});
    expect(isAuthenticationIncidentHistoryFilters({ from: '2028-02-29', through: '2028-02-29' })).toBe(true);
    const boundary = { search: '\u0344'.repeat(64) }; expect(isAuthenticationIncidentHistoryFilters(boundary)).toBe(true);
    expect(isAuthenticationIncidentHistoryFilters(authenticationIncidentHistoryFilters(boundary))).toBe(true);
  });
  it('keeps recorded read outcomes separate from writes, current authentication, repair apply and recovery', () => {
    const v = access(); expect(authenticationHistoryEntryOutcome(v)).toBe('passed');
    expect(authenticationHistoryEntryOutcome(page().incidents[0]!)).toBe('open'); expect(authenticationHistoryEntryOutcome(repair())).toBe('applied');
    v.results[0]!.checks = [{ kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }]; expect(authenticationHistoryEntryOutcome(v)).toBe('unconfirmed');
    v.results[0]!.checks.push({ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }); expect(authenticationHistoryEntryOutcome(v)).toBe('failed');
    v.status = 'checking'; delete v.finished_at; expect(authenticationHistoryEntryOutcome(v)).toBe('running');
    const token = renewal(); token.results.push({ ...token.results[0]!, id: '1'.repeat(64), status: 'unconfirmed', reason: 'not_selected' });
    expect(authenticationHistoryEntryOutcome(token)).toBe('unconfirmed'); token.results[0]!.status = 'failed'; token.results[0]!.reason = 'grant_rejected';
    expect(authenticationHistoryEntryOutcome(token)).toBe('failed');
  });
  it('searches decoded public labels, uses and exact identifiers as literal Unicode text', () => {
    const v = access(); Object.assign(v, { client_secret: 'private-marker' });
    for (const search of ['e\u0301COLE', '100%_', 'work-pack', 'daily PLANNING', 'calendar team', v.id]) expect(authenticationHistoryEntryMatches(v, { search })).toBe(true);
    for (const search of ['private-marker', 'current', 'authentication_revision', 'passed']) expect(authenticationHistoryEntryMatches(v, { search })).toBe(false);
    expect(authenticationHistoryEntryMatches(repair(), { search: 'work' })).toBe(true); expect(authenticationHistoryEntryMatches(renewal(), { search: 'Work API' })).toBe(true);
  });
  it('uses original start times and inclusive UTC days without treating a historical pass as recovery', () => {
    const v = access(); v.started_at = Date.parse('2026-10-16T23:59:59.999Z'); v.finished_at = v.started_at + 1;
    expect(authenticationHistoryEntryMatches(v, { from: '2026-10-16', through: '2026-10-16', type: 'verification', outcome: 'passed' })).toBe(true);
    for (const filters of [{ from: '2026-10-17' }, { through: '2026-10-15' }, { type: 'incident' as const }, { outcome: 'recovered' as const }]) expect(authenticationHistoryEntryMatches(v, filters)).toBe(false);
  });
  it('accepts separately typed renewal history and rejects ambiguous or contradictory mixed orders', () => {
    const data = page(); const token = renewal(); const action = repair();
    const mixed = { ...data, repairs: [action], renewals: [token], order: [token.id, action.id, data.incidents[0]!.id] };
    expect(isAuthenticationIncidentHistoryPage(mixed)).toBe(true);
    for (const patch of [{ order: [action.id, data.incidents[0]!.id] }, { renewals: [token, token] }, { verifications: [token], renewals: [] },
      { renewals: [{ ...token, history_started_at: 99 }] }, { renewals: [{ ...token, history_started_at: Infinity }] },
      { renewals: [{ ...token, references_incomplete: 'false' }] },
      { renewals: [{ ...token, results: [{ ...token.results[0], current: ['no'] }] }] },
      { renewals: [{ ...token, results: [{ ...token.results[0], status: 'passed', reason: 'client_rejected' }] }] }]) {
      expect(isAuthenticationIncidentHistoryPage({ ...mixed, ...patch })).toBe(false);
    }
    const tokens = Array.from({ length: 50 }, (_, n) => ({ ...token, id: 'renewal-' + String(n).padStart(36, '0') }));
    expect(isAuthenticationIncidentHistoryPage({ ...data, incidents: [], repairs: [], renewals: tokens, order: tokens.map(v => v.id) })).toBe(true);
    expect(isAuthenticationIncidentHistoryPage({ ...mixed, renewals: tokens, order: [...tokens.map(v => v.id), action.id, data.incidents[0]!.id] })).toBe(false);
    for (const include_renewals of [true, false, undefined]) expect(isAuthenticationIncidentHistoryQuery({ scope: data.scope, include_renewals })).toBe(true);
    for (const include_renewals of ['true', 1, null, []]) expect(isAuthenticationIncidentHistoryQuery({ scope: data.scope, include_renewals })).toBe(false);
  });
  it('accepts mixed history and older servers while validating repair outcomes and causal ordering', () => {
    const action = repair(); const data = page(); const order = [action.id, data.incidents[0]!.id];
    expect(isAuthenticationRepairAction(action)).toBe(true);
    expect(isAuthenticationIncidentHistoryPage({ ...data, repairs: [action], order })).toBe(true);
    for (const patch of [{ repairs: [action] }, { order }, { repairs: [action], order: [action.id, action.id] },
      { repairs: [action, action], order: [action.id, data.incidents[0]!.id, 'unknown'] }, { repairs: [], order }]) {
      expect(isAuthenticationIncidentHistoryPage({ ...data, ...patch })).toBe(false);
    }
    const linked = { ...action, incidents: [{ id: data.incidents[0]!.id, group_id: data.incidents[0]!.group.id, label: 'Work' }], recovery_confirmed_at: 200 };
    expect(isAuthenticationIncidentHistoryPage({ ...data, repairs: [linked], order })).toBe(false);
  });
  it('requires operation evidence after apply for included recovered incidents, preserving legacy unknown evidence', () => {
    const data = page(); const incident = data.incidents[0]!;
    Object.assign(incident, { status: 'recovered', currently_reported: false, ended_at: 200 });
    incident.events.push({ kind: 'recovered', at: 200, level: 'rejected' });
    const action = repair(); action.incidents = [{ id: incident.id, group_id: incident.group.id, label: 'Work' }]; action.recovery_confirmed_at = 180;
    data.repairs = [action]; data.order = [action.id, incident.id];
    expect(isAuthenticationIncidentHistoryPage(data)).toBe(false);
    incident.recovery_evidence = { earliest_at: 121, latest_at: 180 }; expect(isAuthenticationIncidentHistoryPage(data)).toBe(true);
    incident.recovery_evidence.earliest_at = 120; expect(isAuthenticationIncidentHistoryPage(data)).toBe(false);
    incident.recovery_evidence.earliest_at = 115; expect(isAuthenticationIncidentHistoryPage(data)).toBe(false);
    delete action.recovery_confirmed_at; delete incident.recovery_evidence; expect(isAuthenticationIncidentHistoryPage(data)).toBe(true);
    for (const proof of [{ earliest_at: 99, latest_at: 180 }, { earliest_at: 180, latest_at: 170 }, { earliest_at: 121, latest_at: 201 }, { earliest_at: NaN, latest_at: 180 }]) {
      incident.recovery_evidence = proof; expect(isAuthenticationIncidentHistoryPage(data)).toBe(false);
    }
  });
  it.each([{ status: 'checking' }, { status: 'applied', reason: 'access_failed' }, { status: 'failed' }, { finished_at: 100 },
    { status: 'failed', reason: 'raw_vendor_error' }, { status: 'failed', reason: 'access_failed', restart_required: true },
    { to: { type: 'broker', app_id: 'wrong' } }, { targets: [{ kind: 'all' }] }, { targets: [] }, { targets: [{ kind: 'connection', name: '../unsafe' }] },
    { incidents: [{ id: 'wrong', group_id: 'a'.repeat(64), label: 'Work' }] }, { recovery_confirmed_at: 140 },
  ])('rejects contradictory repair metadata %j', patch => {
    expect(isAuthenticationRepairAction({ ...repair(), ...patch })).toBe(false);
  });
  it('accepts exact local scopes and bounded paging', () => {
    for (const scope of [{ kind: 'all' }, { kind: 'oauth_apps' }, { kind: 'group', id: 'a'.repeat(64) }, { kind: 'connection', name: 'work' },
      { kind: 'collection', platform: 'calendar', slug: 'work account' }, { kind: 'file_source', source_id: 'google.work.file' }]) {
      expect(isAuthenticationIncidentScope(scope)).toBe(true); expect(isAuthenticationIncidentHistoryQuery({ scope, limit: 50, cursor: 'abc_123' })).toBe(true);
    }
    expect(isAuthenticationIncidentHistoryPage(page())).toBe(true);
  });
  it.each([null, [], { kind: 'url', href: 'https://evil.test' }, { kind: 'connection', name: '../work' }, { kind: 'group', id: 'wrong' },
    { kind: 'collection', platform: 'mail', slug: 'bad\nvalue' }, { kind: 'file_source', source_id: '' }])('rejects unsafe scopes %j', scope => {
    expect(isAuthenticationIncidentScope(scope)).toBe(false); expect(isAuthenticationIncidentHistoryQuery({ scope })).toBe(false);
  });
  it('rejects malformed lifecycle state, dates, events, duplicate incidents and paging', () => {
    const original = page().incidents[0]!;
    for (const patch of [{ status: ['open'] }, { status: 'recovered' }, { status: 'retired', ended_at: 200 }, { last_problem_at: 99 },
      { history_started_at: NaN }, { events: [] }, { events: [{ kind: 'vendor_probed', at: 100, level: 'rejected' }] }, { level: ['rejected'] }]) {
      expect(isAuthenticationIncidentHistoryPage({ ...page(), incidents: [{ ...original, ...patch }] })).toBe(false);
    }
    expect(isAuthenticationIncidentHistoryPage({ ...page(), incidents: [original, original] })).toBe(false);
    for (const limit of [0, 51, 1.5, '10']) expect(isAuthenticationIncidentHistoryQuery({ scope: { kind: 'all' }, limit })).toBe(false);
    expect(isAuthenticationIncidentHistoryQuery({ scope: { kind: 'all' }, cursor: 'a\nb' })).toBe(false);
  });
  it('rejects events that contradict lifecycle status or the retained history clock', () => {
    const original = page().incidents[0]!;
    for (const patch of [
      { history_started_at: 110 },
      { events: [...original.events, { kind: 'changed', at: 99, level: 'rejected' }] },
      { events: [...original.events, { kind: 'opened', at: 200, level: 'rejected' }] },
      { events: [...original.events, { kind: 'awaiting_confirmation', at: 200, level: 'rejected' }] },
      { status: 'recovered', currently_reported: false, ended_at: 200, events: [...original.events, { kind: 'retired', at: 200, level: 'rejected' }] },
    ]) expect(isAuthenticationIncidentHistoryPage({ ...page(), incidents: [{ ...original, ...patch }] })).toBe(false);
  });
  it('accepts a closed legacy state recorded after its end with the last failure date unknown', () => {
    const data = page(); const incident = data.incidents[0]!;
    incident.status = 'recovered'; incident.currently_reported = false; incident.ended_at = 200;
    delete incident.last_problem_at; incident.history_started_at = 300; data.observed_at = 300;
    incident.events = [{ kind: 'recorded', at: 300, level: 'rejected' }];
    expect(isAuthenticationIncidentHistoryPage(data)).toBe(true);
  });
});
