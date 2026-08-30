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
 *  unit test. */

import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_CONTRACT_ID,
  TIER1_TOOL_NAMES,
  primitiveGrantEntry,
} from '@recued/contracts';

import { grandfatherPrimitiveGrants, reconcileOwnerGrants } from '../owner-grant-reconcile.js';
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
    reconcileOwnerGrants(store, () => NOW);
    doorId = mintDoor();
  });
  afterEach(() => db.close());

  it('the first run grandfathers the door AND marks it', () => {
    expect(store.get(SCOPE, [doorId])).toBeNull();
    const r = grandfatherPrimitiveGrants(store, () => NOW);
    expect(r.seeded).toBe(TIER1_TOOL_NAMES.length);
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

  it('the UPGRADE case still works — an UNMARKED contract is still covered', () => {
    grandfatherPrimitiveGrants(store, () => NOW);
    // A door that existed before the gate: it has no mark and no rows.
    const legacy = mintDoor('legacy');
    expect(store.get(SCOPE, [legacy])).toBeNull();
    const r = grandfatherPrimitiveGrants(store, () => NOW);
    expect(r.seeded).toBe(TIER1_TOOL_NAMES.length);
    expect(grants.get(legacy, primitiveGrantEntry(PROBE))).toBe(true);
    expect(store.get(SCOPE, [legacy])).not.toBeNull();
  });

  /** ⛔ A contract that already held every row still needs marking — otherwise it stays
   *  unmarked forever and every future primitive lands on it. The bug surviving in the
   *  one case that looks most benign is exactly how it would come back. */
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
