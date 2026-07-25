/** D-206 step 2 — the RESOLVER, and its fence.
 *
 *  `deal.search` now answers *"who is the Acme renewal actually with?"* — a question the
 *  model could not answer before, because `ChatDealCandidate` carried no relationship at
 *  all. The canonical `deal.contact_id` (Pipedrive `person_id`) is DECLARED a ref to
 *  `contact` (step 1), and this resolves it — storing nothing. Two facts we already had
 *  (the deal's raw vendor id; the durable identity link) joined at read time.
 *
 *  ## 🔴 What these tests really defend: the PLANE CROSSING
 *
 *  **This resolver is the first thing in the tree that actually joins the CRM plane to the
 *  core contact graph.** `deal` is NOT in `READABLE_COLLECTIONS` — the CRM plane runs on
 *  the connection's own authorization axis. But `contact` IS. So resolving a CRM record to
 *  *"your contact Bob"* is precisely the gate-crossing edge D-205 §3 was written for — the
 *  one that was MOOT for `contact.search` only because nothing there ever joined.
 *
 *  D-205 §3's rule, verbatim: **`crm = yes, core = no` ⇒ the CRM record renders AS ITSELF,
 *  never as one of the user's people. Do not resolve the link.** Undo that and you ship the
 *  exact leak the owner predicted, on a door that reaches external agents over MCP.
 *
 *  The gate under test is the REAL `createReadGrantChecker` — only the grant-ROW store is
 *  stubbed. A test that stubbed `isCollectionReadGranted` itself would prove nothing.
 *
 *  Spec: D-206; the fence: D-205 §3. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isReadableCollection, parseGrantEntry } from '@recued/contracts';
import type { ChatDispatchContext, ExecutionSource } from '@recued/contracts';

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import type { GrantEntryResolver } from '../contract-grant-resolve.js';
import { createReadGrantChecker, type GatedReadGrantResolver } from '../read-grant-checker.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';

const DOOR = 'door-1';
const VENDOR = 'pipedrive';
/** The vendor's RAW person id — what a Pipedrive deal's canonical `contact_id` holds AND
 *  what `contact_platform_link.platform_id` stores. One key space; that is the join. */
const RAW_PERSON_ID = '123';
const CONTACT_EMAIL = 'bob@acme.example';
/** Distinctive, so a leak ANYWHERE in the serialized envelope is caught. */
const SECRET_NAME = 'Bob-Very-Secret-Surname';

let dir: string;
let db: Database.Database;
let store: ContactStore;

const fence = (collections: readonly string[]): GrantEntryResolver => {
  const cols = new Set(collections);
  return {
    isGranted: (_contract_id, entry, authorDefault) => {
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

/** An external door's MCP dispatch — carries the ExecutionSource the fence resolves from. */
const doorCtx = (): ChatDispatchContext => ({
  channel: 'mcp_wire',
  mcp_token_id: 'tok1',
  execution_source: doorSource,
});

/** A mirrored Pipedrive deal, with the canonical `contact_id` its reconciler projects. */
const dealRow = (contactId?: string) => ({
  scope: `connection.api.${VENDOR}.deal`,
  target_id: `${VENDOR}_deal_acme_55`,
  meta: {
    name: 'Acme renewal',
    amount: 5000,
    ...(contactId !== undefined ? { contact_id: contactId } : {}),
  },
});

const buildDeps = (opts: {
  grants: readonly string[];
  rows?: ReturnType<typeof dealRow>[];
}): ChatToolHandlerDeps =>
  ({
    getContactStore: () => store,
    getCrmRecordMirror: () => ({ list: vi.fn().mockReturnValue(opts.rows ?? [dealRow(RAW_PERSON_ID)]) }),
    getBoundCrmMirrorSources: () => [{ source_id: VENDOR, scope: `connection.api.${VENDOR}.deal` }],
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getReadGrantResolver: () => resolverFor(opts.grants),
  }) as unknown as ChatToolHandlerDeps;

type Envelope = {
  candidates: Array<{
    source: string;
    record: {
      name: string;
      contact_id?: string;
      contact?: { email: string | null; name?: string };
      contact_core_fenced?: boolean;
    };
  }>;
};

const dealSearch = async (deps: ChatToolHandlerDeps) => {
  const handlers = buildChatTier1Handlers(deps);
  return handlers['deal.search']!({ limit: 5 }, doorCtx());
};

const firstDeal = (result: unknown) =>
  (result as { result: Envelope }).result.candidates[0]!.record;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd206-deal-ref-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
  store.observe({ email: CONTACT_EMAIL, name: SECRET_NAME, source: 'email_from', event_at: 1_000 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-206 — deal.search resolves the declared contact ref', () => {
  it('🔑 THE JOIN: a deal’s contact_id resolves to the user’s OWN contact — storing nothing', async () => {
    store.linkPlatformId({
      canonical_email: CONTACT_EMAIL,
      vendor: VENDOR,
      platform_id: RAW_PERSON_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });

    const deal = firstDeal(await dealSearch(buildDeps({ grants: ['contact'] })));

    // The CRM-plane fact: the vendor's own id, verbatim.
    expect(deal.contact_id).toBe(RAW_PERSON_ID);
    // The CORE-plane fact: the user's own contact, reached through the durable identity
    // link. No edge was written anywhere to make this true.
    expect(deal.contact?.email).toBe(CONTACT_EMAIL);
    expect(deal.contact?.name).toBe(SECRET_NAME);
    expect(deal.contact_core_fenced).toBeUndefined();
  });

  it('🔴 THE FENCE: crm=yes / core=no renders the CRM record AS ITSELF — never as “your contact Bob”', async () => {
    // The leak the owner predicted, and the reason this resolver needed a gate at all.
    // A door holding the CRM lens but NOT `data.contact` must see the deal's own
    // contact_id and nothing more.
    store.linkPlatformId({
      canonical_email: CONTACT_EMAIL,
      vendor: VENDOR,
      platform_id: RAW_PERSON_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });

    // `mail` granted, `contact` REVOKED — a real, plausible door fence.
    const result = await dealSearch(buildDeps({ grants: ['mail'] }));
    const deal = firstDeal(result);

    // The CRM plane still answers on its OWN axis — the fence is not a blanket.
    expect(deal.contact_id).toBe(RAW_PERSON_ID);
    expect(deal.name).toBe('Acme renewal');
    // ⛔ But the core graph is not resolved, and NO core PII crosses the wire — not in the
    // field we assert on, and not anywhere else in the envelope.
    expect(deal.contact).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(result)).not.toContain(CONTACT_EMAIL);
  });

  it('🔑 THE REFUSAL IS VISIBLE: a fenced hop is FLAGGED, never a silent absence', async () => {
    // Without the flag, a missing `contact` is ambiguous between "this deal's contact is
    // not one of your people" — a claim about the user's DATA — and "you may not look".
    // A model handed the former states it to the user as fact.
    store.linkPlatformId({
      canonical_email: CONTACT_EMAIL,
      vendor: VENDOR,
      platform_id: RAW_PERSON_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });

    const fenced = firstDeal(await dealSearch(buildDeps({ grants: ['mail'] })));
    expect(fenced.contact_core_fenced).toBe(true);

    // …and a genuinely UNLINKED contact is NOT flagged: we were ALLOWED to look, we looked,
    // and there is nothing. The two absences must stay distinguishable — that distinction IS
    // the flag's whole reason to exist. (A deal pointing at a person Recued has no link for:
    // granted, so the store IS queried, and it honestly comes back empty.)
    const unlinked = firstDeal(
      await dealSearch(buildDeps({ grants: ['contact'], rows: [dealRow('999')] })),
    );
    expect(unlinked.contact_id).toBe('999');
    expect(unlinked.contact).toBeUndefined();
    expect(unlinked.contact_core_fenced).toBeUndefined();
  });

  it('BEHAVIOR-PRESERVING: a vendor with no property route projects no relationship at all', async () => {
    // HubSpot / Salesforce model deal→contact as an association, so their reconcilers never
    // project `contact_id`. Absence is not a failure — it is that vendor saying it has no
    // property route, and the association substrate is a different problem entirely.
    const deal = firstDeal(
      await dealSearch(buildDeps({ grants: ['contact'], rows: [dealRow(undefined)] })),
    );
    expect(deal.name).toBe('Acme renewal');
    expect(deal.contact_id).toBeUndefined();
    expect(deal.contact).toBeUndefined();
    expect(deal.contact_core_fenced).toBeUndefined();
  });

  it('the ref resolves through a MERGE to the LIVE person — not a tombstone', async () => {
    // Why identity is a durable link and not a read-time email join. The address the vendor
    // originally matched on is absorbed; the deal must still name the live human.
    const survivor = 'robert@acme.example';
    store.observe({ email: survivor, name: 'Robert Live', source: 'email_from', event_at: 2_000 });
    store.linkPlatformId({
      canonical_email: CONTACT_EMAIL,
      vendor: VENDOR,
      platform_id: RAW_PERSON_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });
    store.setMergedInto([store.get(CONTACT_EMAIL)!], survivor, Date.now());

    const deal = firstDeal(await dealSearch(buildDeps({ grants: ['contact'] })));
    expect(deal.contact?.email).toBe(survivor);
  });
});
