/** D-161 P2 — origin_actor on manual / recipe contact writes.
 *
 *  `contact.upsert` has two write surfaces: the direct paired-client rpc
 *  (stamped `'user_self'` server-side via `makeContactHandlers`) and the
 *  D-122 `contact-upsert` recipe kernel ingredient (stamped the run's
 *  `stepMeta.actor`, lifted server-side into `handleContactUpsert`'s deps).
 *  Origin is server-injected — a client/recipe `args` payload can't spoof
 *  it (I-6 / A.5). mail/calendar `observe*` sync stays `'system'`.
 *
 *  D-177 N.11 rule 1 REVISED the update semantics: `upsertManual`
 *  re-stamps all three origin facets on EVERY write (create and update)
 *  — last-writer semantics, so the stored-cleanliness gate reads who
 *  authored the row's CURRENT content (an agent edit of a user row
 *  demotes it; a user edit re-adopts it). The `observe*` sync paths
 *  still never touch the facets (an interaction bump isn't authorship). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  handleContactUpsert,
  makeContactHandlers,
} from '../contact-handler.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-161-p2-contact-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-161 P2 — manual contact.upsert origin', () => {
  it("direct paired-client contact.upsert rpc stamps origin_actor='user_self'", async () => {
    const slice = makeContactHandlers({ store, now: () => 1000 })!;
    await slice.handlers['contact.upsert']({ email: 'jane@x.com', name: 'Jane' } as never, undefined as never);
    expect(store.get('jane@x.com')?.origin_actor).toBe('user_self');
  });

  it('a client cannot spoof a different origin on the direct rpc (args ignored)', async () => {
    const slice = makeContactHandlers({ store, now: () => 1000 })!;
    await slice.handlers['contact.upsert']({ email: 'jane@x.com', origin_actor: 'system' } as never, undefined as never);
    expect(store.get('jane@x.com')?.origin_actor).toBe('user_self');
  });

  it('the recipe contact-upsert path stamps the run actor from deps (an MCP recipe → contracted_user)', async () => {
    await handleContactUpsert(
      { store, origin_actor: 'contracted_user', origin_contract_id: 'c-1', now: () => 1000 },
      { email: 'lead@x.com', name: 'Lead' },
    );
    const row = store.get('lead@x.com');
    expect(row?.origin_actor).toBe('contracted_user');
    expect(row?.origin_contract_id).toBe('c-1');
  });

  it('handleContactUpsert ignores an args-level origin spoof (reads deps only)', async () => {
    await handleContactUpsert(
      { store, origin_actor: 'contracted_user', now: () => 1000 },
      { email: 'lead@x.com', origin_actor: 'user_self' } as never,
    );
    expect(store.get('lead@x.com')?.origin_actor).toBe('contracted_user');
  });

  it("handleContactUpsert with no deps origin defaults to 'system'", async () => {
    await handleContactUpsert({ store, now: () => 1000 }, { email: 'x@x.com' });
    expect(store.get('x@x.com')?.origin_actor).toBe('system');
  });
});

describe('D-161 P2 — sync contacts stay system', () => {
  it("mail/calendar observe() stamps origin_actor='system'", () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 100, name: 'Bob' });
    expect(store.get('bob@x.com')?.origin_actor).toBe('system');
  });
});

describe('D-177 N.11 rule 1 — last-writer stamping (upsert re-stamps; sync never touches)', () => {
  it('a manual user_self contact keeps user_self after a later sync interaction', () => {
    store.upsertManual({ email: 'jane@x.com', name: 'Jane' }, 1000, { origin_actor: 'user_self' });
    expect(store.get('jane@x.com')?.origin_actor).toBe('user_self');
    // A subsequent mail-sync interaction updates last_interaction but must
    // NOT flip the write-actor (an interaction bump isn't authorship).
    store.observe({ email: 'jane@x.com', source: 'email_from', event_at: 2000 });
    expect(store.get('jane@x.com')?.origin_actor).toBe('user_self');
  });

  it('a sync-created system contact RE-STAMPS to the editing writer on a manual edit', () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 100, name: 'Bob' });
    expect(store.get('bob@x.com')?.origin_actor).toBe('system');
    // D-177: the update branch stamps the LAST writer — the row's current
    // content is now this writer's authorship.
    store.upsertManual({ email: 'bob@x.com', name: 'Robert' }, 3000, {
      origin_actor: 'user_self',
      origin_surface: 'client_rpc',
    });
    const row = store.get('bob@x.com');
    expect(row?.name).toBe('Robert');
    expect(row?.origin_actor).toBe('user_self');
    expect(row?.origin_surface).toBe('client_rpc');
  });

  it('an agent edit DEMOTES a user-created row (the rule-1 laundering fix)', () => {
    store.upsertManual({ email: 'jane@x.com', name: 'Jane' }, 1000, {
      origin_actor: 'user_self',
      origin_surface: 'client_rpc',
    });
    // An MCP-run recipe edits the row: the facets must flip to the
    // agent's, so the stored-cleanliness gate stops reading it clean.
    store.upsertManual({ email: 'jane@x.com', name: 'Janet' }, 2000, {
      origin_actor: 'contracted_user',
      origin_contract_id: 'c-9',
      origin_surface: 'engine',
    });
    const row = store.get('jane@x.com');
    expect(row?.origin_actor).toBe('contracted_user');
    expect(row?.origin_contract_id).toBe('c-9');
    expect(row?.origin_surface).toBe('engine');
  });

  it('an upsert with no opts re-stamps to system (fail closed, not sticky)', () => {
    store.upsertManual({ email: 'jane@x.com', name: 'Jane' }, 1000, {
      origin_actor: 'user_self',
      origin_surface: 'client_rpc',
    });
    store.upsertManual({ email: 'jane@x.com', name: 'Jane II' }, 2000);
    const row = store.get('jane@x.com');
    expect(row?.origin_actor).toBe('system');
    expect(row?.origin_surface).toBe('system');
    expect(row?.origin_contract_id).toBeUndefined();
  });
});
