import type { ChatDispatchResult, ChatPriorToolCall, MailWorkReadRequest } from '@recued/contracts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const locator = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const key = (slug: string, id: string): string => JSON.stringify([slug, id]);

/** A bounded lexical starting point, not a conclusion about related work.
 * Search the first two subject terms from at most two current anchors across
 * senders/threads. Full subjects often include "request" or "reply" absent from
 * coworkers' messages. Ordinary mail.search owns FTS escaping/tokenization.
 * The agent must assess relevance and can choose better queries afterwards. */
export const mailWorkDiscoveryQueries = (
  request: MailWorkReadRequest, prior: readonly ChatPriorToolCall[],
): string[] => {
  const queries: string[] = [];
  for (const seed of request.seeds) {
    const call = prior.find(c => c.tool_name === 'mail.read' && c.status === 'ok' && object(c.args)
      && c.args.slug === seed.slug && c.args.record_id === seed.record_id && (c.args.offset ?? 0) === 0);
    const result = call?.result;
    if (!object(result) || result.status !== 'read' || !object(result.hot_fields)
      || typeof result.hot_fields.subject !== 'string') continue;
    const subject = result.hot_fields.subject.slice(0, 512).replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, '');
    const terms = subject.match(/[\p{L}\p{N}]+/gu)?.slice(0, 2) ?? [];
    if (!terms.length || terms.some(term => term.length > 64)) continue;
    const query = terms.join(' ');
    if (!queries.some(old => old.toLowerCase() === query.toLowerCase())) queries.push(query);
    if (queries.length === 2) break;
  }
  return queries;
};

/** Prepared investigations only: read up to four unseen search hits per turn
 * through the ordinary dispatcher, before reinvoking the model. One normal
 * 24k page per hit bounds extra reading at 96k characters. Partial pages and
 * unread hits stay visible for the agent to continue; no relevance is inferred.
 * The set includes failed attempts so unavailable mail is not retried blindly. */
export const createMailWorkDiscoveryReader = () => {
  const attempted = new Set<string>();
  let remaining = 4;
  return async (
    prior: readonly ChatPriorToolCall[], searches: readonly ChatDispatchResult[],
    read: (args: { slug: string; record_id: string }) => Promise<void>,
  ): Promise<void> => {
    for (const call of prior) {
      if (call.tool_name === 'mail.read' && object(call.args)
        && locator(call.args.slug, 512) && locator(call.args.record_id, 2048)) {
        attempted.add(key(call.args.slug, call.args.record_id));
      }
    }
    for (const reply of searches) {
      if (!reply.ok || !object(reply.result)) continue;
      const { matches, collections } = reply.result;
      if (!Array.isArray(matches) || !Array.isArray(collections)) continue;
      for (const match of matches) {
        if (remaining === 0) return;
        if (!object(match) || !locator(match.collection_slug, 512) || !locator(match.record_id, 2048)
          || !collections.includes(match.collection_slug)) continue;
        const identity = key(match.collection_slug, match.record_id);
        if (attempted.has(identity)) continue;
        attempted.add(identity);
        remaining--;
        await read({ slug: match.collection_slug, record_id: match.record_id });
      }
    }
  };
};
