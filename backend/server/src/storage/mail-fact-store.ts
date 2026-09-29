/**
 * D-315 — the mail-facts store: templates, owner types, facts and things.
 *
 * Core tables in the warehouse database (spec §5, ruling 1), never synced and
 * never sent to the cloud. Encrypted at rest with the whole file (D-212), like
 * every warehouse table — no per-column seal.
 *
 *   mail_template        every template, its definition, origin and health
 *   mail_fact_type       owner-created types (built-in types are code)
 *   mail_fact            one row per fact: one email can have several
 *   mail_fact_thing      one row per thing, DERIVED from its facts (thing-fold)
 *   mail_fact_thing_key  identity key → every thing that holds it, so a fact
 *                        finds the things that share ANY of its keys
 *                        (`merchant + return_id` or `merchant + order_id`)
 *   mail_fact_run        a recipe run a thing's event started, against the
 *                        email that caused it (§6.4); it goes with the email
 *   mail_fact_sender_dismissed  senders the owner dismissed from "Senders
 *                        without a template" (§6.5); they stay dismissed
 *   mail_fact_ai_job     the AI pass queued per email and template (§4.3), so
 *                        a restart loses nothing; it goes with the email
 *   mail_fact_email      each email the writer has read: what it read (so a
 *                        restart's re-list reads nothing again, ruling 13),
 *                        whether it is news not yet delivered, and why it was
 *                        skipped; it goes with the email
 *
 * The store is deliberately plain: which facts exist, how a thing folds and
 * which events fire are the fact writer's. Every write the writer makes for one
 * email goes through `transaction`.
 *
 * Spec: D-315 §5, §5.3.
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import type {
  MailFact,
  MailFactAi,
  MailFactEmailRef,
  MailFactPass,
  MailFactRefusal,
  MailFactRowsCursor,
  MailFactRunOutcome,
  MailFactThing,
  MailFactTypeId,
  MailFactTypeSpec,
  MailFactValue,
  MailTemplate,
  MailTemplateDefinition,
  MailTemplateHealth,
  MailTemplateOrigin,
} from '@recued/contracts';

export interface MailFactStoreOptions {
  readonly now?: () => number;
  readonly mintId?: (prefix: 'mtpl' | 'mfact' | 'mthing' | 'maijob') => string;
}

export interface MailTemplateCreateInput {
  readonly definition: MailTemplateDefinition;
  readonly origin: MailTemplateOrigin;
  readonly active?: boolean;
}

export interface MailTemplatePatch {
  readonly definition?: MailTemplateDefinition;
  readonly active?: boolean;
}

export type MailTemplateOutcomeKind = 'no_match' | 'not_entered' | 'entered';

export interface MailFactListQuery {
  readonly type?: string;
  readonly thing_id?: string;
  readonly email?: MailFactEmailRef;
  /** Facts whose email is on or after this time. */
  readonly since?: number;
  readonly limit?: number;
}

export interface MailFactThingListQuery {
  readonly type?: string;
  readonly state?: string;
  /** Things updated on or after this time. */
  readonly since?: number;
  readonly limit?: number;
}

/** A recipe run a thing's event started (§6.4), against the email whose facts
 *  caused the event. The audit log's `trigger_fired` names only the thing,
 *  which a later email's facts share. */
export interface MailFactRunLink {
  readonly email: MailFactEmailRef;
  readonly thing_id: string;
  readonly trigger_id: string;
  readonly recipe_id: string;
  readonly run_id?: string;
  readonly outcome: MailFactRunOutcome;
  readonly at: number;
}

/** The facts list's filters (§6.4). */
/** §4.3 — one queued AI call: one email, one template. */
export interface MailFactAiJob {
  /** New each time the job is queued: an answer to an older reading of the
   *  email settles nothing the newer one queued. */
  readonly job_id: string;
  readonly email: MailFactEmailRef;
  readonly template_id: string;
  /** Whether the facts, once placed, may start recipes (§5). */
  readonly may_trigger: boolean;
  readonly origin?: 'backfill';
  readonly attempts: number;
  readonly queued_at: number;
}

/** A fact with what only the writer reads: which revision of its template
 *  read it, whether its news was delivered, and the thing it was on before a
 *  re-read made it wait for the AI (so it returns to it). */
export interface StoredMailFact extends MailFact {
  readonly template_revision: number | null;
  readonly announced: boolean;
  readonly prior_thing_id: string | null;
  /** Its email's place in the order mail was first read (the ledger's
   *  `arrival`), read with a thing's facts: of two emails of one date, the one
   *  read after is the newer (§5). */
  readonly arrival?: number;
}

/** §5 — what the writer knows of one email. */
export interface MailFactEmailLedger {
  readonly email: MailFactEmailRef;
  /** The content fingerprint of its last reading; `null` until it is read. */
  readonly fingerprint: string | null;
  /** Its labels and its sender's relationships when it was last read,
   *  lower-case, relationships as `relationship:<name>`. */
  readonly labels: readonly string[];
  readonly read_at: number | null;
  /** News not yet delivered: it was seen for the first time and its facts
   *  have not been read since. */
  readonly news: boolean;
  readonly skipped: 'security_notice' | null;
  /** The email as its sender wrote it — its Message-ID, subject and text —
   *  so a copy found under another id is known (§5); `null` without a
   *  Message-ID, or until it is read. */
  readonly copy_key?: string | null;
  /** The template revisions (`<template_id>@<revision>`) whose health this
   *  email counted: a second backfill counts nothing again. */
  readonly counted: readonly string[];
  /** The date its facts are ordered by, fixed when it is first read: its own
   *  date, never later than when it was read. Read again later — a backfill —
   *  a future-dated email keeps it, and never moves past mail that came
   *  since. Once set it does not change; `null` until it is read. */
  readonly email_at?: number | null;
  /** Its place in the order mail was first read, set then and never again:
   *  of two emails of one date, the later is the newer — to the thing's fold
   *  and to a backfill's replay alike. A random id decided it. `null` until
   *  it is read. */
  readonly arrival?: number | null;
}

export interface MailFactPageQuery {
  readonly type?: string;
  /** The thing's state, or an unpaired fact's own. */
  readonly state?: string;
  readonly notice?: string;
  /** `null` ⇒ facts the standards pass read alone. */
  readonly template_id?: string | null;
  readonly complete?: boolean;
  readonly unpaired?: boolean;
  readonly has_run?: boolean;
  readonly email?: MailFactEmailRef;
  readonly before?: MailFactRowsCursor;
  /** Emails per page. */
  readonly limit: number;
}

export interface MailFactPageEmail {
  readonly email: MailFactEmailRef;
  readonly email_at: number;
  /** The email's facts that meet the filters, in the email's own order. */
  readonly facts: readonly MailFact[];
}

export interface MailFactStore {
  transaction<T>(fn: () => T): T;

  createTemplate(input: MailTemplateCreateInput): MailTemplate;
  updateTemplate(template_id: string, patch: MailTemplatePatch): MailTemplate | null;
  deleteTemplate(template_id: string): boolean;
  getTemplate(template_id: string): MailTemplate | null;
  listTemplates(query?: { readonly type?: string; readonly active?: boolean }): MailTemplate[];
  recordTemplateOutcome(
    template_id: string,
    outcome: MailTemplateOutcomeKind,
    at: number,
    warnings?: readonly string[],
  ): void;

  /** The standards types the owner switched off (ruling 10); the rest are on. */
  standardsOff(): ReadonlySet<string>;
  setStandardsOn(type: string, on: boolean): void;

  saveCustomType(spec: MailFactTypeSpec): void;
  getCustomType(type_id: string): MailFactTypeSpec | null;
  listCustomTypes(): MailFactTypeSpec[];
  /** §4.5 — an owner type goes, and with it every fact and thing of it (they
   *  are derived, and nothing can read them again without the type). The
   *  caller refuses while a template still reads it. */
  deleteCustomType(type_id: string): boolean;

  getFact(fact_id: string): MailFact | null;
  /** The writer's view of a fact: what only it reads, too. */
  getFactRecord(fact_id: string): StoredMailFact | null;
  factsForEmail(email: MailFactEmailRef): MailFact[];
  factRecordsForEmail(email: MailFactEmailRef): StoredMailFact[];
  factsForThing(thing_id: string): MailFact[];
  /** A thing's facts with what only the writer reads — whether each was
   *  announced. */
  factRecordsForThing(thing_id: string): StoredMailFact[];
  listFacts(query?: MailFactListQuery): MailFact[];
  insertFact(fact: MailFact & Partial<Pick<StoredMailFact, 'template_revision' | 'announced' | 'prior_thing_id'>>): void;
  /** Rewrite a fact in place, keeping its id: a re-read replaces its reading,
   *  and the AI pass fills it and places it (§4.3). */
  updateFact(fact: MailFact & Partial<Pick<StoredMailFact, 'template_revision' | 'announced' | 'prior_thing_id'>>): void;
  /** §4.3 — queue the AI pass for one email's facts of one template. A job
   *  queued again replaces the one waiting, with a new id; news it carried
   *  stays news, and live mail stays live. */
  enqueueAiJob(job: MailFactAiJob): void;
  /** The job as it is stored now — a backfill may have promoted it to carry
   *  news since the runner read it; `null` once replaced or settled. */
  getAiJob(job_id: string): MailFactAiJob | null;
  /** A job queued silently carries news now (a backfill that runs recipes
   *  reached its email). Its id stays, so the call in flight still settles it. */
  promoteAiJob(email: MailFactEmailRef, template_id: string, origin: 'backfill' | null): void;
  /** News another id of the email held, carried to its job for the template:
   *  the job carries news now, and live news stays live (§5). */
  carryAiNews(email: MailFactEmailRef, template_id: string, origin: 'backfill' | null): void;
  aiJobsForEmail(email: MailFactEmailRef): MailFactAiJob[];
  /** The next job: mail that may start recipes first, then live mail before a
   *  backfill's, then the oldest — leaving out the mailboxes in `skip`. */
  nextAiJob(skip?: ReadonlySet<string>): MailFactAiJob | null;
  countAiJobs(skip?: ReadonlySet<string>): number;
  bumpAiJobAttempts(job_id: string): void;
  /** Only that job: one queued again since has a new id and stays. */
  deleteAiJob(job_id: string): void;
  deleteAiJobsForEmails(slug: string, record_ids: readonly string[]): void;
  /** One email's job for one template. */
  deleteAiJobFor(email: MailFactEmailRef, template_id: string): void;
  deleteFacts(fact_ids: readonly string[]): void;
  /** Facts of these emails, for the deletion cascade. */
  factsForEmails(slug: string, record_ids: readonly string[]): MailFact[];
  /** A moved email keeps its facts, their runs, its AI jobs and what the
   *  writer knows of it, under its new id — at once, or not at all. */
  rekeyEmail(slug: string, old_record_id: string, new_record_id: string): number;
  /** An email's runs, under its new id (a move the new id was read under first). */
  moveRuns(slug: string, old_record_id: string, new_record_id: string): void;
  /** Facts of a moved email its new id's reading did not read — a template's
   *  or a standards kind's switched off since — under the new id, dated as the
   *  email is there, with the calls they wait on (§4.3). */
  moveFacts(from: MailFactEmailRef, to: MailFactEmailRef, fact_ids: readonly string[], email_at: number): void;
  /** A moved email's old id names its new one, so a run that ends after the
   *  move is linked where the email is now (§6.4). Earlier moves of it lead
   *  there too. */
  recordEmailMove(slug: string, old_record_id: string, new_record_id: string, at: number): void;
  /** Where a moved email is now; `null` for one that did not move. */
  emailMovedTo(email: MailFactEmailRef): MailFactEmailRef | null;
  /** The ids a move took the email from, the one it was first read under
   *  among them — what its attachments' files are named by (§6.4). */
  formerEmailIds(slug: string, record_id: string): string[];
  /** The deletion cascade: no old id leads to a deleted email. */
  deleteEmailMovesTo(slug: string, record_ids: readonly string[]): void;

  getEmailLedger(email: MailFactEmailRef): MailFactEmailLedger | null;
  saveEmailLedger(ledger: MailFactEmailLedger): void;
  /** The email was seen for the first time and is news (§5): a stop or a crash
   *  before its facts are read does not make it past mail. */
  markEmailNews(email: MailFactEmailRef): void;
  deleteEmailLedgers(slug: string, record_ids: readonly string[]): void;
  /** The ledger of the email of the mailbox first read with this copy key —
   *  the one a copy found again under another id is (§5) — or `null`. */
  emailCopyOf(slug: string, copy_key: string, except_record_id: string): MailFactEmailLedger | null;
  /** A move made `email` the one an earlier email was: when that one was read
   *  first, its place in the order mail was first read and its date become
   *  this one's — on the ledger and on its facts (§5). Whether they did. */
  takeEarlierReading(email: MailFactEmailRef, arrival: number, email_at: number): boolean;
  /** The emails holding a template's facts (§6.3): a backfill reads each again,
   *  however its conditions have changed since. */
  emailsWithTemplateFacts(template_id: string): MailFactEmailRef[];
  /** Every email of a mailbox anything here names — a ledger row, a fact, a
   *  queued AI call or a run — by id, after `after`, `limit` at a time. */
  emailIdsOf(slug: string, after: string | null, limit: number): string[];
  /** Emails newest first, a page at a time, with their facts that meet the
   *  filters; `more` when another page follows. */
  listFactPage(query: MailFactPageQuery): { readonly emails: MailFactPageEmail[]; readonly more: boolean };

  recordRun(run: MailFactRunLink): void;
  /** The runs one email's facts started, oldest first. */
  runsForEmail(email: MailFactEmailRef): MailFactRunLink[];
  /** The deletion cascade: an email's runs go with it. */
  deleteRunsForEmails(slug: string, record_ids: readonly string[]): void;

  /** The stored emails of a mailbox dated on or after `since` that gave a fact. */
  emailsWithFactsSince(slug: string, since: number): ReadonlySet<string>;
  /** Lower-case addresses. */
  dismissedSenders(): string[];
  setSenderDismissed(address: string, dismissed: boolean): void;

  getThing(thing_id: string): MailFactThing | null;
  listThings(query?: MailFactThingListQuery): MailFactThing[];
  /** The oldest thing that holds any of these keys. */
  findThingIdByKeys(type: string, keys: readonly string[]): string | null;
  /** Every thing that holds any of these keys, oldest first — by the index. */
  thingIdsByKeys(type: string, keys: readonly string[]): string[];
  /** Every thing of a type that holds any of these keys, oldest first — by
   *  the things' own keys, so a key two things share finds both. */
  thingsHoldingKeys(type: string, keys: readonly string[]): MailFactThing[];
  saveThing(thing: MailFactThing): void;
  /** A thing goes; a key another thing also has now names that one. */
  deleteThing(thing_id: string): void;
  /** Two things were one: `from`'s facts, runs and waiting facts move to
   *  `to`, and `from` goes. The caller re-folds `to`. */
  mergeThings(from: string, to: string): void;

  mintId(prefix: 'mtpl' | 'mfact' | 'mthing' | 'maijob'): string;
}

/** One definition for creating the fact table and for rebuilding a slice-1 one. */
const MAIL_FACT_TABLE = `
    CREATE TABLE IF NOT EXISTS mail_fact (
      fact_id            TEXT PRIMARY KEY,
      type               TEXT NOT NULL,
      template_id        TEXT,
      email_slug         TEXT NOT NULL,
      email_record_id    TEXT NOT NULL,
      email_at           INTEGER NOT NULL,
      position           INTEGER NOT NULL,
      thing_id           TEXT,
      identity_keys_blob TEXT NOT NULL,
      variables_blob     TEXT NOT NULL,
      passes_blob        TEXT NOT NULL,
      data_blob          TEXT,
      missing_blob       TEXT NOT NULL,
      refused_blob       TEXT NOT NULL,
      complete           INTEGER NOT NULL,
      source_hash        TEXT NOT NULL,
      revision           INTEGER NOT NULL DEFAULT 1,
      created_at         INTEGER NOT NULL,
      ai_blob            TEXT,
      template_revision  INTEGER,
      announced          INTEGER NOT NULL DEFAULT 0,
      prior_thing_id     TEXT
    );
`;

/** A key names every thing that holds it. It named only the first: a thing
 *  whose keys were each held by an older thing it disagrees with — (X, TWO)
 *  after (X, ONE) and (Y, TWO) — could not be found, and the next email about
 *  it started another. */
const MAIL_FACT_THING_KEY_TABLE = `
    CREATE TABLE IF NOT EXISTS mail_fact_thing_key (
      type         TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      thing_id     TEXT NOT NULL,
      PRIMARY KEY (type, identity_key, thing_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mail_fact_thing_key_thing ON mail_fact_thing_key(thing_id);
`;

export const ensureMailFactSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_template (
      template_id     TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      name            TEXT NOT NULL,
      definition_blob TEXT NOT NULL,
      origin_blob     TEXT NOT NULL,
      active          INTEGER NOT NULL DEFAULT 1,
      revision        INTEGER NOT NULL DEFAULT 1,
      health_blob     TEXT NOT NULL DEFAULT '{}',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_template_type ON mail_template(type, active);

    CREATE TABLE IF NOT EXISTS mail_fact_type (
      type_id    TEXT PRIMARY KEY,
      spec_blob  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mail_fact_thing (
      thing_id               TEXT PRIMARY KEY,
      type                   TEXT NOT NULL,
      identity_keys_blob     TEXT NOT NULL,
      variables_blob         TEXT NOT NULL,
      passes_blob            TEXT NOT NULL,
      variable_email_at_blob TEXT NOT NULL,
      missing_blob           TEXT NOT NULL,
      complete               INTEGER NOT NULL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      last_email_at          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mail_fact_thing_type ON mail_fact_thing(type, updated_at);

    ${MAIL_FACT_THING_KEY_TABLE}

    ${MAIL_FACT_TABLE}

    CREATE TABLE IF NOT EXISTS mail_fact_standards_off (
      type       TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mail_fact_run (
      email_slug      TEXT NOT NULL,
      email_record_id TEXT NOT NULL,
      thing_id        TEXT NOT NULL,
      trigger_id      TEXT NOT NULL,
      recipe_id       TEXT NOT NULL,
      run_id          TEXT,
      outcome         TEXT NOT NULL,
      at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_fact_run_email ON mail_fact_run(email_slug, email_record_id, thing_id);
    -- A thing's runs: a kind's deletion and a merge re-point or drop them by thing.
    CREATE INDEX IF NOT EXISTS idx_mail_fact_run_thing ON mail_fact_run(thing_id);

    -- §6.4: a moved email's old id, and where it went. A run that ends after
    -- the move is linked there; the row goes when the email it leads to does.
    CREATE TABLE IF NOT EXISTS mail_fact_email_move (
      email_slug     TEXT NOT NULL,
      from_record_id TEXT NOT NULL,
      to_record_id   TEXT NOT NULL,
      at             INTEGER NOT NULL,
      PRIMARY KEY (email_slug, from_record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mail_fact_email_move_to ON mail_fact_email_move(email_slug, to_record_id);

    CREATE TABLE IF NOT EXISTS mail_fact_sender_dismissed (
      address      TEXT PRIMARY KEY,
      dismissed_at INTEGER NOT NULL
    );

    -- §4.3: one AI call per email and template, queued so a restart loses
    -- nothing. The facts it fills wait on it (ai_blob state 'waiting').
    CREATE TABLE IF NOT EXISTS mail_fact_ai_job (
      job_id          TEXT NOT NULL,
      email_slug      TEXT NOT NULL,
      email_record_id TEXT NOT NULL,
      template_id     TEXT NOT NULL,
      may_trigger     INTEGER NOT NULL,
      origin          TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      queued_at       INTEGER NOT NULL,
      PRIMARY KEY (email_slug, email_record_id, template_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mail_fact_ai_job_queued ON mail_fact_ai_job(queued_at);

    -- §5, ruling 13: each email the writer has read, so a restart's re-list
    -- reads nothing again, and news survives a stop before its facts are read.
    CREATE TABLE IF NOT EXISTS mail_fact_email (
      email_slug      TEXT NOT NULL,
      email_record_id TEXT NOT NULL,
      fingerprint     TEXT,
      labels_blob     TEXT NOT NULL DEFAULT '[]',
      read_at         INTEGER,
      news            INTEGER NOT NULL DEFAULT 0,
      skipped         TEXT,
      counted_blob    TEXT NOT NULL DEFAULT '[]',
      copy_key        TEXT,
      email_at        INTEGER,
      arrival         INTEGER,
      PRIMARY KEY (email_slug, email_record_id)
    );
  `);
  const ledgerColumns = (db.prepare('PRAGMA table_info(mail_fact_email)').all() as { name: string }[]).map((column) => column.name);
  // Which template revisions counted an email's health, so none counts twice.
  if (!ledgerColumns.includes('counted_blob')) {
    db.exec("ALTER TABLE mail_fact_email ADD COLUMN counted_blob TEXT NOT NULL DEFAULT '[]'");
  }
  // The same email found again under another id is not news (§5).
  if (!ledgerColumns.includes('copy_key')) {
    db.exec('ALTER TABLE mail_fact_email ADD COLUMN copy_key TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_fact_email_copy ON mail_fact_email(email_slug, copy_key)');
  // An email's date, fixed when it is first read (§5). A row from before has
  // none: its next reading keeps the date its facts have.
  if (!ledgerColumns.includes('email_at')) db.exec('ALTER TABLE mail_fact_email ADD COLUMN email_at INTEGER');
  // The order mail was first read in; a row from before has none, and sorts
  // before every row that has one — it was read before them.
  if (!ledgerColumns.includes('arrival')) db.exec('ALTER TABLE mail_fact_email ADD COLUMN arrival INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS mail_fact_email_arrival ON mail_fact_email (arrival)');
  // The key index as it was — one thing per key — is rebuilt from the things.
  const keyColumns = db.prepare('PRAGMA table_info(mail_fact_thing_key)').all() as { name: string; pk: number }[];
  if (keyColumns.find((column) => column.name === 'thing_id')?.pk === 0) {
    db.transaction(() => {
      db.exec('DROP TABLE mail_fact_thing_key');
      db.exec(MAIL_FACT_THING_KEY_TABLE);
      db.exec(`INSERT OR IGNORE INTO mail_fact_thing_key (type, identity_key, thing_id)
        SELECT t.type, k.value, t.thing_id FROM mail_fact_thing t, json_each(t.identity_keys_blob) k`);
    })();
  }
  // Slice 1 made `thing_id` NOT NULL; an unpaired standards fact (slice 2)
  // has none. SQLite cannot relax a constraint in place, so a table made
  // then is rebuilt once. The indexes come after: a renamed table keeps its
  // index names, and they go with it when it is dropped.
  const thingColumn = (db.prepare('PRAGMA table_info(mail_fact)').all() as { name: string; notnull: number }[])
    .find((column) => column.name === 'thing_id');
  if (thingColumn?.notnull === 1) {
    db.transaction(() => {
      const columns = (db.prepare('PRAGMA table_info(mail_fact)').all() as { name: string }[])
        .map((column) => column.name)
        .join(', ');
      db.exec('ALTER TABLE mail_fact RENAME TO mail_fact_before_unpaired');
      db.exec(MAIL_FACT_TABLE);
      db.exec(`INSERT INTO mail_fact (${columns}) SELECT ${columns} FROM mail_fact_before_unpaired`);
      db.exec('DROP TABLE mail_fact_before_unpaired');
    })();
  }
  // Slice 4 adds the AI pass's state to a fact (§4.3).
  const factColumns = (db.prepare('PRAGMA table_info(mail_fact)').all() as { name: string }[]).map((column) => column.name);
  if (!factColumns.includes('ai_blob')) db.exec('ALTER TABLE mail_fact ADD COLUMN ai_blob TEXT');
  // What only the writer reads (ruling 13). A fact from before was delivered,
  // or never will be: a backfill does not announce it again.
  if (!factColumns.includes('template_revision')) {
    db.transaction(() => {
      db.exec('ALTER TABLE mail_fact ADD COLUMN template_revision INTEGER');
      db.exec('ALTER TABLE mail_fact ADD COLUMN announced INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE mail_fact ADD COLUMN prior_thing_id TEXT');
      db.exec('UPDATE mail_fact SET announced = 1');
    })();
  }
  // Ruling 44 adds when a thing's newest email arrived, taken once from its facts.
  const thingColumns = (db.prepare('PRAGMA table_info(mail_fact_thing)').all() as { name: string }[]).map((column) => column.name);
  if (!thingColumns.includes('last_email_at')) {
    db.transaction(() => {
      db.exec('ALTER TABLE mail_fact_thing ADD COLUMN last_email_at INTEGER NOT NULL DEFAULT 0');
      db.exec(`UPDATE mail_fact_thing SET last_email_at = COALESCE(
        (SELECT MAX(f.email_at) FROM mail_fact f WHERE f.thing_id = mail_fact_thing.thing_id), 0)`);
    })();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mail_fact_email ON mail_fact(email_slug, email_record_id);
    CREATE INDEX IF NOT EXISTS idx_mail_fact_thing ON mail_fact(thing_id);
    CREATE INDEX IF NOT EXISTS idx_mail_fact_type_at ON mail_fact(type, email_at);
  `);
};

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

interface TemplateRow {
  template_id: string;
  type: string;
  name: string;
  definition_blob: string;
  origin_blob: string;
  active: number;
  revision: number;
  health_blob: string;
  created_at: number;
  updated_at: number;
}

interface FactRow {
  fact_id: string;
  type: string;
  template_id: string | null;
  email_slug: string;
  email_record_id: string;
  email_at: number;
  position: number;
  thing_id: string | null;
  identity_keys_blob: string;
  variables_blob: string;
  passes_blob: string;
  data_blob: string | null;
  missing_blob: string;
  refused_blob: string;
  complete: number;
  source_hash: string;
  revision: number;
  created_at: number;
  ai_blob: string | null;
  template_revision: number | null;
  announced: number;
  prior_thing_id: string | null;
}

interface ThingRow {
  thing_id: string;
  type: string;
  identity_keys_blob: string;
  variables_blob: string;
  passes_blob: string;
  variable_email_at_blob: string;
  missing_blob: string;
  complete: number;
  created_at: number;
  updated_at: number;
  last_email_at: number;
}

const EMPTY_HEALTH: MailTemplateHealth = { matched: 0, entered: 0, not_entered: 0 };

const templateFromRow = (row: TemplateRow): MailTemplate => {
  const definition = parse<MailTemplateDefinition>(row.definition_blob, {} as MailTemplateDefinition);
  return {
    ...definition,
    template_id: row.template_id,
    type: row.type as MailFactTypeId,
    name: row.name,
    origin: parse<MailTemplateOrigin>(row.origin_blob, { kind: 'owner' }),
    active: row.active === 1,
    revision: row.revision,
    health: { ...EMPTY_HEALTH, ...parse<Partial<MailTemplateHealth>>(row.health_blob, {}) },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const factFromRow = (row: FactRow): MailFact => ({
  fact_id: row.fact_id,
  type: row.type as MailFactTypeId,
  template_id: row.template_id,
  email: { slug: row.email_slug, record_id: row.email_record_id },
  email_at: row.email_at,
  position: row.position,
  thing_id: row.thing_id,
  identity_keys: parse<string[]>(row.identity_keys_blob, []),
  variables: parse<Record<string, MailFactValue | null>>(row.variables_blob, {}),
  passes: parse<Record<string, MailFactPass>>(row.passes_blob, {}),
  data: parse<unknown>(row.data_blob, null),
  missing: parse<string[]>(row.missing_blob, []),
  refused: parse<MailFactRefusal[]>(row.refused_blob, []),
  complete: row.complete === 1,
  source_hash: row.source_hash,
  revision: row.revision,
  created_at: row.created_at,
  ...(row.ai_blob !== null && row.ai_blob !== undefined ? { ai: parse<MailFactAi>(row.ai_blob, { state: 'not_read', reason: 'unreadable', at: 0 }) } : {}),
});

const factRecordFromRow = (row: FactRow): StoredMailFact => ({
  ...factFromRow(row),
  template_revision: row.template_revision ?? null,
  announced: row.announced === 1,
  prior_thing_id: row.prior_thing_id ?? null,
});

interface LedgerRow {
  email_slug: string;
  email_record_id: string;
  fingerprint: string | null;
  labels_blob: string;
  read_at: number | null;
  news: number;
  skipped: string | null;
  counted_blob: string;
  copy_key: string | null;
  email_at: number | null;
  arrival: number | null;
}

const ledgerFromRow = (row: LedgerRow): MailFactEmailLedger => ({
  email: { slug: row.email_slug, record_id: row.email_record_id },
  fingerprint: row.fingerprint,
  labels: parse<string[]>(row.labels_blob, []),
  read_at: row.read_at,
  news: row.news === 1,
  skipped: row.skipped === 'security_notice' ? 'security_notice' : null,
  counted: parse<string[]>(row.counted_blob, []),
  copy_key: row.copy_key,
  email_at: row.email_at,
  arrival: row.arrival,
});

const thingFromRow = (row: ThingRow): MailFactThing => ({
  thing_id: row.thing_id,
  type: row.type as MailFactTypeId,
  identity_keys: parse<string[]>(row.identity_keys_blob, []),
  variables: parse<Record<string, MailFactValue | null>>(row.variables_blob, {}),
  passes: parse<Record<string, MailFactPass>>(row.passes_blob, {}),
  variable_email_at: parse<Record<string, number>>(row.variable_email_at_blob, {}),
  last_email_at: row.last_email_at,
  missing: parse<string[]>(row.missing_blob, []),
  complete: row.complete === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const definitionOf = (template: MailTemplateDefinition): MailTemplateDefinition => ({
  name: template.name,
  type: template.type,
  entrance: template.entrance,
  rules: template.rules,
  ...(template.repeat !== undefined ? { repeat: template.repeat } : {}),
  html: template.html,
  ai: template.ai,
});

interface RunRow {
  email_slug: string;
  email_record_id: string;
  thing_id: string;
  trigger_id: string;
  recipe_id: string;
  run_id: string | null;
  outcome: string;
  at: number;
}

interface AiJobRow {
  job_id: string;
  email_slug: string;
  email_record_id: string;
  template_id: string;
  may_trigger: number;
  origin: string | null;
  attempts: number;
  queued_at: number;
}

const aiJobFromRow = (row: AiJobRow): MailFactAiJob => ({
  job_id: row.job_id,
  email: { slug: row.email_slug, record_id: row.email_record_id },
  template_id: row.template_id,
  may_trigger: row.may_trigger === 1,
  ...(row.origin === 'backfill' ? { origin: 'backfill' as const } : {}),
  attempts: row.attempts,
  queued_at: row.queued_at,
});

const runFromRow = (row: RunRow): MailFactRunLink => ({
  email: { slug: row.email_slug, record_id: row.email_record_id },
  thing_id: row.thing_id,
  trigger_id: row.trigger_id,
  recipe_id: row.recipe_id,
  ...(row.run_id !== null ? { run_id: row.run_id } : {}),
  outcome: row.outcome as MailFactRunOutcome,
  at: row.at,
});

/** The facts list's filters over `mail_fact f LEFT JOIN mail_fact_thing t`. */
const pageFilters = (query: MailFactPageQuery): { where: string[]; params: unknown[] } => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.type !== undefined) {
    where.push('f.type = ?');
    params.push(query.type);
  }
  if (query.state !== undefined) {
    // What the row shows: the thing's state, or an unpaired fact's own.
    where.push("COALESCE(json_extract(t.variables_blob, '$.state'), json_extract(f.variables_blob, '$.state')) = ?");
    params.push(query.state);
  }
  if (query.notice !== undefined) {
    where.push("json_extract(f.variables_blob, '$.notice') = ?");
    params.push(query.notice);
  }
  if (query.template_id === null) where.push('f.template_id IS NULL');
  else if (query.template_id !== undefined) {
    where.push('f.template_id = ?');
    params.push(query.template_id);
  }
  if (query.complete !== undefined) {
    where.push('f.complete = ?');
    params.push(query.complete ? 1 : 0);
  }
  // A fact waiting for the AI has no thing yet, and is not unpaired.
  if (query.unpaired !== undefined) {
    where.push(query.unpaired
      ? "f.thing_id IS NULL AND COALESCE(json_extract(f.ai_blob, '$.state'), '') <> 'waiting'"
      : 'f.thing_id IS NOT NULL');
  }
  if (query.has_run !== undefined) {
    where.push(`${query.has_run ? '' : 'NOT '}EXISTS (
      SELECT 1 FROM mail_fact_run r
       WHERE r.email_slug = f.email_slug AND r.email_record_id = f.email_record_id AND r.thing_id = f.thing_id)`);
  }
  if (query.email !== undefined) {
    where.push('f.email_slug = ? AND f.email_record_id = ?');
    params.push(query.email.slug, query.email.record_id);
  }
  return { where, params };
};

const MAX_LIST = 500;
const limitOf = (limit: number | undefined): number =>
  Math.max(1, Math.min(MAX_LIST, Math.floor(limit ?? 100)));

export const createMailFactStore = (
  db: Database.Database,
  options: MailFactStoreOptions = {},
): MailFactStore => {
  ensureMailFactSchema(db);
  const now = options.now ?? Date.now;
  const mintId = options.mintId ?? ((prefix) => `${prefix}_${randomUUID()}`);

  const getTemplateRow = db.prepare<[string], TemplateRow>(
    'SELECT * FROM mail_template WHERE template_id = ?',
  );
  const getFactRow = db.prepare<[string], FactRow>('SELECT * FROM mail_fact WHERE fact_id = ?');
  const getThingRow = db.prepare<[string], ThingRow>('SELECT * FROM mail_fact_thing WHERE thing_id = ?');

  const store: MailFactStore = {
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),

    createTemplate: (input) => {
      const at = now();
      const template_id = mintId('mtpl');
      db.prepare(
        `INSERT INTO mail_template
           (template_id, type, name, definition_blob, origin_blob, active, revision, health_blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, '{}', ?, ?)`,
      ).run(
        template_id,
        input.definition.type,
        input.definition.name,
        JSON.stringify(definitionOf(input.definition)),
        JSON.stringify(input.origin),
        input.active === false ? 0 : 1,
        at,
        at,
      );
      return templateFromRow(getTemplateRow.get(template_id)!);
    },

    updateTemplate: (template_id, patch) => {
      const row = getTemplateRow.get(template_id);
      if (row === undefined) return null;
      const current = templateFromRow(row);
      const definition = patch.definition === undefined ? definitionOf(current) : definitionOf(patch.definition);
      const active = patch.active ?? current.active;
      // A definition change is a new revision: facts read by the old one are
      // re-read (their source hash includes the template revision).
      const revision = patch.definition === undefined ? current.revision : current.revision + 1;
      db.prepare(
        `UPDATE mail_template
            SET type = ?, name = ?, definition_blob = ?, active = ?, revision = ?, updated_at = ?
          WHERE template_id = ?`,
      ).run(definition.type, definition.name, JSON.stringify(definition), active ? 1 : 0, revision, now(), template_id);
      return templateFromRow(getTemplateRow.get(template_id)!);
    },

    deleteTemplate: (template_id) =>
      db.prepare('DELETE FROM mail_template WHERE template_id = ?').run(template_id).changes > 0,

    getTemplate: (template_id) => {
      const row = getTemplateRow.get(template_id);
      return row === undefined ? null : templateFromRow(row);
    },

    listTemplates: (query = {}) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.type !== undefined) {
        where.push('type = ?');
        params.push(query.type);
      }
      if (query.active !== undefined) {
        where.push('active = ?');
        params.push(query.active ? 1 : 0);
      }
      const sql = `SELECT * FROM mail_template ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY created_at ASC, template_id ASC`;
      return (db.prepare(sql).all(...params) as TemplateRow[]).map(templateFromRow);
    },

    recordTemplateOutcome: (template_id, outcome, at, warnings = []) => {
      const row = getTemplateRow.get(template_id);
      if (row === undefined) return;
      const health = { ...EMPTY_HEALTH, ...parse<Partial<MailTemplateHealth>>(row.health_blob, {}) };
      const next: MailTemplateHealth = {
        ...health,
        ...(outcome !== 'no_match'
          ? { matched: health.matched + 1, last_matched_at: at }
          : {}),
        ...(outcome === 'entered' ? { entered: health.entered + 1, last_entered_at: at } : {}),
        ...(outcome === 'not_entered' ? { not_entered: health.not_entered + 1, last_not_entered_at: at } : {}),
        ...(warnings.length > 0 ? { last_warning: warnings[0]!, last_warning_at: at } : {}),
      };
      db.prepare('UPDATE mail_template SET health_blob = ? WHERE template_id = ?').run(JSON.stringify(next), template_id);
    },

    standardsOff: () =>
      new Set(
        (db.prepare('SELECT type FROM mail_fact_standards_off').all() as { type: string }[]).map((row) => row.type),
      ),
    setStandardsOn: (type, on) => {
      if (on) db.prepare('DELETE FROM mail_fact_standards_off WHERE type = ?').run(type);
      else {
        db.prepare(
          `INSERT INTO mail_fact_standards_off (type, updated_at) VALUES (?, ?)
             ON CONFLICT(type) DO UPDATE SET updated_at = excluded.updated_at`,
        ).run(type, now());
      }
    },

    saveCustomType: (spec) => {
      const at = now();
      db.prepare(
        `INSERT INTO mail_fact_type (type_id, spec_blob, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(type_id) DO UPDATE SET spec_blob = excluded.spec_blob, updated_at = excluded.updated_at`,
      ).run(spec.id, JSON.stringify(spec), at, at);
    },

    getCustomType: (type_id) => {
      const row = db.prepare<[string], { spec_blob: string }>('SELECT spec_blob FROM mail_fact_type WHERE type_id = ?').get(type_id);
      return row === undefined ? null : parse<MailFactTypeSpec | null>(row.spec_blob, null);
    },

    listCustomTypes: () =>
      (db.prepare('SELECT spec_blob FROM mail_fact_type ORDER BY type_id').all() as { spec_blob: string }[])
        .map((row) => parse<MailFactTypeSpec | null>(row.spec_blob, null))
        .filter((spec): spec is MailFactTypeSpec => spec !== null),

    deleteCustomType: (type_id) => db.transaction(() => {
      const things = (db.prepare('SELECT thing_id FROM mail_fact_thing WHERE type = ?').all(type_id) as { thing_id: string }[])
        .map((row) => row.thing_id);
      const dropRuns = db.prepare('DELETE FROM mail_fact_run WHERE thing_id = ?');
      for (const thing_id of things) dropRuns.run(thing_id);
      db.prepare('DELETE FROM mail_fact_thing_key WHERE type = ?').run(type_id);
      db.prepare('DELETE FROM mail_fact_thing WHERE type = ?').run(type_id);
      db.prepare('DELETE FROM mail_fact WHERE type = ?').run(type_id);
      return db.prepare('DELETE FROM mail_fact_type WHERE type_id = ?').run(type_id).changes > 0;
    })(),

    getFact: (fact_id) => {
      const row = getFactRow.get(fact_id);
      return row === undefined ? null : factFromRow(row);
    },

    getFactRecord: (fact_id) => {
      const row = getFactRow.get(fact_id);
      return row === undefined ? null : factRecordFromRow(row);
    },

    factsForEmail: (email) =>
      (db.prepare(
        'SELECT * FROM mail_fact WHERE email_slug = ? AND email_record_id = ? ORDER BY type, position, fact_id',
      ).all(email.slug, email.record_id) as FactRow[]).map(factFromRow),

    factRecordsForEmail: (email) =>
      (db.prepare(
        'SELECT * FROM mail_fact WHERE email_slug = ? AND email_record_id = ? ORDER BY type, position, fact_id',
      ).all(email.slug, email.record_id) as FactRow[]).map(factRecordFromRow),

    factsForThing: (thing_id) =>
      (db.prepare('SELECT * FROM mail_fact WHERE thing_id = ? ORDER BY email_at, created_at, fact_id')
        .all(thing_id) as FactRow[]).map(factFromRow),

    factRecordsForThing: (thing_id) =>
      (db.prepare(
        `SELECT f.*, e.arrival AS email_arrival FROM mail_fact f
           LEFT JOIN mail_fact_email e ON e.email_slug = f.email_slug AND e.email_record_id = f.email_record_id
          WHERE f.thing_id = ? ORDER BY f.email_at, e.arrival, f.created_at, f.fact_id`,
      ).all(thing_id) as (FactRow & { email_arrival: number | null })[]).map((row) => ({
        ...factRecordFromRow(row),
        ...(row.email_arrival !== null ? { arrival: row.email_arrival } : {}),
      })),

    listFacts: (query = {}) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.type !== undefined) {
        where.push('type = ?');
        params.push(query.type);
      }
      if (query.thing_id !== undefined) {
        where.push('thing_id = ?');
        params.push(query.thing_id);
      }
      if (query.email !== undefined) {
        where.push('email_slug = ? AND email_record_id = ?');
        params.push(query.email.slug, query.email.record_id);
      }
      if (query.since !== undefined) {
        where.push('email_at >= ?');
        params.push(query.since);
      }
      const sql = `SELECT * FROM mail_fact ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY email_at DESC, fact_id DESC LIMIT ?`;
      return (db.prepare(sql).all(...params, limitOf(query.limit)) as FactRow[]).map(factFromRow);
    },

    insertFact: (fact) => {
      db.prepare(
        `INSERT INTO mail_fact
           (fact_id, type, template_id, email_slug, email_record_id, email_at, position, thing_id,
            identity_keys_blob, variables_blob, passes_blob, data_blob, missing_blob, refused_blob,
            complete, source_hash, revision, created_at, ai_blob, template_revision, announced, prior_thing_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fact.fact_id,
        fact.type,
        fact.template_id,
        fact.email.slug,
        fact.email.record_id,
        fact.email_at,
        fact.position,
        fact.thing_id,
        JSON.stringify(fact.identity_keys),
        JSON.stringify(fact.variables),
        JSON.stringify(fact.passes),
        fact.data === null || fact.data === undefined ? null : JSON.stringify(fact.data),
        JSON.stringify(fact.missing),
        JSON.stringify(fact.refused),
        fact.complete ? 1 : 0,
        fact.source_hash,
        fact.revision,
        fact.created_at,
        fact.ai === undefined ? null : JSON.stringify(fact.ai),
        fact.template_revision ?? null,
        fact.announced === true ? 1 : 0,
        fact.prior_thing_id ?? null,
      );
    },

    updateFact: (fact) => {
      db.prepare(
        `UPDATE mail_fact
            SET template_id = ?, email_at = ?, position = ?, thing_id = ?, identity_keys_blob = ?,
                variables_blob = ?, passes_blob = ?, data_blob = ?, missing_blob = ?, refused_blob = ?,
                complete = ?, source_hash = ?, revision = ?, ai_blob = ?,
                template_revision = COALESCE(?, template_revision),
                announced = COALESCE(?, announced),
                prior_thing_id = ?
          WHERE fact_id = ?`,
      ).run(
        fact.template_id,
        fact.email_at,
        fact.position,
        fact.thing_id,
        JSON.stringify(fact.identity_keys),
        JSON.stringify(fact.variables),
        JSON.stringify(fact.passes),
        fact.data === null || fact.data === undefined ? null : JSON.stringify(fact.data),
        JSON.stringify(fact.missing),
        JSON.stringify(fact.refused),
        fact.complete ? 1 : 0,
        fact.source_hash,
        fact.revision,
        fact.ai === undefined ? null : JSON.stringify(fact.ai),
        fact.template_revision === undefined ? null : fact.template_revision,
        fact.announced === undefined ? null : (fact.announced ? 1 : 0),
        fact.prior_thing_id ?? null,
        fact.fact_id,
      );
    },

    enqueueAiJob: (job) => {
      // Queued again: news not yet delivered stays news, with the origin it
      // came with — live mail stays live even when a backfill reads it again.
      db.prepare(
        `INSERT INTO mail_fact_ai_job
           (job_id, email_slug, email_record_id, template_id, may_trigger, origin, attempts, queued_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(email_slug, email_record_id, template_id)
           DO UPDATE SET job_id = excluded.job_id,
                         may_trigger = MAX(mail_fact_ai_job.may_trigger, excluded.may_trigger),
                         origin = CASE WHEN mail_fact_ai_job.may_trigger = 1 THEN mail_fact_ai_job.origin ELSE excluded.origin END,
                         attempts = 0, queued_at = excluded.queued_at`,
      ).run(
        job.job_id,
        job.email.slug,
        job.email.record_id,
        job.template_id,
        job.may_trigger ? 1 : 0,
        job.origin ?? null,
        job.queued_at,
      );
    },

    getAiJob: (job_id) => {
      const row = db.prepare('SELECT * FROM mail_fact_ai_job WHERE job_id = ?').get(job_id) as AiJobRow | undefined;
      return row === undefined ? null : aiJobFromRow(row);
    },

    promoteAiJob: (email, template_id, origin) => {
      db.prepare(
        `UPDATE mail_fact_ai_job SET may_trigger = 1, origin = ?
          WHERE email_slug = ? AND email_record_id = ? AND template_id = ? AND may_trigger = 0`,
      ).run(origin, email.slug, email.record_id, template_id);
    },

    carryAiNews: (email, template_id, origin) => {
      // Each column on the right is the row's before the update.
      db.prepare(
        `UPDATE mail_fact_ai_job
            SET origin = CASE WHEN ? IS NULL OR (may_trigger = 1 AND origin IS NULL) THEN NULL ELSE 'backfill' END,
                may_trigger = 1
          WHERE email_slug = ? AND email_record_id = ? AND template_id = ?`,
      ).run(origin, email.slug, email.record_id, template_id);
    },

    aiJobsForEmail: (email) =>
      (db.prepare('SELECT * FROM mail_fact_ai_job WHERE email_slug = ? AND email_record_id = ? ORDER BY template_id')
        .all(email.slug, email.record_id) as AiJobRow[]).map(aiJobFromRow),

    nextAiJob: (skip = new Set()) => {
      const slugs = [...skip];
      const row = db.prepare(
        // Mail that can start recipes first, live before a backfill's; a
        // plain backfill's calls wait behind both.
        `SELECT * FROM mail_fact_ai_job
          ${slugs.length > 0 ? `WHERE email_slug NOT IN (${slugs.map(() => '?').join(', ')})` : ''}
          ORDER BY may_trigger DESC, (origin IS NOT NULL), queued_at, email_slug, email_record_id, template_id LIMIT 1`,
      ).get(...slugs) as AiJobRow | undefined;
      return row === undefined ? null : aiJobFromRow(row);
    },

    countAiJobs: (skip = new Set()) => {
      const slugs = [...skip];
      return (db.prepare(
        `SELECT COUNT(*) AS n FROM mail_fact_ai_job
          ${slugs.length > 0 ? `WHERE email_slug NOT IN (${slugs.map(() => '?').join(', ')})` : ''}`,
      ).get(...slugs) as { n: number }).n;
    },

    bumpAiJobAttempts: (job_id) => {
      db.prepare('UPDATE mail_fact_ai_job SET attempts = attempts + 1 WHERE job_id = ?').run(job_id);
    },

    deleteAiJob: (job_id) => {
      db.prepare('DELETE FROM mail_fact_ai_job WHERE job_id = ?').run(job_id);
    },

    deleteAiJobsForEmails: (slug, record_ids) => {
      const del = db.prepare('DELETE FROM mail_fact_ai_job WHERE email_slug = ? AND email_record_id = ?');
      for (const id of record_ids) del.run(slug, id);
    },

    deleteAiJobFor: (email, template_id) => {
      db.prepare('DELETE FROM mail_fact_ai_job WHERE email_slug = ? AND email_record_id = ? AND template_id = ?')
        .run(email.slug, email.record_id, template_id);
    },

    deleteFacts: (fact_ids) => {
      const del = db.prepare('DELETE FROM mail_fact WHERE fact_id = ?');
      for (const id of fact_ids) del.run(id);
    },

    factsForEmails: (slug, record_ids) => {
      if (record_ids.length === 0) return [];
      const out: MailFact[] = [];
      const select = db.prepare<[string, string], FactRow>(
        'SELECT * FROM mail_fact WHERE email_slug = ? AND email_record_id = ?',
      );
      for (const id of record_ids) out.push(...select.all(slug, id).map(factFromRow));
      return out;
    },

    rekeyEmail: (slug, old_record_id, new_record_id) => db.transaction(() => {
      db.prepare(
        'UPDATE mail_fact_run SET email_record_id = ? WHERE email_slug = ? AND email_record_id = ?',
      ).run(new_record_id, slug, old_record_id);
      // A job the new id queued already stays; the old one's is then a copy.
      db.prepare(
        'UPDATE OR IGNORE mail_fact_ai_job SET email_record_id = ? WHERE email_slug = ? AND email_record_id = ?',
      ).run(new_record_id, slug, old_record_id);
      db.prepare('DELETE FROM mail_fact_ai_job WHERE email_slug = ? AND email_record_id = ?').run(slug, old_record_id);
      db.prepare(
        'UPDATE OR REPLACE mail_fact_email SET email_record_id = ? WHERE email_slug = ? AND email_record_id = ?',
      ).run(new_record_id, slug, old_record_id);
      return db.prepare(
        'UPDATE mail_fact SET email_record_id = ? WHERE email_slug = ? AND email_record_id = ?',
      ).run(new_record_id, slug, old_record_id).changes;
    })(),

    moveRuns: (slug, old_record_id, new_record_id) => {
      db.prepare(
        'UPDATE mail_fact_run SET email_record_id = ? WHERE email_slug = ? AND email_record_id = ?',
      ).run(new_record_id, slug, old_record_id);
    },

    moveFacts: (from, to, fact_ids, email_at) => db.transaction(() => {
      const move = db.prepare<[string, string, number, string], { template_id: string | null }>(
        'UPDATE mail_fact SET email_slug = ?, email_record_id = ?, email_at = ? WHERE fact_id = ? RETURNING template_id',
      );
      const templates = new Set<string>();
      for (const fact_id of fact_ids) {
        const template_id = move.get(to.slug, to.record_id, email_at, fact_id)?.template_id;
        if (template_id !== undefined && template_id !== null) templates.add(template_id);
      }
      // A call they wait on goes with them; one the new id queued already stays.
      const job = db.prepare(
        `UPDATE OR IGNORE mail_fact_ai_job SET email_slug = ?, email_record_id = ?
          WHERE email_slug = ? AND email_record_id = ? AND template_id = ?`,
      );
      for (const template_id of templates) job.run(to.slug, to.record_id, from.slug, from.record_id, template_id);
    })(),

    recordEmailMove: (slug, old_record_id, new_record_id, at) => {
      if (old_record_id === new_record_id) return;
      db.transaction(() => {
        // Where the email lives now, no move leads away from.
        db.prepare('DELETE FROM mail_fact_email_move WHERE email_slug = ? AND from_record_id = ?').run(slug, new_record_id);
        db.prepare('UPDATE mail_fact_email_move SET to_record_id = ? WHERE email_slug = ? AND to_record_id = ?')
          .run(new_record_id, slug, old_record_id);
        db.prepare(
          'INSERT OR REPLACE INTO mail_fact_email_move (email_slug, from_record_id, to_record_id, at) VALUES (?, ?, ?, ?)',
        ).run(slug, old_record_id, new_record_id, at);
      })();
    },

    emailMovedTo: (email) => {
      const row = db.prepare<[string, string], { to_record_id: string }>(
        'SELECT to_record_id FROM mail_fact_email_move WHERE email_slug = ? AND from_record_id = ?',
      ).get(email.slug, email.record_id);
      return row === undefined ? null : { slug: email.slug, record_id: row.to_record_id };
    },

    formerEmailIds: (slug, record_id) =>
      (db.prepare<[string, string], { from_record_id: string }>(
        'SELECT from_record_id FROM mail_fact_email_move WHERE email_slug = ? AND to_record_id = ? ORDER BY at DESC, from_record_id',
      ).all(slug, record_id)).map((row) => row.from_record_id),

    deleteEmailMovesTo: (slug, record_ids) => {
      const del = db.prepare('DELETE FROM mail_fact_email_move WHERE email_slug = ? AND to_record_id = ?');
      for (const id of record_ids) del.run(slug, id);
    },

    listFactPage: (query) => {
      const { where, params } = pageFilters(query);
      const emailWhere = [...where];
      const emailParams = [...params];
      if (query.before !== undefined) {
        // Newest first; one email's facts share its date.
        emailWhere.push(`(f.email_at < ? OR (f.email_at = ? AND (f.email_slug < ?
          OR (f.email_slug = ? AND f.email_record_id < ?))))`);
        const { email_at, slug, record_id } = query.before;
        emailParams.push(email_at, email_at, slug, slug, record_id);
      }
      const limit = Math.max(1, Math.floor(query.limit));
      const emailRows = db.prepare(
        `SELECT MAX(f.email_at) AS email_at, f.email_slug AS email_slug, f.email_record_id AS email_record_id
           FROM mail_fact f LEFT JOIN mail_fact_thing t ON t.thing_id = f.thing_id
          ${emailWhere.length > 0 ? `WHERE ${emailWhere.join(' AND ')}` : ''}
          GROUP BY f.email_slug, f.email_record_id
          ORDER BY email_at DESC, email_slug DESC, email_record_id DESC
          LIMIT ?`,
      ).all(...emailParams, limit + 1) as { email_at: number; email_slug: string; email_record_id: string }[];
      const factsOf = db.prepare(
        `SELECT f.* FROM mail_fact f LEFT JOIN mail_fact_thing t ON t.thing_id = f.thing_id
          WHERE ${['f.email_slug = ?', 'f.email_record_id = ?', ...where].join(' AND ')}
          ORDER BY f.type, f.position, f.fact_id`,
      );
      const emails = emailRows.slice(0, limit).map((row) => ({
        email: { slug: row.email_slug, record_id: row.email_record_id },
        email_at: row.email_at,
        facts: (factsOf.all(row.email_slug, row.email_record_id, ...params) as FactRow[]).map(factFromRow),
      }));
      return { emails, more: emailRows.length > limit };
    },

    recordRun: (run) => {
      db.prepare(
        `INSERT INTO mail_fact_run
           (email_slug, email_record_id, thing_id, trigger_id, recipe_id, run_id, outcome, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.email.slug,
        run.email.record_id,
        run.thing_id,
        run.trigger_id,
        run.recipe_id,
        run.run_id ?? null,
        run.outcome,
        run.at,
      );
    },

    runsForEmail: (email) =>
      (db.prepare(
        'SELECT * FROM mail_fact_run WHERE email_slug = ? AND email_record_id = ? ORDER BY at, rowid',
      ).all(email.slug, email.record_id) as RunRow[]).map(runFromRow),

    deleteRunsForEmails: (slug, record_ids) => {
      const del = db.prepare('DELETE FROM mail_fact_run WHERE email_slug = ? AND email_record_id = ?');
      for (const id of record_ids) del.run(slug, id);
    },

    emailsWithFactsSince: (slug, since) =>
      new Set(
        (db.prepare('SELECT DISTINCT email_record_id FROM mail_fact WHERE email_slug = ? AND email_at >= ?')
          .all(slug, since) as { email_record_id: string }[]).map((row) => row.email_record_id),
      ),

    dismissedSenders: () =>
      (db.prepare('SELECT address FROM mail_fact_sender_dismissed ORDER BY address').all() as { address: string }[])
        .map((row) => row.address),

    setSenderDismissed: (address, dismissed) => {
      const key = address.trim().toLowerCase();
      if (dismissed) {
        db.prepare(
          `INSERT INTO mail_fact_sender_dismissed (address, dismissed_at) VALUES (?, ?)
             ON CONFLICT(address) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
        ).run(key, now());
      } else {
        db.prepare('DELETE FROM mail_fact_sender_dismissed WHERE address = ?').run(key);
      }
    },

    getThing: (thing_id) => {
      const row = getThingRow.get(thing_id);
      return row === undefined ? null : thingFromRow(row);
    },

    listThings: (query = {}) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.type !== undefined) {
        where.push('type = ?');
        params.push(query.type);
      }
      if (query.state !== undefined) {
        where.push("json_extract(variables_blob, '$.state') = ?");
        params.push(query.state);
      }
      if (query.since !== undefined) {
        where.push('updated_at >= ?');
        params.push(query.since);
      }
      const sql = `SELECT * FROM mail_fact_thing ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY updated_at DESC, thing_id DESC LIMIT ?`;
      return (db.prepare(sql).all(...params, limitOf(query.limit)) as ThingRow[]).map(thingFromRow);
    },

    getEmailLedger: (email) => {
      const row = db.prepare('SELECT * FROM mail_fact_email WHERE email_slug = ? AND email_record_id = ?')
        .get(email.slug, email.record_id) as LedgerRow | undefined;
      return row === undefined ? null : ledgerFromRow(row);
    },

    saveEmailLedger: (ledger) => {
      db.prepare(
        `INSERT INTO mail_fact_email (email_slug, email_record_id, fingerprint, labels_blob, read_at, news, skipped, counted_blob, copy_key, email_at, arrival)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(arrival), 0) + 1 FROM mail_fact_email)))
           ON CONFLICT(email_slug, email_record_id) DO UPDATE SET
             fingerprint = excluded.fingerprint, labels_blob = excluded.labels_blob, read_at = excluded.read_at,
             news = excluded.news, skipped = excluded.skipped, counted_blob = excluded.counted_blob,
             copy_key = excluded.copy_key,
             email_at = COALESCE(mail_fact_email.email_at, excluded.email_at),
             arrival = COALESCE(mail_fact_email.arrival, excluded.arrival)`,
      ).run(
        ledger.email.slug,
        ledger.email.record_id,
        ledger.fingerprint,
        JSON.stringify(ledger.labels),
        ledger.read_at,
        ledger.news ? 1 : 0,
        ledger.skipped,
        JSON.stringify(ledger.counted),
        ledger.copy_key ?? null,
        ledger.email_at ?? null,
        // A copy takes its original's place; any other email the next one.
        ledger.arrival ?? null,
      );
    },

    emailCopyOf: (slug, copy_key, except_record_id) => {
      const row = db.prepare(
        `SELECT * FROM mail_fact_email WHERE email_slug = ? AND copy_key = ? AND email_record_id <> ?
          ORDER BY arrival IS NULL, arrival, email_record_id LIMIT 1`,
      ).get(slug, copy_key, except_record_id) as LedgerRow | undefined;
      return row === undefined ? null : ledgerFromRow(row);
    },

    takeEarlierReading: (email, arrival, email_at) => db.transaction(() => {
      const taken = db.prepare(
        `UPDATE mail_fact_email SET arrival = ?, email_at = ?
          WHERE email_slug = ? AND email_record_id = ? AND (arrival IS NULL OR arrival > ?)`,
      ).run(arrival, email_at, email.slug, email.record_id, arrival).changes > 0;
      if (taken) {
        db.prepare('UPDATE mail_fact SET email_at = ? WHERE email_slug = ? AND email_record_id = ?')
          .run(email_at, email.slug, email.record_id);
      }
      return taken;
    })(),

    emailsWithTemplateFacts: (template_id) =>
      (db.prepare('SELECT DISTINCT email_slug, email_record_id FROM mail_fact WHERE template_id = ?')
        .all(template_id) as { email_slug: string; email_record_id: string }[])
        .map((row) => ({ slug: row.email_slug, record_id: row.email_record_id })),

    markEmailNews: (email) => {
      db.prepare(
        `INSERT INTO mail_fact_email (email_slug, email_record_id, news) VALUES (?, ?, 1)
           ON CONFLICT(email_slug, email_record_id) DO UPDATE SET news = 1`,
      ).run(email.slug, email.record_id);
    },

    deleteEmailLedgers: (slug, record_ids) => {
      const del = db.prepare('DELETE FROM mail_fact_email WHERE email_slug = ? AND email_record_id = ?');
      for (const id of record_ids) del.run(slug, id);
    },

    emailIdsOf: (slug, after, limit) => {
      const from = after ?? '';
      const rows = db.prepare<{ slug: string; after: string; limit: number }, { record_id: string }>(
        `SELECT record_id FROM (
           SELECT email_record_id AS record_id FROM mail_fact_email WHERE email_slug = @slug AND email_record_id > @after
           UNION SELECT email_record_id FROM mail_fact WHERE email_slug = @slug AND email_record_id > @after
           UNION SELECT email_record_id FROM mail_fact_ai_job WHERE email_slug = @slug AND email_record_id > @after
           UNION SELECT email_record_id FROM mail_fact_run WHERE email_slug = @slug AND email_record_id > @after
         ) ORDER BY record_id LIMIT @limit`,
      ).all({ slug, after: from, limit });
      return rows.map((row) => row.record_id);
    },

    findThingIdByKeys: (type, keys) => {
      if (keys.length === 0) return null;
      const select = db.prepare<[string, string], { thing_id: string; created_at: number }>(
        `SELECT k.thing_id AS thing_id, t.created_at AS created_at
           FROM mail_fact_thing_key k JOIN mail_fact_thing t ON t.thing_id = k.thing_id
          WHERE k.type = ? AND k.identity_key = ?
          ORDER BY t.created_at, t.thing_id LIMIT 1`,
      );
      // When keys point at different things, the oldest thing wins.
      let best: { thing_id: string; created_at: number } | undefined;
      for (const key of keys) {
        const hit = select.get(type, key);
        if (hit !== undefined && (best === undefined || hit.created_at < best.created_at)) best = hit;
      }
      return best?.thing_id ?? null;
    },

    thingsHoldingKeys: (type, keys) => {
      if (keys.length === 0) return [];
      return (db.prepare(
        `SELECT * FROM mail_fact_thing
          WHERE type = ? AND EXISTS (
            SELECT 1 FROM json_each(identity_keys_blob) WHERE value IN (${keys.map(() => '?').join(', ')}))
          ORDER BY created_at, thing_id`,
      ).all(type, ...keys) as ThingRow[]).map(thingFromRow);
    },

    thingIdsByKeys: (type, keys) => {
      const select = db.prepare<[string, string], { thing_id: string; created_at: number }>(
        `SELECT k.thing_id AS thing_id, t.created_at AS created_at
           FROM mail_fact_thing_key k JOIN mail_fact_thing t ON t.thing_id = k.thing_id
          WHERE k.type = ? AND k.identity_key = ?`,
      );
      const found = new Map<string, number>();
      for (const key of keys) {
        for (const hit of select.all(type, key)) found.set(hit.thing_id, hit.created_at);
      }
      return [...found].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([thing_id]) => thing_id);
    },

    saveThing: (thing) => {
      db.prepare(
        `INSERT INTO mail_fact_thing
           (thing_id, type, identity_keys_blob, variables_blob, passes_blob, variable_email_at_blob,
            missing_blob, complete, created_at, updated_at, last_email_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thing_id) DO UPDATE SET
           identity_keys_blob = excluded.identity_keys_blob,
           variables_blob = excluded.variables_blob,
           passes_blob = excluded.passes_blob,
           variable_email_at_blob = excluded.variable_email_at_blob,
           missing_blob = excluded.missing_blob,
           complete = excluded.complete,
           updated_at = excluded.updated_at,
           last_email_at = excluded.last_email_at`,
      ).run(
        thing.thing_id,
        thing.type,
        JSON.stringify(thing.identity_keys),
        JSON.stringify(thing.variables),
        JSON.stringify(thing.passes),
        JSON.stringify(thing.variable_email_at),
        JSON.stringify(thing.missing),
        thing.complete ? 1 : 0,
        thing.created_at,
        thing.updated_at,
        thing.last_email_at,
      );
      // The key index holds the thing's keys as they are now: a key it no
      // longer holds (its last fact with it went) leaves the index with it.
      db.prepare('DELETE FROM mail_fact_thing_key WHERE thing_id = ?').run(thing.thing_id);
      const insertKey = db.prepare(
        'INSERT OR IGNORE INTO mail_fact_thing_key (type, identity_key, thing_id) VALUES (?, ?, ?)',
      );
      for (const key of thing.identity_keys) insertKey.run(thing.type, key, thing.thing_id);
    },

    deleteThing: (thing_id) => {
      db.prepare('DELETE FROM mail_fact_thing_key WHERE thing_id = ?').run(thing_id);
      db.prepare('DELETE FROM mail_fact_thing WHERE thing_id = ?').run(thing_id);
    },

    mergeThings: (from, to) => {
      db.prepare('UPDATE mail_fact SET thing_id = ? WHERE thing_id = ?').run(to, from);
      db.prepare('UPDATE mail_fact SET prior_thing_id = ? WHERE prior_thing_id = ?').run(to, from);
      db.prepare('UPDATE mail_fact_run SET thing_id = ? WHERE thing_id = ?').run(to, from);
      db.prepare('DELETE FROM mail_fact_thing_key WHERE thing_id = ?').run(from);
      db.prepare('DELETE FROM mail_fact_thing WHERE thing_id = ?').run(from);
    },

    mintId,
  };
  return store;
};
