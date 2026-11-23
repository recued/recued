import { expect, it, vi } from 'vitest';
import type { WorkEntity, SourceRegistration, ContactRecord, WorkEntityGetRpcResponse, WorkEntityUpsertRpcRequest } from '@recued/contracts';
import { createNoteBulkActions } from '../note-bulk-actions.js';

type Note = Extract<WorkEntity, { _kind: 'note' }>;
const source: SourceRegistration = { id: 'notes', top_tier_kind: 'note', source_kind: 'builtin', source_label: 'Notes', write_capable: true, registered_at: 1 };
const projectSource: SourceRegistration = { ...source, id: 'projects', top_tier_kind: 'project' };
const note = (id: string, extra: Partial<Note> = {}): Note => ({ _kind: 'note', id, source_id: 'notes', title: id, body: 'Original body\r\n', created_at: 1, updated_at: 1,
  last_seen_at: 1, last_user_action_at: 1, sync_state: 'live', conflict_policy: 'recued_wins', related_project_ids: ['keep'], related_contact_ids: ['other'], related_calendar_event_ids: ['event'], related_mail_thread_ids: ['thread'], ...extra });
const project: Extract<WorkEntity, { _kind: 'project' }> = { _kind: 'project', id: 'target', title: 'Target project', last_activity_at: 1, source_id: 'projects', state: 'active', created_at: 1, updated_at: 1,
  last_seen_at: 1, sync_state: 'live', conflict_policy: 'recued_wins', related_contact_ids: [] };
const person = { email: 'riley@example.test', name: 'Riley', contact_id: 'contact-stable', created_at: 1 } as ContactRecord;
const setup = (initial = [note('a'), note('b')]) => {
  const saved = new Map(initial.map(n => [n.id, n])), versions = new Map(initial.map(n => [n.id, 1]));
  let target = project;
  const sources = [source, projectSource], token = (id: string) => String(versions.get(id) ?? 1).padStart(64, '0');
  const get = vi.fn(async ({ kind, id }: { kind: string; id: string }): Promise<WorkEntityGetRpcResponse> => ({ entity: kind === 'project' ? target : saved.get(id) ?? null, note_edit_revision: token(id) }));
  const update = vi.fn(async (args: WorkEntityUpsertRpcRequest) => {
    if (args.kind !== 'note' || !('id' in args) || !args.id) throw new Error('Unexpected write');
    expect(args.expected_revision).toBe(token(args.id));
    const n = { ...saved.get(args.id)!, ...args }; saved.set(args.id, n); versions.set(args.id, (versions.get(args.id) ?? 1) + 1);
    return { entity: n };
  });
  const ui = createNoteBulkActions({ rows: () => [...saved.values()], sources: () => sources, ready: () => true,
    get, update, listSources: async () => ({ sources }), contactGet: async () => ({ contact: person }),
    render: vi.fn(), begin: vi.fn(), confirmed: vi.fn(), settled: vi.fn() });
  const preview = async (kind = 'project', remove = false) => {
    ui.handleAction('note-bulk-all');
    if (kind === 'project') ui.setProject({ id: 'target', label: 'Search presentation' }); else ui.setContact({ id: person.email, label: 'Search presentation' });
    ui.handleAction(`note-bulk-${kind}-${remove ? 'remove' : 'add'}`); await ui.whenSettled();
  };
  return { ui, saved, versions, get, update, preview, sources, target: (value: typeof project) => { target = value; } };
};

it('bounds selection to eligible loaded rows and retains explicit read-only and pending reasons', () => {
  const f = setup([note('read-only', { source_id: 'read-only' }), note('read-through', { source_id: 'read-through' }),
    note('pending', { pending_write: { state: 'awaiting_verify', operation: 'update', staged_at: 1, dirty_fields: ['body'] } }), ...Array.from({ length: 103 }, (_, i) => note(String(i)))]);
  f.sources.push({ ...source, id: 'read-only', write_capable: false }, { ...source, id: 'read-through', sync_posture: 'read_through' });
  f.ui.handleAction('note-bulk-all');
  const selected = f.ui.selection(); expect(selected.selected_ids.size).toBe(100);
  expect(selected.unavailable.get('read-only')).toContain('read-only'); expect(selected.unavailable.get('read-through')).toContain('read-only'); expect(selected.unavailable.get('pending')).toContain('confirmation');
  expect(f.update).not.toHaveBeenCalled();
});

it('requires review and sends only the chosen link array with its reviewed revision', async () => {
  const f = setup(); await f.preview(); expect(f.update).not.toHaveBeenCalled();
  expect(f.ui.snapshot().map(r => r.state)).toEqual(['ready', 'ready']);
  f.ui.handleAction('note-bulk-apply'); await f.ui.whenSettled();
  expect(f.update.mock.calls.map(([args]) => args)).toEqual(['a', 'b'].map(id => ({ kind: 'note', id, expected_revision: '1'.padStart(64, '0'), related_project_ids: ['keep', 'target'] })));
  expect(f.saved.get('a')).toMatchObject({ body: 'Original body\r\n', related_contact_ids: ['other'], related_calendar_event_ids: ['event'], related_mail_thread_ids: ['thread'] });
  expect(f.ui.selection().selected_ids.size).toBe(0);
});

it('removes only the chosen contact and its canonical alias, retaining other relationships in order', async () => {
  const f = setup([note('a', { related_contact_ids: ['other', person.email, 'third', person.contact_id!] })]); await f.preview('contact', true);
  f.ui.handleAction('note-bulk-apply'); await f.ui.whenSettled();
  expect(f.update).toHaveBeenCalledWith({ kind: 'note', id: 'a', expected_revision: '1'.padStart(64, '0'), related_contact_ids: ['other', 'third'] });
  expect(f.saved.get('a')?.related_project_ids).toEqual(['keep']);
});

it('skips a note changed since review and a project whose ID was reused', async () => {
  const f = setup(); await f.preview(); f.versions.set('a', 2);
  f.ui.handleAction('note-bulk-apply'); await f.ui.whenSettled();
  expect(f.ui.snapshot().map(r => r.state)).toEqual(['skipped', 'confirmed']);
  expect(f.update.mock.calls.map(([args]) => 'id' in args ? args.id : undefined)).toEqual(['b']); expect([...f.ui.selection().selected_ids]).toEqual(['a']);
  f.ui.handleAction('note-bulk-back'); f.ui.setProject({ id: 'target', label: 'Target project' }); f.ui.handleAction('note-bulk-project-add'); await f.ui.whenSettled();
  f.target({ ...project, created_at: 2 }); f.ui.handleAction('note-bulk-apply'); await f.ui.whenSettled();
  expect(f.ui.snapshot()[0]?.state).toBe('skipped'); expect(f.update).toHaveBeenCalledTimes(1);
});

it('reconciles a lost acknowledgement by reading the requested state without writing again', async () => {
  const f = setup([note('a')]); await f.preview(); const actual = f.update.getMockImplementation()!;
  f.update.mockImplementationOnce(async input => { await actual(input); throw new Error('Reply lost'); });
  f.ui.handleAction('note-bulk-apply'); await f.ui.whenSettled(); expect(f.ui.snapshot()[0]?.state).toBe('failed');
  f.ui.handleAction('note-bulk-retry'); await f.ui.whenSettled();
  expect(f.ui.snapshot()[0]?.state).toBe('confirmed'); expect(f.update).toHaveBeenCalledTimes(1); expect(f.ui.selection().selected_ids.size).toBe(0);
});

it('retries only failures and does not duplicate existing contact links', async () => {
  const f = setup([note('a', { related_contact_ids: [person.email] }), note('b'), note('c')]); await f.preview('contact');
  f.update.mockImplementationOnce(async () => { throw new Error('Interrupted before write'); });
  f.ui.handleAction('note-bulk-apply'); await f.ui.whenSettled();
  expect(f.ui.snapshot().map(r => r.state)).toEqual(['unchanged', 'failed', 'confirmed']);
  f.ui.handleAction('note-bulk-retry'); await f.ui.whenSettled();
  expect(f.update.mock.calls.map(([args]) => 'id' in args ? args.id : undefined)).toEqual(['b', 'c', 'b']);
  expect(f.saved.get('a')?.related_contact_ids).toEqual([person.email]); expect(f.ui.selection().selected_ids.size).toBe(0);
});

it('retires late preview reads on reset and refuses a server without conditional-note revisions', async () => {
  const f = setup([note('a')]); let release: (() => void) | undefined;
  f.get.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); return { entity: project, note_edit_revision: '1'.padStart(64, '0') }; });
  f.ui.handleAction('note-bulk-all'); f.ui.setProject({ id: 'target', label: 'Target' }); f.ui.handleAction('note-bulk-project-add');
  await vi.waitFor(() => expect(release).toBeDefined()); f.ui.reset(); release!(); await f.ui.whenSettled(); expect(f.ui.snapshot()).toEqual([]); expect(f.ui.selection().selected_ids.size).toBe(0);
  const actual = f.get.getMockImplementation()!;
  f.get.mockImplementation(async args => ({ ...await actual(args), note_edit_revision: undefined }));
  await f.preview(); expect(f.ui.snapshot()[0]?.state).toBe('skipped'); f.ui.handleAction('note-bulk-apply'); await f.ui.whenSettled(); expect(f.update).not.toHaveBeenCalled();
});
