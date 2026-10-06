import { RpcError, type MailWorkReadRequest, type ChatDispatchResult } from '@recued/contracts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (slug: string, id: string): string => JSON.stringify([slug, id]);
const locator = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export const parseMailWorkReadRequest = (value: unknown): MailWorkReadRequest => {
  if (!object(value) || !Array.isArray(value.seeds) || value.seeds.length === 0 || value.seeds.length > 8
    || value.seeds.some(seed => !object(seed) || !locator(seed.slug, 512) || !locator(seed.record_id, 2048)
      || (seed.thread_id !== undefined && seed.thread_id !== null && !locator(seed.thread_id, 2048)))) {
    throw new RpcError('bad_request', 'Choose one to eight starting emails for this investigation.', 400);
  }
  return { seeds: value.seeds.map(seed => ({ slug: String(seed.slug), record_id: String(seed.record_id),
    ...(seed.thread_id !== undefined ? { thread_id: seed.thread_id as string | null } : {}) })) };
};

export type MailWorkRead = (name: 'mail.read' | 'mail.search', args: Record<string, unknown>) => Promise<ChatDispatchResult>;
const UNAVAILABLE = 'I could not finish rereading the current linked mail. I have not updated the work from older Chat context. Check mailbox access and try Investigate in Chat again.';
const TOO_LARGE = 'The linked mail exceeded this investigation’s automatic reading limit. I have not updated the work from incomplete reading. Open the relevant sources or narrow the linked conversations, then investigate again.';

/** Runs before AI, including on a resumed/queued turn. The callback is the
 * normal dispatch boundary (grants, cancellation, visible activity and audit).
 * Bodies remain tool results and pass through the normal privacy boundary.
 * This checks stored mail, not provider synchronization or semantic relevance. */
export const readCurrentMailWork = async (
  request: MailWorkReadRequest, read: MailWorkRead,
): Promise<{ failure?: string; limited: boolean }> => {
  let chars = 0;
  let calls = 0;
  let limited = false;
  let failure: string | undefined;
  const seen = new Set<string>();
  const call: MailWorkRead = async (name, args) => {
    if (++calls > 96) { failure = TOO_LARGE; return { ok: false, reason: 'execution_error' }; }
    return read(name, args);
  };
  const fullRead = async (slug: string, record_id: string): Promise<Record<string, unknown> | null> => {
    let offset = 0;
    let read_version: string | undefined;
    let first: Record<string, unknown> | null = null;
    do {
      const reply = await call('mail.read', { slug, record_id, offset, ...(read_version ? { read_version } : {}) });
      const result = reply.ok && object(reply.result) ? reply.result : null;
      if (!result || result.status !== 'read' || result.slug !== slug || result.record_id !== record_id
        || result.offset !== offset || typeof result.body !== 'string' || typeof result.read_version !== 'string') {
        failure ??= UNAVAILABLE; return null;
      }
      if (read_version !== undefined && result.read_version !== read_version) { failure = UNAVAILABLE; return null; }
      first ??= result;
      chars += result.body.length;
      if (chars > 160_000) { failure = TOO_LARGE; return null; }
      if (result.next_offset === null && result.body_incomplete === false) break;
      if (!Number.isSafeInteger(result.next_offset) || Number(result.next_offset) <= offset) { failure = UNAVAILABLE; return null; }
      offset = Number(result.next_offset);
      read_version = result.read_version;
    } while (!failure);
    seen.add(key(slug, record_id));
    return first;
  };
  for (const seed of request.seeds) {
    const anchor = await fullRead(seed.slug, seed.record_id);
    if (!anchor) break;
    const thread = object(anchor.hot_fields) && locator(anchor.hot_fields.thread_id, 2048)
      ? anchor.hot_fields.thread_id : null;
    if (seed.thread_id !== undefined && thread !== seed.thread_id) { failure = UNAVAILABLE; break; }
    const reply = await call('mail.search', thread !== null
      ? { slug: seed.slug, filters: { thread_id: thread }, limit: 40 }
      : { slug: seed.slug, near_id: seed.record_id, prev: 5, next: 10, limit: 40 });
    const result = reply.ok && object(reply.result) ? reply.result : null;
    if (!result || !Array.isArray(result.matches) || !Array.isArray(result.collections)
      || !result.collections.includes(seed.slug) || result.matches.length > 40) { failure ??= UNAVAILABLE; break; }
    limited ||= result.more_matches === true || thread === null;
    for (const match of result.matches) {
      if (!object(match) || match.collection_slug !== seed.slug || !locator(match.record_id, 2048)) { failure = UNAVAILABLE; break; }
      if (!seen.has(key(seed.slug, match.record_id))) {
        const message = await fullRead(seed.slug, match.record_id);
        if (message && thread !== null && (!object(message.hot_fields) || message.hot_fields.thread_id !== thread)) {
          failure = UNAVAILABLE;
        }
      }
      if (failure) break;
    }
    if (failure) break;
  }
  return { ...(failure ? { failure } : {}), limited };
};
