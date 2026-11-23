import { expect, it, vi } from 'vitest';
import type { Commitment, ContactRecord, WorkEntity } from '@recued/contracts';
import type { createMailMessageSurface } from '../mail-message-surface.js';
import { canDraftCommitmentFollowUp, commitmentFollowUpBrief, createCommitmentFollowUp, requireFollowUpCommitment } from '../commitment-follow-up.js';

type OpenRequest = Parameters<ReturnType<typeof createMailMessageSurface>['openCreate']>[0];

const promise: Commitment = { id: 'promise-one', statement: 'Send the proposal <team>', direction: 'outbound',
  source_id: 'recued.commitment', source_record_id: 'native-one', created_at: 1, updated_at: 1, last_seen_at: 1,
  state_changed_at: 1, lifecycle_changed_at: 1, due_status_changed_at: 1, sync_state: 'live', conflict_policy: 'recued_wins', promised_at: 1,
  promised_for_at: Date.parse('2026-11-21T19:30:00Z'), lifecycle_state: 'pending', due_status: 'not_due',
  expiry_policy: 'indefinite', derivation: 'user_declared', counterparty_contact_id: 'contact-one', blocks_task_ids: [], blocks_project_ids: [] };
const contact: ContactRecord = { _id: 'contact-one', _collection: 'contact', contact_id: 'contact-one', email: 'riley@example.test',
  name: 'Riley <team>', source: 'manual', created_at: 1, first_seen: 1, last_interaction: 1, interaction_count: 0, updated_at: 1 };
const entity = (value: Commitment): WorkEntity => ({ ...value, _kind: 'commitment' });

it('quotes saved facts with explicit direction and preserves timed and date-only deadlines', () => {
  const original = structuredClone(promise), brief = commitmentFollowUpBrief(promise, contact);
  expect(JSON.parse(brief.split('Commitment context:\n')[1]!)).toEqual({ contact: contact.name, email: contact.email,
    statement: promise.statement, direction: 'I owe them', deadline: '2026-11-21T19:30:00.000Z' });
  const inbound = commitmentFollowUpBrief({ ...promise, direction: 'inbound', promised_for_at: Date.parse('2026-11-21T00:00:00Z') }, contact);
  expect(JSON.parse(inbound.split('Commitment context:\n')[1]!)).toMatchObject({ direction: 'They owe me', deadline: '2026-11-21' });
  expect(commitmentFollowUpBrief({ ...promise, promised_for_at: undefined }, contact)).toContain('No deadline');
  expect(promise).toEqual(original);
});

it('requires an open external promise and rejects changed identity or changed drafting facts', () => {
  expect(canDraftCommitmentFollowUp(promise)).toBe(true);
  for (const patch of [{ lifecycle_state: 'fulfilled' }, { lifecycle_state: 'cancelled' }, { lifecycle_state: 'expired' },
    { direction: 'internal' }, { counterparty_contact_id: undefined }, { sync_state: 'tombstoned' },
    { sync_state: 'orphaned' }, { sync_state: 'stale_unreachable' }, { deleted_at: 2 }]) {
    expect(canDraftCommitmentFollowUp({ ...promise, ...patch } as Commitment)).toBe(false);
  }
  for (const patch of [{ id: 'reused' }, { created_at: 2 }, { source_id: 'other' }, { source_record_id: 'new' },
    { statement: 'Changed' }, { direction: 'inbound' }, { counterparty_contact_id: 'other' }, { promised_for_at: undefined }]) {
    expect(() => requireFollowUpCommitment(promise, { ...promise, ...patch } as Commitment)).toThrow('Reopen it');
  }
  expect(() => requireFollowUpCommitment(promise, null)).toThrow('Reopen it');
  expect(requireFollowUpCommitment(promise, { ...promise, updated_at: 2 })).toMatchObject({ id: promise.id });
});

const fixture = () => {
  let current = true, person: ContactRecord | null = contact, work: Commitment | null = promise;
  const open = vi.fn(async (_request: OpenRequest) => ({ opened: true })), render = vi.fn(), focus = vi.fn();
  const flow = createCommitmentFollowUp({ get: async () => ({ entity: work && entity(work) }),
    contact: async () => ({ contact: person }), open, render, focus });
  flow.bind(promise, () => current);
  return { flow, open, render, focus, person: (value: ContactRecord | null) => { person = value; },
    work: (value: Commitment | null) => { work = value; }, leave: () => { current = false; } };
};

it('rechecks the person and promise before opening and passes an editable brief without executing mail', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.flow.view(promise)?.busy).toBeUndefined());
  await f.flow.draft();
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.open.mock.calls[0]?.[0]).toMatchObject({ to: [contact.email], focusAi: true, brief: commitmentFollowUpBrief(promise, contact),
    contactContext: { id: contact.contact_id, name: contact.name, email: contact.email } });
});

it('rejects a deleted, merged, replaced or newly addressed contact and changed promise before opening mail', async () => {
  for (const person of [null, { ...contact, merged_into: 'other@example.test' }, { ...contact, contact_id: 'reused' },
    { ...contact, created_at: 2 }, { ...contact, email: 'new@example.test' }, { ...contact, email: 'mention:test' }]) {
    const f = fixture(); await vi.waitFor(() => expect(f.flow.view(promise)?.busy).toBeUndefined());
    f.person(person); await f.flow.draft(); expect(f.open).not.toHaveBeenCalled(); expect(f.flow.view(promise)?.error).toBeTruthy();
  }
  const f = fixture(); await vi.waitFor(() => expect(f.flow.view(promise)?.busy).toBeUndefined());
  f.work({ ...promise, statement: 'Changed remotely' }); await f.flow.draft(); expect(f.open).not.toHaveBeenCalled();
});

it('retires a pending contact check when its reader is left', async () => {
  let complete!: (value: { contact: ContactRecord }) => void, current = true;
  const open = vi.fn(async (_request: OpenRequest) => ({ opened: true })), render = vi.fn();
  const flow = createCommitmentFollowUp({ get: async () => ({ entity: entity(promise) }),
    contact: () => new Promise(done => { complete = done; }), open, render, focus: vi.fn() });
  flow.bind(promise, () => current); current = false; complete({ contact });
  await Promise.resolve(); await Promise.resolve(); await flow.draft();
  expect(flow.view(promise)).toBeUndefined(); expect(open).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
});
