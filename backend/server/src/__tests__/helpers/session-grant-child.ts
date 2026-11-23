import Database from 'better-sqlite3';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type ContractDefinition, type ContractScope, type OpenProjection, type SessionGrantMatchContext } from '@recued/contracts';
import { createSessionGrantResolver } from '../../session-grant-resolver.js';
import { createContractStore } from '../../storage/contract-store.js';
import { createContractDefinitionStore, type ContractDefinitionStore, type MintSessionGrantInput } from '../../storage/contract-definition-store.js';

export const GRANT_NOW = 1_700_000_000_000;
export const GRANT_MODES = ['exact', 'open', 'scoped', 'raw_op', 'kind', 'delegation-exact', 'delegation-open', 'batch-consume', 'batch-claim'] as const;
export type GrantMode = typeof GRANT_MODES[number];
export type GrantOperation =
  | { kind: 'consume'; call?: Parameters<ContractDefinitionStore['consumeSessionGrant']>[1] }
  | { kind: 'claim'; member: string; call: Parameters<ContractDefinitionStore['claimBatchMember']>[2] }
  | { kind: 'revoke'; reason: string }
  | { kind: 'active-revoke' }
  | { kind: 'reserve-use' }
  | { kind: 'read-spheres'; spheres: Parameters<ContractDefinitionStore['setReadSpheres']>[1] }
  | { kind: 'door-types'; door_types: Parameters<ContractDefinitionStore['setDoorTypes']>[1] }
  | { kind: 'limits'; limits: Parameters<ContractDefinitionStore['setLimits']>[1] };
export type GrantResult = boolean | ContractDefinition | null;
export interface GrantChildInput {
  database: string; contract_id: string; operation: GrantOperation;
  marker: string; start: string; release: string; pause: boolean; now: number;
}
export const openGrantStore = (database: string, now = GRANT_NOW) => {
  const db = new Database(database, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  const store = createContractStore(db, { now: () => now });
  const definitions = createContractDefinitionStore(store, { now: () => now });
  return { db, store, definitions };
};
export const applyGrantOperation = (definitions: ContractDefinitionStore, id: string, operation: GrantOperation): GrantResult => {
  switch (operation.kind) {
    case 'consume': return definitions.consumeSessionGrant(id, operation.call);
    case 'claim': return definitions.claimBatchMember(id, operation.member, operation.call);
    case 'revoke': return definitions.revoke(id, operation.reason);
    case 'active-revoke': return definitions.revokeSessionGrant(id);
    case 'reserve-use': return definitions.reserveDispatchUse?.(id) != null;
    case 'read-spheres': return definitions.setReadSpheres(id, operation.spheres);
    case 'door-types': return definitions.setDoorTypes(id, operation.door_types);
    case 'limits': return definitions.setLimits(id, operation.limits);
  }
};

/** Legal minted rows, with a real resolver match before any lifecycle mutation. */
export const seedGrant = (database: string, mode: GrantMode, budget = 1, finalBatchUse = false) => {
  const env = openGrantStore(database);
  try {
    env.store.seedSchema(D165_CONTRACT_SCHEMA);
    const scope: ContractScope = { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['mail.send'], operation_ids: ['mail.send'], connection_names: ['fixture-mail'] };
    const common = { minted_by: 'fixture-owner', display_name: 'Transaction fixture', scope, risk_tier: 'write' as const, approved_action_ref: 'fixture-approval', expiry_at: GRANT_NOW + 60_000, max_uses: budget };
    const recipe = { recipe_id: 'fixture-recipe', recipe_hash: 'fixture-version' };
    const recipeInput: MintSessionGrantInput = { ...common, channel_session_id: 'fixture-session', bound_recipe: recipe, arg_shape_hash: 'shape', canonical_payload_hash: 'payload' };
    const projection: OpenProjection = { version: 1, args: [{ path: 'to', skeleton: '{{config.to}}', roots: [{ ref: 'config.to', origin: 'config', pinned: 'sender@example.test' }], derived_pinned: 'sender@example.test' }] };
    let context: SessionGrantMatchContext = { channel: 'chat', actor: 'user_self', channel_session_id: 'fixture-session', ingredient_slug: 'mail.send', operation_id: 'mail.send', connection_name: 'fixture-mail', recipe_id: recipe.recipe_id, recipe_hash: recipe.recipe_hash, risk_tier: 'write', pre_lift_approval: 'ask', arg_shape_hash: 'shape', canonical_payload_hash: 'payload' };
    let operation: GrantOperation = { kind: 'consume', call: { canonical_payload_hash: 'payload' } };
    let grant: ContractDefinition;
    if (mode === 'exact') grant = env.definitions.mintSessionGrant(recipeInput);
    else if (mode === 'open') {
      grant = env.definitions.mintSessionGrant({ ...recipeInput, grant_mode: 'open', pinned_projection_hash: 'projection', open_projection: projection });
      operation = { kind: 'consume', call: { pinned_projection_hash: 'projection' } };
      context = { ...context, open_pinned_projection_hash: 'projection' };
    } else if (mode === 'scoped') {
      grant = env.definitions.mintScopedSessionGrant({ ...common, channel_session_id: 'fixture-session', scoped_source: 'forwarded_item_sender' });
      const containment = { destination_emails: ['sender@example.test'], scoped_sender_candidates: [{ email: 'sender@example.test', contributed_at: GRANT_NOW }] };
      operation = { kind: 'consume', call: containment };
      context = { ...context, ...containment };
    } else if (mode === 'raw_op') {
      grant = env.definitions.mintRawOpGrant({ ...common, scope: { ...scope, channels: ['mcp'], actors: ['contracted_user'] }, channel_session_id: 'fixture-session', arg_shape_hash: 'shape', canonical_payload_hash: 'payload', bound_contract_id: 'ct_fixture_door' });
      operation = { kind: 'consume', call: { canonical_payload_hash: 'payload', source_contract_id: 'ct_fixture_door' } };
      const { recipe_id: _id, recipe_hash: _hash, ...recipeLess } = context;
      context = { ...recipeLess, channel: 'mcp', actor: 'contracted_user', mcp_token_id: 'http_fixture_token', source_contract_id: 'ct_fixture_door' };
    } else if (mode === 'kind') {
      grant = env.definitions.mintKindGrant({ ...common, channel_session_id: 'fixture-session', bound_recipe: recipe });
      operation = { kind: 'consume', call: { operation_id: 'mail.send' } };
    } else if (mode === 'delegation-exact' || mode === 'delegation-open') {
      const open = mode === 'delegation-open';
      grant = env.definitions.mintDelegationRule({ ...common, grant_mode: open ? 'open' : 'exact', bound_recipe: recipe, arg_shape_hash: 'shape', canonical_payload_hash: 'payload', ...(open ? { pinned_projection_hash: 'projection', open_projection: projection } : {}) });
      if (open) {
        operation = { kind: 'consume', call: { pinned_projection_hash: 'projection' } };
        context = { ...context, open_pinned_projection_hash: 'projection' };
      }
    } else {
      grant = env.definitions.mintSessionGrant({ ...recipeInput, grant_mode: 'batch', max_uses: 2, batch_members: [{ member_id: 'm1', canonical_payload_hash: 'payload-1' }, { member_id: 'm2', canonical_payload_hash: 'payload-2' }] });
      if (finalBatchUse && !env.definitions.claimBatchMember(grant.contract_id, 'm1', { arg_shape_hash: 'shape', canonical_payload_hash: 'payload-1' })) throw new Error('Could not establish final batch use');
      operation = mode === 'batch-claim'
        ? { kind: 'claim', member: 'm2', call: { arg_shape_hash: 'shape', canonical_payload_hash: 'payload-2' } }
        : { kind: 'consume', call: { canonical_payload_hash: 'payload-2' } };
      context = { ...context, canonical_payload_hash: 'payload-2' };
    }
    if (createSessionGrantResolver({ definitionStore: env.definitions, now: () => GRANT_NOW }).match(context) !== grant.contract_id) throw new Error('Unmatchable grant fixture: ' + mode);
    return { contract_id: grant.contract_id, operation, before: env.definitions.get(grant.contract_id)! };
  } finally { env.db.close(); }
};

const mark = (path: string, value: unknown) => {
  writeFileSync(path + '.tmp', JSON.stringify(value));
  renameSync(path + '.tmp', path);
};
const waitFor = (path: string) => {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('Owned grant fixture timed out');
    Atomics.wait(wait, 0, 0, 10);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as GrantChildInput;
  const env = openGrantStore(input.database, input.now);
  const get = env.store.get.bind(env.store);
  let paused = false;
  env.store.get = (scope, segments) => {
    const row = get(scope, segments);
    if (input.pause && !paused && scope === CONTRACT_DEFINITION_SCOPE && segments[0] === input.contract_id) {
      paused = true;
      mark(input.marker + '.read', { in_transaction: env.db.inTransaction });
      waitFor(input.release);
    }
    return row;
  };
  try {
    mark(input.marker + '.ready', true);
    waitFor(input.start);
    mark(input.marker + '.attempt', true);
    const value = applyGrantOperation(env.definitions, input.contract_id, input.operation);
    mark(input.marker + '.result', { value });
  } finally { env.db.close(); }
}
