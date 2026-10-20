import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { CollectionRecord, RecordsExecutionBinding, RecordsFieldSnapshot, RecordsSchemaSnapshot } from '@recued/contracts';
import { createRecordsStore } from '../records/store.js';
import { readPhotoTraces } from '../situations/photo-traces.js';
import { arrivalTrace } from '../situations/arrival-traces.js';
import { createEpisodeRuntime } from '../situations/episode-runtime.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createCollectionTable } from '../collections/table.js';

it('joins attributed faces to existing contacts through an exact file path, rejecting roster names, skipped matches and another same-named file', () => {
  const db = new Database(':memory:'); const now = Date.parse('2026-10-17'); const store = createRecordsStore(db, { now: () => now });
  const field = (key: string, slot: RecordsFieldSnapshot['slot'], kind: 'id' | 'string' | 'ref' = 'string'): RecordsFieldSnapshot => ({ key, slot, kind, required: true });
  const install = (pack_slug: string, entities: RecordsSchemaSnapshot['entities']) => {
    const owner = { publisher: 'recued-core', pack_slug }; const bindings = Object.fromEntries(Object.keys(entities).map(entity => [entity,
      { kind: 'core.records' as const, action: 'create' as const, entity, owner, pack_version: 1, storage_schema_hash: 'c'.repeat(64), declaration_hash: 'd'.repeat(64), operation_digest: `${entity}-create` }]));
    store.installNamespace({ owner, version: 1, schema: { decimal_scale: 4, entities }, bindings, storage_schema_hash: 'c'.repeat(64), declaration_hash: 'd'.repeat(64), artifact_digest: `fixture-${pack_slug}` });
    return (entity: string, id: string, values: Record<string, unknown>) => store.execute({ binding: bindings[entity]!, principal: 'owner', args: { id, values } });
  };
  try {
    const photo = install('job-photo-delivery', { photo: { kind: 'photo', fields: [field('id', 'pk', 'id'), field('source_record_id', 's1'), field('taken_at', 's5')] } });
    photo('photo', 'capture', { source_record_id: 'file:captured', taken_at: '2025-10-17' });
    const faces = install('photo-attribution', { face_profile: { kind: 'face_profile', fields: [field('id', 'pk', 'id'), field('contact_email', 's3'), field('status', 's5')] },
      photo: { kind: 'photo', fields: [field('id', 'pk', 'id'), field('source_path', 's1'), field('status', 's4')] },
      attributed_result: { kind: 'attributed_result', fields: [field('id', 'pk', 'id'), field('photo_ref', 'r1', 'ref'), field('profile_ref', 'r2', 'ref'), field('status', 's1')] } });
    faces('face_profile', 'ana', { contact_email: 'ana@example.test', status: 'active' });
    faces('photo', 'right', { source_path: '/photos/holiday/museum.jpg', status: 'scanned' });
    faces('photo', 'wrong', { source_path: '/photos/work/museum.jpg', status: 'scanned' });
    faces('attributed_result', 'match', { photo_ref: 'photo/right', profile_ref: 'face_profile/ana', status: 'pending' });
    const contact = vi.fn((email: string) => email === 'ana@example.test' ? 'contact-ana' : undefined);
    expect(readPhotoTraces(store, now, { filePath: () => '/photos/holiday/museum.jpg', contact })[0]!.people).toEqual(['contact-ana']);
    expect(readPhotoTraces(store, now, { filePath: () => '/photos/work/museum.jpg', contact })[0]!.people).toEqual([]);
    expect(readPhotoTraces(store, now)[0]!.people).toEqual([]);
    expect(readPhotoTraces(store, now, { filePath: () => '/photos/holiday/museum.jpg', contact: () => undefined })[0]!.people).toEqual([]);
  } finally { db.close(); }
});

it('uses prepared photo metadata from a real ready Records namespace and never treats a caption or scan date as capture evidence', async () => {
  const db = new Database(':memory:'); const now = Date.parse('2026-10-17'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const store = createRecordsStore(db, { now: () => now }); const owner = { publisher: 'recued-core', pack_slug: 'job-photo-delivery' };
  const schema: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { photo: { kind: 'photo', fields: [
    { key: 'id', slot: 'pk', kind: 'id', required: true, privacy: 'external_id' }, { key: 'source_record_id', slot: 's1', kind: 'string', required: true, privacy: 'external_id' },
    { key: 'filename', slot: 's2', kind: 'string', required: false, privacy: 'content' }, { key: 'taken_at', slot: 's5', kind: 'string', required: false, privacy: 'content' },
    { key: 'found_location', slot: 't1', kind: 'text', required: false, privacy: 'address' }, { key: 'has_location', slot: 'b1', kind: 'boolean', required: false },
  ] } } };
  const binding: RecordsExecutionBinding = { kind: 'core.records', action: 'create', entity: 'photo', owner, pack_version: 1,
    storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: 'photo-create' };
  store.installNamespace({ owner, version: 1, schema, bindings: { create: binding }, storage_schema_hash: binding.storage_schema_hash,
    declaration_hash: binding.declaration_hash, artifact_digest: 'fixture-photo-pack' });
  const create = (id: string, values: Record<string, unknown>) => store.execute({ binding, principal: 'owner', args: { id, values: { source_record_id: `file:local:${id}`, ...values } } });
  create('captured', { filename: 'museum.jpg', taken_at: '2025:10:17 13:45:00', found_location: 'Museum', has_location: true });
  create('missing', { filename: 'a caption is not a trace.jpg' }); create('invalid', { taken_at: '2025:02:30 13:45:00' });
  const runtime = createEpisodeRuntime({ db, work, situations: createSituationStore(db), calendars: () => [], now: () => now, timeZone: () => 'UTC', isVaultUnlocked: () => true }); runtime.bindRecords(store);
  try {
    const traces = readPhotoTraces(store, now); expect(traces).toHaveLength(1); expect(traces[0]).toMatchObject({ title: 'Photo: museum.jpg', class_id: 'photos', people: [], sources: [{ collection: 'file', id: 'file:local:captured' }] });
    const episodes = await runtime.ownerEpisodes(); expect(episodes).toHaveLength(1); expect(episodes[0]).toMatchObject({ basis: 'inferred', class_id: 'photos' });
    const read = vi.spyOn(store, 'ownerSearch'); read.mockClear();
    await runtime.source.read({ surface: 'tool', time: { from: Date.parse('2025-10-17'), to: Date.parse('2025-10-18') } }, undefined,
      { owner: true, grants: { isVerbOpGranted: op => op !== 'core.data.file.get', isCollectionReadGranted: () => true, isTopicReadGranted: () => true } });
    expect(read).not.toHaveBeenCalled(); runtime.forget(); expect(await runtime.ownerEpisodes()).toEqual([]);
  } finally { await runtime.stop(); db.close(); }
});

it('requires a completed dated arrival sentence and refuses prompts, future reports, quoted and cancelled check-ins', () => {
  const row = (body_inline: string): CollectionRecord => ({ record_id: 'email', source_id: 'provider', received_at: Date.parse('2025-10-17'), modified_at: Date.parse('2025-10-17'),
    size_bytes: Buffer.byteLength(body_inline), hot_fields: { from: 'hotel@example.test', subject: 'Check-in' }, body_inline });
  const now = Date.parse('2026-10-17'); expect(arrivalTrace('personal', row('You have checked in at Las Vegas on 2025-10-17.'), now)).toMatchObject({ class_id: 'checkin', where: { name: 'Las Vegas' } });
  for (const body of ['Please check in at Las Vegas on 2025-10-17.', 'Your booking is confirmed for 2025-10-17.', 'You have checked in at Las Vegas on 2027-10-17.',
    'You have checked in at Las Vegas on 2025-02-30.', '> You have checked in at Las Vegas on 2025-10-17.', 'Forwarded message\nYou have checked in at Las Vegas on 2025-10-17.',
    'You have checked in at Las Vegas on 2025-10-17.\nThis check-in was cancelled.']) expect(arrivalTrace('personal', row(body), now)).toBeNull();
});

it('pages the complete indexed evidence set through a large unrelated mailbox and a shared arrival timestamp', () => {
  const db = new Database(':memory:');
  try {
    const table = createCollectionTable({ db, platform: 'mail', slug: 'fixture' });
    const expected: string[] = [];
    db.transaction(() => { for (let index = 0; index < 3505; index++) {
      const candidate = index < 505; const record_id = `${candidate ? 'arrival' : 'other'}-${index}`;
      const body_inline = candidate ? 'You have checked in at Museum on 2025-10-17.' : 'An unrelated message with no arrival evidence';
      table.upsert({ record_id, source_id: record_id, received_at: 1, modified_at: 1, hot_fields: {}, body_inline, size_bytes: Buffer.byteLength(body_inline) });
      if (candidate) expected.push(record_id);
    } })();
    const seen: string[] = []; let cursor = '';
    for (;;) { const page = table.bodyEvidencePage!({ expression: '"checked in" OR "arrived at"', after: cursor, limit: 200 }); if (!page.length) break;
      seen.push(...page.map(row => row.record_id)); cursor = page.at(-1)!.record_id; }
    expect(seen).toEqual(expected.sort()); expect(new Set(seen).size).toBe(505);
  } finally { db.close(); }
});
