/** D-131 A.12 — `preparation_notes` enrichment producer.
 *
 *  First calendar-scope AI producer + first multi-source-corpus
 *  housekeeping producer. `dependent` policy keyed on the
 *  calendar-event record id; cascade-deletes when the event is
 *  removed; cascade-marks-stale on attendee / time / title edits via
 *  the standard `hashCalendarRecord` source-record hash.
 *
 *  Distinct from the mail-scope ai-summarize triad (`summary` /
 *  `purpose` / `action_items`) in two ways:
 *
 *    1. **Multi-source corpus.** The producer assembles a small mail
 *       corpus by querying `collection_mail_*` for rows whose
 *       `from` / `to` / `cc` mention any event attendee, then folds
 *       the latest few snippets per participant into a structured
 *       prompt context. Mail accumulating between two cycles does
 *       NOT flip the calendar walker hash by design — Run-Now is
 *       the refresh signal until a future per-record TTL knob lands.
 *
 *    2. **Past-event skip + future-event accept.** Events more than
 *       24h in the past return null (no prep value for elapsed
 *       events; running the LLM on them is pure cost). Future events
 *       are computed as the walker visits them; recipes filter
 *       `start_at` to the window they care about (e.g. "events in
 *       the next 7 days").
 *
 *  Mirrors the AI-producer contract:
 *    - Positive `estimate_per_record_tokens()` + `ai_surface: 'chat'`
 *      flips the harness's AI-surface gate; D-132 trust state defaults
 *      to `'manual'` (registry); pool policy `'free_only'`.
 *    - LLM resolution failure throws; harness counts via per-task
 *      error counter.
 *    - `emits_confidence: true` on the registry → D-133 PSI covers
 *      drift detection once 100 baseline samples accumulate.
 *
 *  `findRecentMailForParticipants` is a new shape (multi-email,
 *  multi-direction inbox query) distinct from `company` / `role`'s
 *  `findRecentInboundBody` (single-sender, sender-only filter); kept
 *  local to this producer until a second consumer ships per the
 *  codebase's third-caller-extracts convention. */

import {
  computeProducerVersionHash,
  type CollectionRecord,
  type IngredientManifest,
  type PreparationNotesValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import {
  composeEnrichmentPath,
  hashEnrichmentResult,
  hashLlmInput,
  parseEnrichmentPath,
} from '../llm-result-cache-store.js';
import { canonicalOne, collectAddresses } from './_email-addresses.js';
import { truncateForLlm } from './_mail-body.js';
import { listCollectionDataTables } from '../../collections/table.js';

/** D-136 P3 — producer-version hash. */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'preparation_notes:1',
  model_id: '',
  prompt_template_hash: 'preparation_notes_summarize_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-summarize', version: '1' }],
});

/** Minimum total characters across the assembled corpus. Below this
 *  the mail signal is too thin for prep notes — running the LLM on a
 *  one-line "thanks" message produces noise. */
const MIN_CORPUS_CHARS = 200;

/** Per-record token estimate exposed to the Run-Now cost preview.
 *  ~1200 input + ~250 output for a typical multi-attendee corpus.
 *  Higher than `summary` because the corpus packs N mail snippets
 *  rather than one body. */
const TOKEN_ESTIMATE_PER_RECORD = 1500;

/** Confidence for AI-summarised prep notes. Aligns with `company` /
 *  `role` so D-133 PSI baselines stay symmetric across the AI
 *  signature-parse + ai-summarize producer set. */
const CONFIDENCE_AI = 0.85;

/** Skip events whose `start_at` is more than this many ms in the
 *  past. 24h gives the user breathing room to grab prep notes for a
 *  meeting that just ended (post-mortem / follow-up drafting) without
 *  burning tokens on stale calendar history. */
const PAST_EVENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** Per-participant mail snippet cap. Big threads can have hundreds of
 *  messages from one person; capping per-participant keeps the corpus
 *  balanced across attendees instead of being dominated by one
 *  prolific sender. */
const MAX_SNIPPETS_PER_PARTICIPANT = 3;

/** Maximum body characters per mail snippet. Caps individual snippet
 *  size so a single long email doesn't push the corpus over the LLM
 *  truncation threshold before other participants' signal is folded
 *  in. */
const MAX_CHARS_PER_SNIPPET = 2_000;

/** Look-back window for the corpus query — mail older than this is
 *  unlikely to be relevant prep context. 90 days covers most quarter-
 *  scoped projects + ongoing relationships without dragging stale
 *  threads into the prompt. */
const MAIL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** Inline `IngredientManifest` matching `community/ingredients/ai-summarize.json`.
 *  Same shape `summary.ts` uses; kept local rather than importing across
 *  producers to keep the producer file self-contained. The third caller
 *  (us) is below the four-caller threshold for shared extraction; if a
 *  fourth AI-summarize consumer ships we'll lift the manifest into a
 *  shared kernel-manifest table. */
const aiSummarizeManifest: IngredientManifest = {
  slug: 'ai-summarize',
  name: 'AI Summarizer',
  description:
    'Produces a short summary and extracted key points from long-form text.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'summarization'],
  input: {
    'llm.data': null,
    'llm.max_length': null,
    'llm.focus': null,
    'llm.model_hint': null,
  },
  output: {
    summary: 'summary',
    key_points: 'key_points',
  },
};

/** Focus prompt pinned to `llm.focus`. Steers the summariser toward
 *  meeting-prep semantics (context per participant, prior decisions,
 *  open questions, talking points) rather than a generic abstract. */
const PREP_FOCUS =
  'Distill prep notes for an upcoming meeting. Surface key context per ' +
  'participant, prior decisions or asks already on the table, open ' +
  'questions worth raising, and one or two suggested talking points. ' +
  "Be concrete — name people, decisions, and dates from the corpus; don't " +
  'paraphrase generically.';

interface AiSummarizeOutput {
  summary: string;
  key_points: ReadonlyArray<string>;
}

const isSummarizeOutput = (value: unknown): value is AiSummarizeOutput =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AiSummarizeOutput).summary === 'string' &&
  Array.isArray((value as AiSummarizeOutput).key_points) &&
  (value as AiSummarizeOutput).key_points.every((p) => typeof p === 'string');

/** Pull canonical attendee emails from a calendar source record's
 *  `hot_fields`. Excludes the organizer (treated separately) so the
 *  "no attendees beyond organizer" filter is honest. The walker
 *  populates `hot_fields.attendees` with the canonical event's
 *  attendees array, which is either `string[]` or `{email, ...}[]`
 *  depending on the calendar adapter. */
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

interface MailSnippet {
  participant: string;
  from: string;
  subject: string;
  received_at: number;
  body: string;
}

/** Trim + cap a single mail body for inclusion in the prep corpus.
 *  Strips leading whitespace, collapses runs of blank lines, hard-caps
 *  at `MAX_CHARS_PER_SNIPPET`. */
const normaliseSnippet = (body: string): string => {
  const collapsed = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (collapsed.length <= MAX_CHARS_PER_SNIPPET) return collapsed;
  return collapsed.slice(0, MAX_CHARS_PER_SNIPPET);
};

/** Find recent mail for each participant. Walks every
 *  `collection_mail_*` table on the per-pair SQLite DB, JSON-LIKE
 *  pre-narrows by participant email, then post-filters for an actual
 *  email match in `from` / `to` / `cc` (via `collectAddresses` so the
 *  RFC-5322 wrapper variants resolve). Up to
 *  `MAX_SNIPPETS_PER_PARTICIPANT` newest rows per participant; rows
 *  older than `MAIL_LOOKBACK_MS` are skipped at the SQL level. */
const findRecentMailForParticipants = async (
  ctx: HousekeepingContext,
  participants: ReadonlyArray<string>,
  now: number,
): Promise<MailSnippet[]> => {
  if (participants.length === 0 || !ctx.blobs) return [];
  const tables = listCollectionDataTables(ctx.db, 'mail');
  const earliest = now - MAIL_LOOKBACK_MS;
  const snippets: MailSnippet[] = [];
  for (const participant of participants) {
    const perParticipant: Array<{
      received_at: number;
      hot_fields: string;
      body_inline: string | null;
      blob_hash: string | null;
    }> = [];
    for (const table of tables) {
      const rows = ctx.db
        .prepare(
          `SELECT received_at, hot_fields, body_inline, blob_hash FROM "${table}"
            WHERE hot_fields LIKE ? AND received_at >= ?
            ORDER BY received_at DESC
            LIMIT 50`,
        )
        .all(`%${participant}%`, earliest) as Array<{
          received_at: number;
          hot_fields: string;
          body_inline: string | null;
          blob_hash: string | null;
        }>;
      for (const row of rows) perParticipant.push(row);
    }
    perParticipant.sort((a, b) => b.received_at - a.received_at);
    let kept = 0;
    for (const row of perParticipant) {
      if (kept >= MAX_SNIPPETS_PER_PARTICIPANT) break;
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
      const hasInline =
        typeof row.body_inline === 'string' && row.body_inline.length > 0;
      const hasBlob =
        typeof row.blob_hash === 'string' && row.blob_hash.length > 0;
      if (!hasInline && !hasBlob) continue;
      let body: string | null = null;
      if (hasInline) {
        body = row.body_inline as string;
      } else if (hasBlob) {
        const buf = await ctx.blobs.get(row.blob_hash as string);
        if (buf === null) continue;
        body = buf.toString('utf8');
      }
      if (body === null) continue;
      const trimmed = normaliseSnippet(body);
      if (trimmed.length === 0) continue;
      const fromCanonical = canonicalOne(parsed.from);
      const subject =
        typeof parsed.subject === 'string' ? parsed.subject : '(no subject)';
      snippets.push({
        participant,
        from: fromCanonical || String(parsed.from ?? ''),
        subject,
        received_at: row.received_at,
        body: trimmed,
      });
      kept += 1;
    }
  }
  return snippets;
};

/** Compose the corpus string fed to `ai-summarize`. Header carries
 *  event metadata; body groups snippets by participant in the order
 *  the producer received them. Section dividers are explicit so the
 *  LLM can attribute each fragment correctly when extracting key
 *  points. */
export const composeCorpus = (
  eventSummary: string,
  attendees: ReadonlyArray<string>,
  startAtIso: string,
  snippets: ReadonlyArray<MailSnippet>,
): string => {
  const header =
    `Meeting: ${eventSummary || '(untitled)'}\n` +
    `Starts: ${startAtIso}\n` +
    `Attendees: ${attendees.join(', ')}\n`;
  const grouped = new Map<string, MailSnippet[]>();
  for (const snip of snippets) {
    const list = grouped.get(snip.participant) ?? [];
    list.push(snip);
    grouped.set(snip.participant, list);
  }
  const sections: string[] = [];
  for (const participant of attendees) {
    const list = grouped.get(participant);
    if (!list || list.length === 0) continue;
    const block = list
      .map((s) => {
        const dateIso = new Date(s.received_at).toISOString();
        return (
          `From: ${s.from}\n` +
          `Subject: ${s.subject}\n` +
          `Date: ${dateIso}\n\n` +
          `${s.body}`
        );
      })
      .join('\n\n--- next message ---\n\n');
    sections.push(`# Recent mail involving ${participant}\n\n${block}`);
  }
  return `${header}\n${sections.join('\n\n===\n\n')}`;
};

const isoOrEmpty = (n: unknown): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '(unknown)';
  try {
    return new Date(n).toISOString();
  } catch {
    return '(unknown)';
  }
};

export const preparationNotesProducer: HousekeepingEnrichmentProducer<CollectionRecord> = {
  // D-136 P3 — harness skip-rule version-hash invalidation.
  producer_version_hash: baseProducerVersionHash,
  topic: 'preparation_notes',
  source_scope: 'calendar',
  ai_surface: 'chat',
  scope_read_declaration: [
    {
      collection: 'data.calendar',
      sample_field_paths: [
        'summary',
        'start_at',
        'attendees',
        'organizer',
        'location',
      ],
    },
    {
      collection: 'data.mail',
      sample_field_paths: [
        'from',
        'to',
        'cc',
        'subject',
        'received_at',
        'body_inline',
      ],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<CollectionRecord>) {
    if (!ctx.llmWithMeta) {
      throw new Error(
        'preparation_notes_producer_misconfigured: ctx.llmWithMeta is required for AI-driven producers',
      );
    }
    if (!ctx.blobs) {
      throw new Error(
        'preparation_notes_producer_misconfigured: ctx.blobs is required for body resolution',
      );
    }

    const event = source_record.data;
    const hot = event.hot_fields;
    const startAt = typeof hot.start_at === 'number' ? hot.start_at : NaN;
    if (!Number.isFinite(startAt)) return null;

    const now = ctx.now();
    if (startAt < now - PAST_EVENT_GRACE_MS) {
      // Past event beyond the 24h grace — no prep value, skip.
      return null;
    }

    const attendees = extractAttendeeEmails(event);
    if (attendees.length === 0) {
      // No collaborators — nothing to prep against.
      return null;
    }

    const snippets = await findRecentMailForParticipants(ctx, attendees, now);
    const corpus = composeCorpus(
      typeof hot.summary === 'string' ? hot.summary : '',
      attendees,
      isoOrEmpty(startAt),
      snippets,
    );
    if (corpus.length < MIN_CORPUS_CHARS || snippets.length === 0) {
      // Either no participant mail at all, or what we found summed to
      // too little signal to drive a useful summary.
      return null;
    }

    const truncated = truncateForLlm(corpus);
    const input = {
      'llm.data': truncated,
      'llm.max_length': 250,
      'llm.focus': PREP_FOCUS,
      'llm.model_hint': 'fast',
    };

    // D-145 § A.7.10 (PA9.7b) — content-addressed cache. The prep-
    // notes corpus encodes start_at + summary + attendees + the mail
    // snippet bytes, so identical inputs are rare in practice (most
    // events have distinct start times). The wiring is still correct
    // for the duplicate-event / recurring-meeting edge cases where
    // two calendar rows share an identical assembled corpus.
    const inputHash = ctx.llmResultCache ? hashLlmInput(input) : undefined;
    if (ctx.llmResultCache && inputHash !== undefined) {
      const cached = readCachedPreparationNotes(ctx, inputHash);
      if (cached !== null) {
        ctx.llmResultCache.incrementHitCount(inputHash);
        return {
          value: cached.value,
          sidecar_text: cached.value.summary,
          event_at: startAt,
          model_id: cached.model_id,
          ingredient_slug: 'ai-summarize',
          producer_version_hash: cached.producer_version_hash,
        };
      }
    }

    const { result, model_id } = await ctx.llmWithMeta(aiSummarizeManifest, input);
    if (!isSummarizeOutput(result)) {
      throw new Error(
        `preparation_notes_output_invalid: ai-summarize returned non-conformant shape for event '${source_record.target_id}'`,
      );
    }

    const value: PreparationNotesValue = {
      summary: result.summary,
      key_points: result.key_points,
      attendees_considered: attendees,
      corpus_size: truncated.length,
      computed_at: now,
    };

    if (ctx.llmResultCache && inputHash !== undefined) {
      ctx.llmResultCache.insertOrIgnore({
        input_hash: inputHash,
        result_hash: hashEnrichmentResult(value),
        result_path: composeEnrichmentPath({
          topic: 'preparation_notes',
          scope: 'calendar',
          target_id: source_record.target_id,
        }),
        computed_at: ctx.now(),
      });
    }

    return {
      value,
      sidecar_text: result.summary,
      // D-136 P3 — bistemporal stamping. Calendar events anchor on
      // their `start_at` (the meeting's real-world clock); the prep
      // notes are forward-looking but anchored on when the meeting
      // happens, NOT producer compute time. ttl_days=30 lifecycle
      // (registry) still trims old rows post-event.
      event_at: startAt,
      model_id,
      ingredient_slug: 'ai-summarize',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};

/** D-145 § A.7.10 (PA9.7b) — resolve a cached preparation_notes value
 *  by input hash. Same self-healing semantics as the sibling body-only
 *  producers — lazy-delete on dangling pointer / hash drift / schema
 *  drift on the cached row. */
const readCachedPreparationNotes = (
  ctx: HousekeepingContext,
  inputHash: string,
): {
  value: PreparationNotesValue;
  model_id: string;
  producer_version_hash: string;
} | null => {
  if (!ctx.llmResultCache) return null;
  const entry = ctx.llmResultCache.lookup(inputHash);
  if (!entry) return null;
  const parsed = parseEnrichmentPath(entry.result_path);
  if (!parsed || parsed.kind !== 'shape_a') {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  const rows = ctx.enrichmentStore.list({
    topic: parsed.topic,
    scope: parsed.scope,
    target_id: parsed.target_id,
    fresh_only: true,
    limit: 1,
  });
  const row = rows[0];
  if (!row || row.value === null || row.value === undefined) {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  if (hashEnrichmentResult(row.value) !== entry.result_hash) {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  if (!isPreparationNotesValue(row.value)) {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  return {
    value: row.value,
    model_id: row.model_id ?? '',
    producer_version_hash: row.producer_version_hash ?? baseProducerVersionHash,
  };
};

const isPreparationNotesValue = (value: unknown): value is PreparationNotesValue => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<PreparationNotesValue>;
  return (
    typeof v.summary === 'string' &&
    Array.isArray(v.key_points) &&
    v.key_points.every((p) => typeof p === 'string') &&
    Array.isArray(v.attendees_considered) &&
    v.attendees_considered.every((a) => typeof a === 'string') &&
    typeof v.corpus_size === 'number' &&
    typeof v.computed_at === 'number' &&
    (v.attendees_considered_resolved === undefined ||
      (Array.isArray(v.attendees_considered_resolved) &&
        v.attendees_considered_resolved.every(
          (r) =>
            typeof r === 'object' &&
            r !== null &&
            typeof (r as { entity?: unknown }).entity === 'string' &&
            typeof (r as { name?: unknown }).name === 'string',
        )))
  );
};

export {
  MIN_CORPUS_CHARS as PREPARATION_NOTES_MIN_CORPUS_CHARS,
  TOKEN_ESTIMATE_PER_RECORD as PREPARATION_NOTES_TOKEN_ESTIMATE,
  CONFIDENCE_AI as PREPARATION_NOTES_CONFIDENCE,
  PAST_EVENT_GRACE_MS as PREPARATION_NOTES_PAST_GRACE_MS,
  MAX_SNIPPETS_PER_PARTICIPANT as PREPARATION_NOTES_MAX_SNIPPETS_PER_PARTICIPANT,
  MAX_CHARS_PER_SNIPPET as PREPARATION_NOTES_MAX_CHARS_PER_SNIPPET,
  MAIL_LOOKBACK_MS as PREPARATION_NOTES_MAIL_LOOKBACK_MS,
};
