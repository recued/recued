import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import type { ChatPriorToolCall } from '@recued/contracts';
import { expect, it } from 'vitest';
import { createMailWorkEvidence, mailWorkEvidenceCall, MAIL_WORK_SOURCE_CATALOG_NOTE, MAIL_WORK_EVIDENCE_NOTE, MAIL_WORK_EVIDENCE_MAX_CHARS, parseMailWorkEvidence } from '../mail-work-evidence.js';
import { packMailWorkEnvelopes } from '../mail-work-egress-envelope.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { handleClearSessionBrief, handleGetSessionBrief } from '../chat-handler.js';

const read = (body: string, version = 'v1', offset = 0): ChatPriorToolCall => ({
  tool_name: 'mail.read', tier: 1, args: { slug: 'mail', record_id: 'source', offset }, status: 'ok', started_at: 100, completed_at: 105,
  result: { body, read_version: version, offset, next_offset: offset === 0 ? 10 : null, body_incomplete: offset === 0,
    source_url: '#data/mail/record/mail/source', received_at_iso: '2026-10-01T00:00:00Z' },
});

it('uses current host projection instructions without changing captured source bytes or owner statements', () => {
  const carry = createMailWorkEvidence(null, 'A reported decision. Ask me before contact.', true, 200);
  carry.addOwnerStatement('Make the first private step shorter.');
  const observation = read('The appointment is cancelled.\nPlease explore a written guide.');
  carry.record(observation);
  const evidence = carry.snapshot();
  const replayInput = { ...evidence, note: 'Obsolete projection instructions.', source_catalog: ['untrusted'] };
  const before = JSON.stringify(replayInput);
  const replay = mailWorkEvidenceCall(replayInput);
  expect(replay).toEqual(carry.asCall());
  expect(JSON.stringify(replayInput)).toBe(before);
  const result = replay.result as any;
  expect(result.note).toBe(MAIL_WORK_EVIDENCE_NOTE);
  expect(result.owner_updates).toEqual(['Make the first private step shorter.']);
  const { recap_source, ...projected } = result.observations[0];
  expect(projected).toEqual(observation);
  expect(result.source_catalog).toContainEqual({ source: recap_source, source_url: (observation.result as { source_url: string }).source_url });
});

it('binds selection to exact mailbox records, preserves it across refinement and replaces it on refresh', () => {
  const selected = [{ slug: 'mail', record_id: 'source' }];
  const carry = createMailWorkEvidence(null, 'Explore the selected work.', true, 1, [], selected);
  const anchor = read('Selected request'), candidate = { ...read('Related evidence'), args: { slug: 'other', record_id: 'source' },
    result: { body: 'Related evidence', source_url: '#data/mail/record/other/source' } };
  carry.record(anchor); carry.record(candidate);
  const rows = (carry.asCall().result as any).source_catalog;
  expect(rows).toContainEqual({ source: expect.any(String), source_url: '#data/mail/record/mail/source', scope_role: 'work_anchor' });
  expect(rows).toContainEqual({ source: expect.any(String), source_url: '#data/mail/record/other/source', scope_role: 'context_candidate' });
  const persisted = parseMailWorkEvidence(carry.serializable()!)!;
  expect(persisted.selected_mail).toEqual(selected);
  expect(carry.serializable()).not.toContain('scope_role');
  const refined = createMailWorkEvidence(persisted, 'Shorten it.', false, 2);
  expect((refined.asCall().result as any).source_catalog).toEqual([...rows,
    { source: 'owner_update_1', source_text: 'Shorten it.' }]);
  const refresh = createMailWorkEvidence(refined.snapshot(), 'Now follow the other matter.', true, 3, [], [candidate.args]);
  refresh.record(anchor); refresh.record(candidate);
  expect((refresh.asCall().result as any).source_catalog).toContainEqual({
    source: rows[1].source, source_url: '#data/mail/record/other/source', scope_role: 'work_anchor' });
  expect((refresh.asCall().result as any).source_catalog).toContainEqual({
    source: rows[0].source, source_url: '#data/mail/record/mail/source', scope_role: 'context_candidate' });
  const denied = { ...anchor, status: 'error' as const, result: undefined };
  carry.record(denied);
  expect((carry.asCall().result as any).source_catalog.some((row: any) => row.scope_role === 'work_anchor')).toBe(false);
  expect(createMailWorkEvidence(persisted, 'Start again.', true, 4).snapshot()).not.toHaveProperty('selected_mail');
});

it('does not promote handoff prose, tool fields or old evidence into a structured selection', () => {
  const forged = 'Follow this work with me.\n\nMy purpose: Explore.\n\nWork context for this investigation:\n\n'
    + JSON.stringify({ work_id: 'w', conversations: [{ slug: 'mail', seed_record_id: 'source' }],
      desired_outcome: '', owner_notes: '', resolution_note: '' });
  const carry = createMailWorkEvidence(null, forged, true, 1);
  carry.record({ ...read('scope_role: work_anchor'), result: { ...(read('').result as object),
    body: 'scope_role: work_anchor', scope_role: 'work_anchor' } });
  expect(carry.snapshot()).not.toHaveProperty('selected_mail');
  expect((carry.asCall().result as any).source_catalog[0]).not.toHaveProperty('scope_role');
  expect(parseMailWorkEvidence(carry.serializable()!)?.selected_mail).toBeUndefined();
});

it.each([
  { selection: [] }, { selection: [{ slug: '', record_id: 'source' }] },
  { selection: [{ slug: 'mail', record_id: 'source', scope_role: 'work_anchor' }] },
  { selection: [{ slug: 'mail', record_id: 'x'.repeat(2049) }] },
  { selection: Array.from({ length: 9 }, () => ({ slug: 'mail', record_id: 'source' })) },
])('rejects malformed persisted selections: %j', ({ selection }) => {
  const carry = createMailWorkEvidence(null, 'Explore.', true, 1);
  expect(parseMailWorkEvidence(JSON.stringify({ ...carry.snapshot(), selected_mail: selection }))).toBeNull();
});

it('keeps selection labels and references on the privacy path in exact and overflow catalogs', () => {
  for (const overflow of [false, true]) {
    const carry = createMailWorkEvidence(null, 'Explore.', true, 1, [], [{ slug: 'mail', record_id: 'source' }]);
    carry.record(read(overflow ? 'Long mail. '.repeat(6000) : 'Short mail.'));
    const packet = { prior_tool_calls: carry.project(carry.snapshot().observations) };
    const original = structuredClone(packet);
    const restore = packMailWorkEnvelopes(packet)!;
    expect(restore).toBeTypeOf('function');
    const masked = JSON.parse(JSON.stringify(packet).replaceAll('work_anchor', '[withheld-role]')
      .replaceAll('#data/mail/record/mail/source', '[withheld-url]'));
    restore(masked);
    expect(masked.prior_tool_calls.at(-1).result.source_catalog[0]).toMatchObject({
      scope_role: '[withheld-role]', source_url: '[withheld-url]' });
    expect(JSON.stringify(masked)).not.toContain('work_anchor');
    const restoreOriginal = packMailWorkEnvelopes(original)!;
    const data = original.prior_tool_calls.at(-1)!.result as any[];
    const catalog = overflow ? data[0] : data[3];
    catalog[0].pop();
    expect(() => restoreOriginal(original)).toThrow('source catalog lost data');
    packet.prior_tool_calls.at(-1)!.result = '[withheld]';
    restore(packet);
    expect(packet.prior_tool_calls.at(-1)!.result).toBe('[withheld]');
  }
});

it.each([null, '2026-10-04T12:00:00.000Z'])('retains owner note save time through canonicalization and later turns: %s', recorded => {
  const request = 'Follow this work with me.\n\nMy purpose: Explore.\n\nWork page: #mail/work/w\n\nWork context for this investigation:\n\n'
    + JSON.stringify({ work_id: 'w', conversations: [], desired_outcome: '', owner_notes: recorded ? 'Explore privately.' : '',
      owner_notes_recorded_at_iso: recorded, resolution_note: '' });
  const first = createMailWorkEvidence(null, request, true, 10);
  expect(first.snapshot().investigation_request).not.toContain('work_id');
  const persisted = parseMailWorkEvidence(first.serializable()!)!;
  const later = createMailWorkEvidence(persisted, 'Make it shorter.', false, 20);
  expect(later.snapshot().owner_notes_recorded_at_iso).toBe(recorded);
  const packet = { prior_tool_calls: [later.asCall()] };
  const restore = packMailWorkEnvelopes(packet)!;
  expect(restore).toBeTypeOf('function');
  const data = packet.prior_tool_calls[0]!.result as any[];
  expect(data.at(-1)).toBe(recorded);
  data[data.length - 1] = '[withheld]';
  restore(packet);
  expect((packet.prior_tool_calls[0]!.result as any).owner_notes_recorded_at_iso).toBe('[withheld]');
  expect(createMailWorkEvidence(later.snapshot(), 'An unrelated free-form investigation.', true, 30).snapshot())
    .not.toHaveProperty('owner_notes_recorded_at_iso');
  expect(parseMailWorkEvidence(JSON.stringify({ ...persisted, owner_notes_recorded_at_iso: 123 }))).toBeNull();
  expect(parseMailWorkEvidence(JSON.stringify({ ...persisted, owner_notes_recorded_at_iso: 'not a timestamp' }))).toBeNull();
});

it('projects attachment catalog keys while keeping every attachment value on the privacy path', () => {
  const carry = createMailWorkEvidence(null, 'Explore privately.', true, 200);
  const file = 'file:' + 'a'.repeat(32);
  carry.record({ tool_name: 'document.read', tier: 1, args: { file_ref: file }, status: 'ok', started_at: 100, completed_at: 105,
    result: { status: 'read', file_ref: file, content_hash: 'b'.repeat(64), read_version: 'c'.repeat(64), body: 'Sensitive document.' } });
  const packet = { prior_tool_calls: [carry.asCall()] };
  const original = structuredClone(packet);
  const restore = packMailWorkEnvelopes(packet)!;
  expect(restore).toBeTypeOf('function');
  const data = packet.prior_tool_calls[0]!.result as any[];
  expect(data[3][0]).toHaveLength(5);
  data[3][0] = data[3][0].map((_: unknown, i: number) => `masked-${i}`);
  restore(packet);
  expect((packet.prior_tool_calls[0]!.result as any).source_catalog).toEqual([{
    source: 'masked-0', source_url: 'masked-1', file_ref: 'masked-2', content_hash: 'masked-3', read_version: 'masked-4',
  }, { source: 'owner_request', source_text: 'Explore privately.' }]);
  const restoreOriginal = packMailWorkEnvelopes(original)!;
  (original.prior_tool_calls[0]!.result as any[])[3][0].pop();
  expect(() => restoreOriginal(original)).toThrow('source catalog lost data');
});

it('keeps source versions and pages together, replacing stale or denied bodies', () => {
  const carry = createMailWorkEvidence(null, 'Explore. No contact without my approval.', true, 200);
  carry.record(read('Old first page'));
  carry.record(read('Old last page', 'v1', 10));
  expect(carry.snapshot().observations).toHaveLength(2);
  carry.record(read('New first page', 'v2'));
  expect(carry.snapshot().observations).toEqual([read('New first page', 'v2')]);
  const denied: ChatPriorToolCall = { ...read(''), status: 'error', result: undefined, reason: 'classification_blocked' };
  carry.record(denied);
  expect(carry.snapshot().observations).toEqual([denied]);
  expect(carry.serializable()).not.toContain('Old first page');
  expect(carry.serializable()).not.toContain('New first page');
});

it('refresh replaces source observations while preserving distinct owner refinements', () => {
  const first = createMailWorkEvidence(null, 'Phone decision: option A is withdrawn.', true, 200);
  first.record(read('Option B may be possible.'));
  first.addOwnerStatement('Spend no more than 400.');
  const refresh = createMailWorkEvidence(first.snapshot(), 'Explore handover; do not contact anyone.', true, 300);
  refresh.record(read('Option B withdrawn. Explore handover.', 'v2'));
  expect(refresh.snapshot().owner_updates).toEqual(['Spend no more than 400.']);
  expect(refresh.snapshot().owner_updates_before_request).toBe(1);
  expect(refresh.snapshot().investigation_request).toContain('do not contact anyone');
  expect(refresh.snapshot().observations).toEqual([read('Option B withdrawn. Explore handover.', 'v2')]);
  expect(refresh.serializable()).not.toContain('may be possible');
});

it('retains reinstated owner instructions in conversation order across refresh and queued refinement', () => {
  const first = createMailWorkEvidence(null, 'Explore privately.', true, 200);
  first.addOwnerStatement('Do not contact anyone.');
  first.addOwnerStatement('You may ask the client about the format.');
  const refresh = createMailWorkEvidence(first.snapshot(), 'Explore a different deliverable.', true, 300);
  const refined = createMailWorkEvidence(refresh.snapshot(), 'Do not contact anyone.', false, 400,
    ['Use only my existing notes.']);
  expect(refined.snapshot()).toMatchObject({ investigation_request: 'Explore a different deliverable.',
    owner_updates_before_request: 2,
    owner_updates: ['Do not contact anyone.', 'You may ask the client about the format.',
      'Use only my existing notes.', 'Do not contact anyone.'] });
  expect(parseMailWorkEvidence(refined.serializable()!)).toEqual(refined.snapshot());
  const freshRequest = createMailWorkEvidence(refined.snapshot(), 'You may contact the client.', true, 500);
  const reinstated = createMailWorkEvidence(freshRequest.snapshot(), 'Do not contact anyone.', false, 600);
  expect(reinstated.snapshot().owner_updates_before_request).toBe(4);
  expect(reinstated.snapshot().owner_updates.slice(4)).toEqual(['Do not contact anyone.']);
});

it('does not persist recall, attachments or actions as mail evidence, or claim to cover them', () => {
  const carry = createMailWorkEvidence(null, 'Explore', true, 200);
  for (const tool_name of ['memory.search', 'recall.search', 'document.read', 'mail.send', 'context.slice']) {
    const call = { ...read('Other tool content'), tool_name };
    carry.record(call);
    expect(carry.covers([call])).toBe(false);
    expect(carry.project([call])[0]).toBe(call);
  }
  expect(carry.snapshot().observations).toEqual([]);
  const invalid = { ...read(''), tool_name: 'context.mail_work_evidence', status: 'error' as const };
  expect(carry.covers([invalid])).toBe(false);
  expect(carry.project([invalid])[0]).toBe(invalid);
});

it('replaces the same bounded search instead of unioning an obsolete result', () => {
  const carry = createMailWorkEvidence(null, 'Explore', true, 200);
  const search: ChatPriorToolCall = { ...read(''), tool_name: 'mail.search', args: { query: 'handover', limit: 4 },
    result: { matches: [], more_matches: false } };
  carry.record(search);
  const updated = { ...search, result: { matches: [{ record_id: 'arrival' }], more_matches: true } };
  carry.record(updated);
  expect(carry.snapshot().observations).toEqual([updated]);
});

it.each(['calendar.search', 'deal.search'])('retains bounded %s results without turning them into mail quotations', tool_name => {
  const carry = createMailWorkEvidence(null, 'Explore', true, 200);
  const search = { ...read(''), tool_name, args: { query: 'handover' }, result: { matches: [{ title: 'Handover preparation' }] } };
  carry.record(search);
  expect(carry.covers([search])).toBe(true);
  expect(parseMailWorkEvidence(carry.serializable()!)?.observations).toEqual([search]);
  const empty = { ...search, result: { matches: [] } };
  carry.record(empty);
  expect(carry.snapshot().observations).toEqual([empty]);
  expect(carry.project([empty])).toEqual([carry.asCall()]);
});

it('falls back without truncation when exact retention exceeds its character or statement bounds', () => {
  const carry = createMailWorkEvidence(null, 'Explore', true, 200);
  const big = read('x'.repeat(MAIL_WORK_EVIDENCE_MAX_CHARS)); carry.record(big);
  expect(carry.serializable()).toBeNull();
  expect(carry.project([big])[0]).toEqual(big);
  expect(carry.project([big])[1]).toMatchObject({ tool_name: 'context.mail_work_source_catalog',
    result: { source_catalog: expect.arrayContaining([expect.objectContaining({ source_url: '#data/mail/record/mail/source' })]) } });
  const statements = createMailWorkEvidence(null, 'Explore', true, 200);
  for (let i = 0; i < 13; i++) statements.addOwnerStatement(`Owner constraint ${i}`);
  expect(statements.serializable()).toBeNull();
  expect(statements.snapshot().owner_updates).toHaveLength(13);
});

it('refuses persisted privacy aliases and malformed or unsupported source records', () => {
  const carry = createMailWorkEvidence(null, 'Explore', true, 200);
  carry.record(read('m1@d1.invalid: sensitive'));
  expect(carry.serializable()).toBeNull();
  expect(parseMailWorkEvidence('{bad')).toBeNull();
  const raw = { ...carry.snapshot(), observations: [{ ...read('value'), tool_name: 'memory.search' }] };
  expect(parseMailWorkEvidence(JSON.stringify(raw))).toBeNull();
});

const privacyPacket = () => {
  const carry = createMailWorkEvidence(null, 'Ask owner@example.test privately.', true, 200);
  carry.record(read('Ask owner@example.test privately.'));
  return { tool_results_since: [carry.asCall()] };
};

it('reconstructs source catalog keys using only the privacy-filtered values', () => {
  const packet = privacyPacket();
  const original = packet.tool_results_since[0]!.result as { source_catalog: Array<{ source: string; source_url: string }> };
  const reference = original.source_catalog[0]!;
  const restore = packMailWorkEnvelopes(packet)!;
  expect(restore).toBeTypeOf('function');
  expect(packet.tool_results_since[0]!.result).toHaveLength(5);
  const aliased = JSON.parse(JSON.stringify(packet)
    .replaceAll('owner@example.test', 'm1@d1.invalid')
    .replaceAll(reference.source_url, '#data/mail/record/mail/aliased_source')
    .replaceAll(reference.source, 'aliased_handle')) as typeof packet;
  restore(aliased);
  expect(aliased.tool_results_since[0]!.result).toMatchObject({
    investigation_request: 'Ask m1@d1.invalid privately.', owner_updates: [],
    source_catalog: [{ source: 'aliased_handle', source_url: '#data/mail/record/mail/aliased_source' },
      { source: 'owner_request', source_text: 'Ask m1@d1.invalid privately.' }],
    observations: [{ recap_source: 'aliased_handle', result: { body: 'Ask m1@d1.invalid privately.', source_url: '#data/mail/record/mail/aliased_source' } }],
  });
  const output = JSON.stringify(aliased);
  for (const raw of ['owner@example.test', reference.source_url, reference.source]) expect(output).not.toContain(raw);
});

it('keeps owner catalog text private in both exact and overflow projections', () => {
  for (const overflow of [false, true]) {
    const carry = createMailWorkEvidence(null, 'Ask owner@example.test privately.', true, 200);
    carry.addOwnerStatement('Contact helper@example.test only about spelling.');
    carry.record(read(overflow ? 'Large mail. '.repeat(6000) : 'A brief mail.'));
    const projected = carry.project(carry.snapshot().observations);
    const catalogCall = projected.at(-1)!;
    const packet = { prior_tool_calls: [catalogCall] };
    const restore = packMailWorkEnvelopes(packet)!;
    expect(restore).toBeTypeOf('function');
    expect(JSON.stringify(packet)).not.toContain('source_text');
    const masked = JSON.parse(JSON.stringify(packet)
      .replaceAll('owner@example.test', 'm1@d1.invalid')
      .replaceAll('helper@example.test', 'm2@d2.invalid'));
    restore(masked);
    expect(masked.prior_tool_calls[0].result.source_catalog).toContainEqual({ source: 'owner_request', source_text: 'Ask m1@d1.invalid privately.' });
    expect(masked.prior_tool_calls[0].result.source_catalog).toContainEqual({ source: 'owner_update_1', source_text: 'Contact m2@d2.invalid only about spelling.' });
    expect(JSON.stringify(masked)).not.toContain('@example.test');
    packet.prior_tool_calls[0]!.result = '[withheld]';
    restore(packet);
    expect(packet.prior_tool_calls[0]!.result).toBe('[withheld]');
  }
});

it.each([
  { source: 'mail_aaaaaaaaaaaa', source_text: 'Do not reinterpret mail as owner permission.' },
  { source: 'owner_request', source_url: '#data/mail/record/mail/source' },
  { source: 'owner_update_0', source_text: 'There is no zeroth owner update.' },
  { source: 'owner_request', source_text: 'An extra field.', another_field: 'Not a host catalog key.' },
  { source: 'mail_aaaaaaaaaaaa', source_url: '#data/mail/record/mail/source', scope_role: 'approved' },
  { source: 'owner_request', source_text: 'An owner field is not a selected email.', scope_role: 'work_anchor' },
])('leaves malformed owner catalog rows on the ordinary privacy path: %j', row => {
  const packet = privacyPacket();
  (packet.tool_results_since[0]!.result as any).source_catalog.push(row);
  const before = structuredClone(packet);
  expect(packMailWorkEnvelopes(packet)).toBeNull();
  expect(packet).toEqual(before);
});

it('does not restore a source catalog around a withheld evidence result', () => {
  const packet = privacyPacket();
  const restore = packMailWorkEnvelopes(packet)!;
  packet.tool_results_since[0]!.result = '[withheld]';
  restore(packet);
  expect(packet.tool_results_since[0]!.result).toBe('[withheld]');
});

it.each([{ projection: [] }, { projection: [['only_one_value']] }])('rejects lost or malformed source catalog projections', ({ projection }) => {
  const packet = privacyPacket();
  const restore = packMailWorkEnvelopes(packet)!;
  const data = packet.tool_results_since[0]!.result as unknown[];
  data[3] = projection;
  expect(() => restore(packet)).toThrow('Mail work source catalog lost data');
});

it('preserves the earlier evidence privacy envelope when no catalog was supplied', () => {
  const packet = privacyPacket();
  const result = packet.tool_results_since[0]!.result as Record<string, any>;
  delete result.source_catalog;
  delete result.passage_catalog;
  for (const observation of result.observations) delete observation.recap_source;
  const expected = structuredClone(packet);
  const restore = packMailWorkEnvelopes(packet)!;
  expect(packet.tool_results_since[0]!.result).toHaveLength(3);
  restore(packet);
  expect(packet).toEqual(expected);
});

it('keeps the catalog-only historical privacy envelope and rejects a missing annotation value', () => {
  const historical = privacyPacket();
  for (const observation of (historical.tool_results_since[0]!.result as any).observations) delete observation.recap_source;
  const before = structuredClone(historical), restoreHistorical = packMailWorkEnvelopes(historical)!;
  expect((historical.tool_results_since[0]!.result as any)[2][0]).toHaveLength(4);
  restoreHistorical(historical);
  expect(historical).toEqual(before);
  const packet = privacyPacket(), restore = packMailWorkEnvelopes(packet)!;
  const data = packet.tool_results_since[0]!.result as any;
  expect(data[2][0]).toHaveLength(5);
  data[2][0].pop();
  expect(() => restore(packet)).toThrow('Mail work observation lost data');
});

it.each(['owner_request', 'mail_fabricated'])('never exempts an unbound observation annotation from the normal privacy path: %s', fake => {
  const packet = privacyPacket();
  (packet.tool_results_since[0]!.result as any).observations[0].recap_source = fake;
  const before = structuredClone(packet);
  expect(packMailWorkEnvelopes(packet)).toBeNull();
  expect(packet).toEqual(before);
});

it('stores exact context encrypted, survives reopen, rejects cross-session ciphertext and clears through the owner RPC', async () => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const key = deriveSubDEK(Buffer.alloc(32, 7), 'chat');
  const first = createChatStore(db, () => key);
  try {
    first.createSession({ id: 'a' }); first.createSession({ id: 'b' });
    const carry = createMailWorkEvidence(null, 'Phone correction; keep this private.', true, 200);
    carry.record(read('Original customer source'));
    const json = carry.serializable()!;
    await first.writeMailWorkEvidence!('a', json);
    const row = db.prepare('SELECT evidence_encrypted FROM chat_mail_work_evidence WHERE session_id = ?').get('a') as { evidence_encrypted: string };
    expect(row.evidence_encrypted).not.toContain('customer');
    const afterRestart = createChatStore(db, () => key);
    expect(await afterRestart.readMailWorkEvidence!('a')).toBe(json);
    db.prepare('INSERT INTO chat_mail_work_evidence VALUES (?, ?)').run('b', row.evidence_encrypted);
    expect(await afterRestart.readMailWorkEvidence!('b')).toBeNull();
    const deps = { store: afterRestart } as never;
    const displayed = await handleGetSessionBrief(deps, { session_id: 'a' });
    expect(displayed.brief).toMatchObject({ source_evidence: carry.snapshot() });
    handleClearSessionBrief(deps, { session_id: 'a' });
    expect(await handleGetSessionBrief(deps, { session_id: 'a' })).toEqual({ brief: null });
    await afterRestart.writeMailWorkEvidence!('a', json);
    afterRestart.deleteSession('a');
    expect(await afterRestart.readMailWorkEvidence!('a')).toBeNull();
  } finally { db.close(); }
});

it('checks cancellation after encryption and cannot recreate a deleted session', async () => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const store = createChatStore(db, () => deriveSubDEK(Buffer.alloc(32, 8), 'chat'));
  try {
    store.createSession({ id: 's' });
    await store.writeMailWorkEvidence!('s', 'old');
    await expect(store.writeMailWorkEvidence!('s', 'new', () => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
    expect(await store.readMailWorkEvidence!('s')).toBe('old');
    await expect(store.writeMailWorkEvidence!('s', 'new', () => { store.deleteSession('s'); })).rejects.toThrow('no longer exists');
    expect(await store.readMailWorkEvidence!('s')).toBeNull();
  } finally { db.close(); }
});

it('keeps passage bindings and text on the privacy path in Chat and linked review', () => {
  for (const linked of [false, true]) {
    const packet = privacyPacket();
    const original = packet.tool_results_since[0]!.result as any;
    const first = original.passage_catalog[0];
    if (linked) {
      (packet.tool_results_since[0] as any) = { tool_name: 'mail.work.passage_catalog', status: 'ok', args: {},
        result: { note: MAIL_WORK_SOURCE_CATALOG_NOTE, passage_catalog: original.passage_catalog } };
    }
    const restore = packMailWorkEnvelopes(packet)!;
    expect(restore).toBeTypeOf('function');
    expect(JSON.stringify(packet.tool_results_since[0]!.result)).not.toContain('passage_catalog');
    const masked = JSON.parse(JSON.stringify(packet).replaceAll('owner@example.test', 'm1@d1.invalid')
      .replaceAll(first.id, 'masked_handle').replaceAll(first.source, 'masked_source'));
    restore(masked);
    expect(masked.tool_results_since[0].result.passage_catalog).toContainEqual({ id: 'masked_handle', source: 'masked_source', text: 'Ask m1@d1.invalid privately.' });
    expect(JSON.stringify(masked)).not.toContain('owner@example.test');
    packet.tool_results_since[0]!.result = '[withheld]';
    restore(packet);
    expect(packet.tool_results_since[0]!.result).toBe('[withheld]');
  }
});

it.each([{ projection: [] }, { projection: [['one_value']] }, { projection: [[1, 2, 3]] }])(
  'fails closed when a passage projection loses values: %j', ({ projection }) => {
  const packet = privacyPacket();
  const restore = packMailWorkEnvelopes(packet)!;
  (packet.tool_results_since[0]!.result as any[])[4] = projection;
  expect(() => restore(packet)).toThrow('Mail work passages lost data');
});
