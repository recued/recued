import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OAuthAppsRequest, type OAuthAppsResponse, type SavedOAuthApp, type OAuthAppUsageReview } from '@recued/contracts';
import { createOAuthAppsPanel } from '../settings/oauth-apps-panel.js';

const cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 15, 12)); });
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
const app = (date?: string): SavedOAuthApp => ({ id: 'default', issuer: 'microsoft', label: 'Work <app>',
  client_id: 'fixture-client', revision: 1, has_secret: true, ...(date ? { secret_expires_on: date } : {}) });
const fixture = async (date = '2026-10-15', supported = true,
  override?: (request: OAuthAppsRequest) => Promise<OAuthAppsResponse | undefined>) => {
  let apps = [app(date)]; let html = ''; let renders = 0; let reminderRenders = 0; let reminderHtml = '';
  const listeners = new Map<string, EventListener[]>(), docListeners = new Map<string, EventListener[]>();
  const calls: OAuthAppsRequest[] = []; const reminders = {
    get innerHTML() { return reminderHtml; }, set innerHTML(value: string) { reminderHtml = value; reminderRenders++; },
  }, usage = { innerHTML: '' };
  const fieldNodes = new Map<string, { value: string; disabled: boolean; focus(): void }>();
  const add = (map: Map<string, EventListener[]>, name: string, fn: EventListener) => map.set(name, [...map.get(name) ?? [], fn]);
  const remove = (map: Map<string, EventListener[]>, name: string, fn: EventListener) => map.set(name, (map.get(name) ?? []).filter(f => f !== fn));
  const document = { defaultView: null, addEventListener: (name: string, fn: EventListener) => add(docListeners, name, fn),
    removeEventListener: (name: string, fn: EventListener) => remove(docListeners, name, fn) };
  const host = {
    get innerHTML() { return html; }, set innerHTML(value: string) { html = value; renders++; reminders.innerHTML = /<div data-oauth-app-expiry-reminders>([\s\S]*?)<\/div>/.exec(value)?.[1] ?? ''; },
    ownerDocument: document, contains: () => true, querySelectorAll: () => [],
    querySelector: (selector: string) => {
      if (selector === '[data-oauth-app-expiry-reminders]') return reminders;
      if (selector === '[data-oauth-app-usage-host]') return usage;
      const field = /^\[data-oauth-app-field="([^"]+)"\]$/.exec(selector)?.[1];
      if (field) { if (!fieldNodes.has(field)) fieldNodes.set(field, { value: '', disabled: false, focus() {} }); return fieldNodes.get(field); }
      return null;
    },
    addEventListener: (name: string, fn: EventListener) => add(listeners, name, fn),
    removeEventListener: (name: string, fn: EventListener) => remove(listeners, name, fn),
  };
  const call = async (request: OAuthAppsRequest): Promise<OAuthAppsResponse> => {
    calls.push(request); const custom = await override?.(request); if (custom) return custom;
    const response = { action: request.action, apps, ...(supported ? { secret_expiry_supported: true } : {}) };
    if (request.action === 'save') {
      const saved = { ...apps[0]!, label: request.label, client_id: request.client_id, revision: apps[0]!.revision + 1 };
      if (request.secret_expires_on) saved.secret_expires_on = request.secret_expires_on;
      else if (request.secret_expires_on === null) delete saved.secret_expires_on;
      apps = [saved]; return { ...response, apps, saved_id: saved.id };
    }
    if (request.action === 'usage') {
      const review: OAuthAppUsageReview = { id: 'u'.repeat(43), fingerprint: 'a'.repeat(64), expires_at: Date.now() + 600_000, app: apps[0]!, can_rotate: true,
        native_accounts: [{ platform: 'mail', slug: 'work' }], connections: [{ name: 'api-copy', display_name: 'API copy', origin: 'confirmed', secret_matches: true,
          client_id_matches: true, group_id: 'copy', group_complete: true, selected_by_default: true, uses: [{ kind: 'pack', id: 'work-pack', label: 'Work pack' }], usage_available: true }],
        unreadable_connections: [], warnings: [] };
      return { ...response, usage: review };
    }
    if (request.action === 'rotate_secret') {
      const saved = { ...apps[0]!, revision: apps[0]!.revision + 1 };
      if (request.secret_expires_on) saved.secret_expires_on = request.secret_expires_on;
      else delete saved.secret_expires_on;
      apps = [saved]; return { ...response, apps, rotation_outcome: {
      attempt_id: request.attempt_id, issuer: 'microsoft', app_id: 'default', status: 'applied', selected_names: request.selected_names, skipped_names: [],
      native_accounts: [{ platform: 'mail', slug: 'work' }], verification: 'not_checked', app_revision: 2,
      ...(request.secret_expires_on ? { secret_expires_on: request.secret_expires_on } : {}),
      } };
    }
    return response;
  };
  const panel = createOAuthAppsPanel({ host: host as unknown as HTMLElement, call }); cleanup.push(() => panel.dispose()); await panel.whenLoaded();
  const fire = (name: string, dataset: Record<string, string>, value = '', attributes: string[] = [], badInput = false) => {
    const node = { dataset, value, validity: { badInput }, hasAttribute: (name: string) => attributes.includes(name),
      closest: (selector: string) => selector === '[data-oauth-app-action]' && dataset.oauthAppAction !== undefined
        || selector === '[data-app-usage-action]' && dataset.appUsageAction !== undefined ? node : null };
    for (const fn of [...listeners.get(name) ?? []]) fn({ target: node, preventDefault() {} } as unknown as Event);
  };
  return { panel, host, reminders, usage, calls, fieldNodes, renders: () => renders, reminderRenders: () => reminderRenders,
    click: (action: string) => fire('click', { oauthAppAction: action, oauthAppId: 'microsoft:default' }),
    field: (name: string, value: string, badInput = false) => fire('input', { oauthAppField: name }, value, [], badInput),
    submit: () => fire('submit', {}, '', ['data-oauth-app-editor']),
    usageClick: (action: string) => fire('click', { appUsageAction: action }),
    usageField: (name: 'secret' | 'expiry', value: string, badInput = false) => fire('input', {}, value, ['data-app-usage-' + name], badInput),
    visibility: () => { for (const fn of docListeners.get('visibilitychange') ?? []) fn({} as Event); },
    documentListenerCount: () => (docListeners.get('visibilitychange') ?? []).length };
};

describe('saved OAuth app expiry reminders', () => {
  it('shows a due reminder with an entry point even while saved apps are collapsed', async () => {
    const f = await fixture('2026-11-14');
    expect(f.reminders.innerHTML).toContain('Saved app expiry reminders');
    expect(f.reminders.innerHTML).toContain('Work &lt;app&gt;'); expect(f.reminders.innerHTML).toContain('in 30 days');
    expect(f.reminders.innerHTML).toContain('Review usage and rotate secret'); expect(f.reminders.innerHTML).toContain('Edit expiry date');
    expect(f.host.innerHTML).not.toContain('data-oauth-app-editor'); expect(f.calls.map(c => c.action)).toEqual(['list']);
  });
  it('edits only the date without requesting a secret, authorization or usage scan', async () => {
    const f = await fixture(); f.click('edit-expiry'); expect(f.host.innerHTML).toContain('value="2026-10-15"');
    f.field('expiry', '2027-01-01'); expect(f.panel.hasDraft()).toBe(true); f.submit(); await f.panel.whenLoaded();
    expect(f.calls).toEqual([{ action: 'list' }, { action: 'save', issuer: 'microsoft', id: 'default',
      expected_revision: 1, label: 'Work <app>', client_id: 'fixture-client', secret_expires_on: '2027-01-01' }]);
    expect(f.reminders.innerHTML).toBe(''); expect(f.host.innerHTML).toContain('Recorded secret expiry: 2027-01-01'); expect(f.panel.hasDraft()).toBe(false);
  });
  it('clears a reminder explicitly without treating an unknown date as never expiring', async () => {
    const f = await fixture(); f.click('edit-expiry'); f.field('expiry', ''); f.submit(); await f.panel.whenLoaded();
    expect(f.calls.at(-1)).toMatchObject({ action: 'save', secret_expires_on: null });
    expect(f.reminders.innerHTML).toBe(''); expect(f.host.innerHTML).toContain('No secret expiry date recorded');
    expect(f.host.innerHTML).not.toContain('never expires');
  });
  it('does not treat a partially entered native date as an intentional clear', async () => {
    const f = await fixture(); f.click('edit-expiry'); f.field('expiry', '', true); f.submit();
    expect(f.calls.map(c => c.action)).toEqual(['list']); expect(f.panel.hasDraft()).toBe(true);
    expect(f.host.innerHTML).toContain('use Clear expiry date');
    f.click('clear-expiry'); f.submit(); await f.panel.whenLoaded();
    expect(f.calls.at(-1)).toMatchObject({ action: 'save', secret_expires_on: null });
  });
  it('refuses impossible dates locally and preserves a stale-edit draft on failure', async () => {
    const f = await fixture('2026-10-15', true, async request => { if (request.action === 'save') throw Error('The saved app changed.'); return undefined; });
    f.click('edit-expiry'); f.field('expiry', '2026-02-29'); f.submit();
    expect(f.calls).toHaveLength(1); expect(f.host.innerHTML).toContain('Enter a real secret expiry date');
    f.field('expiry', '2027-01-01'); f.submit(); await f.panel.whenLoaded();
    expect(f.panel.hasDraft()).toBe(true); expect(f.host.innerHTML).toContain('The saved app changed');
    expect(f.reminders.innerHTML).toContain('2026-10-15');
  });
  it('does not silently copy the old expiry date to a changed Client ID', async () => {
    const f = await fixture(); f.click('edit-expiry'); f.field('client-id', 'replacement-client'); f.field('secret', 'fixture-new-secret');
    expect(f.fieldNodes.get('expiry')?.value).toBe(''); f.submit(); await f.panel.whenLoaded();
    expect(f.calls.at(-1)).toMatchObject({ action: 'save', client_id: 'replacement-client', secret_expires_on: null });
  });
  it('updates at local midnight without replacing an app draft or making an RPC', async () => {
    const f = await fixture('2026-11-15'); expect(f.reminders.innerHTML).toBe('');
    f.click('edit'); f.field('label', 'Unsaved label'); const renders = f.renders();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(f.reminders.innerHTML).toContain('in 30 days'); expect(f.renders()).toBe(renders);
    expect(f.panel.hasDraft()).toBe(true); expect(f.calls.map(c => c.action)).toEqual(['list']);
    f.panel.dispose(); expect(vi.getTimerCount()).toBe(0); expect(f.documentListenerCount()).toBe(0);
  });
  it('refreshes calendar status on visibility changes and does not mark access as expired', async () => {
    const f = await fixture(); vi.setSystemTime(new Date(2026, 9, 16, 12)); f.visibility();
    expect(f.reminders.innerHTML).toContain('date has passed'); expect(f.reminders.innerHTML).toContain('Access may still work');
    expect(f.calls.map(c => c.action)).toEqual(['list']); expect(f.reminders.innerHTML).not.toContain('authorization expired');
  });
  it('keeps unchanged reminder controls mounted when returning to the view', async () => {
    const f = await fixture(); const renders = f.reminderRenders(); f.visibility();
    expect(f.reminderRenders()).toBe(renders); expect(f.calls.map(c => c.action)).toEqual(['list']);
  });
  it('keeps a date draft visible and blocks saving if the server loses expiry support', async () => {
    let supported = true;
    const f = await fixture('2026-10-15', true, async request => request.action === 'list'
      ? { action: 'list', apps: [app('2026-10-15')], secret_expiry_supported: supported } : undefined);
    f.click('edit-expiry'); f.field('expiry', '2027-01-01'); f.field('label', 'Unsaved name');
    supported = false; f.click('refresh'); await f.panel.whenLoaded();
    expect(f.host.innerHTML).toContain('expiry support changed'); expect(f.host.innerHTML).toContain('value="2027-01-01"');
    f.submit(); await f.panel.whenLoaded(); expect(f.calls.some(c => c.action === 'save')).toBe(false); expect(f.panel.hasDraft()).toBe(true);
    supported = true; f.click('refresh'); await f.panel.whenLoaded(); f.submit(); await f.panel.whenLoaded();
    expect(f.calls.find(c => c.action === 'save')).toMatchObject({ label: 'Unsaved name', secret_expires_on: '2027-01-01' });
  });
  it('does not clear a newly visible stored date when expiry support appears during an old-server edit', async () => {
    let supported = false;
    const f = await fixture('2026-10-15', false, async request => request.action === 'list'
      ? { action: 'list', apps: [app(supported ? '2027-01-01' : undefined)], secret_expiry_supported: supported } : undefined);
    f.click('toggle'); f.click('edit'); f.field('label', 'Unsaved name'); supported = true;
    f.click('refresh'); await f.panel.whenLoaded(); f.submit(); await f.panel.whenLoaded();
    expect(f.host.innerHTML).toContain('expiry support changed'); expect(f.calls.some(c => c.action === 'save')).toBe(false);
    expect(f.panel.hasDraft()).toBe(true); expect(f.host.innerHTML).toContain('Unsaved name');
  });
  it('opens the existing usage review for the exact app and shows native accounts and API copies', async () => {
    const f = await fixture(); f.click('usage'); await f.panel.whenLoaded();
    expect(f.calls.map(c => c.action)).toEqual(['list', 'usage']);
    expect(f.calls[1]).toEqual({ action: 'usage', issuer: 'microsoft', id: 'default', expected_revision: 1 });
    expect(f.usage.innerHTML).toContain('mail work'); expect(f.usage.innerHTML).toContain('API copy'); expect(f.usage.innerHTML).toContain('Work pack');
    expect(f.usage.innerHTML).toContain('Current recorded secret expiry: 2026-10-15');
  });
  it('hides unsupported date edits with an older server and sends the legacy save shape', async () => {
    const f = await fixture('2026-10-15', false); f.click('toggle'); f.click('edit');
    expect(f.host.innerHTML).not.toContain('data-oauth-app-field="expiry"'); expect(f.reminders.innerHTML).toBe('');
    f.field('label', 'Renamed'); f.submit(); await f.panel.whenLoaded();
    expect(f.calls.at(-1)).not.toHaveProperty('secret_expires_on');
  });
  it('reports an unconfirmed expiry save without leaving a repeatable new-app write', async () => {
    const f = await fixture('2026-10-15', true, async request => request.action === 'save'
      ? { action: 'save', apps: [app()], saved_id: 'default' } : undefined);
    f.click('edit-expiry'); f.field('expiry', '2027-01-01'); f.submit(); await f.panel.whenLoaded();
    expect(f.host.innerHTML).toContain('did not confirm the expiry date'); expect(f.panel.hasDraft()).toBe(false);
    expect(f.calls.filter(c => c.action === 'save')).toHaveLength(1);
  });
  it('reviews and freezes the new date in the same rotation request as the secret', async () => {
    const f = await fixture(); f.click('usage'); await f.panel.whenLoaded();
    expect(f.usage.innerHTML).toContain('data-app-usage-expiry value=""');
    f.usageField('secret', 'fixture-new-secret'); f.usageField('expiry', '2027-11-14'); f.usageClick('review');
    expect(f.usage.innerHTML).toContain('New recorded secret expiry: 2027-11-14');
    f.usageField('expiry', '2028-11-14'); f.usageClick('apply'); await f.panel.whenLoaded();
    expect(f.calls.find(c => c.action === 'rotate_secret')).toMatchObject({ secret_expires_on: '2027-11-14', client_secret: 'fixture-new-secret' });
    expect(f.usage.innerHTML).toContain('Recorded expiry for the new secret: 2027-11-14');
  });
  it('makes the unknown-date rotation choice explicit and rejects impossible new dates', async () => {
    const f = await fixture(); f.click('usage'); await f.panel.whenLoaded(); f.usageField('secret', 'fixture-new-secret');
    f.usageField('expiry', '2027-02-29'); f.usageClick('review'); f.usageClick('apply'); await f.panel.whenLoaded();
    expect(f.usage.innerHTML).toContain('Enter a real new secret expiry date'); expect(f.calls.some(c => c.action === 'rotate_secret')).toBe(false);
    f.usageField('expiry', ''); f.usageClick('review'); expect(f.usage.innerHTML).toContain('The old reminder will clear');
    f.usageClick('apply'); await f.panel.whenLoaded(); expect(f.calls.find(c => c.action === 'rotate_secret')).toMatchObject({ secret_expires_on: null });
    expect(f.usage.innerHTML).toContain('No expiry date is recorded for the new secret');
    await f.panel.whenLoaded(); expect(f.reminders.innerHTML).toBe('');
  });
  it('requires an explicit clear for an incomplete native date in the rotation form', async () => {
    const f = await fixture(); f.click('usage'); await f.panel.whenLoaded(); f.usageField('secret', 'fixture-new-secret');
    f.usageField('expiry', '', true); f.usageClick('review');
    expect(f.usage.innerHTML).toContain('use Clear new expiry date'); expect(f.calls.some(c => c.action === 'rotate_secret')).toBe(false);
    f.usageClick('clear-expiry'); f.usageClick('review'); f.usageClick('apply'); await f.panel.whenLoaded();
    expect(f.calls.find(c => c.action === 'rotate_secret')).toMatchObject({ secret_expires_on: null });
  });
  it('recovers the recorded date after a lost rotation reply without repeating the write', async () => {
    let attempt = '';
    const f = await fixture('2026-10-15', true, async request => {
      if (request.action === 'rotate_secret') { attempt = request.attempt_id; throw Error('reply lost'); }
      if (request.action === 'rotation_status') return { action: 'rotation_status', apps: [app('2027-11-14')], secret_expiry_supported: true,
        rotation_outcome: { attempt_id: attempt, issuer: 'microsoft', app_id: 'default', status: 'applied', selected_names: ['api-copy'],
          skipped_names: [], native_accounts: [{ platform: 'mail', slug: 'work' }], verification: 'not_checked', app_revision: 2, secret_expires_on: '2027-11-14' } };
      return undefined;
    });
    f.click('usage'); await f.panel.whenLoaded(); f.usageField('secret', 'fixture-new-secret'); f.usageField('expiry', '2027-11-14');
    f.usageClick('review'); f.usageClick('apply'); await f.panel.whenLoaded();
    expect(f.usage.innerHTML).toContain('Check the rotation result'); f.usageClick('status'); await f.panel.whenLoaded();
    expect(f.usage.innerHTML).toContain('Recorded expiry for the new secret: 2027-11-14');
    expect(f.calls.filter(c => c.action === 'rotate_secret')).toHaveLength(1);
  });
  it.each([
    { label: 'missing date', date: undefined, supported: true },
    { label: 'different date', date: '2028-01-01', supported: true },
    { label: 'missing capability', date: undefined, supported: false },
  ])('reports an applied rotation with an unconfirmed expiry: $label', async ({ date, supported }) => {
    const f = await fixture('2026-10-15', true, async request => request.action === 'rotate_secret'
      ? { action: 'rotate_secret', apps: [app(date)], secret_expiry_supported: supported,
        rotation_outcome: { attempt_id: request.attempt_id, issuer: 'microsoft', app_id: 'default', status: 'applied',
          selected_names: request.selected_names, skipped_names: [], native_accounts: [], verification: 'not_checked', app_revision: 2,
          ...(date ? { secret_expires_on: date } : {}) } } : undefined);
    f.click('usage'); await f.panel.whenLoaded(); f.usageField('secret', 'fixture-new-secret'); f.usageField('expiry', '2027-11-14');
    f.usageClick('review'); f.usageClick('apply'); await f.panel.whenLoaded();
    expect(f.usage.innerHTML).toContain('Secret rotation saved.'); expect(f.usage.innerHTML).toContain('did not confirm the requested expiry date');
    expect(f.usage.innerHTML).not.toContain('No expiry date is recorded'); expect(f.usage.innerHTML).not.toContain('Recorded expiry for the new secret:');
    expect(f.panel.hasDraft()).toBe(false); expect(f.calls.filter(c => c.action === 'rotate_secret')).toHaveLength(1);
    f.usageClick('apply'); expect(f.calls.filter(c => c.action === 'rotate_secret')).toHaveLength(1);
  });
  it('requires confirmation of an explicit unknown date on an applied rotation', async () => {
    const f = await fixture('2026-10-15', true, async request => request.action === 'rotate_secret'
      ? { action: 'rotate_secret', apps: [app('2026-10-15')], secret_expiry_supported: true,
        rotation_outcome: { attempt_id: request.attempt_id, issuer: 'microsoft', app_id: 'default', status: 'applied',
          selected_names: request.selected_names, skipped_names: [], native_accounts: [], verification: 'not_checked', app_revision: 2,
          secret_expires_on: '2026-10-15' } } : undefined);
    f.click('usage'); await f.panel.whenLoaded(); f.usageField('secret', 'fixture-new-secret'); f.usageClick('review'); f.usageClick('apply'); await f.panel.whenLoaded();
    expect(f.usage.innerHTML).toContain('did not confirm the requested expiry date'); expect(f.panel.hasDraft()).toBe(false);
    expect(f.calls.find(c => c.action === 'rotate_secret')).toMatchObject({ secret_expires_on: null });
  });
  it('retains the proposed date while recovering a lost reply and reports an unconfirmed result', async () => {
    let attempt = '';
    const f = await fixture('2026-10-15', true, async request => {
      if (request.action === 'rotate_secret') { attempt = request.attempt_id; throw Error('reply lost'); }
      if (request.action === 'rotation_status') return { action: 'rotation_status', apps: [app()], secret_expiry_supported: true,
        rotation_outcome: { attempt_id: attempt, issuer: 'microsoft', app_id: 'default', status: 'applied', selected_names: ['api-copy'],
          skipped_names: [], native_accounts: [], verification: 'not_checked', app_revision: 2 } };
      return undefined;
    });
    f.click('usage'); await f.panel.whenLoaded(); f.usageField('secret', 'fixture-new-secret'); f.usageField('expiry', '2027-11-14');
    f.usageClick('review'); f.usageClick('apply'); await f.panel.whenLoaded(); f.usageClick('status'); await f.panel.whenLoaded();
    expect(f.usage.innerHTML).toContain('Secret rotation saved.'); expect(f.usage.innerHTML).toContain('did not confirm the requested expiry date');
    expect(f.panel.hasDraft()).toBe(false); expect(f.calls.filter(c => c.action === 'rotate_secret')).toHaveLength(1);
  });
});
