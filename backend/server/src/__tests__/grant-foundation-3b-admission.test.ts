/** Grant-foundation slice 3b (D-187 AMENDMENT) — the admission spine: the governing-
 *  contract resolver, the op-admission gate, the owner boot reconcile, and the
 *  owner-permissive read author-default. Covers the security-critical invariants:
 *
 *   - the OWNER-AI surfaces (`(chat | messenger, user_self)`, no explicit contract_id)
 *     resolve to the always-live OWNER contract; the human HID (`(user, user_self)`) +
 *     the system channels stay contract-free;
 *   - the PRIVILEGE-ESCALATION FENCE (codex 3b HIGH): an EXPLICIT contract_id equal to
 *     `OWNER_CONTRACT_ID` on a contracted source is NEVER treated as the owner — it is a
 *     door with no `contract_definition` ⇒ dead ⇒ ungoverned, so it can't inherit the
 *     owner's permissive grants / revokes;
 *   - the op-admission gate denies `op_not_granted` on an explicit owner REVOKE, is
 *     permissive by default, and is a no-op for a contract-free dispatch;
 *   - the boot reconcile seeds the owner complete + idempotent + PRESERVES revokes;
 *   - the owner-permissive read author-default (owner sees a fenced topic; a door does
 *     not). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectionGrantEntry,
  CONTRACT_DEFINITION_SCOPE,
  KERNEL_OP_REGISTRY,
  opGrantEntry,
  OWNER_CONTRACT_ID,
  topicGrantEntry,
  type ContractDefinition,
  type EnrichmentTopic,
  type ExecutionSource,
} from '@recued/contracts';

import {
  gateGrantGoverningContractId,
  resolveGrantGoverningContractId,
  gateStandingContractId,
} from '../grant-governing-contract.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { reconcileOwnerGrants } from '../owner-grant-reconcile.js';
import {
  AUTHOR_DEFAULT_ONLY_RESOLVER,
  createGatedReadGrantResolver,
  createReadGrantChecker,
} from '../read-grant-checker.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = 1_750_000_000_000;
const PUBLIC_TOPIC: EnrichmentTopic = 'company';
// A kernel op every owner is reconciled to hold (and a sensible op to revoke in tests).
const MAIL_SEND_OP = 'core.mail.send';

// ── canonical sources ────────────────────────────────────────────
const ownerChat: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 's1',
  user_id: 'owner',
};
const ownerMessenger: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'owner',
};
const humanHid: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner',
  client_token_id: 'ct',
};
const systemSchedule: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 * * * *',
  source_recipe: 'r1',
};
const door = (contract_id: string): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'a1',
  tool_call_id: 'tc1',
  mcp_token_id: 'tok1',
  contract_id,
});

describe('resolveGrantGoverningContractId — provenance-keyed owner derivation', () => {
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let defStore: ReturnType<typeof createContractDefinitionStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, { now: () => NOW, newId: () => 'ct_door' });
  });
  afterEach(() => db.close());

  it('OWNER-AI surfaces (chat / messenger, user_self, no contract_id) → the OWNER sentinel', () => {
    expect(resolveGrantGoverningContractId(ownerChat, defStore, () => NOW)).toBe(OWNER_CONTRACT_ID);
    expect(resolveGrantGoverningContractId(ownerMessenger, defStore, () => NOW)).toBe(
      OWNER_CONTRACT_ID,
    );
  });

  it('the human HID (user, user_self) + the system channels stay CONTRACT-FREE (undefined)', () => {
    expect(resolveGrantGoverningContractId(humanHid, defStore, () => NOW)).toBeUndefined();
    expect(resolveGrantGoverningContractId(systemSchedule, defStore, () => NOW)).toBeUndefined();
  });

  it('a door with a LIVE contract_definition → its bound contract id', () => {
    const def = defStore.mint({
      minted_by: 'user:1',
      display_name: 'd',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    expect(resolveGrantGoverningContractId(door(def.contract_id), defStore, () => NOW)).toBe(
      def.contract_id,
    );
  });

  it('D-196: a customer instance is grant-governing but never ordinary standing', () => {
    const def = defStore.mint({
      minted_by: 'user:1',
      display_name: 'customer_instance',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    store.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], {
      ...def,
      grant_kind: 'customer_instance',
    });
    expect(gateStandingContractId(def.contract_id, defStore, () => NOW)).toBeUndefined();
    expect(gateGrantGoverningContractId(def.contract_id, defStore, () => NOW))
      .toBe(def.contract_id);
    expect(resolveGrantGoverningContractId(door(def.contract_id), defStore, () => NOW))
      .toBe(def.contract_id);
  });

  it('D-196: a customer template remains inert to every bound-door grant gate', () => {
    const def = defStore.mint({
      minted_by: 'user:1',
      display_name: 'customer_template',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    store.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], {
      ...def,
      grant_kind: 'customer_template',
    });
    expect(gateStandingContractId(def.contract_id, defStore, () => NOW)).toBeUndefined();
    expect(gateGrantGoverningContractId(def.contract_id, defStore, () => NOW)).toBeUndefined();
    expect(resolveGrantGoverningContractId(door(def.contract_id), defStore, () => NOW))
      .toBeUndefined();
  });

  it('a door with NO contract_definition (synthetic token id) → undefined (ungoverned)', () => {
    expect(resolveGrantGoverningContractId(door('tok-synthetic'), defStore, () => NOW)).toBeUndefined();
  });

  it('SECURITY: an explicit contract_id === OWNER_CONTRACT_ID on a contracted source is NOT the owner', () => {
    // The escalation the codex 3b HIGH flagged: a door bound to 'user_self' must not be
    // treated as the always-live owner. It has no contract_definition ⇒ dead ⇒ undefined,
    // so it can never inherit the owner's permissive grant rows.
    expect(
      resolveGrantGoverningContractId(door(OWNER_CONTRACT_ID), defStore, () => NOW),
    ).toBeUndefined();
    // Even if SOMEONE managed to mint a def at id 'user_self', the bare-id liveness gate
    // is what the resolver uses for explicit ids — and binding/minting 'user_self' is
    // fenced at the boundary (covered below), so this stays undefined in practice.
    expect(gateStandingContractId(OWNER_CONTRACT_ID, defStore, () => NOW)).toBeUndefined();
  });

  it('SECURITY: even a FORCED live definition at OWNER_CONTRACT_ID cannot make a door govern as owner', () => {
    // Defense in depth (codex 3b HIGH): simulate a stale import / direct store write that
    // planted a LIVE contract_definition at the reserved owner id (the mint + bind fences
    // block the normal creation paths; the resolver must fail closed regardless, since
    // every op/read gate trusts its return value). Mint a normal def, then forcibly clone
    // its row under 'user_self'.
    const elsewhere = defStore.mint({
      minted_by: 'user:1',
      display_name: 'x',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    const row = store.get(CONTRACT_DEFINITION_SCOPE, [elsewhere.contract_id])!
      .value as ContractDefinition;
    store.put(CONTRACT_DEFINITION_SCOPE, [OWNER_CONTRACT_ID], {
      ...row,
      contract_id: OWNER_CONTRACT_ID,
    });
    // The resolver short-circuits the reserved id BEFORE the def lookup ⇒ undefined,
    // regardless of the planted live row — a door bound to 'user_self' never governs.
    expect(gateStandingContractId(OWNER_CONTRACT_ID, defStore, () => NOW)).toBeUndefined();
    expect(
      resolveGrantGoverningContractId(door(OWNER_CONTRACT_ID), defStore, () => NOW),
    ).toBeUndefined();
  });
});

describe('createOpAdmissionGate — op-admission over the unified grant store', () => {
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let gate: ReturnType<typeof createOpAdmissionGate>;
  let grantEntryStore: ReturnType<typeof createContractGrantEntryStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    grantEntryStore = createContractGrantEntryStore(store);
    gate = createOpAdmissionGate({
      grantEntryStore,
      definitionStore: createContractDefinitionStore(store, { now: () => NOW }),
      now: () => NOW,
    });
  });
  afterEach(() => db.close());

  it('an undefined op id ⇒ admit (no op axis to gate)', () => {
    expect(gate.isOpGranted(ownerChat, undefined)).toBe(true);
  });

  it('a contract-free dispatch ⇒ admit (no grant gate — HID / system stay ungated)', () => {
    expect(gate.isOpGranted(humanHid, MAIL_SEND_OP)).toBe(true);
    expect(gate.isOpGranted(systemSchedule, MAIL_SEND_OP)).toBe(true);
  });

  it('the OWNER is PERMISSIVE by default (no row ⇒ author-default true)', () => {
    expect(gate.isOpGranted(ownerChat, MAIL_SEND_OP)).toBe(true);
  });

  it('an explicit OWNER REVOKE denies the op for the owner AI (the tightening point)', () => {
    grantEntryStore.set(OWNER_CONTRACT_ID, opGrantEntry(MAIL_SEND_OP), false, NOW);
    expect(gate.isOpGranted(ownerChat, MAIL_SEND_OP)).toBe(false);
    expect(gate.isOpGranted(ownerMessenger, MAIL_SEND_OP)).toBe(false);
    // A DIFFERENT op the owner did not revoke stays admitted.
    expect(gate.isOpGranted(ownerChat, 'core.contact.resolve')).toBe(true);
  });

  it('SECURITY: an OWNER revoke does NOT leak to a door bound to contract_id user_self', () => {
    grantEntryStore.set(OWNER_CONTRACT_ID, opGrantEntry(MAIL_SEND_OP), false, NOW);
    // The door (contract_id 'user_self', no def) is ungoverned ⇒ admit (the snapshot is
    // its real gate) — it neither inherits the owner's revoke nor its permissive grants.
    expect(gate.isOpGranted(door(OWNER_CONTRACT_ID), MAIL_SEND_OP)).toBe(true);
  });
});

describe('createOpAdmissionGate — isFrozenByPause (D-188 master pause)', () => {
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let defStore: ReturnType<typeof createContractDefinitionStore>;
  let grantEntryStore: ReturnType<typeof createContractGrantEntryStore>;
  let paused: boolean;
  let gate: ReturnType<typeof createOpAdmissionGate>;

  const liveDoor = (): string =>
    defStore.mint({
      minted_by: 'op',
      display_name: 'Door',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    }).contract_id;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, { now: () => NOW });
    grantEntryStore = createContractGrantEntryStore(store);
    paused = false;
    gate = createOpAdmissionGate({
      grantEntryStore,
      definitionStore: defStore,
      isPaused: () => paused,
      now: () => NOW,
    });
  });
  afterEach(() => db.close());

  it('not paused ⇒ nothing is frozen (owner / door / HID all false)', () => {
    expect(gate.isFrozenByPause(ownerChat)).toBe(false);
    expect(gate.isFrozenByPause(door(liveDoor()))).toBe(false);
    expect(gate.isFrozenByPause(humanHid)).toBe(false);
  });

  it('paused ⇒ GOVERNED dispatches freeze — owner-AI (chat + messenger) + a live door', () => {
    paused = true;
    expect(gate.isFrozenByPause(ownerChat)).toBe(true);
    expect(gate.isFrozenByPause(ownerMessenger)).toBe(true);
    expect(gate.isFrozenByPause(door(liveDoor()))).toBe(true);
  });

  it('SECURITY: paused does NOT freeze the contract-free owner HID (resume + direct control stay alive)', () => {
    paused = true;
    expect(gate.isFrozenByPause(humanHid)).toBe(false);
  });

  it('paused does NOT freeze the system channels at the gate (the scheduler-pause half stops those)', () => {
    paused = true;
    expect(gate.isFrozenByPause(systemSchedule)).toBe(false);
  });

  it('paused does NOT freeze a dead / synthetic door (ungoverned ⇒ bypass; it dispatches nothing anyway)', () => {
    paused = true;
    expect(gate.isFrozenByPause(door('tok-synthetic'))).toBe(false);
  });

  it('the freeze set is EXACTLY the governed set — parity with the isOpGranted bypass', () => {
    paused = true;
    const liveId = liveDoor();
    // governed ⇒ resolveGrantGoverningContractId defined ⇒ frozen
    for (const src of [ownerChat, ownerMessenger, door(liveId)]) {
      expect(resolveGrantGoverningContractId(src, defStore, () => NOW)).toBeDefined();
      expect(gate.isFrozenByPause(src)).toBe(true);
    }
    // contract-free ⇒ undefined ⇒ NOT frozen (the SAME bypass isOpGranted uses)
    for (const src of [humanHid, systemSchedule, door('tok-synthetic')]) {
      expect(resolveGrantGoverningContractId(src, defStore, () => NOW)).toBeUndefined();
      expect(gate.isFrozenByPause(src)).toBe(false);
    }
  });

  it('no isPaused thunk injected ⇒ pause is unenforced at the gate (always false)', () => {
    const ungated = createOpAdmissionGate({
      grantEntryStore,
      definitionStore: defStore,
      now: () => NOW,
    });
    expect(ungated.isFrozenByPause(ownerChat)).toBe(false);
    expect(ungated.isFrozenByPause(door(liveDoor()))).toBe(false);
  });
});

describe('createOpAdmissionGate — the DOOR op-grant fold + fail-closed flip (D-187 §6 home-#2)', () => {
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let defStore: ReturnType<typeof createContractDefinitionStore>;
  let grantEntryStore: ReturnType<typeof createContractGrantEntryStore>;
  let gate: ReturnType<typeof createOpAdmissionGate>;

  // A pack op id (`<publisher>/<entity>.<verb>`) alongside the kernel `MAIL_SEND_OP` —
  // the two op-grant-entry shapes a door's `scope.operation_ids` can carry.
  const PACK_OP = 'recued-core/hubspot.deal.read';

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, { now: () => NOW });
    grantEntryStore = createContractGrantEntryStore(store);
    gate = createOpAdmissionGate({ grantEntryStore, definitionStore: defStore, now: () => NOW });
  });
  afterEach(() => db.close());

  /** Mint a live standing door + REPLAY the mint-fold (an explicit `granted:true` row per
   *  scope op — what `handleContractMint` writes atomically). Returns the contract_id. */
  const mintScopedDoor = (operation_ids: string[]): string => {
    const def = defStore.mint({
      minted_by: 'op',
      display_name: 'Door',
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids },
    });
    for (const op of operation_ids) {
      grantEntryStore.set(def.contract_id, opGrantEntry(op), true, NOW);
    }
    return def.contract_id;
  };

  const mintCustomerDoor = (operation_ids: string[]): string => {
    const id = mintScopedDoor(operation_ids);
    const def = defStore.get(id);
    if (def === null) throw new Error(`missing test contract '${id}'`);
    store.put(CONTRACT_DEFINITION_SCOPE, [id], {
      ...def,
      grant_kind: 'customer_instance',
    });
    return id;
  };

  it('a SCOPED door is GRANTED an in-scope op (the folded explicit row)', () => {
    const id = mintScopedDoor([PACK_OP]);
    expect(gate.isOpGranted(door(id), PACK_OP)).toBe(true);
  });

  it('a SCOPED door is DENIED an out-of-scope PACK op (fail-closed; no row)', () => {
    const id = mintScopedDoor([PACK_OP]);
    expect(gate.isOpGranted(door(id), 'recued-core/hubspot.deal.write')).toBe(false);
  });

  it('SECURITY: a SCOPED door is DENIED an out-of-scope KERNEL op — NO isKernelOp carve-out (codex HIGH)', () => {
    const id = mintScopedDoor([PACK_OP]);
    // The fail-closed flip: a scoped door does NOT inherit every `core.*` verb for free…
    expect(gate.isOpGranted(door(id), MAIL_SEND_OP)).toBe(false);
    // …and a future / unenumerated kernel op is denied too (the version-skew guard).
    expect(gate.isOpGranted(door(id), 'core.future.verb')).toBe(false);
  });

  it('a SCOPED door IS granted an in-scope KERNEL op (folded like any other), but not a sibling it never listed', () => {
    const id = mintScopedDoor([MAIL_SEND_OP]);
    expect(gate.isOpGranted(door(id), MAIL_SEND_OP)).toBe(true);
    expect(gate.isOpGranted(door(id), 'core.contact.resolve')).toBe(false);
  });

  it('a WILDCARD door (absent / empty operation_ids) stays PERMISSIVE — behaviour-preserving', () => {
    const wild = defStore.mint({
      minted_by: 'op',
      display_name: 'Wildcard',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    expect(gate.isOpGranted(door(wild.contract_id), MAIL_SEND_OP)).toBe(true);
    expect(gate.isOpGranted(door(wild.contract_id), PACK_OP)).toBe(true);
    // An explicit EMPTY list is wildcard too (no finite op set to materialize).
    const empty = defStore.mint({
      minted_by: 'op',
      display_name: 'Empty',
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: [] },
    });
    expect(gate.isOpGranted(door(empty.contract_id), PACK_OP)).toBe(true);
  });

  it('a customer instance consumes explicit op rows and defaults missing ops off', () => {
    const id = mintCustomerDoor([PACK_OP]);
    expect(gate.isOpGranted(door(id), PACK_OP)).toBe(true);
    expect(gate.isOpGranted(door(id), MAIL_SEND_OP)).toBe(false);

    const wildcard = mintCustomerDoor([]);
    expect(gate.isOpGranted(door(wildcard), PACK_OP)).toBe(false);
  });

  it('an explicit REVOKE wins over the folded grant (the owner tightening point)', () => {
    const id = mintScopedDoor([PACK_OP]);
    grantEntryStore.set(id, opGrantEntry(PACK_OP), false, NOW);
    expect(gate.isOpGranted(door(id), PACK_OP)).toBe(false);
  });

  it('the scoped-door fail-closed flip does NOT touch the OWNER (still permissive by default)', () => {
    mintScopedDoor([PACK_OP]); // a scoped door exists in the store…
    expect(gate.isOpGranted(ownerChat, MAIL_SEND_OP)).toBe(true); // …the owner is unaffected
  });
});

describe('the read-gate VERB-OP term resolves IDENTICALLY to op-admission (D-187 slice 3)', () => {
  // The native MCP read tools (timeline / registry.describe / enrichment.read /
  // vector_search) gate their cross-topic VERB via a per-contract `op` grant, resolved by
  // `ReadGrantChecker.isVerbOpGranted`. This pins the "one decision, many seams"
  // consolidation: the verb-op term and `OpAdmissionGate.isOpGranted` must NEVER disagree
  // about a contract's op posture (they share `opAuthorDefault` + the one grant store).
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let defStore: ReturnType<typeof createContractDefinitionStore>;
  let grantEntryStore: ReturnType<typeof createContractGrantEntryStore>;
  let gate: ReturnType<typeof createOpAdmissionGate>;
  let readResolver: ReturnType<typeof createGatedReadGrantResolver>;

  // A NATIVE verb-op (a D-187 slice-3 MCP-native read-tool grant handle, no backing
  // ingredient) — the new thing the read gate gates.
  const NATIVE_VERB_OP = 'core.data.enrichment.read';

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, { now: () => NOW });
    grantEntryStore = createContractGrantEntryStore(store);
    gate = createOpAdmissionGate({ grantEntryStore, definitionStore: defStore, now: () => NOW });
    readResolver = createGatedReadGrantResolver(store, () => NOW);
  });
  afterEach(() => db.close());

  /** Mint a live standing door + replay the mint-fold (the explicit `granted:true` rows
   *  `handleContractMint` writes per scope op). Returns the contract_id. */
  const mintScopedDoor = (operation_ids: string[]): string => {
    const def = defStore.mint({
      minted_by: 'op',
      display_name: 'Door',
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids },
    });
    for (const op of operation_ids) grantEntryStore.set(def.contract_id, opGrantEntry(op), true, NOW);
    return def.contract_id;
  };

  /** Assert BOTH seams agree on `op` for the door `contractId`. */
  const assertParity = (contractId: string, op: string, expected: boolean): void => {
    expect(gate.isOpGranted(door(contractId), op), `op-admission(${op})`).toBe(expected);
    expect(
      readResolver.resolveForContract(contractId).isVerbOpGranted(op),
      `verb-op(${op})`,
    ).toBe(expected);
  };

  it('OWNER (resolved from the owner-AI source) → verb-op permissive on both seams', () => {
    expect(readResolver.resolveForSource(ownerChat).isVerbOpGranted(NATIVE_VERB_OP)).toBe(true);
    expect(gate.isOpGranted(ownerChat, NATIVE_VERB_OP)).toBe(true);
  });

  it('an OWNER revoke of the verb-op closes it on both seams (tightenable)', () => {
    grantEntryStore.set(OWNER_CONTRACT_ID, opGrantEntry(NATIVE_VERB_OP), false, NOW);
    expect(readResolver.resolveForSource(ownerChat).isVerbOpGranted(NATIVE_VERB_OP)).toBe(false);
    expect(gate.isOpGranted(ownerChat, NATIVE_VERB_OP)).toBe(false);
  });

  it('a WILDCARD door (no op-scope) → verb-op permissive (both seams)', () => {
    const wild = defStore.mint({
      minted_by: 'op',
      display_name: 'Wildcard',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    assertParity(wild.contract_id, NATIVE_VERB_OP, true);
  });

  it('a SCOPED door WITHOUT the verb-op → FAIL-CLOSED (both seams)', () => {
    const id = mintScopedDoor(['core.mail.get']); // scoped, but not the read verb-op
    assertParity(id, NATIVE_VERB_OP, false);
  });

  it('a SCOPED door GRANTED the verb-op (in scope) → admitted (both seams)', () => {
    const id = mintScopedDoor([NATIVE_VERB_OP]);
    assertParity(id, NATIVE_VERB_OP, true);
  });

  it('a customer instance is explicit-row-only on both op and read seams', () => {
    const id = mintScopedDoor([NATIVE_VERB_OP]);
    const def = defStore.get(id);
    if (def === null) throw new Error(`missing test contract '${id}'`);
    store.put(CONTRACT_DEFINITION_SCOPE, [id], {
      ...def,
      grant_kind: 'customer_instance',
    });
    assertParity(id, NATIVE_VERB_OP, true);
    assertParity(id, 'core.customer.missing', false);

    const checker = readResolver.resolveForContract(id);
    expect(checker.isCollectionReadGranted('mail')).toBe(false);
    expect(checker.isTopicReadGranted(PUBLIC_TOPIC)).toBe(false);
    grantEntryStore.set(id, collectionGrantEntry('mail'), true, NOW);
    grantEntryStore.set(id, topicGrantEntry(PUBLIC_TOPIC), true, NOW);
    expect(checker.isCollectionReadGranted('mail')).toBe(true);
    expect(checker.isTopicReadGranted(PUBLIC_TOPIC)).toBe(true);
  });

  it('an ABSENT / gated-out contract → verb-op ADMIT (no governing contract gates it)', () => {
    // matches `isOpGranted` returning true when no governing contract resolves.
    expect(readResolver.resolveForContract('ct-ghost').isVerbOpGranted(NATIVE_VERB_OP)).toBe(true);
    expect(gate.isOpGranted(door('ct-ghost'), NATIVE_VERB_OP)).toBe(true);
  });
});

describe('OWNER-default-only sensitive surfaces (D-187 slice 3b) — owner ON, every door OFF', () => {
  // Sensitive engagements / audit / webhook / free-form-response surfaces
  // default ON for the owner and OFF for EVERY live door — INCLUDING a wildcard
  // door (whose normal op default is permissive). A contract-free dispatch
  // (owner's unbound MCP / HID / system) admits (owner-trust). An explicit grant
  // opts a door in. The op gate + the read-grant verb-op seam resolve identically
  // (the override lives in the shared `ownerOnlyAdjustedAuthorDefault`).
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let defStore: ReturnType<typeof createContractDefinitionStore>;
  let grantEntryStore: ReturnType<typeof createContractGrantEntryStore>;
  let gate: ReturnType<typeof createOpAdmissionGate>;
  let readResolver: ReturnType<typeof createGatedReadGrantResolver>;

  const ENGAGEMENTS_OP = 'core.contact.engagements.read'; // owner-only NATIVE verb-op
  const WEBHOOK_OP = 'core.data.webhook.list'; // owner-only ORDINARY (recipe) read op
  const FORM_RESPONSE_OP = 'core.data.form-response.get'; // owner-only ORDINARY response read
  const NORMAL_OP = 'core.mail.get'; // a NON-sensitive read op (wildcard-permissive)
  const WORK_READ_OP = 'core.work-entity.read'; // owner-only NATIVE verb-op (work.search / work.read)

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, { now: () => NOW });
    grantEntryStore = createContractGrantEntryStore(store);
    gate = createOpAdmissionGate({ grantEntryStore, definitionStore: defStore, now: () => NOW });
    readResolver = createGatedReadGrantResolver(store, () => NOW);
  });
  afterEach(() => db.close());

  const mintWildcardDoor = (): string =>
    defStore.mint({
      minted_by: 'op',
      display_name: 'Wildcard',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    }).contract_id;

  const mintScopedDoor = (operation_ids: string[]): string => {
    const def = defStore.mint({
      minted_by: 'op',
      display_name: 'Door',
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids },
    });
    for (const op of operation_ids) grantEntryStore.set(def.contract_id, opGrantEntry(op), true, NOW);
    return def.contract_id;
  };

  it('a LIVE WILDCARD door is DENIED an owner-only surface but ADMITTED a normal one', () => {
    const id = mintWildcardDoor();
    // the wildcard permissive default still admits a non-sensitive read op…
    expect(gate.isOpGranted(door(id), NORMAL_OP)).toBe(true);
    // …but the owner-only override fail-closes the sensitive ones (the "off for others").
    expect(gate.isOpGranted(door(id), ENGAGEMENTS_OP)).toBe(false);
    expect(gate.isOpGranted(door(id), WEBHOOK_OP)).toBe(false);
    expect(gate.isOpGranted(door(id), FORM_RESPONSE_OP)).toBe(false);
    expect(gate.isOpGranted(door(id), WORK_READ_OP)).toBe(false);
    // the read-grant verb-op seam agrees (no drift).
    expect(readResolver.resolveForContract(id).isVerbOpGranted(ENGAGEMENTS_OP)).toBe(false);
    expect(readResolver.resolveForContract(id).isVerbOpGranted(FORM_RESPONSE_OP)).toBe(false);
    expect(readResolver.resolveForContract(id).isVerbOpGranted(WORK_READ_OP)).toBe(false);
  });

  // ── core.work-entity.read — the work-graph read capability ──────
  //
  // Before this op existed, `work.search` / `work.read` had NO grant handle at
  // all: Tier-1 + `classification: 'read'` made them default-ON in every door's
  // per-token checklist, and the only thing between a door and the owner's whole
  // work graph was the per-Source `mcp_exposed` flag — which is GLOBAL, so
  // exposing a Source for ONE door exposed it to every door. These pin the two
  // ends that matter: the owner keeps reading, a door must be granted.

  it('🔑 the OWNER keeps reading their work graph — contract-free admits (no regression)', () => {
    // THE safety property of adding this op. Owner chat dispatches
    // `(chat, user_self)` with NO contract_id → contract-free → `isOpGranted`
    // short-circuits ADMIT. If this ever goes red, owner chat has silently lost
    // `work.search` and "what's on my plate" answers an empty list.
    expect(gate.isOpGranted(ownerChat, WORK_READ_OP)).toBe(true);
    expect(gate.isOpGranted(ownerMessenger, WORK_READ_OP)).toBe(true);
    expect(gate.isOpGranted(humanHid, WORK_READ_OP)).toBe(true);
    expect(gate.isOpGranted(systemSchedule, WORK_READ_OP)).toBe(true);
  });

  it('a SCOPED door without the op is denied; an EXPLICIT grant opts it in', () => {
    const ungranted = mintScopedDoor([MAIL_SEND_OP]);
    expect(gate.isOpGranted(door(ungranted), WORK_READ_OP)).toBe(false);

    // The owner CAN hand a door the work graph — owner-default-only is a
    // default, not a prohibition (an explicit row wins over the override).
    const granted = mintScopedDoor([WORK_READ_OP]);
    expect(gate.isOpGranted(door(granted), WORK_READ_OP)).toBe(true);
    expect(readResolver.resolveForContract(granted).isVerbOpGranted(WORK_READ_OP)).toBe(true);
  });

  it('an explicit REVOKE beats the grant fold, and the two seams agree', () => {
    const id = mintScopedDoor([WORK_READ_OP]);
    grantEntryStore.set(id, opGrantEntry(WORK_READ_OP), false, NOW);
    expect(gate.isOpGranted(door(id), WORK_READ_OP)).toBe(false);
    expect(readResolver.resolveForContract(id).isVerbOpGranted(WORK_READ_OP)).toBe(false);
  });

  it('a LIVE SCOPED door is DENIED an owner-only surface not in its scope', () => {
    const id = mintScopedDoor([NORMAL_OP]);
    expect(gate.isOpGranted(door(id), ENGAGEMENTS_OP)).toBe(false);
    expect(readResolver.resolveForContract(id).isVerbOpGranted(ENGAGEMENTS_OP)).toBe(false);
  });

  it('the OWNER is GRANTED owner-only surfaces by default (both seams)', () => {
    expect(gate.isOpGranted(ownerChat, ENGAGEMENTS_OP)).toBe(true);
    expect(gate.isOpGranted(ownerChat, WEBHOOK_OP)).toBe(true);
    expect(gate.isOpGranted(ownerChat, FORM_RESPONSE_OP)).toBe(true);
    expect(readResolver.resolveForSource(ownerChat).isVerbOpGranted(ENGAGEMENTS_OP)).toBe(true);
    expect(readResolver.resolveForSource(ownerChat).isVerbOpGranted(FORM_RESPONSE_OP)).toBe(true);
  });

  it('a CONTRACT-FREE dispatch (owner unbound MCP / HID / system / dead door) ADMITS owner-only', () => {
    // op gate: the undefined-governing short-circuit admits the human HID + system channels.
    expect(gate.isOpGranted(humanHid, WEBHOOK_OP)).toBe(true);
    expect(gate.isOpGranted(systemSchedule, WEBHOOK_OP)).toBe(true);
    expect(gate.isOpGranted(systemSchedule, FORM_RESPONSE_OP)).toBe(true);
    // read seam: a contract-free (`''`) bound id — the owner's unbound stdio/CLI MCP, or a
    // dead/absent door — admits owner-only (owner-trust), matching the op-gate short-circuit.
    expect(readResolver.resolveForContract(undefined).isVerbOpGranted(ENGAGEMENTS_OP)).toBe(true);
    expect(readResolver.resolveForContract('ct-ghost').isVerbOpGranted(ENGAGEMENTS_OP)).toBe(true);
  });

  it('an EXPLICIT grant opts a door into an owner-only surface (owner can delegate)', () => {
    const id = mintScopedDoor([ENGAGEMENTS_OP, FORM_RESPONSE_OP]); // mints + folds explicit grants
    expect(gate.isOpGranted(door(id), ENGAGEMENTS_OP)).toBe(true);
    expect(gate.isOpGranted(door(id), FORM_RESPONSE_OP)).toBe(true);
    expect(readResolver.resolveForContract(id).isVerbOpGranted(ENGAGEMENTS_OP)).toBe(true);
    expect(readResolver.resolveForContract(id).isVerbOpGranted(FORM_RESPONSE_OP)).toBe(true);
  });

  it('an OWNER REVOKE closes an owner-only surface for the owner too (tightenable)', () => {
    grantEntryStore.set(OWNER_CONTRACT_ID, opGrantEntry(ENGAGEMENTS_OP), false, NOW);
    expect(gate.isOpGranted(ownerChat, ENGAGEMENTS_OP)).toBe(false);
    expect(readResolver.resolveForSource(ownerChat).isVerbOpGranted(ENGAGEMENTS_OP)).toBe(false);
  });
});

describe('reconcileOwnerGrants — boot materialization (idempotent, revoke-preserving)', () => {
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;
  let grantEntryStore: ReturnType<typeof createContractGrantEntryStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    grantEntryStore = createContractGrantEntryStore(store);
  });
  afterEach(() => db.close());

  it('a fresh reconcile seeds the owner granted:true per kernel op / collection / topic', () => {
    const result = reconcileOwnerGrants(store, () => NOW);
    expect(result.seeded).toBeGreaterThan(0);
    expect(result.preserved).toBe(0);
    // Spot-check one of each kind is granted true under the owner.
    expect(grantEntryStore.get(OWNER_CONTRACT_ID, opGrantEntry(MAIL_SEND_OP))).toBe(true);
    expect(grantEntryStore.get(OWNER_CONTRACT_ID, collectionGrantEntry('mail'))).toBe(true);
    expect(grantEntryStore.get(OWNER_CONTRACT_ID, topicGrantEntry(PUBLIC_TOPIC))).toBe(true);
    // Every registered kernel op landed.
    for (const e of KERNEL_OP_REGISTRY) {
      expect(grantEntryStore.get(OWNER_CONTRACT_ID, opGrantEntry(e.op))).toBe(true);
    }
  });

  it('is IDEMPOTENT — a re-run seeds nothing and preserves every row', () => {
    const first = reconcileOwnerGrants(store, () => NOW);
    const second = reconcileOwnerGrants(store, () => NOW);
    expect(second.seeded).toBe(0);
    expect(second.preserved).toBe(first.seeded);
  });

  it('PRESERVES an explicit owner revoke across the reconcile (never re-grants it)', () => {
    grantEntryStore.set(OWNER_CONTRACT_ID, opGrantEntry(MAIL_SEND_OP), false, NOW);
    reconcileOwnerGrants(store, () => NOW);
    // The revoke must survive — the reconcile only ADDS where no row exists.
    expect(grantEntryStore.get(OWNER_CONTRACT_ID, opGrantEntry(MAIL_SEND_OP))).toBe(false);
  });
});

describe('owner-permissive read author-default + the escalation fence', () => {
  let db: Database.Database;
  let store: ReturnType<typeof createContractStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it('the OWNER reads owner-only raw collections a DOOR cannot', () => {
    // Slice 6 — with the scope-fence half retired, the owner-permissive override shows on
    // the OWNER-default-only collections: a DOOR's author-default is FALSE
    // (door-default-off), while the OWNER's is TRUE.
    const doorChecker = createReadGrantChecker(AUTHOR_DEFAULT_ONLY_RESOLVER, 'ct_door');
    expect(doorChecker.isCollectionReadGranted('webhook')).toBe(false);
    expect(doorChecker.isCollectionReadGranted('form_response')).toBe(false);

    const ownerChecker = createReadGrantChecker(AUTHOR_DEFAULT_ONLY_RESOLVER, OWNER_CONTRACT_ID);
    expect(ownerChecker.isCollectionReadGranted('webhook')).toBe(true);
    expect(ownerChecker.isCollectionReadGranted('form_response')).toBe(true);
  });

  it('SECURITY: a door claiming user_self is gated out — NOT governed by the owner contract', () => {
    // Seed an explicit OWNER revoke on the public probe topic. The scope-fence half that
    // used to distinguish a gated-out door from the owner retired in slice 6; the surviving
    // distinction is grant-row GOVERNANCE — only a source the resolver binds to the owner
    // contract honours the owner's rows.
    createContractGrantEntryStore(store).set(
      OWNER_CONTRACT_ID,
      topicGrantEntry(PUBLIC_TOPIC),
      false,
      NOW,
    );
    const resolver = createGatedReadGrantResolver(store, () => NOW);
    // The owner's OWN chat source IS governed by the owner contract ⇒ the revoke applies.
    expect(resolver.resolveForSource(ownerChat).isTopicReadGranted(PUBLIC_TOPIC)).toBe(false);
    // A door claiming `user_self` (a contract_id with no def) is gated OUT (the escalation
    // fence: a door is never resolved to the owner contract) ⇒ it does NOT inherit the
    // owner's revoke row; it reads the plain public author-default.
    expect(
      resolver.resolveForSource(door(OWNER_CONTRACT_ID)).isTopicReadGranted(PUBLIC_TOPIC),
    ).toBe(true);
  });
});
