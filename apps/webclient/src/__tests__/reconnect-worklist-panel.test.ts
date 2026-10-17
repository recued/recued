import { describe, expect, it, vi } from 'vitest';
import type { PackReconnectGroup, PackReconnectResponse, AuthenticationRepairCaller, AuthenticationRepairWorklist } from '@recued/contracts';
import { createReconnectWorklistPanel, type PackReconnectCaller } from '../settings/reconnect-worklist-panel.js';

class Element {
  children: Element[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, () => void>();
  textContent = ''; className = ''; type = ''; disabled = false;
  get firstChild(): Element | null { return this.children[0] ?? null; }
  appendChild(child: Element): void { this.children.push(child); }
  removeChild(child: Element): void { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  addEventListener(key: string, fn: () => void): void { this.listeners.set(key, fn); }
  click(): void { if (!this.disabled) this.listeners.get('click')?.(); }
  text(): string { return this.textContent + ' ' + this.children.map(child => child.text()).join(' '); }
  all(key: string): Element[] { return [...(this.attrs.has(key) ? [this] : []), ...this.children.flatMap(child => child.all(key))]; }
  find(key: string, value: string): Element | undefined {
    return this.attrs.get(key) === value ? this : this.children.map(child => child.find(key, value)).find(Boolean);
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const group = (reviewed = false): PackReconnectGroup => ({ id: 'a'.repeat(64), fingerprint: 'b'.repeat(64), name: 'mail',
  display_name: 'Saved mail', authentication: 'broker', required_scopes: ['Mail.Read'], reviewed,
  can_reconnect: true, can_mark_reviewed: true, items: [{ id: 'c'.repeat(64), pack_slug: 'mail', pack_name: 'Mail',
    slot: 'graph', version: 1, required_scopes: ['Mail.Read'], missing_scopes: [], coverage: 'unknown', reviewed }] });
const response = (groups: PackReconnectGroup[], action: PackReconnectResponse['action'] = 'list'): PackReconnectResponse =>
  ({ action, groups, unresolved_packs: [] });
const mount = (call?: PackReconnectCaller, repairs?: AuthenticationRepairCaller) => {
  const host = new Element();
  const panel = createReconnectWorklistPanel({ document: { createElement: () => new Element() } as unknown as Document,
    ...(call ? { call } : {}), ...(repairs ? { repairs } : {}) });
  panel.mount(host as unknown as HTMLElement); return { host, panel };
};

describe('reconnect worklist refresh lifecycle', () => {
  it('coalesces install events during a pending list and reads again before settling', async () => {
    const first = deferred<PackReconnectResponse>();
    const call = vi.fn<PackReconnectCaller>().mockReturnValueOnce(first.promise).mockResolvedValue(response([group()]));
    const { host, panel } = mount(call);
    const settled = panel.refresh(); void panel.refresh();
    first.resolve(response([])); await settled;
    expect(call).toHaveBeenCalledTimes(2);
    expect(host.find('data-reconnect-worklist-group', group().id)).toBeDefined(); panel.dispose();
  });
  it('replays events received during a review write instead of leaving the returned snapshot on screen', async () => {
    const write = deferred<PackReconnectResponse>();
    const changed = { ...group(), id: 'd'.repeat(64), display_name: 'Newly installed Pack account' };
    const call = vi.fn<PackReconnectCaller>().mockResolvedValueOnce(response([group()]))
      .mockReturnValueOnce(write.promise).mockResolvedValue(response([changed]));
    const { host, panel } = mount(call); await panel.whenLoaded();
    host.find('data-reconnect-worklist-action', 'mark-reviewed')!.click();
    const settled = panel.whenLoaded(); void panel.refresh(); void panel.refresh();
    write.resolve(response([group(true)], 'mark_reviewed')); await settled;
    expect(call.mock.calls.map(([request]) => request.action)).toEqual(['list', 'mark_reviewed', 'list']);
    expect(host.find('data-reconnect-worklist-group', changed.id)).toBeDefined(); panel.dispose();
  });
  it('discards a queued read after disposal', async () => {
    const first = deferred<PackReconnectResponse>(); const call = vi.fn<PackReconnectCaller>().mockReturnValue(first.promise);
    const { host, panel } = mount(call); const before = host.firstChild;
    const settled = panel.refresh(); panel.dispose(); first.resolve(response([group()])); await settled;
    expect(call).toHaveBeenCalledTimes(1); expect(host.firstChild).toBe(before);
  });
});

const authentication = (): AuthenticationRepairWorklist => ({ observed_at: 1234, unavailable: [], groups: [{
  id: 'd'.repeat(64), kind: 'account', label: 'Work account', authentication: 'direct_oauth', connection_names: ['mail'], usage_available: true,
  issues: [{ id: 'e'.repeat(64), code: 'credential_rejected', message: 'The saved authentication was rejected.', observed_at: 1200 }],
  uses: [{ kind: 'mail', id: 'inbox', label: 'Work inbox' }, { kind: 'file', id: 'google.mail.file', label: 'Work files' }],
  targets: [{ kind: 'connection', name: 'mail' }, { kind: 'collection', platform: 'mail', slug: 'inbox' },
    { kind: 'file_source', source_id: 'google.mail.file' }, { kind: 'oauth_apps' }],
}] });
describe('unified authentication repair worklist', () => {
  it('combines permission reminders and authentication failures under their saved account', async () => {
    const call = vi.fn<PackReconnectCaller>().mockResolvedValue(response([group()]));
    const repairs = vi.fn<AuthenticationRepairCaller>().mockResolvedValue(authentication());
    const { host, panel } = mount(call, repairs); await panel.whenLoaded();
    expect(host.text()).toContain('Authentication repairs'); expect(host.text()).toContain('Recued direct OAuth');
    const account = host.find('data-authentication-repair-group', 'd'.repeat(64))!;
    expect(account.find('data-reconnect-worklist-group', group().id)).toBeDefined();
    expect(account.text()).toContain('Work inbox'); expect(account.text()).toContain('Work files');
    expect(call.mock.calls.map(([request]) => request.action)).toEqual(['list']); expect(repairs).toHaveBeenCalledTimes(1);
    panel.dispose();
  });
  it('opens exact local repair destinations without automatically authorizing or switching authentication', async () => {
    const { host, panel } = mount(undefined, async () => authentication()); await panel.whenLoaded();
    const links = host.all('data-authentication-repair-link').map(link => link.attrs.get('href'));
    expect(links).toEqual(['#connections/others/review-access/api/mail', '#connections/mail/inbox', '#data/files/remote%3Agoogle.mail.file', '#connections/others/oauth-apps']);
    expect(host.find('data-authentication-history-link', 'all')?.attrs.get('href')).toBe('#connections/others/incident-history');
    expect(host.find('data-authentication-history-link', authentication().groups[0]!.id)?.attrs.get('href')).toBe('#connections/others/incident-history/group/' + authentication().groups[0]!.id);
    expect(host.text()).not.toContain('Authorize with Nango'); expect(host.text()).toContain('does not contact vendors'); panel.dispose();
  });
  it('does not clear an authentication failure when unknown Pack permissions are marked reviewed', async () => {
    const call = vi.fn<PackReconnectCaller>().mockResolvedValueOnce(response([group()])).mockResolvedValueOnce(response([group(true)], 'mark_reviewed'));
    const { host, panel } = mount(call, async () => authentication()); await panel.whenLoaded();
    host.find('data-reconnect-worklist-action', 'mark-reviewed')!.click(); await panel.whenLoaded();
    expect(host.find('data-authentication-repair-issue', 'credential_rejected')).toBeDefined();
    expect(host.find('data-reconnect-worklist-group', group().id)).toBeUndefined();
    expect(host.text()).toContain('only that Pack reminder'); panel.dispose();
  });
  it('removes a repaired health entry only after a refreshed local snapshot reports it clear', async () => {
    const repaired = authentication(); repaired.groups[0]!.issues = [];
    const repairs = vi.fn<AuthenticationRepairCaller>().mockResolvedValueOnce(authentication()).mockResolvedValueOnce(repaired);
    const { host, panel } = mount(undefined, repairs); await panel.whenLoaded(); expect(host.find('data-authentication-repair-issue', 'credential_rejected')).toBeDefined();
    await panel.refresh(); expect(host.find('data-authentication-repair-issue', 'credential_rejected')).toBeUndefined();
    expect(host.text()).toContain('No recorded authentication problems'); panel.dispose();
  });
  it('still shows authentication failures when Pack inventory cannot be read', async () => {
    const { host, panel } = mount(async () => { throw new Error('never-export-raw-error'); }, async () => authentication()); await panel.whenLoaded();
    expect(host.find('data-authentication-repair-issue', 'credential_rejected')).toBeDefined();
    expect(host.text()).toContain('Pack permission reminders could not be read'); expect(host.text()).not.toContain('never-export'); panel.dispose();
  });
  it('keeps Pack repair available when authentication inventory is unavailable', async () => {
    const { host, panel } = mount(async () => response([group()]), async () => { throw new Error('never-export-token'); }); await panel.whenLoaded();
    expect(host.find('data-reconnect-worklist-group', group().id)).toBeDefined();
    expect(host.text()).toContain('Authentication status could not be refreshed'); expect(host.text()).not.toContain('never-export'); panel.dispose();
  });
  it('keeps earlier health observations visibly stale after a failed refresh', async () => {
    const repairs = vi.fn<AuthenticationRepairCaller>().mockResolvedValueOnce(authentication()).mockRejectedValueOnce(new Error('private'));
    const { host, panel } = mount(undefined, repairs); await panel.whenLoaded(); await panel.refresh();
    expect(host.find('data-authentication-repair-issue', 'credential_rejected')).toBeDefined();
    expect(host.text()).toContain('Earlier observations may be shown'); panel.dispose();
  });
  it('does not claim that an empty or partly unavailable inventory proves healthy vendor access', async () => {
    const data = authentication(); data.groups = []; data.unavailable = ['Mail and Calendar status is unavailable.'];
    const { host, panel } = mount(undefined, async () => data); await panel.whenLoaded();
    expect(host.text()).toContain('Mail and Calendar status is unavailable'); expect(host.text()).not.toContain('No recorded authentication problems'); panel.dispose();
  });
  it('rejects malformed repair responses and does not create remote or arbitrary repair links', async () => {
    const data = authentication(); data.groups[0]!.targets.push({ kind: 'url', href: 'https://evil.invalid' } as never);
    const { host, panel } = mount(undefined, async () => data); await panel.whenLoaded();
    expect(host.all('data-authentication-repair-link')).toHaveLength(0); expect(host.text()).toContain('Authentication status could not be refreshed'); panel.dispose();
  });
  it('discards an authentication read completed after the panel is disposed', async () => {
    const read = deferred<AuthenticationRepairWorklist>(); const { host, panel } = mount(undefined, () => read.promise); const before = host.firstChild;
    const pending = panel.whenLoaded(); panel.dispose(); read.resolve(authentication()); await pending;
    expect(host.firstChild).toBe(before); expect(host.find('data-authentication-repair-group', 'd'.repeat(64))).toBeUndefined();
  });
});
