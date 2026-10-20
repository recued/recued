import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IngredientError } from '@recued/ingredients';
import { parsePreapprovalReconcile, opGrantEntry, READABLE_COLLECTIONS, collectionGrantEntry, type MailSentReconciliationResult } from '@recued/contracts';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import type { MailProvider } from '../collections/mail/provider.js';
import { resourceFixture, resourceFixtureDisposers, recordStep } from './preapproval-resources-fixture.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import { PREAPPROVAL_MAIL_PREFIX } from '../preapproval-mail-attempt.js';
import { makePreapprovalHandlers } from '../preapproval-handler.js';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
const mailStep = () => ({ id: 'send', ingredient: 'mail-send', input: { sender_mail_instance: 'work', to: ['recipient@example.com'],
  subject: 'Reviewed message', body: 'The exact approved message.' } });
const fixture = async () => {
  const send = vi.fn<NonNullable<MailProvider['send']>>(async () => { throw new Error('Provider reply lost'); });
  const lookup = vi.fn<NonNullable<MailProvider['lookupSentByReconciliationId']>>(async query => ({ status: 'matched',
    match: { proof_kind: 'envelope', source_id: 'provider-record', provider_message_id: '<original@provider>', sent_at: query.sent_after }, scanned_candidates: 1 }));
  const provider: MailProvider = { kind: 'imap', slug: 'work', sendCapable: true, mutationCapable: false, accountEmail: 'sender@example.com',
    connect: async () => {}, initialScan: async () => {}, startSync: async () => async () => {}, close: async () => {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }), send, lookupSentByReconciliationId: lookup };
  const f = await resourceFixture(undefined, { mailProvider: provider });
  f.save([mailStep(), recordStep('b')]);
  const prepare = async (origin: PreapprovalOrigin = f.origin) => {
    const original = await f.service.prepare(f.request(), origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    const before = await f.storage.repository.inspect(original.proposal_id);
    const uncertain = before.members.find(item => item.status === 'in_doubt');expect(uncertain, JSON.stringify(before.members)).toBeDefined();
    f.clock.now += 1_000;
    return { original, before, request: { proposal_id: original.proposal_id, member_id: uncertain!.member_id } };
  };
  const reconcile = f.composed.handlers.reconcile!;
  return { ...f, send, lookup, provider, prepare, reconcile };
};

it('verifies the exact attempted message and prepares only remaining work under a new owner decision', async () => {
  const f = await fixture(), { original, before, request } = await f.prepare();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![0].reconciliation_id).toMatch(/^recued-pa-[a-f0-9]{64}$/);
  expect(before.recovery?.eligible).toBe(false);
  expect(before.members[0]?.provider_verification).toBe('mail');
  const verified = await f.reconcile(request, f.responder);
  expect(verified.status, verified.message).toBe('verified');expect(verified.evidence_id).toMatch(/^pae_/);
  expect(f.lookup).toHaveBeenCalledWith(expect.objectContaining({ reconciliation_id: f.send.mock.calls[0]![0].reconciliation_id,
    recipient: 'recipient@example.com', subject: 'Reviewed message', proof_kind: 'envelope' }));
  expect(verified.inspection.members[0]).toMatchObject({ status: 'in_doubt', reconciled_outcome: 'succeeded' });
  expect(verified.inspection.execution_status).toBe('in_doubt');expect(verified.inspection.recovery?.eligible).toBe(true);
  expect(f.row('b')!.title).toBe('b');expect(f.send).toHaveBeenCalledTimes(1);
  const retry = await f.reconcile(request, f.responder);expect(retry.evidence_id).toBe(verified.evidence_id);expect(f.lookup).toHaveBeenCalledTimes(1);
  const next = await f.service.continuePlan({ proposal_id: original.proposal_id, idempotency_key: randomUUID(),
    activation: { kind: 'one_shot', run_at: f.clock.now + 60_000, time_zone: 'UTC' },
    decision_deadline: f.clock.now + 30_000, dispatch_deadline: f.clock.now + 120_000 }, f.responder);
  const review = await f.storage.repository.review(next.proposal_id, f.responder);
  expect(review.members).toHaveLength(1);expect(review.members[0]?.op_id).toBe('fixture.note.update');
  expect(review.continuation?.completed[0]?.action_ref).toBe(before.members[0]?.action_ref);
  expect(f.row('b')!.title).toBe('b');
  await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
  expect((await f.run(next.future_execution_ref)).success).toBe(true);
  expect(f.row('b')!.title).toBe('Reviewed b');expect(f.send).toHaveBeenCalledTimes(1);
});

for (const scenario of ['permitted', 'bearer-read-missing', 'read-revoked', 'credential-revoked', 'read-revoked-during-check'] as const) it(`keeps original contract read authority: ${scenario}`, async () => {
  const f = await fixture(), operations = ['core.preapproval.request', 'core.schedule.recipe', 'core.mail.send', 'core.mail.email.list', 'fixture.note.update'];
  const contract = f.definitions.mint({ minted_by: 'owner', display_name: 'Original requester', door_types: ['mcp'],
    scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: operations } });
  for (const operation of operations) f.grants.set(contract.contract_id, opGrantEntry(operation), true, f.clock.now);
  for (const collection of READABLE_COLLECTIONS) f.grants.set(contract.contract_id, collectionGrantEntry(collection), true, f.clock.now);
  const credential = f.inbound.issueToken({ value: { label: 'Original token', concurrency_tier: 3, chat_mode: null,
    contract_id: contract.contract_id, grants: { ['core/' + f.recipe.recipe_id]: true,
      ...(scenario !== 'bearer-read-missing' ? { 'core.mail.email.list': true } : {}) } }, now: f.clock.now }).record;
  const origin: PreapprovalOrigin = { mode: 'contract', contract_id: contract.contract_id, entry: 'kernel', credential_id: credential.token_id,
    credential_label: 'Original token', entry_tool_grants: [], entry_raw_op_id: 'core.preapproval.request', recipe_grant_key: null, display_name: 'Original requester',
    source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'assistant', tool_call_id: 'request', mcp_token_id: credential.token_id, contract_id: contract.contract_id } };
  const { request } = await f.prepare(origin);
  if (scenario === 'read-revoked') f.grants.set(contract.contract_id, collectionGrantEntry('mail'), false, f.clock.now);
  if (scenario === 'credential-revoked') f.inbound.revokeToken({ token_id: credential.token_id, now: f.clock.now });
  if (scenario === 'read-revoked-during-check') {
    const implementation = f.lookup.getMockImplementation()!;
    f.lookup.mockImplementation(async query => { const result = await implementation(query);f.grants.set(contract.contract_id, collectionGrantEntry('mail'), false, f.clock.now);return result; });
  }
  if (scenario === 'permitted') expect((await f.reconcile(request, f.responder)).status).toBe('verified');
  else {
    await expect(f.reconcile(request, f.responder)).rejects.toMatchObject({ code: expect.stringMatching(/^preapproval_(authority_changed|stale)$/) });
    expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);
    if (scenario === 'read-revoked-during-check') expect(f.lookup).toHaveBeenCalledTimes(1);else expect(f.lookup).not.toHaveBeenCalled();
  }
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('keeps earlier local successes when verifying a later uncertain mail attempt', async () => {
  const f = await fixture();f.save([recordStep('a'), mailStep(), recordStep('b')]);
  const { request } = await f.prepare();expect(f.row('a')!._record.revision).toBe(1);
  const verified = await f.reconcile(request, f.responder);expect(verified.status).toBe('verified');
  expect(verified.inspection.recovery?.eligible).toBe(true);expect(f.row('b')!.title).toBe('b');
  expect(f.row('a')!._record.revision).toBe(1);expect(f.send).toHaveBeenCalledTimes(1);
});

it('rechecks owner authority after the provider response and before the evidence commit', async () => {
  const f = await fixture(), { request } = await f.prepare();
  const original = f.storage.repository.recordReconciliation.bind(f.storage.repository);
  vi.spyOn(f.storage.repository, 'recordReconciliation').mockImplementation(async (input, guard) => {
    f.clients.revoke(f.token.token_id, 'revoked after provider observation', f.clock.now);return original(input, guard);
  });
  await expect(f.reconcile(request, f.responder)).rejects.toThrow();expect(f.lookup).toHaveBeenCalledTimes(1);
  expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);
});

it('bounds concurrent checks of the same attempt without repeating effects', async () => {
  const f = await fixture(), { request } = await f.prepare();
  let complete!: (result: MailSentReconciliationResult) => void;
  f.lookup.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = f.reconcile(request, f.responder);
  await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledTimes(1));
  await expect(f.reconcile(request, f.responder)).rejects.toMatchObject({ code: 'preapproval_limit_exceeded' });
  const query = f.lookup.mock.calls[0]![0];
  complete({ status: 'matched', match: { proof_kind: 'envelope', source_id: 'provider-record', provider_message_id: '<bounded@provider>', sent_at: query.sent_after }, scanned_candidates: 1 });
  expect((await pending).status).toBe('verified');expect(f.send).toHaveBeenCalledTimes(1);
});

it('leaves a timed-out check uncertain and ignores its later positive response', async () => {
  const f = await fixture(), { request } = await f.prepare();
  let complete!: (result: MailSentReconciliationResult) => void;
  f.lookup.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  vi.useFakeTimers();
  try {
    const pending = f.reconcile(request, f.responder);
    await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending).status).toBe('unavailable');
    await expect(f.reconcile(request, f.responder)).rejects.toMatchObject({ code: 'preapproval_limit_exceeded' });
    const query = f.lookup.mock.calls[0]![0];
    complete({ status: 'matched', match: { proof_kind: 'envelope', source_id: 'late-record', provider_message_id: '<late@provider>', sent_at: query.sent_after }, scanned_candidates: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);
    expect(f.send).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

for (const point of ['before-evidence', 'after-evidence'] as const) it(`recovers after actual process death ${point} without another send`, async () => {
  const f = await fixture(), { request } = await f.prepare();
  const root = fileURLToPath(new URL('../../../../', import.meta.url)), child = join(f.dir, 'verify-child.mts');
  const fixtureUrl = pathToFileURL(join(root, 'backend/server/src/__tests__/preapproval-resources-fixture.ts')).href;
  writeFileSync(child, [
    `import {resourceFixture} from ${JSON.stringify(fixtureUrl)};`,
    `const provider={kind:'imap',slug:'work',sendCapable:true,mutationCapable:false,accountEmail:'sender@example.com',connect:async()=>{},initialScan:async()=>{},startSync:async()=>async()=>{},close:async()=>{},health:()=>({last_successful_sync_at:0,error_count_24h:0,pending_queue_size:0}),send:async()=>{throw new Error('A verification must not send');},lookupSentByReconciliationId:async query=>({status:'matched',match:{proof_kind:'envelope',source_id:'record',provider_message_id:'<crash@provider>',sent_at:query.sent_after},scanned_candidates:1})};`,
    // Only fixture counters are replaced in the child; the host, authority,
    // crypto, provider boundary and SQLite repository are the real modules.
    `const spies={fn:()=>Object.assign(()=>{},{mockClear(){}}),spyOn:(object,key)=>object[key].bind(object)};`,
    `const f=await resourceFixture(${JSON.stringify({ dir: f.dir, clock: f.clock, token: f.token })},{mailProvider:provider,spies});`,
    ...(point === 'before-evidence' ? ['f.storage.repository.recordReconciliation=async()=>process.exit(86);'] : []),
    `await f.composed.handlers.reconcile(${JSON.stringify(request)},${JSON.stringify(f.responder)});process.exit(87);`,
  ].join('\n'));
  await f.close();
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href, child],
    { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'tsconfig.test.json') } });
  expect(result.status, result.stdout + result.stderr).toBe(point === 'before-evidence' ? 86 : 87);
  const reopened = await f.reopen();
  const prior = await reopened.storage.repository.inspect(request.proposal_id);
  expect(prior.members[0]?.reconciled_outcome).toBe(point === 'before-evidence' ? null : 'succeeded');
  expect((await reopened.composed.handlers.reconcile!(request, reopened.responder)).status).toBe('verified');
  expect(reopened.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(1);
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.lookup).toHaveBeenCalledTimes(point === 'before-evidence' ? 1 : 0);
}, 45_000);

for (const result of [
  { status: 'not_found', scanned_candidates: 0 },
  { status: 'ambiguous', reason: 'multiple_messages', scanned_candidates: 2 },
  { status: 'unavailable', reason: 'provider_error', scanned_candidates: 0 },
] satisfies MailSentReconciliationResult[]) it(`retains uncertainty on provider ${result.status}`, async () => {
  const f = await fixture(), { request } = await f.prepare();f.lookup.mockResolvedValue(result);
  const checked = await f.reconcile(request, f.responder);
  expect(checked.status).toBe(result.status === 'unavailable' ? 'unavailable' : 'unknown');
  expect(checked.inspection.members[0]?.reconciled_outcome).toBeNull();expect(checked.inspection.recovery?.eligible).toBe(false);
  expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.row('b')!.title).toBe('b');
});

for (const kind of ['owner', 'account', 'recipe', 'claim'] as const) it(`refuses ${kind} drift during the provider check`, async () => {
  const f = await fixture(), { request } = await f.prepare();
  f.lookup.mockImplementation(async query => {
    if (kind === 'owner') f.clients.revoke(f.token.token_id, 'revoked', f.clock.now);
    if (kind === 'account') { const instance = f.mail!.instances.get('mail', 'work')!;f.mail!.instances.upsert({ ...instance, config: { account_email: 'other@example.com' } }); }
    if (kind === 'recipe') f.save([{ ...mailStep(), input: { ...mailStep().input, body: 'Edited after sending' } }, recordStep('b')]);
    if (kind === 'claim') f.db.prepare('UPDATE mail_send_claims SET subject=? WHERE reconciliation_id=?').run('Changed claim', query.reconciliation_id);
    return { status: 'matched', match: { proof_kind: 'envelope', source_id: 'record', provider_message_id: '<original@provider>', sent_at: query.sent_after }, scanned_candidates: 1 };
  });
  await expect(f.reconcile(request, f.responder)).rejects.toThrow();
  expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);expect(f.send).toHaveBeenCalledTimes(1);
});

it('uses a retained acknowledgement without asking the provider again after result settlement was lost', async () => {
  const f = await fixture(), { request } = await f.prepare();
  const marker = f.send.mock.calls[0]![0].reconciliation_id!;
  const claims = createMailSendClaimStore(f.db), claim = claims.get(marker)!;
  claims.markSent({ reconciliation_id: marker, expected_revision: claim.revision, provider_message_id: '<ack@provider>', sent_at: f.clock.now, now: f.clock.now });
  expect((await f.reconcile(request, f.responder)).status).toBe('verified');expect(f.lookup).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('distinguishes explicit rejection from absence and still requires a fresh review to send', async () => {
  const f = await fixture();
  f.send.mockRejectedValueOnce(new IngredientError('MAIL_SEND_FAILED', 'Provider rejected before accepting', { not_sent: true }));
  const { request, original } = await f.prepare();
  const result = await f.reconcile(request, f.responder);
  expect(result.inspection.members[0]).toMatchObject({ status: 'in_doubt', reconciled_outcome: 'failed' });expect(f.lookup).not.toHaveBeenCalled();
  const next = await f.service.continuePlan({ proposal_id: original.proposal_id, idempotency_key: randomUUID(),
    activation: { kind: 'one_shot', run_at: f.clock.now + 60_000, time_zone: 'UTC' },
    decision_deadline: f.clock.now + 30_000, dispatch_deadline: f.clock.now + 120_000 }, f.responder);
  expect((await f.storage.repository.review(next.proposal_id, f.responder)).members).toHaveLength(2);expect(f.send).toHaveBeenCalledTimes(1);
});

it('does not promote an owner recollection into provider proof', async () => {
  const f = await fixture(), { request } = await f.prepare();
  const claims = createMailSendClaimStore(f.db), marker = f.send.mock.calls[0]![0].reconciliation_id!, claim = claims.get(marker)!;
  claims.decideByOwner({ reconciliation_id: marker, expected_revision: claim.revision, went_out: true, now: f.clock.now });
  f.lookup.mockResolvedValue({ status: 'not_found', scanned_candidates: 0 });
  expect((await f.reconcile(request, f.responder)).status).toBe('unknown');
  expect((await f.storage.repository.inspect(request.proposal_id)).members[0]?.reconciled_outcome).toBeNull();
});

it('recovers exact verification after reopening and does not need another provider read for the historical fact', async () => {
  const f = await fixture(), { request } = await f.prepare();
  const reopened = await f.reopen();
  const first = await reopened.composed.handlers.reconcile!(request, reopened.responder);
  expect(first.status).toBe('verified');expect(f.send).toHaveBeenCalledTimes(1);
  const again = await reopened.reopen();
  expect((await again.composed.handlers.reconcile!(request, again.responder)).evidence_id).toBe(first.evidence_id);
  expect(f.lookup).toHaveBeenCalledTimes(1);
});

it('refuses unsupported legacy mail claims without asking the provider', async () => {
  const f = await fixture();f.save([{ ...mailStep(), input: { ...mailStep().input, reconciliation_id: 'workflow-owned-marker' } }, recordStep('b')]);
  const { request, before } = await f.prepare();expect(before.members[0]?.provider_verification).toBeUndefined();
  expect((await f.reconcile(request, f.responder)).status).toBe('unsupported');expect(f.lookup).not.toHaveBeenCalled();
});

it('does not accept a claimed provider match with the wrong proof or time window', async () => {
  const f = await fixture(), { request } = await f.prepare();
  f.lookup.mockImplementation(async query => ({ status: 'matched', match: { proof_kind: 'envelope', source_id: 'record',
    provider_message_id: '<wrong@provider>', sent_at: query.sent_after - 1 }, scanned_candidates: 1 }));
  expect((await f.reconcile(request, f.responder)).status).toBe('unavailable');
  expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);
});

it('retains the exact attachment byte proof and refuses an envelope downgrade', async () => {
  const f = await fixture();
  const file = await f.mail!.fileCollection.ingest({ bytes: Buffer.from('Reviewed attachment bytes'), filename: 'reviewed.txt',
    mime_type: 'text/plain', origin: 'mail_attachment', source_id: 'attachment-proof' });
  f.save([{ ...mailStep(), input: { ...mailStep().input, attachments: [file.record_id] } }, recordStep('b')]);
  const { request } = await f.prepare();
  expect((await f.reconcile(request, f.responder)).status).toBe('unavailable'); // Default fake offers only an envelope.
  expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);
  f.lookup.mockImplementation(async query => {
    if (query.proof_kind !== 'attachment') throw new Error('The provider must be asked for byte proof');
    return { status: 'matched', match: { proof_kind: 'attachment', source_id: 'provider-record', provider_message_id: '<bytes@provider>',
      sent_at: query.sent_after, attachment_sha256: query.attachment_sha256, attachment_size_bytes: query.attachment_size_bytes }, scanned_candidates: 1 };
  });
  const result = await f.reconcile(request, f.responder);expect(result.status).toBe('verified');
  expect(result.inspection.recovery?.eligible).toBe(false); // Child file reads retain their separate continuation boundary.
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('reserves private marker input and accepts only owner locators through the handler', async () => {
  const f = await fixture(), { request } = await f.prepare();
  await expect(f.mail!.collection.send({ to: ['recipient@example.com'], subject: 'Subject', body_text: 'Body', reconciliation_id: PREAPPROVAL_MAIL_PREFIX + 'forged' })).rejects.toThrow(/private reviewed/);
  expect(() => parsePreapprovalReconcile({ ...request, outcome: 'succeeded' })).toThrow();
  const handlers = makePreapprovalHandlers(f.composed.handlers)!;
  await expect(handlers.handlers['preapproval.reconcile']!(request, { client_kind: 'mcp', client_token_id: f.token.token_id } as never)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
  const owner = { client_kind: 'webclient', client_token_id: f.token.token_id, token_instance_id: 'browser' } as never;
  const forged = { ...request, provider_message_id: 'forged' };
  await expect(handlers.handlers['preapproval.reconcile']!(forged, owner)).rejects.toThrow();
  expect((await handlers.handlers['preapproval.reconcile']!(request, owner)).status).toBe('verified');
});


for (const subject of ['', 's'.repeat(999)]) it(`preserves reviewed sends outside the claim envelope bounds: ${subject.length} subject characters`, async () => {
  const f = await fixture();
  f.send.mockResolvedValue({ source_id: 'sent-proof-boundary', message_id: '<sent@provider>', sent_at: f.clock.now + 60_000 });
  // These inputs were supported before automatic proof markers. Opting a
  // reviewed send into proof must not add a new send-time failure.
  await f.mail!.collection.send({ to: ['recipient@example.com'], subject, body_text: 'Original body' });
  f.send.mockClear();
  f.save([{ ...mailStep(), input: { ...mailStep().input, subject } }, recordStep('b')]);
  const original = await f.service.prepare(f.request(), f.origin);
  await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
  expect((await f.run(original.future_execution_ref)).success).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![0].reconciliation_id).toBeUndefined();
  expect(f.db.prepare('SELECT count(*) FROM mail_send_claims').pluck().get()).toBe(0);
});

for (const drift of ['revision', 'replacement'] as const) it(`refuses a remaining mail continuation after sender ${drift}`, async () => {
  const f = await fixture();
  f.send.mockRejectedValueOnce(new IngredientError('MAIL_SEND_FAILED', 'Provider rejected before accepting', { not_sent: true }));
  const { original, request } = await f.prepare();
  expect((await f.reconcile(request, f.responder)).inspection.members[0]?.reconciled_outcome).toBe('failed');
  const instance = f.mail!.instances.get('mail', 'work')!;
  if (drift === 'replacement') f.mail!.instances.delete('mail', 'work');
  f.mail!.instances.upsert({ ...instance, config: { ...instance.config, account_email: 'replacement@example.com' } });
  const proposalsBefore = f.db.prepare('SELECT count(*) FROM preapproval_proposals').pluck().get();
  await expect(f.service.continuePlan({ proposal_id: original.proposal_id, idempotency_key: randomUUID(),
    activation: { kind: 'one_shot', run_at: f.clock.now + 60_000, time_zone: 'UTC' },
    decision_deadline: f.clock.now + 30_000, dispatch_deadline: f.clock.now + 120_000 }, f.responder)).rejects.toMatchObject({ code: 'preapproval_stale' });
  expect(f.db.prepare('SELECT count(*) FROM preapproval_proposals').pluck().get()).toBe(proposalsBefore);
  expect(f.send).toHaveBeenCalledTimes(1);
});


it('retains a completed mail receipt when only local work remains after a sender change', async () => {
  const f = await fixture(), { original, request, before } = await f.prepare();
  expect((await f.reconcile(request, f.responder)).status).toBe('verified');
  const instance = f.mail!.instances.get('mail', 'work')!;
  f.mail!.instances.upsert({ ...instance, config: { account_email: 'replacement@example.com' } });
  const next = await f.service.continuePlan({ proposal_id: original.proposal_id, idempotency_key: randomUUID(),
    activation: { kind: 'one_shot', run_at: f.clock.now + 60_000, time_zone: 'UTC' },
    decision_deadline: f.clock.now + 30_000, dispatch_deadline: f.clock.now + 120_000 }, f.responder);
  const review = await f.storage.repository.review(next.proposal_id, f.responder);
  expect(review.members.map(member => member.op_id)).toEqual(['fixture.note.update']);
  expect(review.continuation?.completed[0]?.action_ref).toBe(before.members[0]?.action_ref);
  expect(f.send).toHaveBeenCalledTimes(1);
});
