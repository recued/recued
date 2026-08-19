/** D-247 slice 6 — Tier-2 catalog membership reads the owner's grant.
 *
 *  ⛔⛔ THE DEFECT THIS FILE EXISTS TO PREVENT IS NOT "an ungranted recipe shows
 *  up". It is the OPPOSITE, and it is a total outage: `isOwnerRecipeGranted`
 *  answers `false` for a DOOR structurally — a door's recipe authority is its
 *  inbound token, not the owner's contract — so a filter that skips
 *  `isOwnerGoverned` hides EVERY Tier-2 recipe from EVERY door while looking
 *  exactly like a working gate. Both directions are pinned below. */

import Database from 'better-sqlite3';
import { OWNER_CONTRACT_ID, recipeGrantEntry, type ExecutionSource } from '@recued/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChatTier2GrantFilter } from '../chat-tool-handlers.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = 1_750_000_000_000;
const TOOL = 'recued-core/overdue-invoice-chase';
const KEY = recipeGrantEntry('recued-core', 'overdue-invoice-chase');

const ownerChat: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner',
};
const doorSrc: ExecutionSource = {
  channel: 'mcp', actor: 'contracted_user', agent_id: 'a1', tool_call_id: 'tc1',
  mcp_token_id: 'tok1', contract_id: 'door-1',
};

describe('D-247 slice 6 — the Tier-2 grant filter', () => {
  let db: Database.Database;
  let grants: ReturnType<typeof createContractGrantEntryStore>;
  let gate: ReturnType<typeof createOpAdmissionGate>;
  let deps: { getOpAdmissionGate: () => typeof gate };

  beforeEach(() => {
    db = new Database(':memory:');
    const store = createContractStore(db, { now: () => NOW });
    grants = createContractGrantEntryStore(store);
    gate = createOpAdmissionGate({
      grantEntryStore: grants,
      definitionStore: createContractDefinitionStore(store, { now: () => NOW }),
      now: () => NOW,
    });
    deps = { getOpAdmissionGate: () => gate };
  });
  afterEach(() => db.close());

  const filterFor = (source?: ExecutionSource) =>
    createChatTier2GrantFilter(deps as never)(source);

  it('hides an ungranted recipe from the OWNER (D7 deny-by-default)', () => {
    expect(filterFor(ownerChat)(TOOL)).toBe(false);
  });

  it('shows it once the owner grants it', () => {
    grants.set(OWNER_CONTRACT_ID, KEY, true, NOW);
    expect(filterFor(ownerChat)(TOOL)).toBe(true);
  });

  it('hides it again on an explicit revoke', () => {
    grants.set(OWNER_CONTRACT_ID, KEY, false, NOW);
    expect(filterFor(ownerChat)(TOOL)).toBe(false);
  });

  it('⛔ ADMITS EVERYTHING FOR A DOOR — the total-outage direction', () => {
    // A door's recipe authority is its inbound token, already enforced. Reading
    // its structural `false` as a revoke takes down every Tier-2 recipe on every
    // door, and every owner-path test above stays green while it happens.
    expect(filterFor(doorSrc)(TOOL)).toBe(true);
    grants.set(OWNER_CONTRACT_ID, KEY, true, NOW);
    expect(filterFor(doorSrc)(TOOL)).toBe(true);
  });

  it('leaves non-recipe tool names alone', () => {
    // Tier-1 primitives and ingredient slugs never contain `/` — that is what
    // makes the name-derived key safe to compute here.
    expect(filterFor(ownerChat)('recall_search')).toBe(true);
    expect(filterFor(ownerChat)('mail-send')).toBe(true);
    expect(filterFor(ownerChat)('trailing/')).toBe(true);
  });

  it('fails CLOSED on an absent source, and stays open with no gate wired', () => {
    expect(filterFor(undefined)(TOOL)).toBe(false);
    const noGate = createChatTier2GrantFilter({ getOpAdmissionGate: () => undefined } as never);
    expect(noGate(ownerChat)(TOOL)).toBe(true);
  });

  it('isOwnerGoverned separates "door" from "no grant"', () => {
    expect(gate.isOwnerGoverned(ownerChat)).toBe(true);
    expect(gate.isOwnerGoverned(doorSrc)).toBe(false);
    // …and the ambiguity that makes the helper necessary:
    expect(gate.isOwnerRecipeGranted(ownerChat, KEY)).toBe(false); // no grant
    expect(gate.isOwnerRecipeGranted(doorSrc, KEY)).toBe(false);   // not the owner
  });

  it('the name-derived key matches the formatter the seed uses', () => {
    // A key formed two ways is a grant that writes to one address and reads from
    // another. The filter derives from `<publisher>/<recipe_id>` in the tool name
    // to stay off the per-turn hot path; this pins the equivalence.
    const slash = TOOL.indexOf('/');
    expect(recipeGrantEntry(TOOL.slice(0, slash), TOOL.slice(slash + 1))).toBe(KEY);
  });
});

/** ⛔⛔ CODEX REVIEW FINDING 2 — `chat_exposed` was STILL a gate after seeding.
 *
 *  `buildTier2ToolEntry` drops a hidden recipe before any grant is consulted, and
 *  a filter applied downstream can only NARROW what the projection produced. So
 *  the owner could explicitly grant a hidden recipe and get nothing — the flag
 *  remained the authorization gate D-247 set out to demote to a seed, and every
 *  test that granted an EXPOSED recipe stayed green. */
describe('D-247 D8 — a grant must be able to widen PAST chat_exposed', () => {
  const lookup = (() => null) as never;
  const hidden = {
    publisher_id: 'recued-core',
    recipe_id: 'quiet-one',
    recipe: {
      recipe_id: 'quiet-one', version: 1, ttl: 300, chat_exposed: false,
      metadata: { name: 'Quiet', description: 'hidden by the author', author: 'recued-core' },
      variables: {}, prefetch_steps: [], steps: [], output: { sidebar: [] },
    },
  } as never;

  it('the default projection still drops it — the seed default is unchanged', async () => {
    const { buildTier2Catalog } = await import('@recued/recipes');
    expect(buildTier2Catalog([hidden], lookup)).toHaveLength(0);
  });

  it('includeHidden projects it, so a grant has something to act on', async () => {
    const { buildTier2Catalog } = await import('@recued/recipes');
    const out = buildTier2Catalog([hidden], lookup, undefined, true);
    expect(out.map((e) => e.name)).toEqual(['recued-core/quiet-one']);
    expect(out[0]!.tier).toBe(2);
  });
});

/** D-247 D8 — the DOOR grant picker sees hidden recipes too.
 *
 *  ⛔⛔ SAME DEFECT AS CODEX FINDING 2, ONE SURFACE OVER. `catalogProvider` feeds
 *  `chat.inbound_token.tool_catalog` — the list the owner PICKS FROM when granting
 *  an inbound token — and it projected Tier 2 through the `chat_exposed` filter,
 *  so the owner could not grant a hidden recipe to a door even deliberately.
 *  `chat_exposed` is the AUTHOR's default; the thesis that it is a good default
 *  and a bad gate does not stop at the owner's own catalog.
 *
 *  ⚠ AND IT WIDENS NOTHING: every tool still defaults deny per-token, so a door
 *  reaches a recipe only once the owner ticks it. Showing a choice is not making
 *  one — which is exactly why the fix belongs on the picker and not on the gate. */
describe('D-247 — the token grant picker offers hidden recipes', () => {
  it('projects a chat_exposed:false recipe so the owner can grant it to a door', async () => {
    const { buildTier2Catalog } = await import('@recued/recipes');
    const hidden = {
      publisher_id: 'recued-core',
      recipe_id: 'quiet-one',
      recipe: {
        recipe_id: 'quiet-one', version: 1, ttl: 300, chat_exposed: false,
        metadata: { name: 'Quiet', description: 'hidden by the author', author: 'recued-core' },
        variables: {}, prefetch_steps: [], steps: [], output: { sidebar: [] },
      },
    } as never;
    const lookup = (() => null) as never;
    // What the picker used to see:
    expect(buildTier2Catalog([hidden], lookup)).toHaveLength(0);
    // What it sees now — a row the owner can tick, still ungranted until they do.
    const offered = buildTier2Catalog([hidden], lookup, undefined, true);
    expect(offered.map((e) => e.name)).toEqual(['recued-core/quiet-one']);
  });
});
