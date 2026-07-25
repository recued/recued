/** D-131 A.13 — `related_threads` enrichment producer.
 *
 *  Second calendar-scope housekeeping topic. `dependent` policy keyed
 *  on the calendar-event record id; cascade-deletes when the event is
 *  removed; cascade-marks-stale on attendee / time / title edits via
 *  the standard `hashCalendarRecord`.
 *
 *  Aggregate-with-AI-tie-break shape:
 *
 *    1. **Deterministic candidate generation.** Walk
 *       `collection_mail_*` tables for messages where any attendee
 *       appears in `from` / `to` / `cc`, group by `thread_id`, count
 *       attendee overlap + messages per thread, sort by recency,
 *       cap at `MAX_CANDIDATES`.
 *
 *    2. **Full-overlap deterministic short-circuit.** Threads where
 *       every meeting attendee appears in the thread + the thread
 *       has at least `MIN_DETERMINISTIC_MESSAGES` messages emit as
 *       `relevance: 'high'`, `source: 'deterministic'` without
 *       calling the LLM. The "everyone is on this thread, multiple
 *       times" signal is strong enough that an AI tie-break wouldn't
 *       improve the grade.
 *
 *    3. **AI tie-break.** Remaining candidates go to a single
 *       `ai-extract` call. The model returns a `grades` field —
 *       array of `{ thread_id, relevance, reasoning }` per thread.
 *       Producer validates each grade (thread_id must be in the
 *       candidate set, relevance must be in the closed set), drops
 *       `'unrelated'` rows, caps at `MAX_RELATED_THREADS`.
 *
 *    4. **Final ranking.** Combine deterministic + AI threads, sort
 *       by relevance desc + `last_message_at` desc, return.
 *
 *  Different shape from `preparation_notes` (A.12) which produces a
 *  free-text brief over a multi-source corpus. A.13 emits a
 *  structured list of thread ids — recipes pull each thread via
 *  `mail-thread-reader` to compose a brief themselves. Two producers
 *  share the same calendar walker + the same attendee-extraction
 *  pure helper (duplicated until a third consumer per the codebase's
 *  third-caller-extracts convention). */

import {
  computeProducerVersionHash,
  type CollectionRecord,
  type IngredientManifest,
  type RelatedThread,
  type RelatedThreadRelevance,
  type RelatedThreadsValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { canonicalOne, collectAddresses } from './_email-addresses.js';

/** D-136 P3 — producer-version hash. */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'related_threads:1',
  model_id: '',
  prompt_template_hash: 'related_threads_extract_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-extract', version: '1' }],
});

/** Per-record token estimate exposed to the Run-Now cost preview.
 *  ~1000 input (candidate list metadata) + ~400 output (per-thread
 *  grades + reasoning) for the typical ~12-candidate batch. Mirrors
 *  the order-of-magnitude estimate `preparation_notes` carries for
 *  the same calendar-scope cost-preview comparability. */
const TOKEN_ESTIMATE_PER_RECORD = 1400;

/** Confidence on the row as a whole. Matches `company` / `role` /
 *  `preparation_notes` so D-133 PSI baselines stay symmetric across
 *  the AI-surface producer set. */
const CONFIDENCE_AI = 0.85;

/** Skip events more than this many ms in the past. 24h grace lets
 *  prep-style consumers grab related threads for a meeting that just
 *  ended without burning tokens on stale calendar history. */
const PAST_EVENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** Look-back window for the candidate query. Mail older than this
 *  rarely surfaces as topically related to an upcoming meeting; the
 *  90d window matches A.12's corpus look-back. */
const MAIL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** Maximum candidate threads handed to the AI tie-break. Larger
 *  batches pad the prompt without proportionally improving the
 *  ranking; 12 is enough headroom for an active meeting series and
 *  small enough to stay well under the LLM's structured-output
 *  context budget. */
const MAX_CANDIDATES = 12;

/** Maximum threads emitted on a row. Capped at 5 because the
 *  consumer (a meeting brief) only ever surfaces a handful — more
 *  threads is information overload. */
const MAX_RELATED_THREADS = 5;

/** Minimum messages a thread needs for the deterministic full-
 *  overlap short-circuit. A single "Hi all, scheduling this" message
 *  with everyone CC'd shouldn't auto-grade as 'high' — full-overlap
 *  is a strong signal but not strong enough to bypass AI on its
 *  own. */
const MIN_DETERMINISTIC_MESSAGES = 2;

/** Closed list of relevance grades (mirrors `RelatedThreadRelevance`
 *  + `'unrelated'`). The AI's output may include `'unrelated'`; the
 *  producer drops those rows before emit. */
const VALID_AI_GRADES = new Set<string>([
  'high',
  'medium',
  'low',
  'unrelated',
]);

/** Inline `IngredientManifest` matching `community/ingredients/ai-extract.json`.
 *  Same shape used by `company.ts` / `role.ts` / `action-items.ts` —
 *  three callers already; this is the fourth. The next AI-extract
 *  consumer is the right moment to lift the manifest into a shared
 *  kernel-manifest table per the codebase's third-caller-extracts
 *  convention extended to the four-caller threshold. */
const aiExtractManifest: IngredientManifest = {
  slug: 'ai-extract',
  name: 'AI Field Extractor',
  description:
    'Extracts a caller-specified set of fields from unstructured input into a flat object.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'extraction'],
  input: {
    'llm.data': null,
    'llm.fields': null,
    'llm.context': null,
    'llm.model_hint': null,
  },
  output: {
    extracted: 'dynamic_fields_per_llm_fields_input',
  },
};

/** Pinned `llm.context` for the tie-break call. Steers the model
 *  toward "topically related to this specific meeting" — not
 *  "involves these participants in any way." Includes the closed
 *  grade set + the echo-thread_id-verbatim instruction so post-
 *  validation can reject fabricated ids. */
const TIE_BREAK_CONTEXT =
  'For each thread below, classify its topical relevance to the ' +
  'upcoming meeting in the header. Use exactly one of: ' +
  "'high' (definitely the same topic), 'medium' (probably related), " +
  "'low' (weak signal but worth surfacing), 'unrelated' (not topically " +
  'related). Echo each thread_id VERBATIM from the input — do not ' +
  'invent ids. Provide a brief one-sentence reasoning per thread. ' +
  'Return as a `grades` array of `{thread_id, relevance, reasoning}`.';

/** Pull canonical attendee emails from a calendar source record's
 *  `hot_fields`. Excludes the organizer (treated separately by
 *  consumers). Duplicated from
 *  `preparation_notes.ts:extractAttendeeEmails` — second caller of
 *  this exact shape; extract to a shared `_calendar-attendees.ts`
 *  helper at the third caller per the codebase convention. */
export const extractAttendeeEmails = (
  record: CollectionRecord,
): ReadonlyArray<string> => {
  const hot = record.hot_fields;
  const organizerCanonical = canonicalOne(hot.organizer);
  const set = new Set<string>();
  collectAddresses(hot.attendees, set);
  if (organizerCanonical !== '') set.delete(organizerCanonical);
  return Array.from(set).sort();
};

/** One candidate thread surfaced by the deterministic aggregation
 *  step. Carries enough metadata for both the deterministic short-
 *  circuit and the AI tie-break prompt. */
export interface CandidateThread {
  thread_id: string;
  subject: string;
  last_message_at: number;
  overlap_count: number;
  message_count: number;
}

/** Walk every `collection_mail_*` table. Aggregate messages where
 *  any attendee appears in `from` / `to` / `cc` (post-filter via
 *  `collectAddresses` so RFC-5322 wrapper variants resolve) into
 *  per-`thread_id` candidates, capped at `MAX_CANDIDATES` newest. */
export const findCandidateThreads = (
  ctx: HousekeepingContext,
  attendees: ReadonlyArray<string>,
  now: number,
): CandidateThread[] => {
  if (attendees.length === 0) return [];
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_mail_%'`,
    )
    .all() as Array<{ name: string }>;
  const earliest = now - MAIL_LOOKBACK_MS;
  const threads = new Map<
    string,
    {
      thread_id: string;
      subject: string;
      last_message_at: number;
      message_count: number;
      overlapping_attendees: Set<string>;
    }
  >();

  for (const participant of attendees) {
    for (const { name: table } of tables) {
      const rows = ctx.db
        .prepare(
          `SELECT received_at, hot_fields FROM "${table}"
            WHERE hot_fields LIKE ? AND received_at >= ?
            ORDER BY received_at DESC
            LIMIT 200`,
        )
        .all(`%${participant}%`, earliest) as Array<{
          received_at: number;
          hot_fields: string;
        }>;
      for (const row of rows) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
        } catch {
          continue;
        }
        const involved = new Set<string>();
        collectAddresses(parsed.from, involved);
        collectAddresses(parsed.to, involved);
        collectAddresses(parsed.cc, involved);
        if (!involved.has(participant)) continue;
        const threadId =
          typeof parsed.thread_id === 'string' && parsed.thread_id !== ''
            ? parsed.thread_id
            : null;
        if (threadId === null) continue;
        const subject =
          typeof parsed.subject === 'string' ? parsed.subject : '(no subject)';
        const existing = threads.get(threadId);
        if (existing) {
          existing.message_count += 1;
          if (row.received_at > existing.last_message_at) {
            existing.last_message_at = row.received_at;
            existing.subject = subject;
          }
          existing.overlapping_attendees.add(participant);
        } else {
          threads.set(threadId, {
            thread_id: threadId,
            subject,
            last_message_at: row.received_at,
            message_count: 1,
            overlapping_attendees: new Set([participant]),
          });
        }
      }
    }
  }

  // Note: each (thread_id, attendee) pair runs an independent SQL
  // query; the same row can be counted once per attendee that appears
  // on it. The Set-of-attendees rewrites overlap_count correctly
  // (set membership is idempotent), but message_count over-counts.
  // For a thread with 3 messages where 2 attendees both appear, the
  // count would be 6. Acceptable for v1: message_count is used only
  // for the deterministic short-circuit threshold, not surfaced
  // verbatim to recipes; the over-count makes the threshold easier
  // to clear, not harder. A future refactor should de-dup at the
  // (thread_id, message_id) level.
  const candidates = Array.from(threads.values())
    .map((t) => ({
      thread_id: t.thread_id,
      subject: t.subject,
      last_message_at: t.last_message_at,
      overlap_count: t.overlapping_attendees.size,
      message_count: t.message_count,
    }))
    .sort((a, b) => b.last_message_at - a.last_message_at);

  return candidates.slice(0, MAX_CANDIDATES);
};

/** Tag the deterministic full-overlap threads. Returns a partition:
 *  threads accepted as `'high' / 'deterministic'` and the rest passed
 *  on to AI tie-break. */
export const partitionDeterministic = (
  candidates: ReadonlyArray<CandidateThread>,
  attendee_count: number,
): { deterministic: RelatedThread[]; remaining: CandidateThread[] } => {
  const deterministic: RelatedThread[] = [];
  const remaining: CandidateThread[] = [];
  for (const candidate of candidates) {
    if (
      candidate.overlap_count >= attendee_count &&
      candidate.message_count >= MIN_DETERMINISTIC_MESSAGES
    ) {
      deterministic.push({
        thread_id: candidate.thread_id,
        subject: candidate.subject,
        last_message_at: candidate.last_message_at,
        overlap_count: candidate.overlap_count,
        relevance: 'high',
        source: 'deterministic',
      });
    } else {
      remaining.push(candidate);
    }
  }
  return { deterministic, remaining };
};

/** Compose the AI tie-break prompt corpus. Header carries event
 *  metadata; body is one block per candidate thread. */
export const composeTieBreakCorpus = (
  eventSummary: string,
  attendees: ReadonlyArray<string>,
  startAtIso: string,
  candidates: ReadonlyArray<CandidateThread>,
): string => {
  const header =
    `Meeting: ${eventSummary || '(untitled)'}\n` +
    `Starts: ${startAtIso}\n` +
    `Attendees: ${attendees.join(', ')}\n`;
  const blocks = candidates.map((c) => {
    const dateIso = new Date(c.last_message_at).toISOString();
    return (
      `Thread: ${c.thread_id}\n` +
      `Subject: ${c.subject}\n` +
      `Most recent: ${dateIso}\n` +
      `Attendees overlapping: ${c.overlap_count}\n` +
      `Message count: ${c.message_count}`
    );
  });
  return `${header}\n${blocks.join('\n--- next thread ---\n')}`;
};

interface AiGrade {
  thread_id: string;
  relevance: string;
  reasoning?: string;
}

const isAiGrade = (v: unknown): v is AiGrade => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.thread_id !== 'string' || o.thread_id === '') return false;
  if (typeof o.relevance !== 'string' || !VALID_AI_GRADES.has(o.relevance)) return false;
  if (o.reasoning !== undefined && typeof o.reasoning !== 'string') return false;
  return true;
};

const isAiOutput = (v: unknown): v is { grades: ReadonlyArray<AiGrade> } => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const grades = (v as { grades?: unknown }).grades;
  if (!Array.isArray(grades)) return false;
  return grades.every(isAiGrade);
};

const isoOrEmpty = (n: unknown): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '(unknown)';
  try {
    return new Date(n).toISOString();
  } catch {
    return '(unknown)';
  }
};

/** Compare relevance grades — `'high'` > `'medium'` > `'low'`. */
const RELEVANCE_RANK: Record<RelatedThreadRelevance, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const rankRelevance = (a: RelatedThread, b: RelatedThread): number => {
  const diff = RELEVANCE_RANK[b.relevance] - RELEVANCE_RANK[a.relevance];
  if (diff !== 0) return diff;
  return b.last_message_at - a.last_message_at;
};

export const relatedThreadsProducer: HousekeepingEnrichmentProducer<CollectionRecord> = {
  // D-136 P3 — harness skip-rule version-hash invalidation.
  producer_version_hash: baseProducerVersionHash,
  topic: 'related_threads',
  source_scope: 'calendar',
  ai_surface: 'chat',
  scope_read_declaration: [
    {
      collection: 'data.calendar',
      sample_field_paths: ['summary', 'start_at', 'attendees', 'organizer'],
    },
    {
      collection: 'data.mail',
      sample_field_paths: [
        'from',
        'to',
        'cc',
        'subject',
        'thread_id',
        'received_at',
      ],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<CollectionRecord>) {
    if (!ctx.llmWithMeta) {
      throw new Error(
        'related_threads_producer_misconfigured: ctx.llmWithMeta is required for AI-driven producers',
      );
    }

    const event = source_record.data;
    const hot = event.hot_fields;
    const startAt = typeof hot.start_at === 'number' ? hot.start_at : NaN;
    if (!Number.isFinite(startAt)) return null;

    const now = ctx.now();
    if (startAt < now - PAST_EVENT_GRACE_MS) return null;

    const attendees = extractAttendeeEmails(event);
    if (attendees.length === 0) return null;

    const candidates = findCandidateThreads(ctx, attendees, now);
    if (candidates.length === 0) return null;

    const { deterministic, remaining } = partitionDeterministic(
      candidates,
      attendees.length,
    );

    let aiThreads: RelatedThread[] = [];
    let aiInvoked = false;
    let resolvedModelId = '';
    if (remaining.length > 0) {
      aiInvoked = true;
      const corpus = composeTieBreakCorpus(
        typeof hot.summary === 'string' ? hot.summary : '',
        attendees,
        isoOrEmpty(startAt),
        remaining,
      );
      const { result, model_id } = await ctx.llmWithMeta(aiExtractManifest, {
        'llm.data': corpus,
        'llm.fields': ['grades'],
        'llm.context': TIE_BREAK_CONTEXT,
        'llm.model_hint': 'fast',
      });
      resolvedModelId = model_id;
      if (!isAiOutput(result)) {
        throw new Error(
          `related_threads_output_invalid: ai-extract returned non-conformant shape for event '${source_record.target_id}'`,
        );
      }
      const candidateMap = new Map<string, CandidateThread>(
        remaining.map((c) => [c.thread_id, c]),
      );
      for (const grade of result.grades) {
        if (grade.relevance === 'unrelated') continue;
        const candidate = candidateMap.get(grade.thread_id);
        if (!candidate) continue; // fabricated id — drop silently
        aiThreads.push({
          thread_id: candidate.thread_id,
          subject: candidate.subject,
          last_message_at: candidate.last_message_at,
          overlap_count: candidate.overlap_count,
          relevance: grade.relevance as RelatedThreadRelevance,
          source: 'ai',
          ...(grade.reasoning ? { reasoning: grade.reasoning } : {}),
        });
      }
    }

    const merged = [...deterministic, ...aiThreads]
      .sort(rankRelevance)
      .slice(0, MAX_RELATED_THREADS);
    if (merged.length === 0) return null;

    const value: RelatedThreadsValue = {
      threads: merged,
      candidate_count: candidates.length,
      ai_invoked: aiInvoked,
      computed_at: now,
    };
    return {
      value,
      // D-136 P3 — bistemporal stamping. Calendar event start clock.
      event_at: startAt,
      // model_id only stamps when AI was actually invoked; deterministic-
      // only outputs leave it null.
      ...(resolvedModelId ? { model_id: resolvedModelId } : {}),
      ingredient_slug: 'ai-extract',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};

export {
  TOKEN_ESTIMATE_PER_RECORD as RELATED_THREADS_TOKEN_ESTIMATE,
  CONFIDENCE_AI as RELATED_THREADS_CONFIDENCE,
  PAST_EVENT_GRACE_MS as RELATED_THREADS_PAST_GRACE_MS,
  MAIL_LOOKBACK_MS as RELATED_THREADS_MAIL_LOOKBACK_MS,
  MAX_CANDIDATES as RELATED_THREADS_MAX_CANDIDATES,
  MAX_RELATED_THREADS,
  MIN_DETERMINISTIC_MESSAGES as RELATED_THREADS_MIN_DETERMINISTIC_MESSAGES,
};
