/** D-213 Track A / A1 — positive owner-principal gate and absence ratchets. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  KERNEL_DOMAINS,
  KERNEL_OP_REGISTRY,
  OWNER_CONTRACT_ID,
  type ExecutionSource,
} from '@recued/contracts';

import {
  isOwnerRecallRowEligibility,
  resolveOwnerRecallCorpusScope,
} from '../chat-recall-scope.js';
import { CHAT_MESSAGE_RECALL_ELIGIBILITY } from '../storage/chat-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';

const NOW = 1_784_915_200_000;

const OWNER_CHAT: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'owner-session',
  user_id: 'local',
};

const OWNER_MESSENGER: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'coworker',
};

const ANONYMOUS: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'reception-1',
};

describe('D-213 A1 — owner recall corpus scope', () => {
  let db: Database.Database;
  let definitions: ReturnType<typeof createContractDefinitionStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    const contractStore = createContractStore(db, { now: () => NOW });
    definitions = createContractDefinitionStore(contractStore, {
      now: () => NOW,
      newId: () => 'ct_live',
    });
  });

  afterEach(() => db.close());

  it('admits only unrestricted owner direct chat and returns the fixed row scope', () => {
    expect(
      resolveOwnerRecallCorpusScope(OWNER_CHAT, definitions, () => NOW),
    ).toEqual({
      governing_contract_id: OWNER_CONTRACT_ID,
      row_eligibility:
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      // D-166 door corpus — the storage discriminant. `null` here is not
      // padding: the owner's rows are contract-free by construction, and the
      // store compares with SQL `IS`, so a null scope selects exactly the rows
      // whose `recall_contract_id` is NULL. `toEqual` is deliberately exact so
      // a future field cannot be added to this scope without a decision about
      // what it means for the predicate.
      recall_contract_id: null,
    });
  });

  it('refuses messenger even though the shared resolver maps it to the owner sentinel', () => {
    expect(
      resolveOwnerRecallCorpusScope(
        OWNER_MESSENGER,
        definitions,
        () => NOW,
      ),
    ).toBeNull();
  });

  it('refuses contracted chat, anonymous, absent, and malformed callers', () => {
    const live = definitions.mint({
      minted_by: 'owner',
      display_name: 'Live chat door',
      scope: { channels: ['chat'], actors: ['contracted_user'] },
    });
    const contracted: ExecutionSource = {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 'door-session',
      user_id: 'door-user',
      contract_id: live.contract_id,
    };

    expect(
      resolveOwnerRecallCorpusScope(contracted, definitions, () => NOW),
    ).toBeNull();
    expect(
      resolveOwnerRecallCorpusScope(ANONYMOUS, definitions, () => NOW),
    ).toBeNull();
    expect(
      resolveOwnerRecallCorpusScope(undefined, definitions, () => NOW),
    ).toBeNull();
    expect(
      resolveOwnerRecallCorpusScope(
        { channel: 'chat', actor: 'user_self' },
        definitions,
        () => NOW,
      ),
    ).toBeNull();
  });

  it('refuses an explicit dead/deleted chat-door contract instead of inheriting contract-free admission', () => {
    const deadDoor: ExecutionSource = {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 'dead-door-session',
      user_id: 'door-user',
      contract_id: 'ct_deleted',
    };
    expect(
      resolveOwnerRecallCorpusScope(deadDoor, definitions, () => NOW),
    ).toBeNull();
  });

  it('accepts only the closed owner-authenticated row stamp', () => {
    expect(
      isOwnerRecallRowEligibility(
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      ),
    ).toBe(true);
    expect(
      isOwnerRecallRowEligibility(
        CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_MESSENGER,
      ),
    ).toBe(false);
    expect(isOwnerRecallRowEligibility('chat:owner_authenticated ')).toBe(false);
  });
});

describe('D-213 A1 — `context` has no grant handle; `recall` was given one', () => {
  it('registers no context domain and no `core.context.read`', () => {
    expect(KERNEL_DOMAINS.map((entry) => entry.domain)).not.toContain('context');
    expect(KERNEL_OP_REGISTRY.map((entry) => entry.op)).not.toContain('core.context.read');
  });

  it('⛔ REGISTERS `core.recall.search` — D-253 REVERSED this half deliberately', () => {
    // This assertion used to read `.not.toContain('core.recall.search')`, and it was
    // right when D-213 wrote it: recall was hand-built into the chat registry view
    // so it would never enter the raw MCP registry, and its own header recorded the
    // consequence — "interaction recall acquires no grant handle and cannot be
    // discovered there."
    //
    // 🔑 D-253 CALLED THAT THE DEFECT, NOT THE DESIGN. Fail-closed for DOORS was
    // correct; having no row was wrong for the OWNER, who could not switch off the
    // most sensitive corpus on the server. `kernel-ops.ts` now states it outright:
    // "the whole reason recall needs a grant is that it is the most sensitive
    // corpus on the server."
    //
    // ⚠ So this is NOT a relaxed ratchet — it is the same ratchet pointing the
    // other way. Removing the row again must red here.
    expect(KERNEL_DOMAINS.map((entry) => entry.domain)).toContain('recall');
    expect(KERNEL_OP_REGISTRY.map((entry) => entry.op)).toContain('core.recall.search');
  });
});
