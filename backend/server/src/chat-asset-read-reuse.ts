import { chatSourceCitationsOf, type ChatDispatchResult } from '@recued/contracts';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const simpleAssetReadId = (args: unknown): string | undefined => {
  if (!object(args) || args.kind !== 'asset' || typeof args.id !== 'string'
    || !args.id || args.id.length > 2048 || args.id.startsWith('we1:')
    || Object.keys(args).some(key => key !== 'kind' && key !== 'id')) return undefined;
  return args.id;
};

/** Only a canonical, terminal local owner-asset result can be reused. This
 * also checks the attested source target, rather than trusting a payload hint. */
export const localAssetReadVersion = (id: string, result: ChatDispatchResult): string | undefined => {
  if (!result.ok || result.run_failed || isNonTerminalToolResult(result) || !object(result.result)) return undefined;
  const value = result.result;
  if (value.found !== true || !object(value.entity) || value.entity.kind !== 'asset'
    || value.entity.source_id !== 'recued.asset' || !object(value.plan) || value.plan.action !== 'local'
    || !object(value.source_freshness) || value.source_freshness.source_id !== 'recued.asset'
    || value.source_freshness.state !== 'local' || value.source_kind !== 'asset'
    || typeof value.read_version !== 'string' || !/^[a-f0-9]{64}$/u.test(value.read_version)) return undefined;
  return chatSourceCitationsOf(result.source_citations).some(source => source.kind === 'asset'
    && source.asset_id === id && source.read_version === value.read_version
    && value.source_ref === `#source/${source.id}`) ? value.read_version : undefined;
};

export const ASSET_READ_REUSE_FEEDBACK = 'The repeated asset read was not dispatched again. Its access and source version were rechecked. '
  + 'Use its earlier successful result in prior_tool_calls to answer the current question. '
  + 'If context fitting has since elided that result, recover the missing evidence normally. '
  + 'A missing field remains unavailable; do not repeat the same read to fill it. Request different evidence if needed.';

/** Per-turn pointers to results already retained by the executor. Reuse never
 * restores elided/folded data, adds a cached result to a packet, or crosses a
 * write. Version validation still performs an authorized canonical read. */
export const createAssetReadReuse = (validate: (id: string, version: string) => Promise<boolean>) => {
  const reads = new Map<string, { result: Extract<ChatDispatchResult, { ok: true }>; version: string; payload: string }>();
  return {
    clear: () => reads.clear(),
    remember(args: unknown, result: ChatDispatchResult): void {
      const id = simpleAssetReadId(args); if (!id) return;
      const version = localAssetReadVersion(id, result);
      if (!version || !result.ok) { reads.delete(id); return; }
      const payload = JSON.stringify(result.result);
      // Large results may already have needed context recovery; don't make
      // reparsing them another reason to retain or recover a second copy.
      if (payload.length <= 16_384) reads.set(id, { result, version, payload });
      else reads.delete(id);
    },
    async reuse(args: unknown, packet: string): Promise<ChatDispatchResult | undefined> {
      const id = simpleAssetReadId(args); const read = id ? reads.get(id) : undefined;
      if (!id || !read) return undefined;
      let exposed = false;
      try {
        const body: unknown = JSON.parse(packet);
        exposed = object(body) && Array.isArray(body.prior_tool_calls) && body.prior_tool_calls.some(call =>
          object(call) && call.tool_name === 'work.read' && call.status === 'ok'
          && simpleAssetReadId(call.args) === id && JSON.stringify(call.result) === read.payload);
      } catch { /* No complete canonical result in a readable packet. */ }
      if (!exposed) return undefined;
      if (!await validate(id, read.version)) { reads.delete(id); return undefined; }
      if (JSON.stringify(read.result.result) !== read.payload || localAssetReadVersion(id, read.result) !== read.version) {
        reads.delete(id); return undefined;
      }
      return read.result;
    },
  };
};
