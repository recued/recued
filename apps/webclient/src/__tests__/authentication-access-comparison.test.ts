import { describe, expect, it, vi } from 'vitest';
import { isAuthenticationAccessVerification, type AuthenticationAccessVerification, type AuthenticationRepairTarget } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { createAuthenticationAccessComparisons, resolveAuthenticationAccessComparison } from '../connections/authentication-access-comparison.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';

const pair = (target: AuthenticationRepairTarget = { kind: 'connection', name: 'work' }) => {
  const kind = target.kind === 'collection' ? 'collection_read' : target.kind === 'file_source' ? 'file_metadata' : 'api_read';
  const original: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: 'a'.repeat(64) },
    status: 'completed', started_at: 1000, finished_at: 1100, targets_truncated: false, usage_available: true, uses: [],
    results: [{ id: 'b'.repeat(64), target, label: '<Work account>', authentication_revision: 'c'.repeat(64), current: 'no',
      checks: [{ kind, status: 'failed', reason: 'access_rejected' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }] };
  const recheck: AuthenticationAccessVerification = { ...structuredClone(original), id: 'verify-22345678-1234-4123-8123-123456789abc',
    selection: { kind: 'verification', id: original.id }, started_at: 1200, finished_at: 1300,
    results: original.results.map(r => ({ ...structuredClone(r), authentication_revision: 'd'.repeat(64), current: 'yes', checks: [{ kind, status: 'passed' },
      { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] })) };
  const call = vi.fn<ManagedOAuthCaller>(async request => {
    if (request.action !== 'authentication_access_status') throw Error('Unexpected mutation');
    return { action: request.action, verification: request.id === original.id ? original : recheck };
  });
  return { original, recheck, call };
};
const fixture = () => {
  const f = pair(); const root = new PickerElement(); let active: PickerElement | null = null; let copies = 1; let links = 0;
  const doc = { get activeElement() { return active; }, createElement: () => { const n = new PickerElement(); n.focus = () => { active = n; }; return n; } };
  let source = structuredClone(f.recheck); let targetId: string | undefined;
  const render = () => { controller.beginRender(); root.textContent = '';
    for (let n = 0; n < links; n++) { const a = doc.createElement(); a.setAttribute('href', '#connections/others'); root.appendChild(a); }
    for (let n = 0; n < copies; n++) controller.append(root as unknown as HTMLElement, source, targetId);
  };
  const controller = createAuthenticationAccessComparisons({ document: doc as unknown as Document, call: f.call, host: () => root as unknown as HTMLElement,
    active: () => true, changed: render }); render();
  const compare = () => root.querySelector('[data-access-compare]')!;
  return { ...f, root, doc, controller, compare, render, setSource: (v: AuthenticationAccessVerification) => { source = v; render(); },
    setCopies: (n: number) => { copies = n; render(); }, setLinks: (n: number) => { links = n; render(); }, setTarget: (id: string) => { targetId = id; render(); } };
};

describe('saved original and recheck comparison', () => {
  it('offers a comparison address and opens its existing mounted review without a synthetic click', async () => {
    const f = fixture(); expect(f.root.querySelector('[data-access-comparison-page]')!.getAttribute('href')).toBe('#connections/others/access-check/' + f.recheck.id + '/compare');
    expect(f.call).not.toHaveBeenCalled(); await f.controller.open(structuredClone(f.recheck));
    expect(f.root.querySelector('[data-access-comparison]')).not.toBeNull(); expect(f.call).toHaveBeenCalledTimes(2); f.controller.dispose();
  });
  it('does not open a comparison from an unmounted or replaced snapshot', async () => {
    const f = fixture(); const changed = structuredClone(f.recheck); changed.results[0]!.authentication_revision = 'f'.repeat(64);
    await f.controller.open(changed); expect(f.call).not.toHaveBeenCalled(); f.controller.dispose();
    await f.controller.open(f.recheck); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'] as const)('does not move focus into an automatically opened comparison after %s', async outcome => {
    const f = fixture(); const outside = f.doc.createElement(); outside.focus();
    if (outcome === 'failure') f.call.mockRejectedValueOnce(Error('Unavailable'));
    await f.controller.open(f.recheck);
    expect(f.doc.activeElement).toBe(outside); f.controller.dispose();
  });
  it.each<AuthenticationRepairTarget>([{ kind: 'connection', name: 'work' }, { kind: 'collection', platform: 'mail', slug: 'work' },
    { kind: 'collection', platform: 'calendar', slug: 'work' }, { kind: 'file_source', source_id: 'opaque-files' }])('compares %j using saved status only', async target => {
    const f = pair(target); const before = structuredClone([f.original, f.recheck]);
    const value = await resolveAuthenticationAccessComparison(f.call, f.recheck);
    expect(f.call.mock.calls.map(([request]) => request)).toEqual([{ action: 'authentication_access_status', id: f.recheck.id }, { action: 'authentication_access_status', id: f.original.id }]);
    expect(value.original).toEqual(f.original); expect(value.recheck).toEqual(f.recheck); expect(value.original).not.toBe(f.original); expect(value.recheck).not.toBe(f.recheck);
    expect([f.original, f.recheck]).toEqual(before);
  });
  it.each(['ordinary', 'running', 'self', 'malformed'] as const)('does not read or offer a comparison for %s results', async mode => {
    const f = pair(); if (mode === 'ordinary') f.recheck.selection = f.original.selection;
    if (mode === 'running') { f.recheck.status = 'checking'; delete f.recheck.finished_at; f.recheck.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }]; }
    if (mode === 'self') f.recheck.selection.id = f.recheck.id;
    if (mode === 'malformed') f.recheck.id = 'invalid';
    await expect(resolveAuthenticationAccessComparison(f.call, f.recheck)).rejects.toThrow('Wait'); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['id', 'selection', 'start', 'finish', 'resource', 'revision', 'checks', 'extra target'] as const)('refuses a changed recheck %s', async change => {
    const f = pair(); const expected = structuredClone(f.recheck); const r = f.recheck.results[0]!;
    if (change === 'id') f.recheck.id = 'verify-32345678-1234-4123-8123-123456789abc';
    if (change === 'selection') f.recheck.selection.id = 'verify-32345678-1234-4123-8123-123456789abc';
    if (change === 'start') f.recheck.started_at++; if (change === 'finish') f.recheck.finished_at!++;
    if (change === 'resource') r.target = { kind: 'connection', name: 'other' }; if (change === 'revision') r.authentication_revision = 'e'.repeat(64);
    if (change === 'checks') r.checks[0] = { kind: 'api_read', status: 'unconfirmed', reason: 'unavailable' };
    if (change === 'extra target') f.recheck.results.push({ ...structuredClone(r), id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' } });
    await expect(resolveAuthenticationAccessComparison(f.call, expected)).rejects.toThrow('matching original');
  });
  it.each(['id', 'unfinished', 'clock', 'target id', 'resource', 'passed only', 'writes only'] as const)('refuses an unrelated original %s', async change => {
    const f = pair(); const r = f.original.results[0]!;
    if (change === 'id') f.original.id = 'verify-32345678-1234-4123-8123-123456789abc';
    if (change === 'unfinished') { f.original.status = 'checking'; delete f.original.finished_at; r.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }]; }
    if (change === 'clock') f.original.finished_at = 1201;
    if (change === 'target id') r.id = 'f'.repeat(64); if (change === 'resource') r.target = { kind: 'connection', name: 'other' };
    if (change === 'passed only') r.checks[0] = { kind: 'api_read', status: 'passed' };
    if (change === 'writes only') r.checks = [{ kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }];
    await expect(resolveAuthenticationAccessComparison(f.call, f.recheck)).rejects.toThrow('matching original');
  });
  it('compares semantic evidence across field ordering and a selected subset of the original targets', async () => {
    const f = pair(); const expected = structuredClone(f.recheck);
    f.original.results.push({ ...structuredClone(f.original.results[0]!), id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' }, checks: [{ kind: 'api_read', status: 'passed' }] });
    f.recheck.results[0]!.target = { name: 'work', kind: 'connection' }; f.recheck.results[0]!.checks.reverse();
    expect((await resolveAuthenticationAccessComparison(f.call, expected)).recheck.results).toHaveLength(1);
  });
  it.each(['no', 'unknown'] as const)('refreshes the recheck authentication flag to %s without inventing current proof', async current => {
    const f = fixture(); f.recheck.results[0]!.current = current; f.compare().focus(); f.compare().click(); await f.controller.whenLoaded();
    const comparison = f.root.querySelector('[data-access-comparison]')!;
    expect(comparison.querySelector('[data-access-comparison-after-current="' + current + '"]')).not.toBeNull();
    expect(comparison.querySelector('[data-access-comparison-after="api_read"]')!.textContent).toBe('Passed (historical result)'); f.controller.dispose();
  });
  it.each(['different revisions', 'same revision'] as const)('marks contradictory current-authentication observations unknown for %s', async mode => {
    const f = pair({ kind: 'file_source', source_id: 'opaque-files' }); const old = f.original.results[0]!; const next = f.recheck.results[0]!;
    old.current = 'yes'; old.file_connection = { name: 'files', updated_at: 1 };
    if (mode === 'same revision') { next.authentication_revision = old.authentication_revision; next.current = 'no'; }
    else next.file_connection = { name: 'files', updated_at: 2 };
    const before = structuredClone([f.original, f.recheck]); const result = await resolveAuthenticationAccessComparison(f.call, f.recheck);
    expect(result.original.results[0]!.current).toBe('unknown'); expect(result.recheck.results[0]!.current).toBe('unknown');
    expect(result.original.results[0]!.file_connection).toBeUndefined(); expect(result.recheck.results[0]!.file_connection).toBeUndefined();
    expect(isAuthenticationAccessVerification(result.original)).toBe(true); expect(isAuthenticationAccessVerification(result.recheck)).toBe(true);
    expect([f.original, f.recheck]).toEqual(before); expect(f.call).toHaveBeenCalledTimes(2);
  });
  it('shows conflicting current-authentication reads as historical instead of claiming two different revisions are current', async () => {
    const f = fixture(); f.original.results[0]!.current = 'yes'; f.compare().click(); await f.controller.whenLoaded();
    expect(f.root.textContent).toContain('could not be compared consistently');
    expect(f.root.querySelectorAll('[data-access-comparison-before-current="unknown"]')).toHaveLength(1);
    expect(f.root.querySelectorAll('[data-access-comparison-after-current="unknown"]')).toHaveLength(1);
    expect(f.root.querySelector('[data-access-comparison-after="api_read"]')!.textContent).toBe('Passed (historical result)'); f.controller.dispose();
  });
  it('keeps unrelated resource comparisons current when another resource has contradictory authentication flags', async () => {
    const f = fixture(); f.original.results[0]!.current = 'yes';
    const old = { ...structuredClone(f.original.results[0]!), id: 'f'.repeat(64), target: { kind: 'connection' as const, name: 'other' }, current: 'no' as const };
    const next = { ...structuredClone(f.recheck.results[0]!), id: old.id, target: old.target };
    f.original.results.push(old); f.recheck.results.push(next); f.setSource(structuredClone(f.recheck)); f.compare().click(); await f.controller.whenLoaded();
    const unaffected = f.root.querySelector('[data-access-comparison-target="' + old.id + '"]')!;
    expect(unaffected.querySelector('[data-access-comparison-after-current="yes"]')).not.toBeNull();
    expect(unaffected.querySelector('[data-access-comparison-after="api_read"]')!.textContent).toBe('Passed');
    expect(f.root.querySelector('[data-access-comparison-after-current="unknown"]')).not.toBeNull(); f.controller.dispose();
  });
  it('exposes comparison expansion and pending-read feedback to assistive technology', async () => {
    const f = fixture(); const normal = f.call.getMockImplementation()!; let release!: () => void;
    expect(f.compare().getAttribute('aria-expanded')).toBe('false');
    const controlledId = f.compare().getAttribute('aria-controls'); expect(controlledId).toBeTruthy();
    expect(f.root.querySelector('[id="' + controlledId + '"]')).not.toBeNull();
    f.call.mockImplementationOnce(request => new Promise(resolve => { release = () => { void normal(request).then(resolve); }; }));
    f.compare().click(); expect(f.root.querySelector('[role="status"]')!.textContent).toContain('Reading saved checks');
    expect(f.root.querySelector('[aria-busy="true"]')).not.toBeNull(); release(); await f.controller.whenLoaded();
    expect(f.compare().getAttribute('aria-expanded')).toBe('true'); expect(f.compare().getAttribute('aria-controls')).toBe(controlledId);
    expect(f.root.querySelector('[aria-busy="true"]')).toBeNull();
    f.root.querySelector('[data-access-comparison-hide]')!.click(); expect(f.compare().getAttribute('aria-expanded')).toBe('false'); f.controller.dispose();
  });
  it('renders original and recheck clocks, distinct outcomes and authentication without mutating saved receipts', async () => {
    const f = fixture(); const before = structuredClone([f.original, f.recheck]); f.compare().focus(); f.compare().click(); await f.controller.whenLoaded();
    expect(f.root.textContent).toContain('Original and recheck results'); expect(f.root.textContent).toContain('Started:'); expect(f.root.textContent).toContain('Finished:');
    expect(f.root.querySelector('[data-access-comparison-original="' + f.original.id + '"]')).not.toBeNull();
    expect(f.root.querySelector('[data-access-comparison-recheck="' + f.recheck.id + '"]')).not.toBeNull();
    expect(f.root.querySelector('[data-access-comparison-before="api_read"]')!.textContent).toContain('Failed');
    expect(f.root.querySelector('[data-access-comparison-after="api_read"]')!.textContent).toBe('Passed');
    expect(f.root.textContent).toContain('Superseded'); expect(f.root.textContent).toContain('Matches current saved authentication');
    expect(f.root.textContent).toContain('revision changed'); expect(f.root.textContent).toContain('may differ between attempts'); expect(f.root.textContent).toContain('does not establish which repair');
    expect(f.root.querySelector('[data-access-comparison-before="write_permissions"]')!.textContent).toContain('Unconfirmed');
    expect([f.original, f.recheck]).toEqual(before); expect(f.doc.activeElement).toBe(f.compare()); f.controller.dispose();
  });
  it('does not inherit an earlier file-download pass into a metadata-only recheck', async () => {
    const f = fixture(); const old = f.original.results[0]!; const next = f.recheck.results[0]!;
    old.target = next.target = { kind: 'file_source', source_id: 'opaque-files' };
    old.checks = [{ kind: 'file_metadata', status: 'failed', reason: 'access_rejected' }, { kind: 'file_download', status: 'passed' }]; next.checks = [{ kind: 'file_metadata', status: 'passed' }];
    f.setSource(structuredClone(f.recheck)); f.compare().click(); await f.controller.whenLoaded();
    expect(f.root.querySelector('[data-access-comparison-before="file_download"]')!.textContent).toContain('Passed (historical result)');
    expect(f.root.querySelector('[data-access-comparison-after="file_download"]')!.textContent).toBe('Not checked in this attempt'); f.controller.dispose();
  });
  it('does not render unchecked original targets or lose a targeted return when comparing', async () => {
    const f = fixture(); const other = { ...structuredClone(f.original.results[0]!), id: 'f'.repeat(64), target: { kind: 'connection' as const, name: 'other' }, label: 'Other account' };
    f.original.results.push(other); f.recheck.results.push({ ...structuredClone(other), current: 'yes' });
    f.setSource(structuredClone(f.recheck)); f.setTarget('b'.repeat(64)); f.compare().click(); await f.controller.whenLoaded();
    expect(f.root.textContent).not.toContain('Other account'); expect(f.root.querySelectorAll('[data-access-comparison-target]')).toHaveLength(1); f.controller.dispose();
  });
  it('shows a safe local error and clears old comparison proof before an explicit retry', async () => {
    const f = fixture(); f.compare().click(); await f.controller.whenLoaded(); expect(f.root.querySelector('[data-access-comparison]')).not.toBeNull();
    f.call.mockRejectedValueOnce(Error('private-token')); f.compare().click(); expect(f.root.querySelector('[data-access-comparison]')).toBeNull(); await f.controller.whenLoaded();
    expect(f.root.textContent).toContain('may no longer be retained'); expect(f.root.textContent).not.toContain('private-token');
    f.compare().click(); await f.controller.whenLoaded(); expect(f.root.querySelector('[data-access-comparison]')).not.toBeNull();
    expect(f.call.mock.calls.every(([r]) => r.action === 'authentication_access_status')).toBe(true); f.controller.dispose();
  });
  it.each(['reset', 'dispose', 'replaced evidence'] as const)('drops pending comparison replies after %s', async action => {
    const f = fixture(); const normal = f.call.getMockImplementation()!; let release!: () => void;
    f.call.mockImplementationOnce(request => new Promise(resolve => { release = () => { void normal(request).then(resolve); }; }));
    const oldButton = f.compare(); oldButton.click(); const pending = f.controller.whenLoaded(); oldButton.click(); expect(f.call).toHaveBeenCalledTimes(2);
    if (action === 'reset') { f.controller.reset(); f.root.textContent = ''; }
    else if (action === 'dispose') f.controller.dispose();
    else { const next = structuredClone(f.recheck); next.results[0]!.authentication_revision = 'f'.repeat(64); f.setSource(next); }
    const before = f.root.textContent; release(); await pending;
    if (action === 'replaced evidence') { expect(f.compare().disabled).toBe(false); expect(f.compare().textContent).toBe('Compare with original check'); }
    else expect(f.root.textContent).toBe(before);
    expect(f.root.querySelector('[data-access-comparison]')).toBeNull(); f.controller.dispose();
  });
  it('keeps a later focus choice outside the comparison when replies arrive', async () => {
    const f = fixture(); const normal = f.call.getMockImplementation()!; let release!: () => void;
    f.call.mockImplementationOnce(request => new Promise(resolve => { release = () => { void normal(request).then(resolve); }; }));
    f.compare().focus(); f.compare().click(); const outside = f.doc.createElement(); outside.focus(); release(); await f.controller.whenLoaded();
    expect(f.doc.activeElement).toBe(outside); f.controller.dispose();
  });
  it('retains the chosen navigation-link occurrence when the containing history view rerenders', async () => {
    const f = fixture(); f.setLinks(2); const normal = f.call.getMockImplementation()!; let release!: () => void;
    f.call.mockImplementationOnce(request => new Promise(resolve => { release = () => { void normal(request).then(resolve); }; }));
    f.compare().focus(); f.compare().click(); f.root.querySelectorAll('[href]')[1]!.focus(); release(); await f.controller.whenLoaded();
    expect(f.doc.activeElement).toBe(f.root.querySelectorAll('[href]')[1]); f.controller.dispose();
  });
  it('restores focus to the chosen duplicate occurrence after reading or hiding a comparison', async () => {
    const f = fixture(); f.setCopies(2); const second = f.root.querySelectorAll('[data-access-compare]')[1]!; second.focus(); second.click(); await f.controller.whenLoaded();
    const controlledIds = f.root.querySelectorAll('[data-access-compare]').map(b => b.getAttribute('aria-controls'));
    expect(new Set(controlledIds).size).toBe(2); for (const id of controlledIds) expect(f.root.querySelector('[id="' + id + '"]')).not.toBeNull();
    expect(f.doc.activeElement).toBe(f.root.querySelectorAll('[data-access-compare]')[1]);
    const hide = f.root.querySelectorAll('[data-access-comparison-hide]')[1]!; hide.focus(); hide.click();
    expect(f.doc.activeElement).toBe(f.root.querySelectorAll('[data-access-compare]')[1]); expect(f.root.querySelector('[data-access-comparison]')).toBeNull(); f.controller.dispose();
  });
});
