import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderCreateResult, ReminderView } from '@recued/contracts';
import { createRemindersSurface, type ReminderCallers } from '../reminders-surface.js';

const form = vi.hoisted(() => ({ active: false, busy: false, open: vi.fn(), dispose: vi.fn(),
  close: null as ((result?: ReminderCreateResult) => void) | null }));
vi.mock('../../reminders/reminder-create-form.js', () => ({
  mountReminderCreateForm: (options: { onClose: (result?: ReminderCreateResult) => void }) => {
    form.close = options.onClose; form.open.mockImplementation(() => { form.active = true; });
    return { open: form.open, hasDraft: () => form.active, pending: () => form.busy, dispose: form.dispose };
  },
}));
const NOW = Date.parse('2026-11-01T15:00:00Z');
const row = (id: string, over: Partial<ReminderView> = {}): ReminderView => ({ reminder_id: id, text: 'Follow up ' + id,
  at: NOW - 3_600_000, when: 'Earlier today', time_zone: 'America/New_York', state: 'delivered', delivered_at: NOW - 60_000, ...over });
const rig = (rows = [row('a'), row('b', { state: 'cancelled' })], options: { noGet?: boolean; noCreate?: boolean } = {}) => {
  const get = vi.fn<NonNullable<ReminderCallers['get']>>(async ({ reminder_id }) => ({ reminder: rows.find(row => row.reminder_id === reminder_id) ?? null }));
  const create = vi.fn<NonNullable<ReminderCallers['create']>>(async () => ({ reminder: row('new', { state: 'pending' }), when: 'Later', confirmation: 'Set.' }));
  const render = vi.fn();
  const doc: { activeElement: Element | null; body: HTMLElement; createElement: () => object } = { activeElement: null, body: {} as HTMLElement,
    createElement: () => ({ ownerDocument: doc, contains: () => false }) };
  doc.activeElement = doc.body;
  const target = (id = '', attrs: Record<string, string> = {}) => ({ ownerDocument: doc,
    getAttribute: (key: string) => key === 'data-reminder-id' ? id : attrs[key] ?? null }) as unknown as HTMLElement;
  const surface = createRemindersSurface({ callers: { list: async () => ({ reminders: [], count: 0, delivered: rows }),
    ...(!options.noGet ? { get } : {}), ...(!options.noCreate ? { create } : {}) }, now: () => NOW,
    timeZone: () => 'America/New_York', actionAttr: 'data-act', render });
  return { surface, get, create, render, target, doc };
};
beforeEach(() => { form.active = false; form.busy = false; form.close = null; form.open.mockClear(); form.dispose.mockClear(); });

describe('remind again', () => {
  it('offers only retained terminal one-off reminders with creation and exact lookup available', async () => {
    const r = rig([row('a'), row('b', { state: 'cancelled' }), row('clock', { managed_by: 'clock' }), row('pending', { state: 'pending' })]);
    await r.surface.refresh(); expect(r.surface.render().match(/data-act="reminders-again"/g)).toHaveLength(2);
    r.surface.handleAction('reminders-again', r.target('clock')); r.surface.handleAction('reminders-again', r.target('pending'));
    r.surface.handleAction('reminders-again', r.target('unknown')); expect(r.get).not.toHaveBeenCalled();
    for (const options of [{ noGet: true }, { noCreate: true }]) {
      const old = rig([row('a')], options); await old.surface.refresh();
      expect(old.surface.render()).not.toContain('reminders-again'); old.surface.handleAction('reminders-again', old.target('a'));
      expect(old.get).not.toHaveBeenCalled(); expect(old.create).not.toHaveBeenCalled(); old.surface.dispose();
    }
    r.surface.dispose();
  });

  it('reads fresh wording into a new draft without creating anything or replacing an existing draft', async () => {
    const r = rig(); await r.surface.refresh(); r.get.mockResolvedValueOnce({ reminder: row('a', { text: 'Fresh confirmed wording' }) });
    r.surface.handleAction('reminders-again', r.target('a')); await r.surface.whenLoaded();
    expect(r.get).toHaveBeenCalledExactlyOnceWith({ reminder_id: 'a' }); expect(form.open).toHaveBeenCalledWith(expect.objectContaining({ text: 'Fresh confirmed wording', fromHistory: true, focus: true }));
    expect(r.create).not.toHaveBeenCalled(); expect(r.surface.hasUnsavedChanges()).toBe(true);
    r.surface.handleAction('reminders-again', r.target('b')); expect(r.get).toHaveBeenCalledTimes(1);
    expect(form.open.mock.calls.filter(([initial]) => initial?.text !== undefined)).toHaveLength(1);
    expect(r.surface.render()).toContain('Save or discard your reminder changes'); r.surface.dispose();
  });

  it('reports failed, missing, mismatched and newly managed or pending reads without starting a creation', async () => {
    const r = rig(); await r.surface.refresh(); r.get.mockRejectedValueOnce(new Error('History lookup interrupted'));
    r.surface.handleAction('reminders-again', r.target('a')); await r.surface.whenLoaded();
    expect(r.surface.render()).toContain('History lookup interrupted');
    for (const reminder of [null, row('wrong'), row('a', { state: 'pending' }), row('a', { managed_by: 'clock' })]) {
      r.get.mockResolvedValueOnce({ reminder }); r.surface.handleAction('reminders-again', r.target('a')); await r.surface.whenLoaded();
      expect(r.surface.render()).toMatch(/could not be confirmed|no longer available to reuse/);
    }
    expect(form.open).not.toHaveBeenCalled(); expect(r.create).not.toHaveBeenCalled(); expect(r.surface.isBusy()).toBe(false); r.surface.dispose();
  });

  it('drops a retired lookup after leaving, even when a newer reminder draft is already open', async () => {
    const r = rig(); await r.surface.refresh();
    let release!: (out: { reminder: ReminderView | null }) => void;
    r.get.mockImplementationOnce(() => new Promise(done => { release = done; }));
    r.surface.handleAction('reminders-again', r.target('a')); const older = r.surface.whenLoaded();
    expect(r.surface.beforeLeave()).toBe(true); expect(r.surface.render()).not.toContain('Checking reminder…');
    r.surface.handleAction('reminders-again', r.target('b')); await r.surface.whenLoaded();
    release({ reminder: row('a') }); await older;
    expect(form.open.mock.calls.filter(([initial]) => initial?.text !== undefined)).toHaveLength(1);
    expect(form.open).toHaveBeenCalledWith(expect.objectContaining({ text: 'Follow up b' })); expect(r.create).not.toHaveBeenCalled(); r.surface.dispose();
  });

  it('retires reads on refresh, another detail, a normal creation, and disposal', async () => {
    for (const action of ['refresh', 'detail', 'create', 'dispose'] as const) {
      form.active = false; form.open.mockClear();
      const r = rig(); await r.surface.refresh(); let release!: (out: { reminder: ReminderView }) => void;
      r.get.mockImplementationOnce(() => new Promise(done => { release = done; }));
      r.surface.handleAction('reminders-again', r.target('a')); const older = r.surface.whenLoaded();
      if (action === 'refresh') await r.surface.refresh();
      else if (action === 'detail') { r.surface.open('b'); await r.surface.whenLoaded(); }
      else if (action === 'create') r.surface.handleAction('reminders-create', r.target());
      else r.surface.dispose();
      const paints = r.render.mock.calls.length; release({ reminder: row('a') }); await older;
      expect(r.render).toHaveBeenCalledTimes(paints); expect(form.open.mock.calls.filter(([initial]) => initial?.text !== undefined)).toHaveLength(0);
      expect(r.create).not.toHaveBeenCalled(); r.surface.dispose();
    }
  });

  it('keeps a typed filter and its focus when the checked wording arrives', async () => {
    const r = rig(); await r.surface.refresh(); let release!: (out: { reminder: ReminderView }) => void;
    r.get.mockImplementationOnce(() => new Promise(done => { release = done; }));
    r.surface.handleAction('reminders-again', r.target('a')); const pending = r.surface.whenLoaded();
    const query = r.target('', { 'data-recued-reminders-field': 'query', 'data-recued-reminders-focus': 'query' });
    Object.assign(query, { value: 'Keep my query' }); r.doc.activeElement = query; r.surface.handleInput(query);
    release({ reminder: row('a') }); await pending;
    expect(form.open).toHaveBeenCalledWith(expect.objectContaining({ text: 'Follow up a', focus: false }));
    expect(r.surface.render()).toContain('value="Keep my query"'); expect(r.doc.activeElement).toBe(query); r.surface.dispose();
  });

  it('returns Cancel to its original action or closed history and starts the next normal draft without copied wording', async () => {
    const r = rig(); await r.surface.refresh(); r.surface.handleAction('reminders-history-toggle', r.target());
    r.surface.handleAction('reminders-again', r.target('a')); await r.surface.whenLoaded();
    r.doc.activeElement = r.target(); form.active = false; form.close!(); let focused = '';
    const root = { querySelector: (selector: string) => {
      const key = /data-recued-reminders-focus="([^"]+)"/.exec(selector)?.[1];
      return key ? { focus: () => { focused = key; }, getAttribute: () => key } : null;
    } } as unknown as ParentNode;
    r.surface.restoreFocus(root, null); expect(focused).toBe('again:a');
    r.surface.handleAction('reminders-create', r.target()); expect(form.open.mock.calls.at(-1)).toEqual([undefined]);
    form.active = false; form.close!(); r.surface.handleAction('reminders-again', r.target('a')); await r.surface.whenLoaded();
    r.surface.handleAction('reminders-history-toggle', r.target()); form.active = false; form.close!();
    r.surface.restoreFocus(root, null); expect(focused).toBe('history'); r.surface.dispose();
  });
});
