import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RecipeDefinition, RecordsSchemaSnapshot } from '@recued/contracts';
import WebSocket from 'ws';
import { startServer } from '../server.js';
import { createLocalUpdateUndoStore } from '../storage/local-update-undo-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { parseLocalUndoDecision, parseLocalUndoReceipt } from '../local-update-undo.js';
import { resourceFixture, resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createLocalCalendarProvider } from '../collections/calendar/local-provider.js';
import { createLocalUpdateUndo } from '../local-update-undo.js';
import { createPreapprovalWorkers } from '../storage/preapproval-workers.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
export const undoBatchStep = (): RecipeDefinition['steps'][number] => ({ id: 'batch', ingredient: recordsManifest.slug,
  input: { operation: 'batch', args: { ops: [
    { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'First a' } } },
    { entity: 'note', action: 'update', args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Edited b' } } },
    { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 1, set: { title: 'Final a' } } },
  ] } } });
const land = async (f: Fixture, steps: RecipeDefinition['steps']) => {
  f.save(steps); const prepared = await f.service.prepare(f.request(), f.origin);
  await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
  expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: true });
  const inspection = await f.storage.repository.inspect(prepared.proposal_id);
  const receipt = inspection.members[0]!.local_receipt!;
  expect(receipt).toBeDefined(); return receipt;
};
const undo = (f: Fixture) => f.composed.handlers.localUndo!;
const approve = (review: { undo_id: string; review_hash: string }) => ({ undo_id: review.undo_id, review_hash: review.review_hash, decision: 'approve' as const });

describe('reviewed undo of confirmed local updates', () => {
  it.each(['records', 'calendar', 'batch'] as const)('requires a new decision and links one reverse receipt for %s across restart', async kind => {
    const first = await resourceFixture();
    const receipt = await land(first, [kind === 'records' ? recordStep('a') : kind === 'calendar' ? calendarStep() : undoBatchStep()]);
    const review = await undo(first).review(receipt.receipt_id, first.origin);
    expect(undo(first).get(receipt.receipt_id, first.origin)).toBeNull();
    expect(review.resource_review.resources[0]!.after).toMatchObject(kind === 'calendar' ? { summary: 'Original meeting' } : { title: 'a' });
    if (kind === 'calendar') expect(first.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
    else expect(first.row('a')!.title).toBe(kind === 'batch' ? 'Final a' : 'Reviewed a');
    const f = await first.reopen();
    const result = await undo(f).decide(approve(review), f.origin);
    expect(result).toMatchObject({ status: 'completed', predecessor_receipt_id: receipt.receipt_id,
      local_receipt: { kind: receipt.kind } });
    expect(Object.keys(result.local_receipt!).sort()).toEqual(['committed_at', 'kind', 'receipt_id']);
    if (kind === 'calendar') expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    else {
      expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: kind === 'batch' ? 4 : 2 } });
      if (kind === 'batch') expect(f.row('b')).toMatchObject({ title: 'b', _record: { revision: 2 } });
    }
    const count = f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get();
    expect(await undo(f).decide(approve(review), f.origin)).toEqual(result);
    expect(undo(f).get(receipt.receipt_id, f.origin)).toEqual(result);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(count);
    await expect(undo(f).review(receipt.receipt_id, f.origin)).rejects.toMatchObject({ code: 'local_undo_conflict' });
    await expect(undo(f).review(result.local_receipt!.receipt_id, f.origin)).rejects.toMatchObject({ code: 'local_undo_unavailable' });
  });

  it.each(['ordinary', 'chat'] as const)('captures the same encrypted inverse from %s local receipts', async kind => {
    const f = await ordinaryLocalFixture();
    let receiptId: string;
    if (kind === 'chat') {
      const chat = await f.chat(); await chat.dispatch('execute');
      const execution = (await chat.plans.listForSession!(chat.session_id))[0]!.execution!;
      if (execution.status !== 'completed' || !execution.local_receipt) throw new Error('Missing local confirmation');
      receiptId = execution.local_receipt.receipt_id;
    } else {
      const held = await f.hold([recordStep('a')]); await held.resume();
      receiptId = (await f.execution.gatedActionStore!.get(held.action.action_ref))!.local_receipt!.receipt_id;
    }
    const review = await undo(f).review(receiptId, f.origin);
    expect(await undo(f).decide(approve(review), f.origin)).toMatchObject({ status: 'completed' });
    if (kind === 'chat') expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    else expect(f.row('a')!.title).toBe('a');
  });

  it('restores a missing Calendar optional field without changing identity or untouched fields', async () => {
    const f = await resourceFixture(); const original = f.calendar.table.get('meeting')!.event;
    expect(Object.hasOwn(original, 'location')).toBe(false);
    const step = { id: 'edit', ingredient: 'calendar-update', input: { slug: 'local', source_id: 'meeting',
      patch: { location: 'New room', summary: 'Changed summary' } } };
    const receipt = await land(f, [step]); const review = await undo(f).review(receipt.receipt_id, f.origin);
    expect(review.resource_review.resources[0]!.after).toMatchObject({ location: null, summary: original.summary });
    await undo(f).decide(approve(review), f.origin);
    const restored = f.calendar.table.get('meeting')!.event;
    expect(Object.hasOwn(restored, 'location')).toBe(false);
    const { updated_at: _a, ...before } = original, { updated_at: _b, ...after } = restored;
    expect(after).toEqual(before);
  });

  it('restores exact nested, nullable, decimal, boolean and datetime Records values', async () => {
    const f = await resourceFixture();
    const owner = { publisher: 'core', pack_slug: 'undo-types' };
    const bindings = { create: { ...f.bindings.create, owner }, update: { ...f.bindings.update, owner } };
    const schema: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { note: { kind: 'note', fields: [
      { key: 'id', kind: 'id', slot: 'pk', required: true }, { key: 'title', kind: 'string', slot: 's1', required: true },
      { key: 'detail.label', kind: 'string', slot: 's2', required: false }, { key: 'amount', kind: 'decimal', slot: 'dec1', required: false },
      { key: 'active', kind: 'boolean', slot: 'b1', required: false }, { key: 'due_at', kind: 'datetime', slot: 'dt1', required: false },
      { key: 'note', kind: 'text', slot: 't1', required: false },
    ] } } };
    f.records.installNamespace({ owner, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
      artifact_digest: 'typed-values', schema, bindings });
    f.manifests.register({ ...recordsManifest, slug: owner.pack_slug, surfaces: { records: { schema, executes: bindings } } });
    f.contracts.put('grant', [owner.pack_slug, owner.pack_slug, owner.pack_slug, 'notes.write'], { allowed: true });
    const values = { title: 'Keep this', detail: { label: 'Original label' }, amount: '123456789.1234', active: false,
      due_at: new Date(f.clock.now).toISOString(), note: null };
    f.records.execute({ binding: bindings.create, principal: 'owner', args: { id: 'typed', values } });
    const receipt = await land(f, [{ id: 'typed', ingredient: owner.pack_slug, input: { operation: 'update', args: {
      id: 'typed', expected_version: 1, expected_revision: 0,
      set: { detail: { label: 'Changed' }, amount: '1.0000', active: true, due_at: new Date(f.clock.now + 60_000).toISOString(), note: 'New note' },
    } } }]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    await undo(f).decide(approve(review), f.origin);
    expect(f.records.ownerGet(owner, 'note', 'typed')).toMatchObject({ ...values, _record: { revision: 2 } });
  });

  it('refuses undo while a Records namespace is fenced for replacement', async () => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    f.records.fenceNamespace({ owner: f.owner, expected_activation_generation: f.records.getNamespace(f.owner)!.activation_generation });
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toBeDefined();
    expect(f.row('a')!.title).toBe('Reviewed a');
  });

  it.each(['before_review', 'after_review', 'changed_back', 'replaced'] as const)('refuses stale Records undo (%s)', async when => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const review = when !== 'before_review' ? await undo(f).review(receipt.receipt_id, f.origin) : null;
    if (when === 'replaced') {
      f.records.execute({ binding: f.bindings.delete, principal: 'owner', args: { id: 'a', expected_version: 1, expected_revision: 1 } });
      f.records.execute({ binding: f.bindings.create, principal: 'owner', args: { id: 'a', values: { title: 'Reviewed a' } } });
      f.records.execute({ binding: f.bindings.update, principal: 'owner', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Temporary' } } });
      f.records.execute({ binding: f.bindings.update, principal: 'owner', args: { id: 'a', expected_version: 1, expected_revision: 1, set: { title: 'Reviewed a' } } });
    } else {
      f.records.execute({ binding: f.bindings.update, principal: 'owner', args: { id: 'a', expected_version: 1, expected_revision: 1, set: { title: 'Later edit' } } });
      if (when === 'changed_back') f.records.execute({ binding: f.bindings.update, principal: 'owner',
        args: { id: 'a', expected_version: 1, expected_revision: 2, set: { title: 'Reviewed a' } } });
    }
    const current = f.row('a');
    await expect(review ? undo(f).decide(approve(review), f.origin) : undo(f).review(receipt.receipt_id, f.origin)).rejects.toBeDefined();
    expect(f.row('a')).toEqual(current);
    expect(f.db.prepare('SELECT count(*) FROM local_update_undo_links').pluck().get()).toBe(0);
  });

  it.each(['before_review', 'after_review', 'changed_back', 'replaced', 'account', 'instance_replaced'] as const)('refuses stale Calendar undo (%s)', async when => {
    const f = await resourceFixture(), receipt = await land(f, [calendarStep()]);
    const review = when !== 'before_review' ? await undo(f).review(receipt.receipt_id, f.origin) : null;
    const row = f.calendar.table.get('meeting')!;
    if (when === 'account' || when === 'instance_replaced') {
      const instances = createInstanceStore({ db: f.db, now: () => f.clock.now });
      const instance = instances.get('calendar', 'local')!;
      if (when === 'instance_replaced') instances.delete('calendar', 'local');
      createInstanceStore({ db: f.db, now: () => instance.created_at }).upsert({ ...instance,
        config: when === 'account' ? { ...instance.config, account_slug: 'replacement' } : instance.config });
    } else {
      if (when === 'replaced') f.calendar.table.delete('meeting');
      f.calendar.table.upsert({ event: { ...row.event, summary: when === 'replaced' ? row.event.summary : 'Later edit' }, size_bytes: 0 });
      if (when === 'changed_back') f.calendar.table.upsert({ event: row.event, size_bytes: 0 });
    }
    const current = f.calendar.table.get('meeting');
    await expect(review ? undo(f).decide(approve(review), f.origin) : undo(f).review(receipt.receipt_id, f.origin)).rejects.toBeDefined();
    expect(f.calendar.table.get('meeting')).toEqual(current);
  });

  it('rolls back every member of a reverse batch when its receipt fails', async () => {
    const f = await resourceFixture(), receipt = await land(f, [undoBatchStep()]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    f.db.exec("CREATE TRIGGER reject_undo BEFORE INSERT ON local_mutation_receipts WHEN NEW.owner='local_undo' BEGIN SELECT RAISE(ABORT,'receipt rejected'); END");
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toThrow('receipt rejected');
    expect(f.row('a')).toMatchObject({ title: 'Final a', _record: { revision: 2 } });
    expect(f.row('b')).toMatchObject({ title: 'Edited b', _record: { revision: 1 } });
    expect(await undo(f).decide(approve(review), f.origin)).toMatchObject({ status: 'failed' });
  });

  it('preserves a calendar review through routine cursor and polling updates', async () => {
    const first = await resourceFixture(), receipt = await land(first, [calendarStep()]);
    const review = await undo(first).review(receipt.receipt_id, first.origin);
    const instances = createInstanceStore({ db: first.db });
    const instance = instances.get('calendar', 'local')!;
    instances.upsert({ ...instance, config: { ...instance.config, cursor: 'next', poll_interval_ms: 60_000 } });
    instances.updateAuthState('calendar', 'local', { auth_state: 'healthy', last_synced_at: first.clock.now });
    const f = await first.reopen();
    expect(await undo(f).decide(approve(review), f.origin)).toMatchObject({ status: 'completed' });
  });

  it('refuses a replaced manifest and revoked paired token', async () => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    f.manifests.register({ ...recordsManifest, description: 'Replacement' });
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toMatchObject({ code: 'local_undo_conflict' });
    f.manifests.register(recordsManifest);
    f.clients.revoke(f.token.token_id, 'Revoked');
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toMatchObject({ code: 'preapproval_authority_changed' });
    expect(f.row('a')!.title).toBe('Reviewed a');
  });

  it.each(['expiry', 'retention', 'realm'] as const)('expires %s without dispatch', async kind => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    if (kind === 'realm') f.storage.localUndo!.clock.rotateEpoch();
    else f.clock.now += kind === 'expiry' ? 10 * 60_000 : 31 * 24 * 60 * 60_000;
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toBeDefined();
    if (kind !== 'expiry') {
      f.storage.localUndo!.prune();
      undo(f).prune();
      expect(f.db.prepare('SELECT count(*) FROM local_update_inverses').pluck().get()).toBe(0);
      expect(f.db.prepare('SELECT encrypted FROM local_update_undo_reviews').pluck().get()).toBe('');
    }
    expect(f.row('a')!.title).toBe('Reviewed a');
  });

  it('keeps prior values out of metadata and rejects swapped ciphertext', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b')]);
    const first = await land(f, [recordStep('a'), recordStep('b')]);
    const rows = f.db.prepare('SELECT receipt_id,encrypted FROM local_update_inverses ORDER BY receipt_id').all() as { receipt_id: string; encrypted: string }[];
    expect(rows).toHaveLength(2);
    const review = await undo(f).review(first.receipt_id, f.origin);
    const dump = JSON.stringify(f.db.prepare('SELECT * FROM local_update_inverses').all())
      + JSON.stringify(f.db.prepare('SELECT * FROM local_mutation_receipts').all())
      + JSON.stringify(f.db.prepare('SELECT * FROM local_update_undo_reviews').all());
    expect(dump).not.toContain('Reviewed a'); expect(dump).not.toContain('"title"');
    f.db.prepare('UPDATE local_update_inverses SET encrypted=? WHERE receipt_id=?').run(rows[1]!.encrypted, rows[0]!.receipt_id);
    await expect(undo(f).review(rows[0]!.receipt_id, f.origin)).rejects.toMatchObject({ code: 'local_undo_unavailable' });
    expect(review.predecessor_receipt_id).toBe(first.receipt_id);
  });

  it('recovers a completed receipt after prior values expire without dispatching again', async () => {
    const first = await resourceFixture(), receipt = await land(first, [recordStep('a')]);
    const review = await undo(first).review(receipt.receipt_id, first.origin);
    const result = await undo(first).decide(approve(review), first.origin);
    first.clock.now += 31 * 24 * 60 * 60_000;
    const f = await first.reopen();
    undo(f).prune();
    expect(f.db.prepare('SELECT encrypted FROM local_update_undo_reviews').pluck().get()).toBe('');
    expect(await undo(f).decide(approve(review), f.origin)).toEqual(result);
    f.manifests.register({ ...recordsManifest, description: 'Operation changed since completion' });
    f.storage.localUndo!.clock.rotateEpoch();
    expect(undo(f).get(receipt.receipt_id, { ...f.origin, credential_id: 'another-paired-device' })).toEqual(result);
    expect(undo(f).get(receipt.receipt_id, { ...f.origin, owner_id: 'other-realm' })).toBeNull();
    expect(f.row('a')!._record.revision).toBe(2);
  });

  it('rolls the original update back when encrypted capture fails', async () => {
    const f = await resourceFixture();
    const codec = createPreapprovalCodec(() => new Uint8Array(32).fill(1));
    createLocalUpdateUndoStore(f.db, { ...codec, sealSync: () => { throw new Error('Encryption failure'); } }, () => f.clock.now);
    f.save([recordStep('a')]); const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: false });
    expect(f.row('a')!.title).toBe('a'); expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('keeps ordinary writes working without an undo key and never stores a plaintext inverse', async () => {
    const f = await ordinaryLocalFixture();
    createLocalUpdateUndoStore(f.db, createPreapprovalCodec(() => null), () => f.clock.now);
    const held = await f.hold([recordStep('a')]); await held.resume();
    expect(f.row('a')!.title).toBe('Reviewed a');
    const receipt = (await f.execution.gatedActionStore!.get(held.action.action_ref))!.local_receipt!;
    expect(receipt).toBeDefined();
    expect(f.db.prepare('SELECT count(*) FROM local_update_inverses').pluck().get()).toBe(0);
    await expect(undo(f).review(receipt.receipt_id, f.origin)).rejects.toMatchObject({ code: 'local_undo_unavailable' });
  });

  it('requires the paired owner, a matching fresh review and an unchanged decision', async () => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    await expect(undo(f).decide({ ...approve(review), review_hash: 'sha256:' + '0'.repeat(64) }, f.origin)).rejects.toBeDefined();
    await expect(undo(f).decide(approve(review), { ...f.origin, credential_id: 'other' })).rejects.toBeDefined();
    expect(await undo(f).decide({ ...approve(review), decision: 'deny' }, f.origin)).toMatchObject({ status: 'denied' });
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toBeDefined();
    expect(f.row('a')!.title).toBe('Reviewed a');
  });

  it('authenticates the actual owner RPC and refuses CLI and unpaired callers', async () => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed.handlers });
    const sockets: WebSocket[] = [];
    interface Reply { request_id: string; result?: unknown; error?: { code: string } }
    const rpc = (ws: WebSocket, method: string, args: unknown): Promise<Reply> => new Promise((resolve, reject) => {
      const request_id = randomUUID();
      const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('Undo RPC timed out')); }, 5000);
      const receive = (data: WebSocket.RawData): void => {
        const reply = JSON.parse(data.toString()) as Reply;
        if (reply.request_id !== request_id) return;
        clearTimeout(timer); ws.off('message', receive); resolve(reply);
      };
      ws.on('message', receive); ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
    });
    try {
      for (const kind of ['cli', 'unpaired', 'owner'] as const) {
        const token = kind === 'owner' ? f.token : await f.clients.issue({ client_kind: kind === 'cli' ? 'cli' : 'webclient' });
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`);
          sockets.push(socket); socket.once('open', () => resolve(socket)); socket.once('error', reject);
        });
        const read = await rpc(ws, 'local_undo.get', { receipt_id: receipt.receipt_id });
        const reply = await rpc(ws, 'local_undo.review', { receipt_id: receipt.receipt_id });
        if (kind !== 'owner') {
          expect(read).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
          expect(reply).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
        }
        else {
          expect(read).toMatchObject({ result: null });
          expect(reply.error).toBeUndefined();
          const review = reply.result as { undo_id: string; review_hash: string };
          const decided = await rpc(ws, 'local_undo.decide', approve(review));
          expect(decided).toMatchObject({ result: { status: 'completed' } });
          expect((await rpc(ws, 'local_undo.get', { receipt_id: receipt.receipt_id })).result).toEqual(decided.result);
          f.clients.revoke(f.token.token_id, 'Revoked after completion');
          expect(await rpc(ws, 'local_undo.get', { receipt_id: receipt.receipt_id }))
            .toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
        }
      }
    } finally { for (const socket of sockets) socket.terminate(); await server.close(); }
    expect(f.row('a')!.title).toBe('a');
  });

  it('does not offer update undo for a delete or a mixed-action batch', async () => {
    const f = await resourceFixture();
    const receipt = await land(f, [{ id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Edited' } } },
      { entity: 'note', action: 'delete', args: { id: 'b', expected_version: 1, expected_revision: 0 } },
    ] } } }]);
    await expect(undo(f).review(receipt.receipt_id, f.origin)).rejects.toMatchObject({ code: 'local_undo_unavailable' });
  });

  it('deduplicates concurrent approvals and recovers a committed undo after an observer throws', async () => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    f.changed.mockImplementation(() => { throw new Error('Lost caller response'); });
    const results = await Promise.all([undo(f).decide(approve(review), f.origin), undo(f).decide(approve(review), f.origin)]);
    expect(results[0]).toMatchObject({ status: 'completed' }); expect(results[1]).toMatchObject({ status: 'completed' });
    expect(f.row('a')!._record.revision).toBe(2);
    expect(f.db.prepare('SELECT count(*) FROM local_update_undo_links').pluck().get()).toBe(1);
    f.db.prepare("DELETE FROM local_mutation_receipts WHERE owner='local_undo'").run();
    expect(await undo(f).decide(approve(review), f.origin)).toMatchObject({ status: 'unknown' });
    expect(undo(f).get(receipt.receipt_id, f.origin)).toMatchObject({ status: 'unknown' });
  });

  it.each(['link', 'kind', 'review_hash'] as const)('refuses false confirmation from corrupt %s metadata after retention', async kind => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    await undo(f).decide(approve(review), f.origin);
    f.clock.now += 31 * 24 * 60 * 60_000; undo(f).prune();
    if (kind === 'link') f.db.prepare('DELETE FROM local_update_undo_links').run();
    else if (kind === 'kind') f.db.prepare("UPDATE local_update_undo_reviews SET kind='local_calendar'").run();
    else f.db.prepare("UPDATE local_update_undo_reviews SET resource_review_hash=?").run('sha256:' + '0'.repeat(64));
    expect(undo(f).get(receipt.receipt_id, f.origin)).toMatchObject({ status: 'unknown' });
    expect(undo(f).get(receipt.receipt_id, f.origin)?.local_receipt).toBeUndefined();
    expect(f.row('a')!._record.revision).toBe(2);
  });

  it('keeps a completed link visible after another pending preview is declined', async () => {
    const f = await resourceFixture(), receipt = await land(f, [recordStep('a')]);
    const first = await undo(f).review(receipt.receipt_id, f.origin);
    const other = await undo(f).review(receipt.receipt_id, f.origin);
    const result = await undo(f).decide(approve(first), f.origin);
    f.clock.now += 1;
    await undo(f).decide({ ...approve(other), decision: 'deny' }, f.origin);
    expect(undo(f).get(receipt.receipt_id, f.origin)).toEqual(result);
  });

  it('fences a same-timestamp calendar replacement during asynchronous preparation', async () => {
    const f = await resourceFixture(), receipt = await land(f, [calendarStep()]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    const update = createLocalCalendarProvider({ slug: 'local', now: () => f.clock.now,
      readEvent: id => f.calendar.table.get(id)?.event ?? null }).updateEvent!;
    f.calendarUpdates.mockImplementation(async input => {
      const payload = await update(input);
      const instances = createInstanceStore({ db: f.db });
      const instance = instances.get('calendar', 'local')!;
      instances.delete('calendar', 'local');
      createInstanceStore({ db: f.db, now: () => instance.created_at }).upsert(instance);
      return payload;
    });
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toBeDefined();
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
    expect(undo(f).get(receipt.receipt_id, f.origin)).toMatchObject({ status: 'failed' });
  });

  it('rolls back an asynchronous Calendar preparation after the paired token is revoked', async () => {
    const f = await resourceFixture(), receipt = await land(f, [calendarStep()]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    const update = createLocalCalendarProvider({ slug: 'local', now: () => f.clock.now,
      readEvent: id => f.calendar.table.get(id)?.event ?? null }).updateEvent!;
    f.calendarUpdates.mockImplementation(async input => {
      const payload = await update(input); f.clients.revoke(f.token.token_id, 'Revoked while preparing'); return payload;
    });
    await expect(undo(f).decide(approve(review), f.origin)).rejects.toMatchObject({ code: 'preapproval_authority_changed' });
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
  });

  it('preserves a live claim when another local process composes its owner service', async () => {
    const f = await resourceFixture(), receipt = await land(f, [calendarStep()]);
    const review = await undo(f).review(receipt.receipt_id, f.origin);
    const update = createLocalCalendarProvider({ slug: 'local', now: () => f.clock.now,
      readEvent: id => f.calendar.table.get(id)?.event ?? null }).updateEvent!;
    f.calendarUpdates.mockImplementation(async input => {
      createLocalUpdateUndo({ db: f.db, store: f.storage.localUndo!, execution: f.execution,
        workers: createPreapprovalWorkers(f.db), validate: () => {}, now: () => f.clock.now });
      expect(f.db.prepare('SELECT status FROM local_update_undo_reviews WHERE undo_id=?').pluck().get(review.undo_id)).toBe('dispatching');
      return update(input);
    });
    expect(await undo(f).decide(approve(review), f.origin)).toMatchObject({ status: 'completed' });
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
  });

  it('rejects malformed wire payloads', () => {
    expect(() => parseLocalUndoReceipt({ receipt_id: 'lmr_' + randomUUID(), patch: {} })).toThrow();
    expect(() => parseLocalUndoDecision({ undo_id: 'undo_' + randomUUID(), review_hash: 'sha256:' + 'a'.repeat(64), decision: 'approve', source: {} })).toThrow();
  });
});
