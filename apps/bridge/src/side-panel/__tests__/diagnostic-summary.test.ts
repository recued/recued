import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticSummaryCopy, formatDiagnosticSummary, type DiagnosticSummaryCopyState } from '../diagnostic-summary.js';
import { DEFAULT_DIAGNOSTIC_FRAME, type SidePanelDiagnosticFrame } from '../store/local-store.js';

const createdAt = 1_700_000_000_000;
const opts = { bridgeVersion: '0.0.2', createdAt };
const frame = (): SidePanelDiagnosticFrame => ({
  ...DEFAULT_DIAGNOSTIC_FRAME, idempotency_entry_count: 6, pending_command_count: 2,
  current_command_id: 'private-command', queue_paused: true, grant_count: 3,
  last_successful_refresh_at: createdAt - 1_000,
  unresolved: { count: 1, entries: [{ command_id: 'private-pending', started_at: createdAt }] },
  recent_confirmed: { count: 5, entries: [
    { command_id: 'private-ok', status: 'ok', stored_at: createdAt },
    { command_id: 'private-error', status: 'error', stored_at: createdAt, error_code: 'selector_not_found' },
    { command_id: 'private-rejected', status: 'rejected', stored_at: createdAt, error_code: 'authority_invalid_grant_scope' },
    { command_id: 'private-repeat', status: 'error', stored_at: createdAt, error_code: 'selector_not_found' },
    { command_id: 'private-legacy', status: 'error', stored_at: createdAt },
  ] },
});
afterEach(() => vi.useRealTimers());

describe('diagnostic summary export', () => {
  it('exports only explicit aggregate metadata with unambiguous UTC times', () => {
    const source = frame();
    const text = formatDiagnosticSummary(source, opts);
    expect(text).toBe([
      'Recued Bridge diagnostic summary (v1)',
      'Bridge version: 0.0.2',
      'Summary created at: 2023-11-14T22:13:20.000Z',
      'Last successful refresh: 2023-11-14T22:13:19.000Z',
      'Refresh state: Ready',
      'Saved command results: 6',
      'Awaiting confirmation: 1',
      'Queued commands: 2',
      'Current command present: Yes',
      'Queue state: Paused',
      'Ingredient grants: 3',
      'Recent confirmed outcome sample: 5 of 5',
      'Sample completed: 1',
      'Sample failed: 3',
      'Sample rejected: 1',
      'Sample failure codes: authority_invalid_grant_scope=1, selector_not_found=2',
      'Sample failures without a known code: 1',
    ].join('\n'));
    expect(text).not.toContain('private');
    expect(source).toEqual(frame());
  });

  it('does not copy extra fields, raw errors, page data, identities, or unknown codes', () => {
    const extra = { url: 'https://private.invalid', token: 'private-token', error: { message: 'private-message' }, outputs: { page: 'private-page' } };
    const source = { ...frame(), ...extra, refresh_error: 'private-refresh-error',
      unresolved: { count: 1, entries: [{ command_id: 'private-pending', started_at: createdAt, ...extra }] },
      recent_confirmed: { count: 4, entries: [
        { command_id: 'private-success', status: 'ok', stored_at: createdAt, error_code: 'queue_full', ...extra },
        { command_id: 'private-future', status: 'error', stored_at: createdAt, error_code: 'private-unknown-code', ...extra },
        { command_id: 'private-prototype', status: 'rejected', stored_at: createdAt, error_code: '__proto__', ...extra },
        { command_id: 'private-uncertain', status: 'error', stored_at: createdAt, error_code: 'delivery_uncertain', ...extra },
      ] },
    } as unknown as SidePanelDiagnosticFrame;
    const text = formatDiagnosticSummary(source, opts);
    expect(text).toContain('Refresh state: Incomplete');
    expect(text).toContain('Recent confirmed outcome sample: 3 of 4');
    expect(text).toContain('Sample failure codes: None');
    expect(text).toContain('Sample failures without a known code: 2');
    for (const secret of ['private', '__proto__', 'delivery_uncertain', 'https://', 'queue_full', 'outputs', 'token']) expect(text).not.toContain(secret);
  });

  it('labels the bounded sample separately from the total', () => {
    const source = frame();
    source.recent_confirmed = { count: 200, entries: Array.from({ length: 60 }, (_, i) => ({
      command_id: `private-${i}`, status: 'error', error_code: 'selector_not_found', stored_at: createdAt,
    })) };
    const text = formatDiagnosticSummary(source, opts);
    expect(text).toContain('Recent confirmed outcome sample: 50 of 200');
    expect(text).toContain('selector_not_found=50');
    expect(text).not.toContain('selector_not_found=200');
  });

  it('distinguishes unavailable diagnostics, never refreshed, and known zero counts', () => {
    const unknown = formatDiagnosticSummary(DEFAULT_DIAGNOSTIC_FRAME, { createdAt });
    expect(unknown).toContain('Bridge version: Unavailable');
    expect(unknown).toContain('Last successful refresh: Never');
    expect(unknown).toContain('Refresh state: Not yet refreshed');
    for (const label of ['Saved command results', 'Queued commands', 'Current command present', 'Queue state', 'Recent confirmed outcomes']) {
      expect(unknown).toContain(`${label}: Unavailable`);
    }
    const empty = formatDiagnosticSummary({ ...frame(), idempotency_entry_count: 0, pending_command_count: 0,
      current_command_id: null, queue_paused: false, unresolved: { count: 0, entries: [] }, recent_confirmed: { count: 0, entries: [] } }, opts);
    expect(empty).toContain('Saved command results: 0');
    expect(empty).toContain('Current command present: No');
    expect(empty).toContain('Queue state: Ready');
    expect(empty).toContain('Recent confirmed outcome sample: 0 of 0');
  });

  it.each(['0.0.2\n', 'https://private.invalid', '0.0.2\nprivate-token', '<img src=x>', '1.2.3.4.5'])('rejects arbitrary manifest version text (%j)', bridgeVersion => {
    expect(formatDiagnosticSummary(frame(), { ...opts, bridgeVersion })).toContain('Bridge version: Unavailable');
  });

  it('keeps partial and refreshing exports honest about the displayed snapshot', () => {
    expect(formatDiagnosticSummary({ ...frame(), refreshing: true }, opts)).toContain('Refresh state: Refreshing');
    const partial = formatDiagnosticSummary({ ...frame(), idempotency_entry_count: null, recent_confirmed: null }, opts);
    expect(partial).toContain('Refresh state: Incomplete');
    expect(partial).toContain('Last successful refresh: 2023-11-14T22:13:19.000Z');
    expect(partial).toContain('Recent confirmed outcomes: Unavailable');
  });

  it('does not serialize invalid numbers or timestamps as useful data', () => {
    const text = formatDiagnosticSummary({ ...frame(), pending_command_count: -1, grant_count: Number.POSITIVE_INFINITY,
      last_successful_refresh_at: Number.NaN }, { ...opts, createdAt: Number.POSITIVE_INFINITY });
    expect(text).toContain('Summary created at: Unavailable');
    expect(text).toContain('Last successful refresh: Unavailable');
    expect(text).toContain('Queued commands: Unavailable');
    expect(text).toContain('Ingredient grants: Unavailable');
  });
});

describe('diagnostic summary clipboard flow', () => {
  const setup = (writeText?: (text: string) => Promise<void>) => {
    let paired = true, source = frame();
    const states: DiagnosticSummaryCopyState[] = [];
    const copy = createDiagnosticSummaryCopy({ getSummary: () => formatDiagnosticSummary(source, opts),
      getScope: () => ({ server_public_key: 'server', token_id: 'owner' }),
      canCopy: () => paired, writeText, apply: state => states.push(state) });
    return { copy, states, unpair: () => { paired = false; copy.invalidate(); }, update: (next: SidePanelDiagnosticFrame) => { source = next; } };
  };

  it('starts the write in the click stack, deduplicates pending clicks and copies the snapshot at the click', async () => {
    let release!: () => void;
    const write = vi.fn((_text: string) => new Promise<void>(resolve => { release = resolve; }));
    const f = setup(write), reading = f.copy.copy();
    expect(write).toHaveBeenCalledExactlyOnceWith(formatDiagnosticSummary(frame(), opts));
    expect(f.states.at(-1)?.phase).toBe('copying');
    f.update({ ...frame(), pending_command_count: 99 });
    await f.copy.copy();
    expect(write).toHaveBeenCalledTimes(1);
    release(); await reading;
    expect(f.states.at(-1)).toEqual({ phase: 'copied', summary: '' });
    const second = f.copy.copy();
    expect(write.mock.calls[1]?.[0]).toContain('Queued commands: 99');
    release(); await second; f.copy.dispose();
  });

  it.each(['unavailable', 'rejected', 'throws'])('provides a manual summary when the clipboard is %s', async mode => {
    const write = mode === 'unavailable' ? undefined : () => {
      if (mode === 'throws') throw new Error('private-platform-error');
      return Promise.reject(new Error('private-platform-error'));
    };
    const f = setup(write); await f.copy.copy();
    expect(f.states.at(-1)).toEqual({ phase: 'manual', summary: formatDiagnosticSummary(frame(), opts) });
    expect(JSON.stringify(f.states)).not.toContain('private');
    f.copy.dispose();
  });

  it.each(['invalidate', 'unpair', 'dispose'] as const)('ignores late completion after %s', async action => {
    let release!: () => void;
    const f = setup(() => new Promise<void>(resolve => { release = resolve; })), reading = f.copy.copy();
    if (action === 'unpair') f.unpair();
    else f.copy[action]();
    const length = f.states.length;
    release(); await reading;
    expect(f.states).toHaveLength(length);
    expect(f.states.at(-1)?.phase).not.toBe('copied');
  });

  it.each(['resolve', 'reject'] as const)('does not publish a late %s for a copy begun while the next pair identity was still loading', async outcome => {
    let scope: { server_public_key: string; token_id: string } | null = null;
    let resolve!: () => void, reject!: (error: Error) => void;
    const states: DiagnosticSummaryCopyState[] = [];
    const copy = createDiagnosticSummaryCopy({ getSummary: () => 'Transition snapshot', canCopy: () => true,
      getScope: () => scope, apply: state => states.push(state),
      writeText: () => new Promise<void>((done, fail) => { resolve = done; reject = fail; }) });
    const reading = copy.copy();
    // The invalidation already happened before the click. The paired flag
    // stays true while storage loads a new token for the same server URL.
    scope = { server_public_key: 'server', token_id: 'next-owner' };
    if (outcome === 'resolve') resolve(); else reject(new Error('private-platform-error'));
    await reading;
    expect(states.at(-1)).toEqual({ phase: 'idle', summary: '' });
    copy.dispose();
  });

  it('accepts a refreshed scope object with the same pair identity', async () => {
    let scope = { server_public_key: 'server', token_id: 'owner' }, resolve!: () => void;
    const states: DiagnosticSummaryCopyState[] = [];
    const copy = createDiagnosticSummaryCopy({ getSummary: () => 'Allowlisted summary', canCopy: () => true,
      getScope: () => scope, apply: state => states.push(state),
      writeText: () => new Promise<void>(done => { resolve = done; }) });
    const reading = copy.copy(); scope = { ...scope };
    resolve(); await reading;
    expect(states.at(-1)).toEqual({ phase: 'copied', summary: '' });
    copy.dispose();
  });

  it('falls back after a deadline without overlapping an uncancellable write or publishing late success', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const write = vi.fn((_text: string) => new Promise<void>(resolve => { release = resolve; }));
    const f = setup(write), reading = f.copy.copy();
    await vi.advanceTimersByTimeAsync(5_000); await reading;
    expect(f.states.at(-1)?.phase).toBe('manual');
    f.update({ ...frame(), pending_command_count: 99 });
    await f.copy.copy();
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.states.at(-1)?.summary).toContain('Queued commands: 99');
    const length = f.states.length;
    release(); await Promise.resolve(); await Promise.resolve();
    expect(f.states).toHaveLength(length);
    f.copy.dispose();
  });
});
