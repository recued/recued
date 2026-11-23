import { expect, it } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS, WORK_ENTITY_KINDS } from '@recued/contracts';
import { selectedRecordsWire } from '../selected-records.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../../shell/route.js';
import { workReaderLink, type WorkReaderLink } from '../../data/task-note-source.js';
import type { PreparedRecordLink } from '../../data/record-link-insert.js';

/** D-406 — the chat tool that reads each kind "Add records" attaches, by the ids its reference carries.
 *
 *  The references block tells the model to read each record "through the available governed readers; match
 *  type, ID, and source or account" (`record-context.ts`). Until D-406 Q4, "Chat about this" on an event said
 *  the same while no tool took an event's id: the model searched by title, which a namesake beats, or said it
 *  could not read the exact event. An instruction reads as complete; whether a tool can obey it is a fact about
 *  the catalog. A kind added to the picker therefore needs a row here (the type makes it a compile error), and
 *  the row's tool must take the reference's ids as they are. */
type Kind = WorkReaderLink['tab'];
type WireRecord = Record<string, unknown>;
const READERS: { readonly [K in Kind]: { readonly tool: string; readonly args: (record: WireRecord) => Record<string, unknown> } } = {
  contact: { tool: 'contact.read', args: (r) => ({ target_id: r.id }) },
  task: { tool: 'work.read', args: (r) => ({ kind: r.kind, id: r.id }) },
  note: { tool: 'work.read', args: (r) => ({ kind: r.kind, id: r.id }) },
  booking: { tool: 'work.read', args: (r) => ({ kind: r.kind, id: r.id }) },
  project: { tool: 'work.read', args: (r) => ({ kind: r.kind, id: r.id }) },
  commitment: { tool: 'work.read', args: (r) => ({ kind: r.kind, id: r.id }) },
  mail: { tool: 'mail.read', args: (r) => ({ slug: r.slug, record_id: r.record_id }) },
  calendar: { tool: 'calendar.search', args: (r) => ({ slug: r.slug, record_id: r.record_id }) },
};
const KINDS = Object.keys(READERS) as Kind[];

/** One selected record of `kind`, shaped as the picker prepares it (its identity token is what the wire reads). */
const ID = 'rec/二?7';
const prepared = (kind: Kind): PreparedRecordLink => {
  if (kind === 'mail' || kind === 'calendar') {
    const target = { tab: kind, collectionSlug: 'work', recordId: ID, hash: serializeSourceRecordAddress({ tab: kind, collectionSlug: 'work', recordId: ID }) };
    return { reference: { key: kind, target, identity: JSON.stringify([kind, 'work', ID, 'provider-row', 2]), title: `A ${kind}`, details: [], href: target.hash } };
  }
  const target = { tab: kind, id: ID, hash: serializeShellRoute('data', kind, ID) };
  const identity = kind === 'contact' ? JSON.stringify(['contact', ID, 1]) : JSON.stringify([kind, ID, `recued.${kind}`, null, 1]);
  return { reference: { key: kind, target, identity, title: `A ${kind}`, details: [], href: target.hash } };
};

interface ArgProperty { readonly type?: string; readonly enum?: readonly unknown[] }
interface ArgSchema { readonly properties?: Readonly<Record<string, ArgProperty>>; readonly required?: readonly string[] }
const catalog = TIER1_TOOL_DESCRIPTORS as unknown as Readonly<Record<string, { readonly name: string; readonly arg_schema: ArgSchema } | undefined>>;

it.each(KINDS)('a %s added in "Add records" has a chat tool that reads it by the ids its reference carries', (kind) => {
  const rows = JSON.parse(selectedRecordsWire([prepared(kind)])) as Array<{ record: WireRecord }>;
  const record = rows[0]!.record;
  expect(record.kind).toBe(kind);
  const reader = READERS[kind], tool = catalog[reader.tool];
  expect(tool?.name, `${reader.tool} is in the chat catalog`).toBe(reader.tool);
  const schema = tool!.arg_schema, args = reader.args(record);
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties?.[name];
    expect(property, `${reader.tool} takes \`${name}\``).toBeDefined();
    expect(property!.type, `${reader.tool}'s \`${name}\` is text`).toBe('string');
    expect(typeof value, `the reference gives \`${name}\``).toBe('string');
    if (property!.enum) expect(property!.enum, `${reader.tool}'s \`${name}\` admits "${String(value)}"`).toContain(value);
  }
  for (const name of schema.required ?? []) expect(Object.keys(args), `${reader.tool} requires \`${name}\``).toContain(name);
  // The reference's own ids reach the reader unchanged: an id the model must translate first is a search by
  // another name.
  const ids = kind === 'mail' || kind === 'calendar' ? [record.slug, record.record_id] : [record.id];
  for (const id of ids) expect(Object.values(args)).toContain(id);
  expect(ids).toContain(ID);
});

it('every kind a saved-record link can name has a reader above, and no other kind parses', () => {
  const client = 'https://app.test/client/';
  const candidates = new Set<string>([...KINDS, ...WORK_ENTITY_KINDS, 'files', 'contacts', 'event', 'memory', 'deal', 'account']);
  const parsed = new Set<string>();
  for (const tab of candidates) {
    // Any tab, typed or not: the parser is what decides which kinds a link can name.
    const address = { tab, collectionSlug: 'work', recordId: ID };
    const hashes = [serializeShellRoute('data', tab, ID), serializeSourceRecordAddress(address as Parameters<typeof serializeSourceRecordAddress>[0])];
    for (const hash of hashes) { const target = workReaderLink(client + hash, client); if (target) parsed.add(target.tab); }
  }
  expect([...parsed].sort()).toEqual([...KINDS].sort());
});
