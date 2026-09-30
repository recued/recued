/** D-315 slice 1 — the mail-facts store (§5): templates with health, owner types,
 *  facts, things and the identity-key index. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MailFact, MailFactThing, MailTemplateDefinition } from '@recued/contracts';

import { createMailFactStore, ensureMailFactSchema, type MailFactStore } from '../storage/mail-fact-store.js';

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let clock = 1_000;
let ids = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-store-'));
  db = new Database(join(dir, 'test.db'));
  clock = 1_000;
  ids = 0;
  store = createMailFactStore(db, { now: () => clock, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const definition = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'UPS',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
  rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking:' } }],
  html: false,
  ai: { enabled: false },
  ...over,
});

const fact = (over: Partial<MailFact> = {}): MailFact => ({
  fact_id: 'mfact_a',
  type: 'shipment',
  template_id: 'mtpl_1',
  email: { slug: 'work', record_id: 'mail:aaa' },
  email_at: 500,
  position: 0,
  identity_keys: ['carrier+tracking_number=ups|1z'],
  thing_id: 'mthing_1',
  variables: { carrier: 'UPS', tracking_number: '1Z', state: 'delivered' },
  passes: { carrier: 'rule', tracking_number: 'rule', state: 'rule' },
  data: { note: 'left at door' },
  missing: [],
  refused: [],
  complete: true,
  source_hash: 'h1',
  revision: 1,
  created_at: 900,
  ...over,
});

const thing = (over: Partial<MailFactThing> = {}): MailFactThing => ({
  thing_id: 'mthing_1',
  type: 'shipment',
  identity_keys: ['carrier+tracking_number=ups|1z'],
  variables: { carrier: 'UPS', tracking_number: '1Z', state: 'delivered' },
  passes: { carrier: 'rule' },
  variable_email_at: { carrier: 500 },
  last_email_at: 500,
  missing: [],
  complete: true,
  created_at: 900,
  updated_at: 900,
  ...over,
});

describe('the schema', () => {
  it('can be ensured twice', () => {
    expect(() => {
      ensureMailFactSchema(db);
      ensureMailFactSchema(db);
    }).not.toThrow();
  });

  it('gives a thing made before ruling 44 the time its newest email arrived, from its facts', () => {
    store.saveThing(thing());
    store.insertFact(fact({ fact_id: 'mfact_a', email_at: 500 }));
    store.insertFact(fact({ fact_id: 'mfact_b', email: { slug: 'work', record_id: 'mail:bbb' }, email_at: 700 }));
    // The table as it was: no column for it.
    db.exec('ALTER TABLE mail_fact_thing DROP COLUMN last_email_at');
    ensureMailFactSchema(db);
    expect(store.getThing('mthing_1')?.last_email_at).toBe(700);
  });

  it('gives a fact made before the ledger what only the writer reads: announced, so a backfill never announces it again', () => {
    store.insertFact(fact());
    // The table as it was: none of the three columns.
    db.exec('ALTER TABLE mail_fact DROP COLUMN template_revision');
    db.exec('ALTER TABLE mail_fact DROP COLUMN announced');
    db.exec('ALTER TABLE mail_fact DROP COLUMN prior_thing_id');
    ensureMailFactSchema(db);
    expect(store.getFactRecord('mfact_a')).toMatchObject({ template_revision: null, announced: true, prior_thing_id: null });
    // What a client reads stays the contract's fact.
    expect(store.getFact('mfact_a')).not.toHaveProperty('announced');
  });
});

describe('moving an email', () => {
  it('moves everything at once, and a job the new id queued already stays', () => {
    const job = (record_id: string, job_id: string) => ({
      job_id, email: { slug: 'work', record_id }, template_id: 'mtpl_1', may_trigger: false, attempts: 0, queued_at: 1,
    });
    store.insertFact(fact());
    store.enqueueAiJob(job('mail:aaa', 'j-old'));
    store.enqueueAiJob(job('mail:zzz', 'j-new'));
    expect(store.rekeyEmail('work', 'mail:aaa', 'mail:zzz')).toBe(1);
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:aaa' })).toEqual([]);
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:zzz' }).map((j) => j.job_id)).toEqual(['j-new']);
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:zzz' })).toHaveLength(1);
  });
});

describe('the ledger (§5, ruling 13)', () => {
  const email = { slug: 'work', record_id: 'mail:aaa' };

  it('keeps news from the moment it is marked until the email is read, and follows a move and a deletion', () => {
    expect(store.getEmailLedger(email)).toBeNull();
    store.markEmailNews(email);
    expect(store.getEmailLedger(email)).toMatchObject({ news: true, fingerprint: null, read_at: null });
    store.saveEmailLedger({ email, fingerprint: 'c1', labels: ['inbox'], read_at: 5, news: false, skipped: null, counted: ['mtpl_1@2'], email_at: 1_000 });
    expect(store.getEmailLedger(email)).toEqual({
      email, fingerprint: 'c1', labels: ['inbox'], read_at: 5, news: false, skipped: null, counted: ['mtpl_1@2'], copy_key: null,
      email_at: 1_000, arrival: 1,
    });
    // Its date and its place in the order mail was read are fixed when it is
    // first read: a later reading keeps them.
    store.saveEmailLedger({ email, fingerprint: 'c2', labels: ['inbox'], read_at: 9, news: false, skipped: null, counted: [], email_at: 3_000 });
    expect(store.getEmailLedger(email)).toMatchObject({ fingerprint: 'c2', read_at: 9, email_at: 1_000, arrival: 1 });
    // The next email read is the next in that order.
    const next = { slug: 'work', record_id: 'mail:bbb' };
    store.saveEmailLedger({ email: next, fingerprint: 'n1', labels: [], read_at: 10, news: false, skipped: null, counted: [], email_at: 1_000 });
    expect(store.getEmailLedger(next)?.arrival).toBe(2);
    store.rekeyEmail('work', 'mail:aaa', 'mail:zzz');
    expect(store.getEmailLedger(email)).toBeNull();
    expect(store.getEmailLedger({ slug: 'work', record_id: 'mail:zzz' })).toMatchObject({ fingerprint: 'c2', email_at: 1_000, arrival: 1 });
    store.deleteEmailLedgers('work', ['mail:zzz']);
    expect(store.getEmailLedger({ slug: 'work', record_id: 'mail:zzz' })).toBeNull();
  });
});

describe('templates', () => {
  it.each(['{broken', 'null'])('rejects an unreadable stored definition (%s) instead of inventing an empty template', (blob) => {
    const created = store.createTemplate({ definition: definition(), origin: { kind: 'owner' } });
    db.prepare('UPDATE mail_template SET definition_blob = ? WHERE template_id = ?').run(blob, created.template_id);
    expect(() => store.getTemplate(created.template_id)).toThrow(`Unreadable definition for mail template ${created.template_id}`);
    expect(() => store.listTemplates()).toThrow(`Unreadable definition for mail template ${created.template_id}`);
  });

  it('creates, reads, lists, updates (a definition change is a new revision) and deletes', () => {
    const created = store.createTemplate({ definition: definition(), origin: { kind: 'owner' } });
    expect(created.template_id).toBe('mtpl_1');
    expect(created.revision).toBe(1);
    expect(created.active).toBe(true);
    expect(created.health).toEqual({ matched: 0, entered: 0, not_entered: 0 });
    expect(store.getTemplate('mtpl_1')?.entrance.variables).toEqual(['tracking_number']);

    clock = 2_000;
    const renamed = store.updateTemplate('mtpl_1', { definition: definition({ name: 'UPS notices' }) });
    expect(renamed?.revision).toBe(2);
    expect(renamed?.name).toBe('UPS notices');
    const paused = store.updateTemplate('mtpl_1', { active: false });
    expect(paused?.revision).toBe(2); // switching off is not a new reading
    expect(store.listTemplates({ active: true })).toEqual([]);
    expect(store.listTemplates({ type: 'shipment' })).toHaveLength(1);

    expect(store.deleteTemplate('mtpl_1')).toBe(true);
    expect(store.getTemplate('mtpl_1')).toBeNull();
  });

  it('counts health: matched, entered, not entered, and the latest warning', () => {
    store.createTemplate({ definition: definition(), origin: { kind: 'owner' } });
    store.recordTemplateOutcome('mtpl_1', 'no_match', 10);
    store.recordTemplateOutcome('mtpl_1', 'entered', 20);
    store.recordTemplateOutcome('mtpl_1', 'not_entered', 30, ['the body condition: stopped']);
    expect(store.getTemplate('mtpl_1')?.health).toEqual({
      matched: 2,
      entered: 1,
      not_entered: 1,
      last_matched_at: 30,
      last_entered_at: 20,
      last_not_entered_at: 30,
      last_warning: 'the body condition: stopped',
      last_warning_at: 30,
    });
  });
});

describe('facts and things', () => {
  it('stores a fact and finds it by email, thing and list', () => {
    store.insertFact(fact());
    expect(store.getFact('mfact_a')?.data).toEqual({ note: 'left at door' });
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:aaa' })).toHaveLength(1);
    expect(store.factsForThing('mthing_1')).toHaveLength(1);
    expect(store.listFacts({ type: 'shipment', since: 400 })).toHaveLength(1);
    expect(store.listFacts({ since: 600 })).toHaveLength(0);
  });

  it('finds a thing by ANY of its identity keys, and keeps the key index exact', () => {
    store.saveThing(thing({ identity_keys: ['a', 'b'] }));
    expect(store.findThingIdByKeys('shipment', ['x', 'b'])).toBe('mthing_1');
    expect(store.findThingIdByKeys('bill', ['a'])).toBeNull(); // keys are per type
    store.saveThing(thing({ identity_keys: ['c'] }));
    expect(store.findThingIdByKeys('shipment', ['a'])).toBeNull();
    expect(store.findThingIdByKeys('shipment', ['c'])).toBe('mthing_1');
    store.deleteThing('mthing_1');
    expect(store.findThingIdByKeys('shipment', ['c'])).toBeNull();
  });

  it('indexes a key for every thing that holds it, not only the first', () => {
    // Saved newest first: the oldest still comes first.
    store.saveThing(thing({ thing_id: 'mthing_new', identity_keys: ['a', 'c'], created_at: 2_000 }));
    store.saveThing(thing({ thing_id: 'mthing_old', identity_keys: ['a', 'b'], created_at: 1_000 }));
    expect(store.thingIdsByKeys('shipment', ['a'])).toEqual(['mthing_old', 'mthing_new']);
    expect(store.thingIdsByKeys('shipment', ['c'])).toEqual(['mthing_new']);
    expect(store.findThingIdByKeys('shipment', ['a'])).toBe('mthing_old');
    store.deleteThing('mthing_old');
    expect(store.thingIdsByKeys('shipment', ['a', 'b'])).toEqual(['mthing_new']);
  });

  it('rebuilds a key index that named one thing per key from the things themselves', () => {
    store.saveThing(thing({ thing_id: 'mthing_old', identity_keys: ['a'], created_at: 1_000 }));
    store.saveThing(thing({ thing_id: 'mthing_new', identity_keys: ['a', 'c'], created_at: 2_000 }));
    // The index as it was: one thing per key, the first to hold it.
    db.exec(`DROP TABLE mail_fact_thing_key;
      CREATE TABLE mail_fact_thing_key (type TEXT NOT NULL, identity_key TEXT NOT NULL, thing_id TEXT NOT NULL,
        PRIMARY KEY (type, identity_key));
      CREATE INDEX idx_mail_fact_thing_key_thing ON mail_fact_thing_key(thing_id);
      INSERT INTO mail_fact_thing_key VALUES ('shipment', 'a', 'mthing_old'), ('shipment', 'c', 'mthing_new');`);
    ensureMailFactSchema(db);
    expect(store.thingIdsByKeys('shipment', ['a'])).toEqual(['mthing_old', 'mthing_new']);
    // Rebuilt once: a second open finds nothing to do.
    expect(() => ensureMailFactSchema(db)).not.toThrow();
    expect(store.thingIdsByKeys('shipment', ['a', 'c'])).toEqual(['mthing_old', 'mthing_new']);
  });

  it('prefers the oldest thing when keys point at different things', () => {
    store.saveThing(thing({ thing_id: 'mthing_new', identity_keys: ['b'], created_at: 2_000 }));
    store.saveThing(thing({ thing_id: 'mthing_old', identity_keys: ['a'], created_at: 1_000 }));
    expect(store.findThingIdByKeys('shipment', ['b', 'a'])).toBe('mthing_old');
  });

  it('lists things by state', () => {
    store.saveThing(thing());
    store.saveThing(thing({ thing_id: 'mthing_2', identity_keys: ['k2'], variables: { state: 'in_transit' } }));
    expect(store.listThings({ state: 'delivered' }).map((t) => t.thing_id)).toEqual(['mthing_1']);
  });

  it('moves a re-keyed email’s facts, and finds facts of deleted emails for the cascade', () => {
    store.insertFact(fact());
    expect(store.rekeyEmail('work', 'mail:aaa', 'mail:bbb')).toBe(1);
    expect(store.factsForEmails('work', ['mail:bbb']).map((f) => f.fact_id)).toEqual(['mfact_a']);
    store.deleteFacts(['mfact_a']);
    expect(store.getFact('mfact_a')).toBeNull();
  });
});

describe('slice 2: unpaired facts and the standards switch', () => {
  it('rebuilds a slice-1 table whose thing_id was NOT NULL, keeping its rows and its indexes', () => {
    const old = new Database(join(dir, 'slice1.db'));
    old.exec(`CREATE TABLE mail_fact (
      fact_id TEXT PRIMARY KEY, type TEXT NOT NULL, template_id TEXT, email_slug TEXT NOT NULL,
      email_record_id TEXT NOT NULL, email_at INTEGER NOT NULL, position INTEGER NOT NULL,
      thing_id TEXT NOT NULL, identity_keys_blob TEXT NOT NULL, variables_blob TEXT NOT NULL,
      passes_blob TEXT NOT NULL, data_blob TEXT, missing_blob TEXT NOT NULL, refused_blob TEXT NOT NULL,
      complete INTEGER NOT NULL, source_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL);
      CREATE INDEX idx_mail_fact_email ON mail_fact(email_slug, email_record_id);`);
    old.prepare(`INSERT INTO mail_fact VALUES ('mfact_old','shipment','mtpl_1','work','mail:1',5,0,'mthing_1',
      '[]','{}','{}',NULL,'[]','[]',1,'h',1,9)`).run();
    try {
      const rebuilt = createMailFactStore(old);
      const column = (old.prepare('PRAGMA table_info(mail_fact)').all() as { name: string; notnull: number }[])
        .find((c) => c.name === 'thing_id');
      expect(column?.notnull).toBe(0);
      expect(rebuilt.getFact('mfact_old')?.thing_id).toBe('mthing_1');
      const indexes = (old.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mail_fact' AND name NOT LIKE 'sqlite_autoindex%'`).all() as {
        name: string;
      }[]).map((i) => i.name).sort();
      expect(indexes).toEqual(['idx_mail_fact_email', 'idx_mail_fact_thing', 'idx_mail_fact_type_at']);
      rebuilt.insertFact(fact({ fact_id: 'mfact_unpaired', thing_id: null }));
      expect(rebuilt.getFact('mfact_unpaired')?.thing_id).toBeNull();
      // A second open finds nothing to rebuild.
      expect(() => createMailFactStore(old)).not.toThrow();
    } finally {
      old.close();
    }
  });

  it('switches the standards pass per type, on by default', () => {
    expect([...store.standardsOff()]).toEqual([]);
    store.setStandardsOn('shipment', false);
    store.setStandardsOn('shipment', false);
    expect([...store.standardsOff()]).toEqual(['shipment']);
    store.setStandardsOn('shipment', true);
    expect([...store.standardsOff()]).toEqual([]);
  });
});

describe('owner types', () => {
  it('saves and lists an owner type', () => {
    store.saveCustomType({
      id: 'custom_wine_club',
      name: 'Wine club',
      description: 'A shipment from the club.',
      variables: [{ name: 'box_id', kind: 'id', required: true }],
      states: ['shipped'],
      notices: [],
      identity: [['box_id']],
    });
    expect(store.getCustomType('custom_wine_club')?.name).toBe('Wine club');
    expect(store.listCustomTypes()).toHaveLength(1);
  });
});
