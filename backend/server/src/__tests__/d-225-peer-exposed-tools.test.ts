/** D-225 auto-mint — WHAT DO WE EXPOSE TO THIS PEER?
 *
 *  The loopback diff has exactly one input, and getting it wrong is silent in
 *  both directions: too narrow and a reflection mints back into our own pack,
 *  too wide and a peer's legitimate tool is dropped.
 *
 *  ⛔ THE CLAIM THAT MATTERS IS THE SECOND AXIS. A door's tools come from two
 *  stores that do not know about each other — `contract_grant` rows for raw pack
 *  ops, the inbound token's checklist for the static `recued_*` verbs. Reading
 *  only the first is a filter that looks right and is half-blind, and nothing
 *  about the output shape says which half it read.
 *
 *  ⚠ Driven over the REAL `ContractGrantEntryStore` on a real contract store, so
 *  the entry-key vocabulary under test is the one the gate actually resolves.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exposedToolNamesForPeerContract } from '../peer-exposed-tools.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';
import { mcpToolForKernelOp, type McpInboundTokenRecord } from '@recued/contracts';

const NOW = 1_700_000_000_000;
const CONTRACT = 'contract_peer_b';
const OTHER = 'contract_someone_else';

let db: Database.Database;
let contractStore: ContractStore;
let grantEntryStore: ContractGrantEntryStore;

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db);
  grantEntryStore = createContractGrantEntryStore(contractStore);
});
afterEach(() => db.close());

const token = (over: Partial<McpInboundTokenRecord>): McpInboundTokenRecord => ({
  token_id: 'tok_1',
  bearer_hash: 'h',
  label: 'peer b',
  created_at: NOW,
  expires_at: NOW + 1_000_000,
  revoked_at: null,
  grants: {},
  // ⚠ Both are CLOSED vocabularies: the tier is `3 | 5 | 10`, and chat_mode is
  // `ConnectionMcpChatMode | null`. Strings that read plausibly ('standard' /
  // 'off') are not members.
  concurrency_tier: 3,
  chat_mode: null,
  updated_at: NOW,
  ...over,
});

const resolve = (tokens: McpInboundTokenRecord[] = [], contract = CONTRACT): string[] =>
  exposedToolNamesForPeerContract(
    { grantEntryStore, inboundTokenStore: { listTokens: () => tokens } },
    contract,
  ).sort();

describe('exposedToolNamesForPeerContract', () => {
  it('turns a granted pack-op row into the WIRE name the peer sees', async () => {
    // A grant entry is the BARE op id; a peer probing `tools/list` sees it
    // prefixed. Comparing the two vocabularies without this join finds nothing.
    grantEntryStore.set(CONTRACT, 'recued-core.crm.create_deal', true, NOW);

    expect(resolve()).toEqual(['recued_actionStatus', 'recued_op_recued-core.crm.create_deal']);
  });

  it('⛔ reads the TOKEN CHECKLIST too — the axis a grant-rows-only filter misses', async () => {
    // Static `recued_*` verbs are governed by the token, not the contract. A
    // filter blind to this subtracts no native tool, so every one of them
    // reflects back through a Recued peer unfiltered.
    const t = token({ contract_id: CONTRACT, grants: { recued_listRecipes: true } });

    expect(resolve([t])).toEqual(['recued_actionStatus', 'recued_listRecipes']);
  });

  it('accepts EITHER name for a native verb-op, because the gate does', async () => {
    // `isMcpInboundTokenToolAuthorized` admits the tool name OR the kernel op id
    // (`kernelOpForMcpTool` is that join). An owner who granted the op id must
    // not produce a different exposed set from one who granted the tool name.
    // ⚠ The tool name is READ FROM THE REGISTRY, not written here. Hardcoding
    // `recued_peerAsk` would keep passing after a rename while the door moved.
    const opId = 'core.peer.receive-ask';
    const toolName = mcpToolForKernelOp(opId);
    expect(toolName).toBeDefined();

    const viaToken = resolve([token({ contract_id: CONTRACT, grants: { [opId]: true } })]);
    expect(viaToken).toContain(toolName);

    grantEntryStore.set(CONTRACT, opId, true, NOW);
    expect(resolve()).toContain(toolName);
  });

  it('⛔ an explicit REVOKE row exposes nothing', async () => {
    grantEntryStore.set(CONTRACT, 'recued-core.crm.create_deal', false, NOW);
    const t = token({ contract_id: CONTRACT, grants: { recued_listRecipes: false } });

    expect(resolve([t])).toEqual(['recued_actionStatus']);
  });

  it('⛔ never leaks ANOTHER contract’s grants', async () => {
    // Two peers on one server. Subtracting peer A's tools from peer B's list
    // would delete tools B legitimately offers.
    grantEntryStore.set(OTHER, 'recued-core.crm.create_deal', true, NOW);
    const theirs = token({ contract_id: OTHER, grants: { recued_listRecipes: true } });

    expect(resolve([theirs])).toEqual(['recued_actionStatus']);
  });

  it('skips collection entries — `data.mail` is not a tool', async () => {
    grantEntryStore.set(CONTRACT, 'data.mail', true, NOW);
    expect(resolve()).toEqual(['recued_actionStatus']);
  });

  it('⚠ ignores token LIVENESS, because a reflection outlives the token', async () => {
    // A revoked token cannot call us any more, but the peer's pack was minted
    // while it could and still lists those tools. Filtering on liveness would
    // stop subtracting exactly the stalest reflections.
    const dead = token({
      contract_id: CONTRACT,
      revoked_at: NOW - 1,
      expires_at: NOW - 10,
      grants: { recued_listRecipes: true },
    });

    expect(resolve([dead])).toEqual(['recued_actionStatus', 'recued_listRecipes']);
  });

  it('an empty contract id resolves to nothing without touching a store', async () => {
    // ⛔ Asserted on the CALL. An unbound connection must not trigger a scan at
    // all — and the store itself refuses an empty contract id, so a resolver
    // that passed one through would throw instead of degrading.
    expect(
      exposedToolNamesForPeerContract(
        {
          grantEntryStore: {
            listForContract: () => { throw new Error('must not be consulted'); },
          },
        },
        '',
      ),
    ).toEqual([]);
  });

  it('⛔ ALWAYS names the checklist-exempt protocol utility', () => {
    // FOUND BY A LIVE TWO-SERVER DRIVE. `recued_actionStatus` short-circuits both
    // door gates on principal liveness alone, so it is exposed to every peer
    // while appearing in NO grant row and NO checklist. A set built from those
    // two stores alone reports "we expose nothing like that" about a tool we
    // always expose — and its reflection mints straight back into our own pack.
    expect(resolve()).toEqual(['recued_actionStatus']);
  });

  it('degrades to a host with neither store wired without inventing grants', () => {
    // Still names the always-exposed utility, because that fact does not come
    // from a store — but nothing else, because nothing else can be known.
    expect(exposedToolNamesForPeerContract({}, CONTRACT)).toEqual(['recued_actionStatus']);
  });
});
