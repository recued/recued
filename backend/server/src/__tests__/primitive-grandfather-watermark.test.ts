/** The primitive-grandfather WATERMARK — what makes `grandfatherPrimitiveGrants` a
 *  one-time migration in fact, not only in its own doc.
 *
 *  ⛔⛔ THE BUG IT CLOSES. The grandfather writes `granted: true` for any `primitive.*`
 *  row a non-owner contract lacks, reading the CURRENT `TIER1_TOOL_NAMES` on every
 *  boot. "Missing" has two causes it could not tell apart — this contract predates the
 *  gate (grandfather it) and this PRIMITIVE was added after the contract was minted
 *  (its minter never saw it). So every future Tier-1 primitive landed granted on every
 *  already-issued door, silently, on their next restart. Driven before the fix by
 *  widening the list and rebooting: the door's row went `undefined -> true`.
 *
 *  ⚠ DELETING A ROW IS HOW A NEW PRIMITIVE LOOKS. The tests below remove a row rather
 *  than widening the compiled-in list, because the two produce the IDENTICAL state — an
 *  entry key the contract has no row for — and only one of them is expressible in a
 *  unit test.
 *
 *  ⛔⛔ D-298 — AND IT RUNS ONCE PER SERVER. The per-contract mark could not stop the
 *  other leak: nothing marks a contract at MINT, so a door or a zero-grant customer
 *  template created since the last boot was covered at the next one. The setup here is
 *  a server that has never run a gate build — no owner primitive rows yet, because the
 *  boot runs the grandfather BEFORE the owner reconcile. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_CONTRACT_ID,
  TIER1_TOOL_NAMES,
  primitiveGrantEntry,
} from '@recued/contracts';

import {
  PRIMITIVE_GRANDFATHER_SERVER_KEY,
  grandfatherPrimitiveGrants,
  reconcileOwnerGrants,
} from '../owner-grant-reconcile.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = 1_750_000_000_000;
const SCOPE = 'primitive_grandfather';
const PROBE = 'file.search';

describe('primitive grandfather watermark', () => {
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let grants: ReturnType<typeof createContractGrantEntryStore>;
  let doorId: string;

  const mintDoor = (name = 'door'): string =>
    createContractDefinitionStore(store, { now: () => NOW }).mint({
      minted_by: 'test',
      display_name: name,
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: [] },
    }).contract_id;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    grants = createContractGrantEntryStore(store);
    doorId = mintDoor();
  });

  const SERVER_KEY = PRIMITIVE_GRANDFATHER_SERVER_KEY;
  afterEach(() => db.close());

  it('the first run grandfathers the door AND marks it — and the server', () => {
    expect(store.get(SCOPE, [doorId])).toBeNull();
    const r = grandfatherPrimitiveGrants(store, () => NOW);
    expect(r.seeded).toBe(TIER1_TOOL_NAMES.length);
    expect(store.get(SCOPE, [SERVER_KEY])).not.toBeNull();
    const mark = store.get(SCOPE, [doorId]);
    expect(mark).not.toBeNull();
    // Diagnostic, so a later reader can tell WHAT it was covered against.
    expect((mark?.value as { primitive_count?: number }).primitive_count)
      .toBe(TIER1_TOOL_NAMES.length);
  });

  /** ⛔⛔ THE PROPERTY THE WATERMARK EXISTS FOR. */
  it('a MARKED contract does not gain a primitive it has no row for', () => {
    grandfatherPrimitiveGrants(store, () => NOW);
    // Exactly the state a newly-shipped primitive produces on this door.
    expect(store.delete('contract_grant', [doorId, primitiveGrantEntry(PROBE)])).toBe(true);
    expect(grants.get(doorId, primitiveGrantEntry(PROBE))).toBeUndefined();

    const second = grandfatherPrimitiveGrants(store, () => NOW);
    expect(second.seeded).toBe(0);
    // ⚠ BEFORE the watermark this came back `true` — a capability the door's minter
    // never saw, arriving granted on a restart nobody watches.
    expect(grants.get(doorId, primitiveGrantEntry(PROBE))).toBeUndefined();
  });

  /** ⛔⛔ D-298 — THE LEAK. This test used to be "the UPGRADE case still works": a door
   *  minted AFTER a run, covered at the next — which is every door, and every zero-grant
   *  customer template, created on a server that already runs the gate. */
  it('a contract created AFTER the first run gets nothing at the next boot', () => {
    grandfatherPrimitiveGrants(store, () => NOW);
    const fresh = mintDoor('fresh');
    const r = grandfatherPrimitiveGrants(store, () => NOW);
    expect(r).toEqual({ contracts: 0, seeded: 0 });
    for (const n of TIER1_TOOL_NAMES) expect(grants.get(fresh, primitiveGrantEntry(n))).toBeUndefined();
  });

  it('a server a WATERMARK build ran on (contract marks, no server mark) never grandfathers again', () => {
    store.put(SCOPE, [doorId], { grandfathered_at: NOW - 1, primitive_count: TIER1_TOOL_NAMES.length });
    const fresh = mintDoor('since the last boot');
    const r = grandfatherPrimitiveGrants(store, () => NOW);
    expect(r).toEqual({ contracts: 0, seeded: 0 });
    expect(grants.get(fresh, primitiveGrantEntry(PROBE))).toBeUndefined();
    expect(store.get(SCOPE, [SERVER_KEY])).not.toBeNull();
  });

  /** A fresh install: its gate boots saw no door, so no contract was ever marked — but
   *  the owner reconcile seeded the owner's primitive rows on every one of them. */
  it('a fresh install\'s first door gets nothing: the owner\'s rows say a gate build booted here', () => {
    reconcileOwnerGrants(store, () => NOW - 1);
    const r = grandfatherPrimitiveGrants(store, () => NOW);
    expect(r).toEqual({ contracts: 0, seeded: 0 });
    expect(grants.get(doorId, primitiveGrantEntry(PROBE))).toBeUndefined();
  });

  /** ⛔ A contract that already held every row still needs marking — otherwise it stays
   *  unmarked forever and every future primitive lands on it. The bug surviving in the
   *  one case that looks most benign is exactly how it would come back. */
  it('the run itself is remembered, even when it found nothing to cover', () => {
    store.delete('contract_definition', [doorId]);
    grandfatherPrimitiveGrants(store, () => NOW); // nothing to cover, no owner reconcile
    const later = mintDoor('later');
    expect(grandfatherPrimitiveGrants(store, () => NOW)).toEqual({ contracts: 0, seeded: 0 });
    expect(grants.get(later, primitiveGrantEntry(PROBE))).toBeUndefined();
  });

  /** ⚠ The owner's primitive rows are a sign of an EARLIER gate boot only when read
   *  before this boot's owner reconcile writes them. Reordered, a server's first gate
   *  boot would read its own reconcile, skip the grandfather, and strip the always-on
   *  tools from every door that predates the gate — the failure D-228 slice 5 exists
   *  to prevent. Both boot surfaces. */
  it('both boots run the grandfather BEFORE the owner reconcile', () => {
    for (const file of ['../serve/compose-app-context.ts', '../cli-context/mcp.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      const grandfather = src.indexOf('grandfatherPrimitiveGrants(');
      const owner = src.indexOf('reconcileOwnerGrants(');
      expect(grandfather, file).toBeGreaterThan(-1);
      expect(owner, file).toBeGreaterThan(-1);
      expect(grandfather, file).toBeLessThan(owner);
    }
  });

  it('marks a contract even when it needed NO new rows', () => {
    for (const n of TIER1_TOOL_NAMES) grants.set(doorId, primitiveGrantEntry(n), true, NOW);
    const r = grandfatherPrimitiveGrants(store, () => NOW);
    expect(r.seeded).toBe(0);
    expect(store.get(SCOPE, [doorId])).not.toBeNull();
  });

  it('never touches the OWNER contract, marked or not', () => {
    grandfatherPrimitiveGrants(store, () => NOW);
    expect(store.get(SCOPE, [OWNER_CONTRACT_ID])).toBeNull();
  });

  it('an owner REVOKE on a door survives, watermark or not', () => {
    grandfatherPrimitiveGrants(store, () => NOW);
    grants.set(doorId, primitiveGrantEntry('mail.search'), false, NOW);
    grandfatherPrimitiveGrants(store, () => NOW);
    expect(grants.get(doorId, primitiveGrantEntry('mail.search'))).toBe(false);
  });
});
