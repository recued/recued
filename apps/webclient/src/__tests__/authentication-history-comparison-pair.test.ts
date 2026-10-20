import { describe, expect, it } from 'vitest';
import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, type AuthenticationHistoryExport, type AuthenticationIncident } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { openAuthenticationHistoryFile, AuthenticationHistoryFileError } from '../connections/authentication-history-saved-file.js';
import { compareAuthenticationHistorySnapshots, authenticationHistoryComparisonSnapshot } from '../connections/authentication-history-comparison.js';
import { AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT, prepareAuthenticationHistoryComparisonPair } from '../connections/authentication-history-comparison-pair.js';

const incident = (n = 1): AuthenticationIncident => ({ id: n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc', status: 'open', started_at: 0, history_started_at: 0,
  currently_reported: true, level: 'rejected', events_truncated: false, details_truncated: false, events: [{ kind: 'opened', at: 0, level: 'rejected' }],
  group: { id: 'a'.repeat(64), kind: 'account', label: '<img src=x> École 🚀', authentication: 'direct_oauth', connection_names: ['work'],
    targets: [{ kind: 'connection', name: 'work' }], uses: [], issues: [], usage_available: false } });
const report = (records = [incident()], at = 300): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1, exported_at: at,
  scope: { kind: 'all' }, filters: {}, retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked',
  entry_count: records.length, entries: records.map(record => ({ type: 'incident', outcome: 'open', record })) });
const opened = (value: AuthenticationHistoryExport, mode: 'full' | 'aliases' = 'full') => openAuthenticationHistoryFile(prepareAuthenticationHistoryDownload(value, { scope: value.scope, filters: value.filters }, mode).json);
const capture = (a = report(), b = report([incident(2)], 400)) => compareAuthenticationHistorySnapshots(opened(a), opened(b));
const pair = () => prepareAuthenticationHistoryComparisonPair(capture());
const failure = (value: unknown, code = 'invalid_history') => {
  try { openAuthenticationHistoryFile(JSON.stringify(value)); throw Error('Accepted invalid pair'); }
  catch (error) { expect(error).toBeInstanceOf(AuthenticationHistoryFileError); expect((error as AuthenticationHistoryFileError).code).toBe(code); }
};

describe('saved authentication history comparison pairs', () => {
  it('round-trips both complete checked reports and recomputes the captured comparison without saving derived rows', () => {
    const a = report([incident(1), incident(2)]), b = report([incident(2), incident(3)], 400); b.entries[0]!.record = { ...incident(2), details_truncated: true };
    const before = JSON.stringify([a, b]), original = capture(a, b), saved = prepareAuthenticationHistoryComparisonPair(original);
    expect(saved.pair).toEqual({ format: AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT, version: 1, baseline: original.baseline.report, comparison: original.comparison.report });
    expect(saved.bytes).toBe(new TextEncoder().encode(saved.json).byteLength); expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.pair)).toBe(true);
    expect(saved.json).toContain('<img src=x> École 🚀'); expect(saved.json).toContain('"usage_available":false'); expect(saved.json).toContain('"started_at":0');
    expect(Object.keys(saved.pair)).not.toContain('rows'); expect(Object.keys(saved.pair)).not.toContain('counts'); expect(JSON.stringify([a, b])).toBe(before);
    const result = openAuthenticationHistoryFile('\uFEFF' + JSON.stringify(saved.pair, null, 2)); if (result.kind !== 'comparison') throw Error('Expected pair');
    expect(result.comparison).toEqual(original); expect(result.file).toEqual(saved); expect(Object.isFrozen(result.comparison.baseline.report.entries[0]!.record)).toBe(true);
    expect(() => authenticationHistoryComparisonSnapshot(result)).toThrow('Choose a complete history report');
  });
  it.each(['earlier', 'same', 'later'] as const)('preserves baseline order and a portable filename when the comparison capture time is %s', order => {
    const a = report(), b = report([incident(2)], order === 'earlier' ? 200 : order === 'same' ? 300 : 400);
    const saved = prepareAuthenticationHistoryComparisonPair(capture(a, b)), result = openAuthenticationHistoryFile(saved.json); if (result.kind !== 'comparison') throw Error('Expected pair');
    expect(result.comparison.capture_order).toBe(order); expect(result.comparison.baseline.report.exported_at).toBe(300); expect(result.comparison.comparison.report.exported_at).toBe(b.exported_at);
    expect(saved.filename).toBe('recued-history-comparison-pair-baseline-1970-01-01T00-00-00-300Z-comparison-' + new Date(b.exported_at).toISOString().replace(/[:.]/g, '-') + '.json');
    expect(saved.filename).not.toMatch(/[:/\\\s]/); expect(saved.filename).not.toContain('work'); expect(saved.filename).not.toContain('École');
  });
  it('preserves each source scope, filter text, limits and original entry order without asserting current access', () => {
    const a = report([incident(2), incident(1)]), b = report([incident(1)], 400); a.filters = { search: 'École', from: '1970-01-01', through: '1970-01-02' }; b.scope = { kind: 'connection', name: 'work' };
    const original = capture(a, b), saved = prepareAuthenticationHistoryComparisonPair(original), result = openAuthenticationHistoryFile(saved.json); if (result.kind !== 'comparison') throw Error('Expected pair');
    expect(result.comparison).toEqual(original); expect(result.file.pair.baseline.filters).toEqual(a.filters); expect(result.file.pair.comparison.scope).toEqual(b.scope);
    expect(result.file.pair.baseline.current_authentication).toBe('not_checked'); expect(result.file.pair.baseline.evidence).toBe('retained_local_observations');
    expect(result.comparison.rows[0]!.baseline_index).toBe(1); expect(result.file.pair.baseline.retention_days).toBe(90);
  });
  it.each([0, 1])('keeps a pair with %s records on each side complete and usable', count => {
    const saved = prepareAuthenticationHistoryComparisonPair(capture(report(count ? [incident()] : []), report(count ? [incident()] : [], 400)));
    const result = openAuthenticationHistoryFile(saved.json); if (result.kind !== 'comparison') throw Error('Expected pair');
    expect(result.comparison.counts.unchanged).toBe(count); expect(result.comparison.rows).toHaveLength(count);
  });
  it.each(['baseline', 'comparison'] as const)('rejects unchecked or non-report data in the %s side', side => {
    const original = JSON.parse(pair().json);
    const aliases = opened(report(), 'aliases'); if (aliases.kind !== 'report') throw Error('Expected report');
    for (const invalid of [null, {}, original, aliases.snapshot.report, original[side].entries[0], { ...original[side], format: 'recued.connection-history.related' },
      { ...original[side], complete: false }, { ...original[side], version: 2 }, { ...original[side], entry_count: 9 }, { ...original[side], current_authentication: 'checked' },
      { ...original[side], access_token: 'private-token' }, { ...original[side], entries: [...original[side].entries, original[side].entries[0]], entry_count: 2 }]) {
      failure({ ...original, [side]: invalid });
    }
    const secret = structuredClone(original); secret[side].entries[0].record.refresh_token = 'private-token'; failure(secret);
  });
  it('rejects extra derived claims, incomplete envelopes and unsupported formats or versions', () => {
    const original = JSON.parse(pair().json);
    for (const extra of [{ counts: { unchanged: 100 } }, { rows: [] }, { source_server: 'trusted' }, { current_authentication: 'checked' }, { filename: 'private.json' }, { access_token: 'private-token' }]) failure({ ...original, ...extra });
    const missing = { ...original }; delete missing.baseline; failure(missing);
    failure({ ...original, format: 'recued.connection-history.comparison-future' }, 'unsupported_format'); failure({ ...original, version: 2 }, 'unsupported_version');
  });
  it('enforces the combined UTF-8 bound even when each complete source report fits on its own', () => {
    const large = incident(); large.group.uses = Array.from({ length: 5000 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'x'.repeat(850) }));
    const a = opened(report([large])), b = opened(report([large], 400));
    if (a.kind !== 'report' || b.kind !== 'report') throw Error('Expected reports');
    expect(a.snapshot.bytes).toBeLessThan(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES); expect(b.snapshot.bytes).toBeLessThan(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
    expect(() => prepareAuthenticationHistoryComparisonPair(compareAuthenticationHistorySnapshots(a, b))).toThrow('must fit within 8 MiB');
  });
  it('bounds pair input before parsing and rejects excessive nesting', () => {
    const saved = pair(), padded = ' '.repeat(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - saved.bytes) + saved.json;
    expect(openAuthenticationHistoryFile(padded).kind).toBe('comparison');
    expect(() => openAuthenticationHistoryFile(' ' + padded)).toThrow('must fit within 8 MiB');
    const deep = '{"format":"' + AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT + '","version":1,"baseline":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}';
    expect(() => openAuthenticationHistoryFile(deep)).toThrow('could not be read as history JSON');
  });
});
