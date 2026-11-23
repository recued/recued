/** D-339 slice 12a (D-339 §5.6) — the owner's chats' switch for a Body's numbers: Off · Ask ·
 *  Allow. Off and on are the read's recipe's switch in the owner's contract, the one Self (you) → Recipes on
 *  the Contracts page shows; Allow is a held-read row for the owner's chats alone. Through the real contract
 *  store, grant store, op admission gate and held-read store.
 *
 *  The gate's side (the hook asked for a read held at `always`, and the card without "never ask") is in
 *  `d-339-body-signals.test.ts`, through the shipped pack; the page and a live chat, in the live drive. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BODY_NUMBERS_OPERATION_ID, BODY_NUMBERS_TURN_ON_UNDER, D165_CONTRACT_SCHEMA, OWNER_CONTRACT_ID, recipeGrantEntry, type ExecutionSource,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createHeldReadStore } from '../storage/held-read-store.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { BODY_NUMBERS_RECIPE_GRANT, bodyNumbersFor, bodyNumbersHeldReads, createBodyNumbersSetting, withBodyNumbers } from '../body-numbers-setting.js';
import { handleBodyNumbersRead, handleBodyNumbersWrite } from '../contract-grant-handler.js';
import {
  VALUES_ON_REQUEST_ALLOW_HOW, VALUES_ON_REQUEST_HOW, VALUES_ON_REQUEST_OFF_HOW, valuesOnRequestNote,
} from '../situations/values-on-request.js';

const chat: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'chat-1' };
const messenger = { channel: 'messenger', actor: 'user_self', user_id: 'owner' } as unknown as ExecutionSource;
const hid: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const app = { channel: 'mcp', actor: 'agent', contract_id: 'app-1' } as unknown as ExecutionSource;
const SEARCH = 'recued-core.body-signals.daily_metric.search';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

const fixture = (installed = true) => {
  const db = new Database(':memory:'); cleanups.push(() => db.close());
  const contracts = createContractStore(db); contracts.seedSchema(D165_CONTRACT_SCHEMA);
  const grants = createContractGrantEntryStore(contracts);
  const heldReads = createHeldReadStore(db);
  const setting = createBodyNumbersSetting({ grants, heldReads, now: () => 1_000 });
  const gate = createOpAdmissionGate({ grantEntryStore: grants, definitionStore: createContractDefinitionStore(contracts) });
  // As the pack's install leaves it (`recipe-grant-seed.ts`).
  if (installed) grants.set(OWNER_CONTRACT_ID, BODY_NUMBERS_RECIPE_GRANT, true, 1);
  return { grants, heldReads, setting, gate };
};

const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
};

describe('D-339 slice 12a — one state, two places', () => {
  it('Off and on are the recipe\'s own switch, the key the owner\'s gate reads', () => {
    const f = fixture();
    expect(BODY_NUMBERS_RECIPE_GRANT).toBe(recipeGrantEntry('recued-core', 'read-body-signals'));
    const reachable = () => f.gate.isOwnerRecipeGranted(chat, BODY_NUMBERS_RECIPE_GRANT);
    expect([f.setting.forChats(), reachable()]).toEqual(['ask', true]);
    expect(f.setting.setForChats('off')).toBe('off');
    expect([f.grants.get(OWNER_CONTRACT_ID, BODY_NUMBERS_RECIPE_GRANT), reachable()]).toEqual([false, false]);
    expect(f.setting.setForChats('allow')).toBe('allow');
    expect(reachable()).toBe(true);
    expect(f.setting.setForChats('ask')).toBe('ask');
    expect(reachable()).toBe(true);
  });

  it('switched on the Contracts page, the Body page reads it; with no row (no pack) it is Off', () => {
    const f = fixture();
    f.grants.set(OWNER_CONTRACT_ID, BODY_NUMBERS_RECIPE_GRANT, false, 2);
    expect(f.setting.forChats()).toBe('off');
    f.grants.set(OWNER_CONTRACT_ID, BODY_NUMBERS_RECIPE_GRANT, true, 3);
    expect(f.setting.forChats()).toBe('ask');
    expect(fixture(false).setting.forChats()).toBe('off');
  });

  it('Allow is the owner\'s chats\' alone; Off forgets it, so switched on again it asks', () => {
    const f = fixture();
    f.setting.setForChats('allow');
    expect(f.heldReads.allows({ kind: 'owner_chat' }, BODY_NUMBERS_OPERATION_ID)).toBe(true);
    expect(f.heldReads.allows({ kind: 'ai_app', contract_id: 'app-1' }, BODY_NUMBERS_OPERATION_ID)).toBe(false);
    f.setting.setForChats('off');
    f.grants.set(OWNER_CONTRACT_ID, BODY_NUMBERS_RECIPE_GRANT, true, 4);
    expect(f.setting.forChats()).toBe('ask');
    // An app's own row is no answer for the owner's chats.
    f.heldReads.setAllows({ kind: 'ai_app', contract_id: 'app-1' }, BODY_NUMBERS_OPERATION_ID, true, 5);
    expect(f.setting.forChats()).toBe('ask');
  });
});

describe('D-339 slice 12a — the gate\'s answer', () => {
  it('only for the owner\'s chats: an AI app and the owner\'s own runs get no answer, and ask', () => {
    const f = fixture(); f.setting.setForChats('allow');
    expect(bodyNumbersHeldReads({ setting: f.setting, source: app })).toBeUndefined();
    expect(bodyNumbersHeldReads({ setting: f.setting, source: hid })).toBeUndefined();
    expect(bodyNumbersHeldReads({ setting: f.setting, source: undefined })).toBeUndefined();
  });

  it('only this read, only on Allow, read at each call; each read let through is told', () => {
    const f = fixture();
    const admitted: string[] = [];
    const hooks = bodyNumbersHeldReads({ setting: f.setting, source: chat, onAdmit: op => admitted.push(op) })!;
    const call = (operation_id: string) => hooks.admit({ slug: 'records-x', operation_id });
    expect(call(BODY_NUMBERS_OPERATION_ID)).toBe(false);
    f.setting.setForChats('allow');
    expect([call(BODY_NUMBERS_OPERATION_ID), call(SEARCH)]).toEqual([true, false]);
    expect(admitted).toEqual([BODY_NUMBERS_OPERATION_ID]);
    expect(bodyNumbersHeldReads({ setting: f.setting, source: messenger })!.admit({ slug: 'records-x', operation_id: BODY_NUMBERS_OPERATION_ID })).toBe(true);
    f.setting.setForChats('ask');
    expect(call(BODY_NUMBERS_OPERATION_ID)).toBe(false);
  });
});

describe('D-339 slice 12a — what a held Body\'s note tells each caller', () => {
  const withheld = { readings: ['sleep', 'weight'], states: [], dates: ['birth date'], ranges: ['weight'] };

  it('the owner\'s chats their switch; any other caller nothing, so it says the read asks', () => {
    const f = fixture(); f.setting.setForChats('off');
    expect([bodyNumbersFor(f.setting, chat), bodyNumbersFor(f.setting, app), bodyNumbersFor(f.setting, hid), bodyNumbersFor(undefined, chat)])
      .toEqual(['off', undefined, undefined, undefined]);
    expect(withBodyNumbers(withheld, f.setting, chat)).toEqual({ ...withheld, chats: 'off' });
    expect(withBodyNumbers(withheld, f.setting, app)).toEqual(withheld);
    expect(withBodyNumbers(undefined, f.setting, chat)).toBeUndefined();
  });

  it('Off: nothing reads them, said once when needed, with where they are turned on; no recipe is named', () => {
    const how = valuesOnRequestNote({ ...withheld, chats: 'off' }).how;
    expect(how.startsWith(VALUES_ON_REQUEST_OFF_HOW)).toBe(true);
    expect(how).toContain(`turn them on under ${BODY_NUMBERS_TURN_ON_UNDER}`);
    expect(how).not.toMatch(/tools\.search|that recipe|run that/u);
    // Its dates and ranges still say how they reach a model.
    expect(how).toContain('(such as a birth date) are held too: they reach you only when the owner sends them');
    expect(how).toContain('are held too: they reach you only when the owner sends them in a message.');
  });

  it('Allow: the same recipe, which does not ask; Ask, or no switch: it asks first', () => {
    expect(valuesOnRequestNote({ ...withheld, chats: 'allow' }).how.startsWith(VALUES_ON_REQUEST_ALLOW_HOW)).toBe(true);
    expect(VALUES_ON_REQUEST_ALLOW_HOW).toContain('without asking');
    for (const chats of ['ask', undefined] as const) {
      const how = valuesOnRequestNote({ ...withheld, ...(chats ? { chats } : {}) }).how;
      expect(how.startsWith(VALUES_ON_REQUEST_HOW)).toBe(true);
      expect(how).toContain('that recipe does not read them');
    }
  });
});

describe('D-339 slice 12a — contract.grant.body_numbers.*', () => {
  const paired = { instance_id: 'webclient-1' };
  const audited = () => {
    const rows: Array<{ action: string; target: string; detail?: string }> = [];
    return { rows, auditLog: { logActivity: async (row: { action: string; target: string; detail?: string }) => { rows.push(row); } } as unknown as AuditLogStore };
  };

  it('reads it, and sets it from a paired client, recording the owner\'s choice and what it was', async () => {
    const f = fixture(); const { rows, auditLog } = audited();
    const deps = { store: f.grants, bodyNumbers: f.setting, auditLog };
    expect(handleBodyNumbersRead(deps)).toEqual({ chats: 'ask' });
    expect(handleBodyNumbersWrite(deps, { chats: 'allow' }, paired)).toEqual({ chats: 'allow' });
    await Promise.resolve();
    expect(rows).toEqual([expect.objectContaining({ action: 'body_numbers_set', target: 'body_numbers', detail: JSON.stringify({ chats: 'allow', before: 'ask' }) })]);
    expect(handleBodyNumbersRead(deps)).toEqual({ chats: 'allow' });
  });

  it('refuses an unpaired caller, a mode it does not know, and a server with no store for it', () => {
    const f = fixture(); const deps = { store: f.grants, bodyNumbers: f.setting };
    expect(codeOf(() => handleBodyNumbersWrite(deps, { chats: 'allow' }, undefined))).toBe('permission_denied');
    expect(codeOf(() => handleBodyNumbersWrite(deps, { chats: 'always' }, paired))).toBe('bad_request');
    expect(f.setting.forChats()).toBe('ask');
    expect(codeOf(() => handleBodyNumbersRead({ store: f.grants }))).toBe('bad_request');
    expect(codeOf(() => handleBodyNumbersWrite({ store: f.grants }, { chats: 'off' }, paired))).toBe('bad_request');
  });
});
