/** D-327 — one agreement, one key, one gate.
 *
 *  An agreement minted with `key_authority: 'contract'` is its key's WHOLE
 *  authority: the key reads its tools from the agreement's grant rows, the
 *  agreement grants nothing by default, and the key rpcs refuse to give the key
 *  a second answer of its own. Everything here runs on REAL stores over one
 *  sqlite db with the contract schema seeded, because the field has to survive
 *  the store's own value_shape check — a faked definition store would not. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  D165_CONTRACT_SCHEMA,
  isMcpInboundTokenToolAuthorized,
  type ExecutionSource,
  type RecuedServerSignature,
} from '@recued/contracts';

import {
  handleInboundTokenIssue,
  handleInboundTokenUpdateContract,
  handleInboundTokenUpdateGrants,
  type ChatRpcDeps,
} from '../chat-handler.js';
import { handleContractGrantWrite } from '../contract-grant-handler.js';
import { checkAgreementKeyGrant, createKeyAgreementLookup } from '../key-agreement.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
} from '../storage/chat-inbound-token-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore } from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;
const RECIPE = 'recued-core/peer-request-appointment';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-self',
};

const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const rig = () => {
  const db = new Database(':memory:');
  openDbs.push(db);
  ensureChatSchema(db);
  ensureChatInboundTokenSchema(db);
  const contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  let seq = 0;
  const definitions = createContractDefinitionStore(contractStore, {
    now: () => NOW,
    newId: () => `ct_${++seq}`,
  });
  const grants = createContractGrantEntryStore(contractStore);
  const lookup = createKeyAgreementLookup({ definitions, grants, now: () => NOW });
  const tokens = createChatInboundTokenStore(db, {
    resolveKeyChecklist: (contract_id) => lookup.resolveKeyChecklist(contract_id),
  });
  const deps: ChatRpcDeps = {
    store: createChatStore(db),
    inboundTokenStore: tokens,
    orchestrator: { runTurn: vi.fn(), dispatch: { dispatchTool: vi.fn() } } as unknown as ChatRpcDeps['orchestrator'],
    selfSignature,
    now: () => NOW,
    mintTokenContract: ({ label }: { label: string }) => `ct_for_${label}`,
    keyAgreement: (contract_id) => lookup.keyAgreement(contract_id),
  };
  const agreement = definitions.mint({
    minted_by: 'owner',
    display_name: 'Research workspace',
    scope: {},
    key_authority: 'contract',
  });
  const ordinary = definitions.mint({
    minted_by: 'owner',
    display_name: 'An older agreement',
    scope: {},
  });
  return { db, definitions, grants, tokens, deps, agreement, ordinary };
};

const issueArgs = (contract_id: string, overrides: Record<string, unknown> = {}) => ({
  label: 'Research workspace',
  contract_id,
  grants: {},
  concurrency_tier: 5,
  chat_mode: null,
  ...overrides,
});

const rejectionOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection');
};

describe('D-327 — the agreement is stored with its key authority', () => {
  it('round-trips key_authority through the real store', () => {
    const { definitions, agreement, ordinary } = rig();
    expect(definitions.get(agreement.contract_id)?.key_authority).toBe('contract');
    expect(definitions.get(ordinary.contract_id)?.key_authority).toBeUndefined();
  });
});

describe('D-327 — a key reads its tools from its agreement', () => {
  it('serves the agreement-derived checklist on every read path, live', async () => {
    const { grants, tokens, deps, agreement } = rig();
    grants.set(agreement.contract_id, 'primitive.mail.search', true, NOW);
    grants.set(agreement.contract_id, 'primitive.contact.search', false, NOW);
    grants.set(agreement.contract_id, `recipe.${RECIPE}`, true, NOW);
    grants.set(agreement.contract_id, 'core.data.calendar.list', true, NOW);
    grants.set(agreement.contract_id, 'core.ai.summarize', true, NOW);
    grants.set(agreement.contract_id, 'data.mail', true, NOW);
    const expected = {
      'mail.search': true,
      [RECIPE]: true,
      'core.data.calendar.list': true,
    };

    const issued = await handleInboundTokenIssue(deps, issueArgs(agreement.contract_id));
    expect(issued.record.grants).toEqual(expected);
    const id = issued.record.token_id;
    expect(tokens.getTokenById(id)?.grants).toEqual(expected);
    expect(tokens.listTokens().find((t) => t.token_id === id)?.grants).toEqual(expected);
    const verified = tokens.verifyBearer({ bearer: issued.bearer_plaintext, now: NOW });
    expect(verified?.grants).toEqual(expected);

    // The predicate every reader shares now answers from the agreement.
    expect(isMcpInboundTokenToolAuthorized(verified!, 'mail.search', NOW)).toBe(true);
    expect(isMcpInboundTokenToolAuthorized(verified!, 'contact.search', NOW)).toBe(false);
    expect(isMcpInboundTokenToolAuthorized(verified!, RECIPE, NOW)).toBe(true);
    // A tool the agreement has no switch for is a tool its key does not get.
    expect(isMcpInboundTokenToolAuthorized(verified!, 'recued_listRecipes', NOW)).toBe(false);

    // Switching a grant off reaches the key's next read — nothing is cached.
    grants.set(agreement.contract_id, 'primitive.mail.search', false, NOW + 1);
    expect(tokens.getTokenById(id)?.grants['mail.search']).toBeUndefined();
  });

  it('leaves a key bound to an ordinary contract on its own stored checklist', async () => {
    const { grants, tokens, deps, ordinary } = rig();
    grants.set(ordinary.contract_id, 'primitive.mail.search', true, NOW);
    const issued = await handleInboundTokenIssue(
      deps,
      issueArgs(ordinary.contract_id, { grants: { 'calendar.search': true } }),
    );
    expect(tokens.getTokenById(issued.record.token_id)?.grants).toEqual({ 'calendar.search': true });
  });
});

describe('D-327 — the key rpcs give an agreement\'s key nothing of its own', () => {
  it('refuses a checklist, a chat setting and limits on the key', async () => {
    const { deps, agreement } = rig();
    expect(await rejectionOf(handleInboundTokenIssue(
      deps, issueArgs(agreement.contract_id, { grants: { 'mail.search': true } }),
    ))).toContain('grant tools on the contract');
    expect(await rejectionOf(handleInboundTokenIssue(
      deps, issueArgs(agreement.contract_id, { chat_mode: { offered: true } }),
    ))).toContain('takes no chat setting');
    expect(await rejectionOf(handleInboundTokenIssue(
      deps, issueArgs(agreement.contract_id, { contract_limits: { max_uses: 5 } }),
    ))).toContain('live on the contract');
  });

  it('gives an agreement one key, and a new one only once the old is off', async () => {
    const { deps, tokens, agreement } = rig();
    const first = await handleInboundTokenIssue(deps, issueArgs(agreement.contract_id));
    expect(await rejectionOf(handleInboundTokenIssue(deps, issueArgs(agreement.contract_id))))
      .toContain('already has a key');
    tokens.revokeToken({ token_id: first.record.token_id, now: NOW });
    const second = await handleInboundTokenIssue(deps, issueArgs(agreement.contract_id));
    expect(second.record.token_id).not.toBe(first.record.token_id);
    expect(second.record.contract_id).toBe(agreement.contract_id);
  });

  it('gives a revoked agreement no key', async () => {
    const { deps, definitions, agreement } = rig();
    definitions.revoke(agreement.contract_id, 'owner turned it off');
    expect(await rejectionOf(handleInboundTokenIssue(deps, issueArgs(agreement.contract_id))))
      .toContain('is not active');
  });

  it('refuses to edit the key\'s checklist, or to move a key onto or off the agreement', async () => {
    const { deps, agreement, ordinary } = rig();
    const agreementKey = await handleInboundTokenIssue(deps, issueArgs(agreement.contract_id));
    const otherKey = await handleInboundTokenIssue(
      deps,
      issueArgs(ordinary.contract_id, { label: 'Other', grants: { 'calendar.search': true } }),
    );
    expect(await rejectionOf(handleInboundTokenUpdateGrants(deps, {
      token_id: agreementKey.record.token_id,
      grants: { 'mail.search': true },
    }))).toContain('takes its permissions from contract');
    expect(await rejectionOf(handleInboundTokenUpdateContract(deps, {
      token_id: otherKey.record.token_id,
      contract_id: agreement.contract_id,
    }))).toContain('keeps its own key');
    expect(await rejectionOf(handleInboundTokenUpdateContract(deps, {
      token_id: agreementKey.record.token_id,
      contract_id: ordinary.contract_id,
    }))).toContain('keeps its own key');
  });
});

describe('D-327 — the agreement grants nothing by default', () => {
  it('admits an op only on an explicit row, where an older wildcard contract admits on its default', () => {
    const { definitions, grants, agreement, ordinary } = rig();
    const gate = createOpAdmissionGate({ grantEntryStore: grants, definitionStore: definitions, now: () => NOW });
    const door = (contract_id: string): ExecutionSource => ({
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent',
      tool_call_id: 'call',
      mcp_token_id: 'tok',
      contract_id,
    }) as ExecutionSource;

    expect(gate.isOpGranted(door(agreement.contract_id), 'core.data.calendar.list')).toBe(false);
    expect(gate.isOpGranted(door(ordinary.contract_id), 'core.data.calendar.list')).toBe(true);
    grants.set(agreement.contract_id, 'core.data.calendar.list', true, NOW);
    expect(gate.isOpGranted(door(agreement.contract_id), 'core.data.calendar.list')).toBe(true);
  });
});

describe('D-327 — a grant on the agreement passes the check issuance used to run', () => {
  const caller = { instance_id: 'paired-client' };

  it('runs the check for a row the key reads, and refuses with its reason', () => {
    const { definitions, grants, agreement } = rig();
    const preflight = vi.fn((name: string) => {
      if (name === RECIPE) throw new Error(`recipe '${name}' cannot be granted to a token: cost_step_limit`);
    });
    const deps = {
      store: grants,
      now: () => NOW,
      checkKeyGrant: (contract_id: string, entry_key: string) =>
        checkAgreementKeyGrant({ definitions, preflight }, contract_id, entry_key),
    };
    expect(() => handleContractGrantWrite(deps, {
      contract_id: agreement.contract_id,
      entry_key: `recipe.${RECIPE}`,
      granted: true,
    }, caller)).toThrow(/cost_step_limit/);
    expect(grants.get(agreement.contract_id, `recipe.${RECIPE}`)).toBeUndefined();

    // A kernel op kept off doors goes to the check too, so it can say why.
    handleContractGrantWrite(deps, {
      contract_id: agreement.contract_id,
      entry_key: 'core.ai.summarize',
      granted: true,
    }, caller);
    expect(preflight).toHaveBeenCalledWith('core.ai.summarize');

    // Rows the agreement checks itself, and revokes, need no check.
    preflight.mockClear();
    handleContractGrantWrite(deps, { contract_id: agreement.contract_id, entry_key: 'data.mail', granted: true }, caller);
    handleContractGrantWrite(deps, { contract_id: agreement.contract_id, entry_key: `recipe.${RECIPE}`, granted: false }, caller);
    expect(preflight).not.toHaveBeenCalled();
  });

  it('leaves other contracts alone, and fails closed when the check is not wired', () => {
    const { definitions, grants, agreement, ordinary } = rig();
    const preflight = vi.fn();
    checkAgreementKeyGrant({ definitions, preflight }, ordinary.contract_id, `recipe.${RECIPE}`);
    expect(preflight).not.toHaveBeenCalled();
    expect(() => checkAgreementKeyGrant(
      { definitions, preflight: undefined },
      agreement.contract_id,
      `recipe.${RECIPE}`,
    )).toThrow(/cannot be checked/);
    expect(grants.get(agreement.contract_id, `recipe.${RECIPE}`)).toBeUndefined();
  });
});
