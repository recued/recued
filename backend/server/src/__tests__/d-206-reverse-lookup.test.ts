/** D-206 step 4 — **THE REVERSE LOOKUP, AND ITS COMPLETENESS CLAIM.**
 *
 *  The other end of the contract. Step 2 read `deal.contact_id → ref{contact}` FORWARD
 *  ("this deal's contact"); this reads it BACKWARD ("this contact's deals") — the same
 *  declaration, no new storage.
 *
 *  ## 🔴 What this really defends: a truncated set read as the whole set
 *
 *  `CrmRecordMirrorStore.list()` is HARD-CAPPED at `MIRROR_MAX_LIMIT` (200; default 50) and
 *  reports no size. A reverse lookup through it answers *"Bob has 3 deals"* when he has 240
 *  — a confident number over a truncated set, which the model states to the user **as
 *  fact**. That cap is CORRECT for `list()`'s bounded chat consumers (a smaller answer is a
 *  smaller answer); it is WRONG for a completeness claim. So the reverse lookup gets its own
 *  door — `listByRef` — which returns `{ rows, total }` and makes `total` **mandatory**: a
 *  caller physically cannot obtain a page without also being handed the true size.
 *
 *  ⚠ The store's own `listForConnection` docstring already makes this argument one door
 *  over: *"an under-returning read is not a smaller answer, it is a silent MASS
 *  WITHDRAWAL… Nothing would fail; the data would just quietly go."* This store's cap has
 *  already nearly caused a silent catastrophe twice.
 *  [[feedback_bounded_read_is_a_leak_for_security_seed_sets]]
 *
 *  ## And the plane crossing, again
 *
 *  Resolving an email to one of the user's OWN contacts reads `data.contact`. A door
 *  without that grant must NOT get an empty list — that reads as *"this person has no
 *  deals"*, a claim about the user's data. It gets a NAMED `partial_failure`.
 *
 *  Spec: D-206 §2.2c. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isReadableCollection, parseGrantEntry } from '@recued/contracts';
import type { ChatDispatchContext, ExecutionSource } from '@recued/contracts';

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import type { GrantEntryResolver } from '../contract-grant-resolve.js';
import { createReadGrantChecker, type GatedReadGrantResolver } from '../read-grant-checker.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';

const DOOR = 'door-1';
const VENDOR = 'pipedrive';
const SCOPE = `connection.api.${VENDOR}.deal`;
const RAW_PERSON_ID = '123';
const EMAIL = 'bob@acme.example';
/** Well past `MIRROR_MAX_LIMIT` (200) — the whole point. */
const BOBS_DEALS = 240;

let dir: string;
let db: Database.Database;
let store: ContactStore;
let mirror: CrmRecordMirrorStore;

const fence = (collections: readonly string[]): GrantEntryResolver => {
  const cols = new Set(collections);
  return {
    isGranted: (_c, entry, authorDefault) => {
      const parsed = parseGrantEntry(entry);
      if (parsed.kind === 'collection') {
        return isReadableCollection(parsed.value) ? cols.has(parsed.value) : authorDefault;
      }
      return authorDefault;
    },
  };
};

const resolverFor = (collections: readonly string[]): GatedReadGrantResolver => ({
  resolveForContract: () => createReadGrantChecker(fence(collections), DOOR),
  resolveForSource: () => createReadGrantChecker(fence(collections), DOOR),
});

const doorSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'a1',
  tool_call_id: 'tc1',
  mcp_token_id: 'tok1',
  contract_id: DOOR,
};
const doorCtx = (): ChatDispatchContext => ({
  channel: 'mcp_wire',
  mcp_token_id: 'tok1',
  execution_source: doorSource,
});

const buildDeps = (grants: readonly string[]): ChatToolHandlerDeps =>
  ({
    getContactStore: () => store,
    getCrmRecordMirror: () => mirror,
    getBoundCrmMirrorSources: () => [{ source_id: VENDOR, scope: SCOPE }],
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getReadGrantResolver: () => resolverFor(grants),
  }) as unknown as ChatToolHandlerDeps;

type Envelope = {
  candidates: Array<{ record: { name: string } }>;
  total?: number;
  partial?: boolean;
  partial_failures?: Array<{ source: string; reason: string }>;
};

const dealSearch = async (deps: ChatToolHandlerDeps, args: Record<string, unknown>) => {
  const handlers = buildChatTier1Handlers(deps);
  return handlers['deal.search']!(args, doorCtx());
};
const env = (r: unknown) => (r as { result: Envelope }).result;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd206-reverse-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
  ensureCrmRecordMirrorSchema(db);
  mirror = createCrmRecordMirrorStore(db);

  store.observe({ email: EMAIL, name: 'Bob', source: 'email_from', event_at: 1_000 });
  store.linkPlatformId({
    canonical_email: EMAIL,
    vendor: VENDOR,
    platform_id: RAW_PERSON_ID,
    state: 'auto',
    linked_at: 1_700_000_000_000,
    linked_by: 'auto:email_match',
  });

  // 240 of Bob's deals — deliberately past the 200 cap — plus 10 belonging to someone else,
  // so a filter that silently matched everything would also be caught.
  for (let i = 0; i < BOBS_DEALS; i++) {
    mirror.upsert({
      scope: SCOPE,
      target_id: `${VENDOR}_deal_acme_${i}`,
      meta: {
        name: `Bob deal ${i}`,
        contact_id: RAW_PERSON_ID,
        snapshot_at: 1_700_000_000_000,
        snapshot_hash: `h${i}`,
      } as never,
      now: 1_700_000_000_000 + i,
    });
  }
  for (let i = 0; i < 10; i++) {
    mirror.upsert({
      scope: SCOPE,
      target_id: `${VENDOR}_deal_other_${i}`,
      meta: {
        name: `Someone else ${i}`,
        contact_id: '999',
        snapshot_at: 1_700_000_000_000,
        snapshot_hash: `o${i}`,
      } as never,
      now: 1_700_000_000_000,
    });
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-206 §2.2c — the reverse lookup reports a COMPLETE total', () => {
  it('🔴 THE WHOLE POINT: 240 deals, a bounded page — and the TRUE total, not the page size', async () => {
    const result = await dealSearch(buildDeps(['contact']), { contact: EMAIL, limit: 20 });
    const e = env(result);

    // The page is bounded — correct for a chat surface.
    expect(e.candidates).toHaveLength(20);
    // 🔑 …and the model is handed the TRUE size, so it can never say "Bob has 20 deals".
    // Through `list()` this number would be unavailable and the page would silently BE the
    // answer — "Bob has 3 deals" when he has 240.
    expect(e.total).toBe(BOBS_DEALS);
  });

  it('the store door itself: the page CLAMPS, the total does NOT', () => {
    // Straight at the substrate, past the tool. `listByRef` must never let a caller hold a
    // page without the true size — the cap applies to rows and NEVER to the count.
    const asked = mirror.listByRef(SCOPE, { field: 'contact_id', value: RAW_PERSON_ID, limit: 9999 });
    expect(asked.rows.length).toBe(200); // MIRROR_MAX_LIMIT — the page is bounded…
    expect(asked.total).toBe(BOBS_DEALS); // …the completeness claim is not.
  });

  it('the filter is REAL — another person’s deals are not counted', () => {
    // Guards against the failure that would make every other assertion pass for the wrong
    // reason: a filter that quietly matches everything.
    expect(mirror.listByRef(SCOPE, { field: 'contact_id', value: '999' }).total).toBe(10);
    expect(mirror.listByRef(SCOPE, { field: 'contact_id', value: 'nobody' }).total).toBe(0);
  });

  it('🔑 the EXPRESSION INDEX is actually USED — a param-bound path would silently scan', () => {
    // The invisible property, and the reason `listByRef` inlines the json path as a LITERAL
    // instead of binding it like `list()` does. SQLite matches an expression index only
    // against the IDENTICAL literal expression:
    //
    //   json_extract(meta, ?)              → SEARCH … USING INDEX (scope=?)
    //                                        …narrows to the scope, then SCANS every row.
    //   json_extract(meta, '$.contact_id') → SEARCH … USING COVERING INDEX (scope=? AND <expr>=?)
    //
    // Nothing about correctness changes if this regresses — the answers stay right and the
    // tests stay green while every reverse lookup quietly becomes a full scan of the
    // vendor's deal scope. So the query PLAN is the assertion. It is also what makes the
    // literal safe: the field vocabulary is a closed built-in constant (`REF_FIELDS`).
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(SCOPE, RAW_PERSON_ID) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');

    const countPlan = plan(
      `SELECT COUNT(*) AS n FROM crm_record_mirror
         WHERE scope = ? AND json_extract(meta, '$.contact_id') = ?`,
    );
    expect(countPlan).toMatch(/USING COVERING INDEX idx_crm_record_mirror_ref_contact_id/);

    // And the degraded form — the one a "simplify it to match list()" refactor would produce
    // — provably does NOT get the index. This is the negative control that stops the
    // assertion above passing for the wrong reason.
    const boundPlan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM crm_record_mirror
             WHERE scope = ? AND json_extract(meta, ?) = ?`,
        )
        .all(SCOPE, '$.contact_id', RAW_PERSON_ID) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(boundPlan).not.toMatch(/COVERING INDEX idx_crm_record_mirror_ref_contact_id/);
  });

  it('⛔ an UNDECLARED ref field THROWS — it must never resolve to a confident zero', () => {
    // An unknown field would `json_extract` to NULL on every row and return total: 0 — a
    // complete-looking answer that is entirely wrong. Fail loud.
    expect(() => mirror.listByRef(SCOPE, { field: 'not_a_ref', value: 'x' })).toThrow(
      /not a declared D-206 ref field/,
    );
  });

  it('🔴 THE FENCE: without data.contact it is a NAMED failure, never "this person has no deals"', async () => {
    // Resolving an email to one of the user's own contacts reads the core graph. An empty
    // list here would be indistinguishable from a genuine "no deals" — a claim about the
    // user's DATA that the model states as fact.
    const result = await dealSearch(buildDeps(['mail']), { contact: EMAIL, limit: 20 });
    const e = env(result);

    expect((result as { ok: boolean }).ok).toBe(true); // ANTI-LOOP: never ok:false
    expect(e.candidates).toHaveLength(0);
    expect(e.partial).toBe(true);
    const failure = e.partial_failures?.find((f) => f.source === VENDOR);
    expect(failure?.reason).toMatch(/data\.contact/);
    // ⛔ And NO total — a completeness claim we could not make must not be made.
    expect(e.total).toBe(0);
  });

  it('a plain deal query reports NO total — the tool never claims what it cannot back', async () => {
    // `list()` (the free-text path) is hard-capped at 200 and cannot count. Reporting a
    // `total` there would be a number nobody can stand behind, and the model would state it
    // as fact. Absent means "not computed" — never zero.
    const e = env(await dealSearch(buildDeps(['contact']), { query: 'Bob deal', limit: 5 }));
    expect(e.candidates.length).toBeGreaterThan(0);
    expect(e.total).toBeUndefined();
  });
});
