import { expect, it, vi } from 'vitest';
import { MAIL_DRAFT_BRIEF_MAX, type ContactRecord, type WorkEntity, type WorkEntityProjectAttentionRpcResponse } from '@recued/contracts';
import { createProjectCommunication, projectStatusEmailBrief } from '../project-communication.js';
import { selectedRecordsWire, readSelectedRecordsWire } from '../../chat/selected-records.js';

type Project = Extract<WorkEntity, { _kind: 'project' }>;
const project: Project = { _kind: 'project', id: 'p/二?', title: 'Release <team>', state: 'active', related_contact_ids: ['person-a', 'person-b'],
  source_id: 'recued.project', created_at: 1, updated_at: 1, last_seen_at: 1, last_activity_at: 1, conflict_policy: 'recued_wins', sync_state: 'live' };
const person: ContactRecord = { _id: 'person-a', _collection: 'contact', contact_id: 'person-a', name: 'Riley <team>', email: 'riley@example.test',
  source: 'manual', created_at: 2, updated_at: 2, first_seen: 2, last_interaction: 2, interaction_count: 0 };
const attention = (p = project): WorkEntityProjectAttentionRpcResponse => ({ project: structuredClone(p), as_of: 1_800_000_000_000, checked_at: 1_800_000_000_000,
  time_zone: 'America/Los_Angeles', upcoming_before: 1_800_600_000_000, counts: { open_tasks: 12, completed_tasks: 3, overdue_tasks: 5, due_soon_tasks: 2, blocking_commitments: 1 },
  coverage: { issues: [{ kind: 'task', source_label: 'Vendor', reason: 'incomplete' }], omitted: 0 }, items: [], offset: 0, total: 0, more: false });
const hold = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const setup = () => {
  let current = structuredClone(project), active = true, blocked = false;
  const summary = vi.fn(async () => attention(current)), contact = vi.fn(async ({ email }: { email: string }) => ({ contact: email === 'person-a' ? { ...person } : { ...person, contact_id: 'person-b', email: 'sam@example.test', name: 'Sam' } }));
  const get = vi.fn(async () => ({ entity: current }));
  const openMail = vi.fn<Parameters<typeof createProjectCommunication>[0]['openMail']>(async () => ({ opened: true })), openChat = vi.fn();
  const focus = vi.fn(), beforeLeave = vi.fn(() => true), changed = vi.fn();
  const model = createProjectCommunication({ project: () => current, active: () => active, blocked: () => blocked, beforeLeave, get, contact, summary, openMail, openChat,
    href: () => 'https://app.test/recued/?token=private', changed, focus, focused: () => true });
  return { model, summary, contact, get, openMail, openChat, beforeLeave, focus, changed, leave: () => { active = false; }, block: (value = true) => { blocked = value; }, update: (p: Partial<Project>) => { current = { ...current, ...p }; } };
};

it('requires a chosen linked person and refreshes complete saved facts before opening the existing AI composer', async () => {
  const f = setup(); await f.model.prepareMail(); expect(f.model.view().selected).toBe(''); expect(f.model.view().choices).toHaveLength(2);
  await f.model.draft(); expect(f.openMail).not.toHaveBeenCalled(); f.model.choose('invented'); expect(f.model.view().selected).toBe('');
  f.model.choose('person-a'); const reply = attention(); reply.counts.open_tasks = 11; reply.counts.completed_tasks = 4;
  reply.project.source_extension_blob = { secret: 'do-not-copy' }; f.summary.mockResolvedValueOnce(reply); await f.model.draft();
  expect(f.openMail).toHaveBeenCalledOnce(); const request = f.openMail.mock.calls[0]![0]; expect(request.to).toEqual([person.email]); expect(request.focusAi).toBe(true);
  expect(request.brief).toContain('11 open, 4 completed'); expect(request.brief).toContain('Vendor: saved coverage is incomplete'); expect(request.brief).not.toMatch(/do-not-copy|p\/二\?|person-a/);
  expect(f.contact).toHaveBeenLastCalledWith({ email: 'person-a' }); request.onClosed('held'); expect(f.model.view().notice).toContain('waiting for approval'); expect(f.focus).toHaveBeenLastCalledWith('project-mail');
});

it('refuses a changed email, replaced contact or removed project link before opening mail', async () => {
  for (const change of ['email', 'contact', 'link'] as const) {
    const f = setup(); await f.model.prepareMail(); f.model.choose('person-a');
    if (change === 'email') f.contact.mockResolvedValueOnce({ contact: { ...person, email: 'changed@example.test' } });
    if (change === 'contact') f.contact.mockResolvedValueOnce({ contact: { ...person, created_at: 99 } });
    if (change === 'link') f.update({ related_contact_ids: ['person-b'] });
    await f.model.draft(); expect(f.openMail, change).not.toHaveBeenCalled(); expect(f.model.view().error, change).toMatch(/changed|same identity|no longer linked/);
  }
});

it('keeps unavailable contacts explicit and allows a merged contact only after its canonical person is shown and chosen', async () => {
  const f = setup(); f.update({ related_contact_ids: ['person-a'] }); f.contact.mockRejectedValueOnce(new Error('Contact read interrupted'));
  await f.model.prepareMail(); expect(f.model.view().choices[0]).toMatchObject({ reason: 'Contact read interrupted' }); expect(f.model.view().choices[0]?.email).toBeUndefined();
  f.update({ related_contact_ids: ['old@example.test'] }); f.contact.mockImplementation(async ({ email }) => ({ contact: email === 'old@example.test' ? { ...person, email, merged_into: 'riley@example.test' } : { ...person } }));
  await f.model.prepareMail(); expect(f.model.view().choices[0]).toMatchObject({ email: person.email, merged: true }); expect(f.model.view().selected).toBe('');
  f.model.choose('old@example.test'); await f.model.draft(); expect(f.openMail).toHaveBeenCalledOnce();
});

it('requires fresh confirmed project identity and refuses pending or unavailable facts', async () => {
  for (const change of [{ created_at: 99 }, { pending_write: { staged_at: 1, operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } }, { sync_state: 'stale_unreachable' }] satisfies Partial<Project>[]) {
    const f = setup(); f.summary.mockResolvedValueOnce(attention({ ...project, ...change })); await f.model.prepareMail();
    expect(f.model.view().error).toMatch(/removed or replaced|source and pending/); expect(f.contact).not.toHaveBeenCalled(); expect(f.openMail).not.toHaveBeenCalled();
  }
  const f = setup(); f.summary.mockRejectedValueOnce(new Error('Summary interrupted')); await f.model.prepareMail(); expect(f.model.view().error).toBe('Summary interrupted'); expect(f.openMail).not.toHaveBeenCalled();
});

it('retires delayed contacts and saved-fact reads on leaving or cancelling the recipient choice', async () => {
  const f = setup(), pending = hold<WorkEntityProjectAttentionRpcResponse>(); f.summary.mockReturnValueOnce(pending.promise); const reading = f.model.prepareMail();
  f.leave(); pending.resolve(attention()); await reading; expect(f.contact).not.toHaveBeenCalled(); expect(f.openMail).not.toHaveBeenCalled();
  const g = setup(), personRead = hold<{ contact: ContactRecord }>(); g.contact.mockReturnValueOnce(personRead.promise); const choosing = g.model.prepareMail();
  await vi.waitFor(() => expect(g.contact).toHaveBeenCalled()); g.model.close(); personRead.resolve({ contact: person }); await choosing;
  expect(g.model.view().chooser).toBe(false); expect(g.model.view().choices).toEqual([]);
});

it('rechecks the existing-draft guard after the fresh facts arrive and propagates mailbox refusal', async () => {
  const f = setup(); await f.model.prepareMail(); f.model.choose('person-a'); const pending = hold<WorkEntityProjectAttentionRpcResponse>(); f.summary.mockReturnValueOnce(pending.promise);
  const opening = f.model.draft(); f.beforeLeave.mockReturnValue(false); pending.resolve(attention()); await opening; expect(f.openMail).not.toHaveBeenCalled();
  f.beforeLeave.mockReturnValue(true); f.openMail.mockResolvedValueOnce({ opened: false, error: 'Your mailboxes are read-only.' }); await f.model.draft(); expect(f.model.view().error).toContain('read-only');
});

it('hands Chat an exact project reference that survives selected-record serialization without private contents', async () => {
  const f = setup(); await f.model.ask(); expect(f.openChat).toHaveBeenCalledOnce(); const record = f.openChat.mock.calls[0]![0];
  expect(record.reference.identity).toBe(JSON.stringify(['project', project.id, project.source_id, null, project.created_at]));
  const wire = selectedRecordsWire([record]), parsed = readSelectedRecordsWire(wire)!; expect(parsed[0]!.reference.target).toMatchObject({ tab: 'project', id: project.id });
  expect(wire).not.toContain('private'); f.get.mockResolvedValueOnce({ entity: { ...project, created_at: 99 } }); await f.model.ask();
  expect(f.openChat).toHaveBeenCalledOnce(); expect(f.model.view().chat.error).toContain('removed or replaced');
});

it('rejects an oversized brief without silently dropping coverage facts', () => {
  const reply = attention(); reply.project.description = 'private-description'; expect(projectStatusEmailBrief(reply, person)).not.toContain('private-description');
  reply.project.title = 'x'.repeat(MAIL_DRAFT_BRIEF_MAX); expect(() => projectStatusEmailBrief(reply, person)).toThrow('too long');
});

it('retires a delayed Chat check when another project action blocks it, and permits a fresh attempt later', async () => {
  const f = setup(), wait = hold<{ entity: Project }>(); f.get.mockReturnValueOnce(wait.promise);
  const checking = f.model.ask(); f.block(); wait.resolve({ entity: structuredClone(project) }); await checking;
  expect(f.openChat).not.toHaveBeenCalled(); f.block(false); expect(f.model.busy()).toBe(false);
  await f.model.ask(); expect(f.openChat).toHaveBeenCalledOnce();
});
