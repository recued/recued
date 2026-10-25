import { OWNER_CONTRACT_ID, parseAssetFactContextRequest, parseSituationQueryInput, type AssetFactContext, type AssetFactContextRequest, type ExecutionSource, type SituationQueryInput, type SituationResult } from '@recued/contracts';
import { resolveGrantGoverningContractId } from '../grant-governing-contract.js';
import { createGatedReadGrantResolver, type ReadGrantChecker } from '../read-grant-checker.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import type { SphereStore } from '../storage/sphere-store.js';
import type { createSituationQuery, SituationReadContext } from './query.js';
import { situationSourceAccess } from './sources.js';

export const SITUATION_READ_OP = 'core.situation.read';
export const SITUATION_PREFETCH_OP = 'core.situation.prefetch';
export class SituationAccessError extends Error {}

/** Resolve once per dispatch from the channel-minted source. A dead explicit
 * contract never falls back to permissive author defaults. Owner is derived,
 * never inferred from a caller's actor field or a bound owner-sentinel string. */
export const createSituationAccess = (deps: {
  contracts: ContractStore;
  query: ReturnType<typeof createSituationQuery>;
  spheres?: SphereStore;
  now?: () => number;
  isVaultUnlocked: () => boolean;
  measure?: (name: string, value: number, labels: Record<string, string>) => void;
  memoryAllowed?: SituationReadContext['memoryAllowed'];
  factContext?(input: AssetFactContextRequest, context: SituationReadContext): AssetFactContext | Promise<AssetFactContext>;
}) => {
  const now = deps.now ?? Date.now;
  const definitions = createContractDefinitionStore(deps.contracts, { now });
  const grants = createGatedReadGrantResolver(deps.contracts, now);
  const authority = (source: ExecutionSource | undefined, operation: string): string => {
    const current = context(source, operation);
    return JSON.stringify([current.owner, current.all_spheres, current.spheres,
      ['asset', 'task', 'note', 'commitment', 'booking', 'project', 'contact', 'calendar', 'reminder', 'mail', 'mail_fact', 'memory', 'file', 'episode', 'occasion', 'history_trace']
        .map(collection => { const access = situationSourceAccess(collection)!; return [collection,
          current.grants.isVerbOpGranted(access.verb_op), current.grants.isCollectionReadGranted(access.collection)]; })]);
  };
  const ownerHost: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'situation-host-read' };
  const noReads: ReadGrantChecker = { isTopicReadGranted: () => false, isCollectionReadGranted: () => false, isVerbOpGranted: () => false };
  const resolve = (source: ExecutionSource | undefined) => {
    // Direct HID and the engine's authenticated owner automation have no door
    // definition. D-209 stamps the owner sentinel on schedule/reactive sources;
    // only these system variants may carry it. An MCP/chat bound id never can.
    // A run with no source is the host's own (an internal or resumed run).
    const explicit = source && 'contract_id' in source ? source.contract_id : undefined;
    const ownAutomation = source?.actor === 'system' && (source.channel === 'schedule' || source.channel === 'reactive')
      && (explicit === undefined || explicit === OWNER_CONTRACT_ID);
    const ownHid = source?.channel === 'user' && source.actor === 'user_self' && explicit === undefined;
    const effective = !source || ownAutomation || ownHid ? ownerHost : source;
    const id = resolveGrantGoverningContractId(effective, definitions, now);
    const owner = id === OWNER_CONTRACT_ID;
    const bound = effective === source ? explicit : undefined;
    const def = (owner ? undefined : id !== undefined ? definitions.get(id) : bound !== undefined ? definitions.get(bound) : undefined) ?? undefined;
    // An unbound MCP token (the owner's CLI bearer) carries its own token id as a
    // synthetic contract id with no definition (mcp-server.ts): no contract
    // governs it, as for every other read. Any other dead or deleted explicit
    // contract keeps its spheres and never falls back to permissive defaults.
    const unbound = id === undefined && def === undefined && effective.channel === 'mcp' && effective.contract_id === effective.mcp_token_id;
    const dead = id === undefined && bound !== undefined && !unbound;
    const deleted = dead && def === undefined;
    const context: SituationReadContext = { owner, grants: dead ? noReads : grants.resolveForSource(effective),
      ...(!owner && !deleted && def?.read_spheres === undefined ? { all_spheres: true } : {}),
      ...(def?.read_spheres ? { spheres: def.read_spheres } : deleted ? { spheres: [] } : {}),
      ...(deps.spheres ? { referenceSphere: ref => deps.spheres!.resolve(ref).sphere } : {}),
      ...(deps.memoryAllowed ? { memoryAllowed: deps.memoryAllowed } : {}),
    };
    return { context, live: owner || (id !== undefined && def !== undefined) || unbound };
  };
  const context = (source: ExecutionSource | undefined, operation: string | null = SITUATION_READ_OP): SituationReadContext => {
    if (!deps.isVaultUnlocked()) throw new SituationAccessError('Unlock Recued to read situations');
    if (!source) throw new SituationAccessError('Situation reads require an authenticated execution source');
    const current = resolve(source);
    if (!current.live) throw new SituationAccessError('Situation reads require a live governing contract');
    if (operation !== null && !current.context.grants.isVerbOpGranted(operation)) throw new SituationAccessError(`This contract does not grant ${operation}. This is a permission refusal, not an empty result. Tell the user and do not retry.`);
    return current.context;
  };
  return {
    context,
    /** The grants and sphere fence a run's raw reads apply. It never refuses:
     * the vault, liveness and the operation grant belong to the dispatch gates,
     * so a run or read this cannot fence is never stopped here. */
    fence: (source: ExecutionSource | undefined): SituationReadContext => resolve(source).context,
    ...(deps.measure ? { measure: deps.measure } : {}),
    async read(raw: unknown, source: ExecutionSource | undefined, signal?: AbortSignal): Promise<SituationResult> {
      const access = context(source);
      const before = authority(source, SITUATION_READ_OP);
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'context' in raw) {
        if (Object.keys(raw).some(key => key !== 'context')) throw new Error('Use context by itself to inspect a fact or rule, or time and filters for a situation query.');
        if (!deps.factContext) throw new Error('Fact context is unavailable on this server');
        const request = parseAssetFactContextRequest(raw.context);
        const packet = await deps.factContext(request, { ...access, ...(signal ? { signal } : {}) });
        if (signal?.aborted || before !== authority(source, SITUATION_READ_OP)) throw new SituationAccessError('Permissions changed during the context read. Refresh before relying on it.');
        return { clusters: [], omitted: 0, ambiguous: [], fact_context: packet };
      }
      const input: SituationQueryInput = parseSituationQueryInput(raw);
      const result = await deps.query({ ...input, surface: 'tool' }, { ...access, ...(signal ? { signal } : {}) });
      if (before !== authority(source, SITUATION_READ_OP)) throw new SituationAccessError('Permissions changed during the situation read. Ask the owner to refresh before relying on it.');
      return result;
    },
    async prefetch(text: string, source: ExecutionSource | undefined, signal: AbortSignal): Promise<SituationResult> {
      // The alias is independently grantable. It confers no tool grant and
      // the explicit tool confers no speculative-prefetch grant.
      const access = context(source, SITUATION_PREFETCH_OP);
      const before = authority(source, SITUATION_PREFETCH_OP);
      const at = now();
      const result = await deps.query({ time: { from: at, to: Math.min(8.64e15, at + 14 * 86_400_000) }, text: text.slice(0, 2048),
        surface: 'prefetch', limit_clusters: 2, limit_items: 3 }, { ...access, signal });
      if (before !== authority(source, SITUATION_PREFETCH_OP)) throw new SituationAccessError('Prefetch permissions changed');
      return result;
    },
  };
};
export type SituationAccess = ReturnType<typeof createSituationAccess>;
