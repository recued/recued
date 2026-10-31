import { RpcError, type ChatDispatchContext, type ChatDispatchResult, type ExecutionSource,
  type DocumentContentSearchResult, type OwnerDocumentSearchReply, type OwnerDocumentSearchRequest } from '@recued/contracts';
import type { PreflightRunSettled } from './preflight-resumer.js';
import { toFtsMatch } from '@recued/fts';

const LIMIT = 32, TTL = 30 * 60_000;
type OwnerSource = Extract<ExecutionSource, { channel: 'user' }>;
interface Search {
  owner: string; signature: string; at: number;
  reply: OwnerDocumentSearchReply;
}
const ownerKey = (source: OwnerSource) => JSON.stringify([source.user_id, source.client_token_id]);
const invalid = (): never => { throw new RpcError('invalid_args', 'Enter a search of up to 512 characters and start a new search request.', 400); };
const requestId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const validate = (value: OwnerDocumentSearchRequest): OwnerDocumentSearchRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['request_id', 'query', 'cursor', 'offset'].includes(key))
    || !requestId(value.request_id) || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 512 || !toFtsMatch(value.query)
    || value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 1024)
    || value.offset !== undefined && (!Number.isInteger(value.offset) || value.offset < 0 || value.offset > 5000)) invalid();
  return { request_id: value.request_id, query: value.query.trim(), ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    ...(value.offset === undefined ? {} : { offset: value.offset }) };
};

/** Owner pages use the same governed tool handler and approval finishers as Chat.
 * Only request/result delivery lives here; this service never reads file bytes. */
export const createOwnerDocumentSearch = (deps: {
  dispatch(args: Record<string, unknown>, ctx: ChatDispatchContext): Promise<ChatDispatchResult>;
  isCurrent(result: unknown): boolean;
  now?: () => number;
}) => {
  const now = deps.now ?? Date.now;
  const searches = new Map<string, Search>();
  const early = new Map<string, { owner: string; outcome: ChatDispatchResult; at: number }>();
  const prune = () => {
    for (const [id, entry] of searches) if (now() - entry.at >= TTL) searches.delete(id);
    for (const [id, entry] of early) if (now() - entry.at >= TTL) early.delete(id);
  };
  const accept = (entry: Search, outcome: ChatDispatchResult) => {
    const result = outcome.ok && outcome.result && typeof outcome.result === 'object'
      && (outcome.result as { status?: unknown }).status === 'searched' ? outcome.result as DocumentContentSearchResult : undefined;
    entry.at = now();
    entry.reply = { request_id: entry.reply.request_id,
      state: outcome.ok && outcome.run_held ? 'held' : result ? 'ready' : 'unavailable',
      ...(result ? { result } : {}), ...(outcome.run_id ? { run_id: outcome.run_id } : {}),
      ...(outcome.ok && outcome.run_held ? { message: 'This search is waiting for approval. Review the waiting action, then check this search.' }
        : !result ? { message: !outcome.ok && outcome.reason === 'run_cancelled'
          ? 'This search was declined or stopped. Start a new search to try again.'
          : 'Document contents could not be searched. Check file access and reader setup, then try again.' }
          : outcome.ok && outcome.run_failed ? { message: 'The search did not finish. Some files may still need to be searched.' } : {}) };
  };
  const get = (id: string, source: OwnerSource): OwnerDocumentSearchReply => {
    if (!requestId(id)) invalid();
    prune();
    const entry = searches.get(id);
    if (!entry || entry.owner !== ownerKey(source)) return { request_id: id, state: 'expired', message: 'This search is no longer available. Start a new search.' };
    if (entry.reply.result && !deps.isCurrent(entry.reply.result)) {
      return { request_id: id, state: 'changed', message: 'Files or permissions changed. Restart the file-content search to read the current results.' };
    }
    return entry.reply;
  };
  return {
    get,
    async search(raw: OwnerDocumentSearchRequest, source: OwnerSource): Promise<OwnerDocumentSearchReply> {
      const input = validate(raw), signature = JSON.stringify(input), owner = ownerKey(source);
      prune();
      const prior = searches.get(input.request_id);
      if (prior) {
        if (prior.owner !== owner || prior.signature !== signature) throw new RpcError('conflict', 'This request belongs to a different search. Start a new search.', 409);
        return get(input.request_id, source);
      }
      while (searches.size >= LIMIT) {
        const finished = [...searches].find(([, row]) => !['running', 'held'].includes(row.reply.state));
        if (!finished) throw new RpcError('conflict', 'Too many searches are waiting. Finish a waiting search before starting another.', 409);
        searches.delete(finished[0]);
      }
      const entry: Search = { owner, signature, at: now(), reply: { request_id: input.request_id, state: 'running' } };
      searches.set(input.request_id, entry);
      try {
        const outcome = await deps.dispatch({ query: input.query, scope: 'all', limit: 10,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.offset === undefined ? {} : { offset: input.offset }) },
        { channel: 'internal_function_call', execution_source: source });
        accept(entry, outcome);
        if (entry.reply.state === 'held' && entry.reply.run_id) {
          const settled = early.get(entry.reply.run_id);
          if (settled?.owner === owner) { early.delete(entry.reply.run_id); accept(entry, settled.outcome); }
        }
      } catch {
        entry.reply = { request_id: input.request_id, state: 'unavailable', message: 'The search could not finish. Try again to search the saved files.' };
      }
      return get(input.request_id, source);
    },
    settled(settled: PreflightRunSettled): void {
      const source = settled.execution_source as ExecutionSource | undefined;
      if (source?.channel !== 'user' || source.actor !== 'user_self') return;
      prune();
      const owner = ownerKey(source);
      const entry = [...searches.values()].find(row => row.owner === owner && row.reply.run_id === settled.run_id && row.reply.state === 'held');
      if (!entry && !['document.search', 'document.read', 'read-work-document'].includes(settled.tool_name)) return;
      const value = settled.result as { ok?: unknown; denied?: unknown } | undefined;
      // Denials carry the underlying recipe id, not the tool's finisher name.
      // A missing finisher must not deliver the recipe's raw file bytes.
      const outcome: ChatDispatchResult = settled.tool_name === 'document.search' && value && typeof value.ok === 'boolean'
        ? settled.result as ChatDispatchResult : { ok: false, reason: value?.denied === true ? 'run_cancelled' : 'execution_error' };
      if (entry) accept(entry, outcome);
      else {
        early.set(settled.run_id, { owner, outcome, at: now() });
        while (early.size > LIMIT) early.delete(early.keys().next().value!);
      }
    },
  };
};
export type OwnerDocumentSearch = ReturnType<typeof createOwnerDocumentSearch>;
