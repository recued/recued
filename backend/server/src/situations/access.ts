import { OWNER_CONTRACT_ID, parseAssetFactContextRequest, parseSituationQueryInput, type AssetFactContext, type AssetFactContextRequest, type ExecutionSource, type SituationItem, type SituationQueryInput, type SituationRef, type SituationResult } from '@recued/contracts';
import { resolveGrantGoverningContractId } from '../grant-governing-contract.js';
import { withContractDispatchReservation } from '../contract-dispatch-reservation.js';
import { createGatedReadGrantResolver, type ReadGrantChecker } from '../read-grant-checker.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import type { SphereStore } from '../storage/sphere-store.js';
import type { createSituationQuery, SituationReadContext } from './query.js';
import { situationSourceAccess } from './sources.js';
import { withholdFactContextValues, withholdSituationValues, type WithheldValues } from './values-on-request.js';

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
  fieldVersion?(input: AssetFactContextRequest, context: SituationReadContext): string | undefined | Promise<string | undefined>;
  /** D-338 — the server's zone: the clock a day a caller names is read on when the caller has
   *  none of its own (an MCP agent, a recipe). Chat passes its turn's (`read`). */
  timeZone?: () => string | undefined;
  /** D-338 — the Agenda's rule for what the owner's notifications call only "a private
   *  reminder" (`ScheduledSituations.isPrivateItem`), so a model is told which items those are. */
  isPrivate?: (item: SituationItem) => boolean;
  /** D-342 §5 — whether a read is the Agenda suggestions' own run, which reads the owner's active
   *  pursuits beside the day (`include_pursuits`). The host decides it; a model cannot ask for it. */
  readsPursuits?: (source: ExecutionSource | undefined) => boolean;
  /** D-343 slice 4 — the owner's active pursuits marked "Ask me in the evening", which the evening
   *  notice lists (`ScheduledSituations.eveningPursuits`). */
  eveningPursuits?: () => ReadonlyArray<{ id: string; name: string; private: boolean }>;
  /** D-340 slice 5 — whether the notice a reply quotes names private items
   *  (`ScheduledSituations.namesPrivateIn`). */
  namesPrivateIn?: (title: string) => boolean;
  /** D-340 slice 4 — a managed run's own tool rounds: the streams' AI suggestions
   *  (`ScheduledSituations.suggestionsToolRounds`). */
  toolRoundCap?: (source: ExecutionSource | undefined) => number | undefined;
  /** D-339 slice 6 (§5.3) — the names an asset keeps when it withholds its values from a model's
   *  general reads (`values_on_request`, a Body), or undefined. Absent ⇒ nothing is withheld. Slice 12a:
   *  given the reader, so the owner's chats are told their switch for a Body's numbers. */
  withheldValues?: (assetId: string, source: ExecutionSource | undefined) => WithheldValues | undefined;
  /** D-339 slice 6 — whether a read sees those values all the same: only a stream's own AI
   *  suggestions while that stream's Include private items is on (D-340 §3.4). */
  showsWithheldValues?: (source: ExecutionSource | undefined) => boolean;
}) => {
  const now = deps.now ?? Date.now;
  const definitions = createContractDefinitionStore(deps.contracts, { now });
  const grants = createGatedReadGrantResolver(deps.contracts, now);
  const authority = (source: ExecutionSource | undefined, operation: string, collections: readonly string[] =
    ['asset', 'task', 'note', 'commitment', 'booking', 'project', 'contact', 'calendar', 'reminder', 'mail', 'mail_fact', 'memory', 'file', 'episode', 'occasion', 'history_trace']): string => {
    const current = context(source, operation);
    return JSON.stringify([current.owner, current.all_spheres, current.spheres,
      collections.map(collection => { const access = situationSourceAccess(collection)!; return [collection,
          current.grants.isVerbOpGranted(access.verb_op), current.grants.isCollectionReadGranted(access.collection)]; })]);
  };
  /** D-339 slice 6 — a model's general read: an asset that withholds its values keeps their names. */
  const withheld = (source: ExecutionSource | undefined) => {
    const of = deps.withheldValues;
    return of !== undefined && deps.showsWithheldValues?.(source) !== true ? (assetId: string) => of(assetId, source) : undefined;
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
    /** The field reader returns no graph or evidence, so its authority snapshot
     * depends only on asset access. Context still rechecks the vault, live
     * governing contract, situation operation and sphere scope on both sides.
     * Absence is not a successful validation; callers dispatch normally. */
    async fieldVersion(raw: unknown, source: ExecutionSource | undefined, signal?: AbortSignal): Promise<string | undefined> {
      const access = context(source);
      const before = authority(source, SITUATION_READ_OP, ['asset']);
      if (!deps.fieldVersion) return undefined;
      const version = await deps.fieldVersion(parseAssetFactContextRequest(raw), { ...access, ...(signal ? { signal } : {}) });
      if (signal?.aborted || before !== authority(source, SITUATION_READ_OP, ['asset'])) throw new SituationAccessError('Permissions changed during the context read. Refresh before relying on it.');
      return version;
    },
    /** True for an item the owner's notifications name only as "a reminder in Yours". */
    isPrivate: (item: SituationItem): boolean => deps.isPrivate?.(item) === true,
    /** D-340 slice 5 — whether a notice, by its title, names private items: the stream it came from
     *  includes them. A closing note names them as the notice did. */
    namesPrivateIn: (title: string): boolean => deps.namesPrivateIn?.(title) === true,
    /** D-340 slice 4 — the tool rounds a turn from this source may take, when it is a managed run
     *  with a budget of its own; otherwise the chat's. */
    toolRoundCap: (source: ExecutionSource | undefined): number | undefined => deps.toolRoundCap?.(source),
    /** D-343 slice 4 — the pursuits the evening notice asks about, each with the ref a record cites,
     *  for the owner's own reads only: the evening notice is theirs alone, and an AI app reads none,
     *  whatever it may read of assets. */
    eveningPursuits(source: ExecutionSource | undefined): Array<{ title: string; ref: SituationRef; private: boolean }> {
      if (!context(source).owner) return [];
      return (deps.eveningPursuits?.() ?? []).map(pursuit => ({ title: pursuit.name, ref: { collection: 'asset', id: pursuit.id }, private: pursuit.private }));
    },
    /** `time_zone` is the clock a named day is read on: the chat turn's. Without it, the server's. */
    async read(raw: unknown, source: ExecutionSource | undefined, signal?: AbortSignal, time_zone?: string,
      dispatch?: { reservation?: object }): Promise<SituationResult> {
      // Only kernel dispatches supply this host context. Even an unmetered
      // dispatch clears inherited authority; a reserved use credits its own
      // synchronous checks, never the query, fact reader or nested execution.
      const check = <T>(read: () => T): T => dispatch
        ? withContractDispatchReservation(dispatch.reservation, read) : read();
      const snapshot = () => check(() => authority(source, SITUATION_READ_OP));
      const access = check(() => context(source));
      const before = snapshot();
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'context' in raw) {
        if (Object.keys(raw).some(key => key !== 'context')) throw new Error('Use context by itself to inspect a fact or rule, or time and filters for a situation query.');
        if (!deps.factContext) throw new Error('Fact context is unavailable on this server');
        const request = parseAssetFactContextRequest(raw.context);
        const packet = await deps.factContext(request, { ...access, ...(signal ? { signal } : {}) });
        if (signal?.aborted || before !== snapshot()) throw new SituationAccessError('Permissions changed during the context read. Refresh before relying on it.');
        const names = withheld(source);
        return { clusters: [], omitted: 0, ambiguous: [], fact_context: names ? withholdFactContextValues(packet, names) : packet };
      }
      const input: SituationQueryInput = parseSituationQueryInput(raw, time_zone ?? deps.timeZone?.());
      const result = await deps.query({ ...input, surface: 'tool', ...(deps.readsPursuits?.(source) === true ? { include_pursuits: true } : {}) },
        { ...access, ...(signal ? { signal } : {}) });
      if (before !== snapshot()) throw new SituationAccessError('Permissions changed during the situation read. Ask the owner to refresh before relying on it.');
      const names = withheld(source);
      return names ? withholdSituationValues(result, names) : result;
    },
    async prefetch(text: string, source: ExecutionSource | undefined, signal: AbortSignal, citeSavedDetails = false): Promise<SituationResult> {
      // The alias is independently grantable. It confers no tool grant and
      // the explicit tool confers no speculative-prefetch grant.
      const access = context(source, SITUATION_PREFETCH_OP);
      const before = authority(source, SITUATION_PREFETCH_OP);
      const at = now();
      const result = await deps.query({ time: { from: at, to: Math.min(8.64e15, at + 14 * 86_400_000) }, text: text.slice(0, 2048),
        surface: 'prefetch', limit_clusters: 2, limit_items: 3 }, { ...access, signal,
          ...(citeSavedDetails && access.owner && source?.channel === 'chat' && source.actor === 'user_self'
            && !('contract_id' in source) ? { citeAssetDetails: true as const } : {}) });
      if (before !== authority(source, SITUATION_PREFETCH_OP)) throw new SituationAccessError('Prefetch permissions changed');
      const names = withheld(source);
      return names ? withholdSituationValues(result, names) : result;
    },
  };
};
export type SituationAccess = ReturnType<typeof createSituationAccess>;
