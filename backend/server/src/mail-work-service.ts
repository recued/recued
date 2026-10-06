import { MAIL_WORK_PLAN_GUIDANCE, MAIL_WORK_SOURCE_PLAN_SHAPE } from './mail-work-chat-plan-guidance.js';
import { mailWorkSourcePlanSchema, renderMailWorkSourcePlan } from './mail-work-chat-plan.js';
import { MAIL_WORK_SOURCE_ACTION_FORMAT, groundLinkedMailWorkClaims } from './mail-work-linked-source-review.js';
import { mailWorkSourcePassages, type MailWorkQuoteSource } from './mail-work-source-recap.js';
import { MAIL_WORK_SOURCE_CATALOG_NOTE } from './mail-work-evidence.js';
import { createHash } from 'node:crypto';
import {
  KERNEL_AUTHOR, MAIL_WORK_CLAIM_KINDS, MAIL_WORK_REVIEW_TIMEOUT_MS, PII_ENTITY_MARKER_KEY, RpcError,
  mailWorkOwnerNotesRecordedAtIso,
  type CollectionRecord, type IngredientManifest, type MailWork, type MailWorkClaim,
  type MailWorkCreateRequest, type MailWorkDeleteRequest, type MailWorkDeleteResult, type MailWorkDetail,
  type MailWorkEmailRef, type MailWorkListRequest, type MailWorkSearchResult, type MailWorkThread, type MailWorkUpdateRequest,
} from '@recued/contracts';
import { holdsPiiAliasToken } from '@recued/transforms';
import type { Collection } from './collections/types.js';
import type { MailWorkStore, StoredMailWork } from './storage/mail-work-store.js';
import { mailWorkConflict } from './storage/mail-work-store.js';
import { mailFactAiFailure, type MailFactAiCall } from './mail-facts/ai-pass.js';
import { mailEvidenceMetadata, mailReceivedAtIso } from './mail-evidence.js';
import { renderMailWorkAction } from './mail-work-action-renderer.js';
import { decodeMailWorkReview } from './mail-work-review-sections.js';

export const MAIL_WORK_MANIFEST: IngredientManifest = {
  slug: 'recued-mail-work-review', name: 'Follow this work',
  description: 'Review owner-selected conversations and propose ways to move the work forward.',
  author: KERNEL_AUTHOR, kind: 'ai', category: 'ai', risk_tier: 'read',
  input: { 'llm.system_prompt': null, 'llm.prompt': null, 'llm.output_format': 'json' },
  output: { result: 'body' },
};
export const MAIL_WORK_SYSTEM_PROMPT = `${MAIL_WORK_PLAN_GUIDANCE}\n${MAIL_WORK_SOURCE_PLAN_SHAPE}
CURRENT TASK: Return only the plan object with task propose (no Chat envelope). Select passage IDs from passage_catalog; its source field identifies the supplied mail_source_N, owner_notes, desired_outcome or resolution_note source. There are no tools in this call. Suggest useful work for the live request or a supported conclusion; do not create a commitment or execute work. Omit unavailable attachment details and preserve material coverage uncertainty.`;

export interface MailWorkServiceDeps {
  store: MailWorkStore;
  registry: {
    get(platform: string, slug: string): Pick<Collection, 'get' | 'list'> | undefined;
    list(): Array<Pick<Collection, 'platform' | 'slug' | 'search'>>;
  };
  body: (record: CollectionRecord) => Promise<string | null>;
  ai?: MailFactAiCall;
  now?: () => number;
  hasInvestigation?: (sessionId: string) => Promise<boolean>;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const keyOf = (ref: MailWorkEmailRef): string => JSON.stringify([ref.slug, ref.record_id]);
const threadKey = (thread: MailWorkThread): string => JSON.stringify([thread.slug, thread.thread_id, thread.thread_id === null ? thread.seed_record_id : null]);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const word = (value: unknown, label: string, max = 512, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new RpcError('bad_request', `${label} must be ${empty ? 'text' : 'nonempty text'} of at most ${max} characters.`, 400);
  }
  return value.trim();
};
const emailRef = (value: unknown): MailWorkEmailRef => {
  if (!isObject(value)) throw new RpcError('bad_request', 'Choose an email.', 400);
  return { slug: word(value.slug, 'Mailbox'), record_id: word(value.record_id, 'Email ID', 2048) };
};
const readable = (value: unknown): string => typeof value === 'string' ? value.slice(0, 2000) : value == null ? '' : JSON.stringify(value).slice(0, 2000);
const revisionOf = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RpcError('bad_request', 'A current revision is required.', 400);
  return value;
};
/** A bad item still rejects the whole review, keeping the previous one. The
 * owner reads why in plain words; `details.field` names the item for developers. */
const unusable = (what: string, field: string): never => {
  throw new RpcError('bad_request', `The AI returned ${what}. Try the review again. The previous review is unchanged.`, 400, undefined, { field });
};
/** Recipient lists sit outside the body budget, so one review shares its own:
 * at most 20 addresses per field and 20,000 address characters, newest
 * messages first. An entry over 320 characters is not an address. Whatever is
 * left out is counted; no address is cut. */
const recipientBudget = () => {
  let characters = 20_000;
  return (value: unknown): { shown: string[]; not_shown: number } => {
    const listed: unknown[] = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
    const shown: string[] = [];
    for (const address of listed) {
      if (shown.length === 20) break;
      if (typeof address !== 'string' || address.length > 320) continue;
      if (address.length > characters) break;
      shown.push(address);
      characters -= address.length;
    }
    return { shown, not_shown: listed.length - shown.length };
  };
};
interface Source { ref: MailWorkEmailRef; record: CollectionRecord; hash: string }
interface Snapshot { sources: Source[]; fingerprint: string; warnings: string[] }

export const createMailWorkService = (deps: MailWorkServiceDeps) => {
  const now = deps.now ?? Date.now;
  const requireWork = async (id: unknown): Promise<StoredMailWork> => {
    const found = await deps.store.get(word(id, 'Work ID', 100));
    if (!found) throw new RpcError('not_found', 'This work is no longer available.', 404);
    return found;
  };
  const threadFrom = (ref: MailWorkEmailRef): MailWorkThread => {
    const record = deps.registry.get('mail', ref.slug)?.get(ref.record_id);
    if (!record) throw new RpcError('not_found', 'The selected email is no longer available.', 404);
    return { slug: ref.slug, seed_record_id: ref.record_id,
      thread_id: typeof record.hot_fields.thread_id === 'string' && record.hot_fields.thread_id ? record.hot_fields.thread_id : null,
      subject: readable(record.hot_fields.subject) || 'Untitled conversation' };
  };
  const matching = async (ref: MailWorkEmailRef): Promise<StoredMailWork[]> => {
    const thread = threadFrom(ref);
    const version = deps.store.version();
    const result: StoredMailWork[] = [];
    let before: import('@recued/contracts').MailWorkCursor | undefined;
    do {
      const page = await deps.store.list(before);
      result.push(...page.rows.filter(({ work }) => work.threads.some(item => item.slug === ref.slug
        && (item.seed_record_id === ref.record_id || (thread.thread_id !== null && item.thread_id === thread.thread_id)))));
      before = page.next_cursor ?? undefined;
    } while (before);
    if (version !== deps.store.version() || threadKey(threadFrom(ref)) !== threadKey(thread)) mailWorkConflict();
    return result;
  };
  const snapshot = (work: MailWork): Snapshot => {
    const sources = new Map<string, Source>();
    const warnings: string[] = [];
    for (const thread of work.threads) {
      const collection = deps.registry.get('mail', thread.slug);
      if (!collection) { warnings.push(`Mailbox ${thread.slug} is unavailable.`); continue; }
      const seed = collection.get(thread.seed_record_id);
      if (!seed || (thread.thread_id !== null && seed.hot_fields.thread_id !== thread.thread_id)) {
        warnings.push(`The starting email for “${thread.subject}” is missing or has moved.`);
      }
      const records = thread.thread_id === null ? (seed ? [seed] : []) : collection.list({
        platform: 'mail', slug: thread.slug, filters: { thread_id: thread.thread_id }, limit: 41,
      });
      if (records.length > 40) warnings.push(`Only the latest 40 messages and starting email from “${thread.subject}” are included.`);
      // Keep the chosen email even if the ongoing conversation exceeds the window.
      const selected = records.slice(0, 40);
      if (seed && (thread.thread_id === null || seed.hot_fields.thread_id === thread.thread_id)) selected.push(seed);
      if (!selected.length) warnings.push(`Conversation “${thread.subject}” is no longer stored.`);
      for (const record of selected) {
        const ref = { slug: thread.slug, record_id: record.record_id };
        const fields = record.hot_fields;
        // Production mail stores its effective date in received_at. It also
        // orders the body budget, so a correction must invalidate an in-flight review.
        const content = [record.source_id, fields.rfc_message_id, record.received_at, fields.thread_id, fields.from, fields.to, fields.cc, fields.subject,
          fields.date, fields.direction, fields.has_attachments, record.body_inline, record.blob_hash];
        sources.set(keyOf(ref), { ref, record, hash: hash(JSON.stringify(content)) });
      }
    }
    const sorted = [...sources.values()].sort((a, b) => keyOf(a.ref).localeCompare(keyOf(b.ref)));
    return { sources: sorted, warnings, fingerprint: hash(JSON.stringify([sorted.map(source => [keyOf(source.ref), source.hash]), warnings])) };
  };
  const detail = (stored: StoredMailWork): MailWorkDetail => {
    const current = snapshot(stored.work);
    // Namespace the work ID into a stable v4-shaped Chat creation ID. This
    // also gives legacy encrypted work rows a durable Chat without migration
    // or a second write racing an owner edit. Chat still owns its lifecycle.
    const chatId = hash(`mail-work-chat-v1:${stored.work.id}`);
    const chat_session_id = `${chatId.slice(0, 8)}-${chatId.slice(8, 12)}-4${chatId.slice(13, 16)}-8${chatId.slice(17, 20)}-${chatId.slice(20, 32)}`;
    return { work: stored.work, chat_session_id, needs_review: stored.work.reviewed_fingerprint !== current.fingerprint,
      warnings: current.warnings, sources: current.sources.map(source => ({ ...source.ref,
        subject: readable(source.record.hot_fields.subject), from: readable(source.record.hot_fields.from),
        date: readable(source.record.hot_fields.date) || new Date(source.record.received_at).toISOString(),
        changed: stored.reviewed_sources[keyOf(source.ref)] !== source.hash,
      })) };
  };
  const search = (query: unknown): MailWorkSearchResult => {
    deps.store.assertUnlocked();
    const terms = word(query, 'Search', 240).split(/\s+/u).slice(0, 8);
    // Quote every token: user/model text never becomes an FTS operator or syntax error.
    const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    const emails: MailWorkSearchResult['emails'] = [];
    const warnings: string[] = [];
    const mailboxes = deps.registry.list().filter(item => item.platform === 'mail');
    if (!mailboxes.length) warnings.push('No connected mailbox is available to search.');
    const seen = new Set<string>();
    for (const collection of mailboxes) {
      try {
        const matches = collection.search({ platform: 'mail', slug: collection.slug, query: expression, limit: 12 });
        if (matches.length === 12) warnings.push(`More matches may exist in ${collection.slug}. Refine the search.`);
        for (const match of matches) {
          const thread = typeof match.hot_fields.thread_id === 'string' && match.hot_fields.thread_id ? match.hot_fields.thread_id : null;
          const key = JSON.stringify([collection.slug, thread, thread === null ? match.record_id : null]);
          if (seen.has(key)) continue;
          seen.add(key);
          emails.push({ slug: collection.slug, record_id: match.record_id, subject: readable(match.hot_fields.subject),
            from: readable(match.hot_fields.from), thread_id: thread });
        }
      } catch { warnings.push(`Search is unavailable for ${collection.slug}.`); }
    }
    if (emails.length > 60) warnings.push('Showing the first 60 matches. Refine the search for more.');
    return { emails: emails.slice(0, 60), warnings };
  };
  const reviewing = new Set<string>();
  return {
    async list(input: MailWorkListRequest = {}) {
      if (input.before && (!Number.isSafeInteger(input.before.updated_at) || typeof input.before.id !== 'string')) {
        throw new RpcError('bad_request', 'Invalid page cursor.', 400);
      }
      const page = input.email ? { rows: await matching(emailRef(input.email)), next_cursor: null } : await deps.store.list(input.before);
      return { works: page.rows.map(({ work }) => ({ id: work.id, title: work.title, status: work.status, updated_at: work.updated_at,
        needs_review: work.status === 'active' && work.reviewed_fingerprint !== snapshot(work).fingerprint })), next_cursor: page.next_cursor,
        ...(input.email ? { matched_email: emailRef(input.email) } : {}) };
    },
    async get(id: unknown) {
      const stored = await requireWork(id);
      const result = detail(stored);
      if (!deps.hasInvestigation) return result;
      const investigation_started = await deps.hasInvestigation(result.chat_session_id);
      if ((await requireWork(id)).work.revision !== stored.work.revision) mailWorkConflict();
      return { ...detail(stored), investigation_started };
    },
    async create(input: MailWorkCreateRequest): Promise<MailWorkDetail> {
      const requestId = word(input.request_id, 'Request ID', 100);
      if (!/^[a-zA-Z0-9_-]{16,100}$/u.test(requestId)) throw new RpcError('bad_request', 'Invalid request ID.', 400);
      const ref = emailRef(input.email);
      const title = input.title === undefined ? '' : word(input.title, 'Title', 200, true);
      const goal = input.goal === undefined ? '' : word(input.goal, 'Outcome', 4000, true);
      if (input.separate !== undefined && typeof input.separate !== 'boolean') throw new RpcError('bad_request', 'Invalid separate-investigation choice.', 400);
      const creationKey = hash(JSON.stringify([ref, title, goal]));
      const id = `mw_${hash(requestId).slice(0, 32)}`;
      const previous = await deps.store.get(id);
      if (previous) {
        if (previous.creation_key !== creationKey) mailWorkConflict();
        return detail(previous);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const version = deps.store.version();
        if (!input.separate) {
          let matches: StoredMailWork[];
          try { matches = await matching(ref); }
          catch (error) { if (deps.store.version() !== version) continue; throw error; }
          if (matches.length === 1) return { ...detail(matches[0]!), existing_work: true };
          if (matches.length > 1) throw new RpcError('conflict', 'Several investigations follow this conversation. Choose one, or start a separate investigation.', 409);
        }
        const thread = threadFrom(ref);
        const timestamp = now();
        const stored: StoredMailWork = { work: { id, revision: 1, title: title || thread.subject.slice(0, 200), goal,
          owner_notes: '', owner_notes_recorded_at: null, status: 'active', resolution_note: '', threads: [thread], brief: null, reviewed_fingerprint: null,
          created_at: timestamp, updated_at: timestamp }, reviewed_sources: {}, creation_key: creationKey };
        try { await deps.store.put(stored, null, () => {
          if ((!input.separate && deps.store.version() !== version) || threadKey(threadFrom(ref)) !== threadKey(thread)) mailWorkConflict();
        }); }
        catch (error) {
          const winner = await deps.store.get(id);
          if (!winner && !input.separate && deps.store.version() !== version) continue;
          if (!winner || winner.creation_key !== creationKey) throw error;
          return detail(winner);
        }
        return detail(stored);
      }
      return mailWorkConflict();
    },
    async update(input: MailWorkUpdateRequest): Promise<MailWorkDetail> {
      const expected = revisionOf(input.expected_revision);
      const stored = await requireWork(input.id);
      if (stored.work.revision !== expected) mailWorkConflict();
      const work: MailWork = { ...stored.work, threads: [...stored.work.threads], revision: expected + 1, updated_at: now() };
      if (input.title !== undefined) work.title = word(input.title, 'Title', 200);
      if (input.goal !== undefined) work.goal = word(input.goal, 'Outcome', 4000, true);
      if (input.owner_notes !== undefined) {
        work.owner_notes = word(input.owner_notes, 'Owner notes', 12000, true);
        if (work.owner_notes !== stored.work.owner_notes.trim()) {
          work.owner_notes_recorded_at = work.owner_notes ? work.updated_at : null;
        }
      }
      if (input.resolution_note !== undefined) work.resolution_note = word(input.resolution_note, 'Resolution', 4000, true);
      if (input.status !== undefined) {
        if (!['active', 'resolved', 'archived'].includes(input.status)) throw new RpcError('bad_request', 'Invalid work status.', 400);
        work.status = input.status;
      }
      if (work.status === 'resolved' && !work.resolution_note) throw new RpcError('bad_request', 'Record how the work was resolved.', 400);
      const linked = input.link_email === undefined ? undefined : emailRef(input.link_email);
      const linkedThread = linked ? threadFrom(linked) : undefined;
      if (linkedThread) {
        const thread = linkedThread;
        if (!work.threads.some(item => threadKey(item) === threadKey(thread))) work.threads.push(thread);
        if (work.threads.length > 8) throw new RpcError('bad_request', 'Follow up to eight conversations per work item.', 400);
      }
      if (input.unlink_thread !== undefined) {
        const ref = emailRef({ slug: input.unlink_thread?.slug, record_id: input.unlink_thread?.seed_record_id });
        const remove = work.threads.find(item => item.slug === ref.slug && item.seed_record_id === ref.record_id);
        if (!remove) throw new RpcError('bad_request', 'This conversation is not linked.', 400);
        work.threads = work.threads.filter(item => item !== remove);
        if (!work.threads.length) throw new RpcError('bad_request', 'Keep at least one conversation, or archive the work.', 400);
      }
      if (work.title !== stored.work.title || work.goal !== stored.work.goal || work.owner_notes !== stored.work.owner_notes
        || work.resolution_note !== stored.work.resolution_note || linked || input.unlink_thread !== undefined) work.reviewed_fingerprint = null;
      const next = { ...stored, work };
      await deps.store.put(next, expected, () => { if (linked && linkedThread && threadKey(threadFrom(linked)) !== threadKey(linkedThread)) mailWorkConflict(); });
      return detail(next);
    },
    /** Removes the workbook and its reviewed-source data. Chat keeps its own
     * lifecycle; the owner deletes the conversation there. */
    async delete(input: MailWorkDeleteRequest): Promise<MailWorkDeleteResult> {
      const expected = revisionOf(input.expected_revision);
      const stored = await requireWork(input.id);
      if (stored.work.revision !== expected) mailWorkConflict();
      deps.store.delete(stored.work.id, expected);
      return { id: stored.work.id, deleted: true };
    },
    search,
    async review(id: unknown, expectedRevision: unknown): Promise<MailWorkDetail> {
      const expected = revisionOf(expectedRevision);
      const stored = await requireWork(id);
      if (stored.work.revision !== expected) mailWorkConflict();
      if (stored.work.status !== 'active') throw new RpcError('bad_request', 'Reopen this work before reviewing it.', 400);
      if (!deps.ai) throw new RpcError('not_configured', 'Set up an AI model in Settings to review this work.', 503);
      if (reviewing.has(stored.work.id)) throw new RpcError('conflict', 'A review of this work is already running.', 409);
      reviewing.add(stored.work.id);
      try {
        const before = snapshot(stored.work);
        if (!before.sources.length) throw new RpcError('not_found', 'No linked messages are currently available.', 404);
        const warnings = [...before.warnings];
        const sourceMap = new Map<string, MailWorkEmailRef>();
        const quoteSources = new Map<string, MailWorkQuoteSource>([
          ['owner_notes', { text: stored.work.owner_notes, label: 'Your notes' }],
          ['desired_outcome', { text: stored.work.goal, label: 'Your desired outcome' }],
          ['resolution_note', { text: stored.work.resolution_note, label: 'Your resolution note' }],
        ]);
        const planSources = new Map(quoteSources);
        let remaining = 160_000;
        let incomplete = 0;
        const recipients = recipientBudget();
        let shortenedMessages = 0;
        let leftOut = 0;
        // Most recent messages get the body and recipient budgets first; all supplied headers retain their dates.
        const newest = [...before.sources].sort((a, b) => b.record.received_at - a.record.received_at);
        const messages: Record<string, unknown>[] = [];
        for (const [index, source] of newest.entries()) {
          // Distinct from the privacy layer's mN@dN.invalid email aliases.
          const token = `mail_source_${index + 1}`;
          sourceMap.set(token, source.ref);
          const body = remaining > 0 ? await deps.body(source.record) : null;
          const cut = Math.min(remaining, 16000);
          // Never end on half of a two-unit character (an emoji, say).
          const text = body?.slice(0, /[\uD800-\uDBFF]/u.test(body.charAt(cut - 1)) ? cut - 1 : cut) ?? '';
          remaining -= text.length;
          quoteSources.set(token, { text, label: 'Email' });
          planSources.set(token, { text, label: 'Email', href: mailEvidenceMetadata(source.ref.slug, source.ref.record_id, undefined).source_url });
          const partial = body === null || text.length < body.length;
          if (partial) incomplete++;
          const fields = source.record.hot_fields;
          const to = recipients(fields.to);
          const cc = recipients(fields.cc);
          if (to.not_shown || cc.not_shown) { shortenedMessages++; leftOut += to.not_shown + cc.not_shown; }
          messages.push({ source: token, [PII_ENTITY_MARKER_KEY]: 'mail',
            from: readable(fields.from) || undefined, to: to.shown, cc: cc.shown,
            ...(to.not_shown ? { to_not_shown: to.not_shown } : {}), ...(cc.not_shown ? { cc_not_shown: cc.not_shown } : {}),
            subject: readable(fields.subject),
            date: readable(fields.date) || mailReceivedAtIso(source.record.received_at),
            received_at_iso: mailReceivedAtIso(source.record.received_at),
            direction: readable(fields.direction) || undefined, body_text: text, body_incomplete: partial,
            // Attachment parts live outside the mail row; [] would falsely
            // imply that their absence was checked. Preserve the stored flag.
            has_attachments: typeof fields.has_attachments === 'boolean' ? fields.has_attachments : null,
            attachment_metadata_included: false, attachment_content_included: false });
        }
        if (incomplete) warnings.push(`${incomplete} message bodies are missing or shortened.`);
        if (shortenedMessages) warnings.push(`${shortenedMessages} messages list only some of their recipients; ${leftOut} addresses were not included.`);
        warnings.push('Attachment names and contents have not been read. Mail may not include offline decisions.');
        if ((await requireWork(stored.work.id)).work.revision !== expected) mailWorkConflict();
        if (snapshot(stored.work).fingerprint !== before.fingerprint) mailWorkConflict();
        const answer: unknown = await deps.ai({
          'llm.system_prompt': MAIL_WORK_SYSTEM_PROMPT,
          // Use the chat privacy layer's actual prose/tool-result fields. Custom
          // top-level context fields would bypass its content aliasing pass.
          'llm.prompt': JSON.stringify({ user_message: 'Review this work and suggest the next useful steps.',
            prior_review_at: stored.work.brief?.reviewed_at ?? null,
            prior_tool_calls: [
              // Rebuild from evidence, without feeding generated claims back
              // as facts. The saved brief remains visible until review succeeds.
              ...messages.reverse().map(message => ({ tool_name: 'core.mail.get', status: 'ok', args: {}, result: message,
                started_at: now(), completed_at: now() })),
              { tool_name: 'mail.work.owner_context', status: 'ok', args: {},
                result: { title: stored.work.title, desired_outcome: stored.work.goal, owner_notes: stored.work.owner_notes,
                  owner_notes_recorded_at_iso: mailWorkOwnerNotesRecordedAtIso(stored.work),
                  resolution_note: stored.work.resolution_note }, started_at: now(), completed_at: now() },
              { tool_name: 'mail.work.passage_catalog', status: 'ok', args: {},
                result: { note: MAIL_WORK_SOURCE_CATALOG_NOTE, passage_catalog: mailWorkSourcePassages(planSources) }, started_at: now(), completed_at: now() },
            ] }),
          'llm.output_format': 'json',
          'llm.output_schema': mailWorkSourcePlanSchema(planSources, 'propose'),
        }, { timeout_ms: MAIL_WORK_REVIEW_TIMEOUT_MS - 10_000 }).catch((error: unknown) => {
          if (isObject(error) && error.code === 'AI_LLM_UNAVAILABLE') {
            throw new RpcError('not_configured', 'Set up an available AI model in Settings to review this work.', 503);
          }
          throw new RpcError('internal', `The review was not updated: ${mailFactAiFailure(error)}.`, 502);
        });
        let parsed: unknown = answer;
        if (typeof answer === 'string' && answer.length <= 100_000) {
          try { parsed = JSON.parse(answer); }
          catch { throw new RpcError('bad_request', 'The AI returned an unreadable review. The previous review is unchanged.', 400); }
        }
        if (!isObject(parsed) || JSON.stringify(parsed).length > 100_000) {
          throw new RpcError('bad_request', 'The AI returned an unreadable review. The previous review is unchanged.', 400);
        }
        const sourcePlan = parsed.task === 'propose' ? renderMailWorkSourcePlan(parsed, planSources, 'propose') : null;
        if (sourcePlan && !sourcePlan.ok) {
          throw new RpcError('bad_request', 'The AI returned a plan with invalid source or action references. The previous review is unchanged.', 400);
        }
        // Older provider declarations remain readable under their original
        // guards. A failed new plan is never converted into a legacy review.
        if (!sourcePlan) {
          // New sectioned declarations and legacy claims share the same source,
          // state and permission guards. No failed legacy reply is converted.
          parsed = decodeMailWorkReview(parsed);
          if (!isObject(parsed) || !Array.isArray(parsed.claims) || parsed.claims.length > 24) {
            throw new RpcError('bad_request', 'The AI returned an unreadable review. The previous review is unchanged.', 400);
          }
          if (parsed.review_format !== MAIL_WORK_SOURCE_ACTION_FORMAT) {
            throw new RpcError('bad_request', 'The AI returned an unreadable review. The previous review is unchanged.', 400);
          }
          // The EXACT alias grammar: the loose pre-scan also matches "PII." and
          // "pii.csv", which a faithful claim can say.
          if (holdsPiiAliasToken(parsed)) {
            throw new RpcError('bad_request', 'The AI returned a private reference that could not be matched back to your data. Try the review again. The previous review is unchanged.', 400);
          }
        }
        const claims: MailWorkClaim[] = sourcePlan ? sourcePlan.items.map(item => ({ kind: item.kind, basis: item.basis === 'source' ? 'email' : item.basis,
          text: item.text, evidence: item.source_ids.filter(id => sourceMap.has(id)).map(id => sourceMap.get(id)!) })) : [];
        for (const claim of sourcePlan ? [] : groundLinkedMailWorkClaims((parsed as { claims: unknown[] }).claims, quoteSources)) {
          if (!isObject(claim) || !MAIL_WORK_CLAIM_KINDS.some(kind => kind === claim.kind)
            || (claim.basis !== 'email' && claim.basis !== 'owner' && claim.basis !== 'inference')) {
            throw new RpcError('bad_request', 'The AI returned a claim with invalid evidence. The previous review is unchanged.', 400,
              undefined, { field: `claims[${claims.length}].kind_or_basis` });
          }
          const basis = claim.basis;
          // A live model can omit an empty list on an inference. That asserts
          // no email evidence; email claims still require an explicit list,
          // and malformed or unknown citations are never repaired or dropped.
          const sources = claim.sources === undefined && basis !== 'email' ? [] : claim.sources;
          if (!Array.isArray(sources) || sources.length > 12 || sources.some(token => typeof token !== 'string' || !sourceMap.has(token))) {
            throw new RpcError('bad_request', 'The AI returned a claim with invalid evidence. The previous review is unchanged.', 400,
              undefined, { field: `claims[${claims.length}].sources` });
          }
          if ((basis === 'email' && !sources.length)
            || (basis === 'owner' && (sources.length > 0 || (!stored.work.goal && !stored.work.owner_notes && !stored.work.resolution_note)))) {
            throw new RpcError('bad_request', 'The AI returned an unsupported claim. The previous review is unchanged.', 400,
              undefined, { field: `claims[${claims.length}].basis_sources` });
          }
          let text = typeof claim.text === 'string' && claim.text.length <= 1200 ? claim.text.trim() : '';
          if (!text) unusable('a statement that was empty, too long or unreadable', `claims[${claims.length}].text`);
          const declaredSources = new Set(sources as string[]);
          if (claim.kind === 'next_action') {
            const rendered = renderMailWorkAction(claim.action, text, stored.work.owner_notes, new Set(sourceMap.keys()));
            text = rendered.text;
            for (const source of rendered.sources) declaredSources.add(source);
          }
          // Suggested actions and stopping points are proposals, even when
          // derived from an email or owner goal. They cannot speak for the owner.
          claims.push({ kind: claim.kind as MailWorkClaim['kind'], basis: claim.kind === 'completion_condition' || claim.kind === 'next_action' ? 'inference' : basis, text,
            evidence: [...declaredSources].map(token => sourceMap.get(token)!) });
        }
        if (!claims.length) throw new RpcError('bad_request', 'The AI returned an empty review. Try again with more context.', 400);
        // A blank suggestion carries nothing, so it is dropped; any other unusable one rejects the review.
        const queries = (!sourcePlan && isObject(parsed) && Array.isArray(parsed.search_queries) ? parsed.search_queries : [])
          .map((value: unknown, index: number) => ({ value, index }))
          .filter(({ value }) => typeof value !== 'string' || value.trim() !== '')
          .slice(0, 3)
          .map(({ value, index }) => typeof value === 'string' && value.length <= 240 ? value.trim()
            : unusable('a suggested search that was too long or unreadable', `search_queries[${index}]`));
        const current = await requireWork(stored.work.id);
        if (current.work.revision !== expected || snapshot(current.work).fingerprint !== before.fingerprint) mailWorkConflict();
        const work: MailWork = { ...stored.work, revision: expected + 1, updated_at: now(), reviewed_fingerprint: before.fingerprint,
          brief: { claims, search_queries: queries, warnings, reviewed_at: now() } };
        const next: StoredMailWork = { ...stored, work,
          reviewed_sources: Object.fromEntries(before.sources.map(source => [keyOf(source.ref), source.hash])) };
        await deps.store.put(next, expected, () => { if (snapshot(work).fingerprint !== before.fingerprint) mailWorkConflict(); });
        return detail(next);
      } finally { reviewing.delete(stored.work.id); }
    },
  };
};
export type MailWorkService = ReturnType<typeof createMailWorkService>;
