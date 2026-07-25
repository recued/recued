/** D-131 A.11 — `role` enrichment producer.
 *
 *  Second AI signature-parse producer (after A.10 `company`); second
 *  AI-driven contact-scope topic. `dependent` policy keyed on the
 *  contact's canonical email; pure-AI surface — unlike `company`
 *  there's no deterministic signal in the contact record itself, so
 *  the producer returns null when no usable body / no extractable
 *  signature is available (no row written).
 *
 *  Output split into two facets:
 *
 *    1. `title` — free-form string parsed by `ai-extract` from the
 *       signature block.
 *    2. `category` — closed-set bucket derived deterministically from
 *       the title via priority-ordered keyword matching (NOT a second
 *       LLM call). C-suite / VP / founder maps to `executive` first;
 *       function-level titles map to engineering / product / sales /
 *       marketing / operations / support / research; everything else
 *       falls to `other`.
 *
 *  Mirrors the AI-producer contract:
 *    - Positive `estimate_per_record_tokens()` + `ai_surface: 'chat'`
 *      flips the harness's AI-surface gate; D-132 trust state defaults
 *      to `'manual'` (registry); pool policy `'free_only'`.
 *    - Contact source-record hash flips on `last_interaction` /
 *      `interaction_count` change → harness re-derives the next cycle
 *      and picks up the most-recent signature each time.
 *    - LLM resolution failure throws; harness counts via per-task
 *      error counter (D-132 P2's `runProduce` translates pool-mismatch
 *      `AI_LLM_UNAVAILABLE` into a soft yield).
 *    - `emits_confidence: true` on the registry → D-133 PSI covers
 *      drift detection once 100 baseline samples accumulate.
 *
 *  `findRecentInboundBody` is duplicated from `company.ts` per the
 *  codebase's third-caller-extracts convention (one prior caller +
 *  this producer = two; extraction triggers at three). When the
 *  third consumer ships we lift it to a shared `_inbound-mail.ts`
 *  helper alongside `_email-addresses.ts` / `_mail-body.ts`. */

import {
  computeProducerVersionHash,
  type ContactRecord,
  type IngredientManifest,
  ROLE_CATEGORIES,
  type RoleCategory,
  type RoleValue,
} from '@recued/contracts';

/** D-136 P3 — producer-version hash. */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'role:1',
  model_id: '',
  prompt_template_hash: 'role_extract_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-extract', version: '1' }],
});

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { canonicalOne } from './_email-addresses.js';
import {
  contactAddresses,
  likeAnyParams,
  sqlLikeAny,
} from './_contact-addresses.js';
import { truncateForLlm } from './_mail-body.js';

/** Minimum body length for which signature parsing is worth running.
 *  Same floor as `company` — sub-100-char messages rarely carry a
 *  signature block. Below the floor → producer returns null, harness
 *  skips the row. */
const MIN_BODY_CHARS = 100;

/** Per-record token estimate. ~250 (~200 input — body fragment for
 *  signature area + ~50 structured output: short title string).
 *  Matches `company`'s estimate; both producers do the same shape of
 *  ai-extract call. */
const TOKEN_ESTIMATE_PER_RECORD = 250;

/** Cap title length at 100 chars. Longer outputs from the LLM are
 *  almost always hallucinations / run-on sentences; the cap is a
 *  producer-side guard rather than enforcing strict shape on the
 *  permissive `ai-extract` contract. */
const MAX_TITLE_CHARS = 100;

/** Confidence for AI-parsed titles. Same level as `company`'s
 *  signature_parse confidence; both producers ship at the same
 *  graded confidence so D-133 PSI baselines align. */
const CONFIDENCE_SIGNATURE_PARSE = 0.85;

/** Inline `IngredientManifest` matching `community/ingredients/ai-extract.json`.
 *  Same shape `company.ts` + `action-items.ts` use. Once the third
 *  caller ships we'll extract a shared kernel-manifest table. */
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

/** Extraction policy pinned in `llm.context`. Same shape as
 *  `company`'s SIGNATURE_PARSE_CONTEXT — keep the title strictly to
 *  what the signature names, don't infer from the email body's
 *  content (e.g. discussion of an "engineering" project doesn't make
 *  the sender an engineer). */
const SIGNATURE_PARSE_CONTEXT =
  'Look at the email signature block (typically at the end after a "--", ' +
  '"Sent from", "Best", "Regards", or similar closing). Extract only the ' +
  "sender's job title / role as it appears in the signature. Return null " +
  'if no clear title is named in a signature. Do NOT infer a role from ' +
  'the email content, the company name, or the email domain — only return ' +
  'a value when the signature itself names the title.';

/** Priority-ordered category keyword tables. Each entry's `keywords`
 *  list is matched as **whole-word substrings** against a normalised
 *  title (lowercased, non-alphanumerics replaced with spaces, padded
 *  with leading + trailing space). Every keyword therefore carries
 *  its own leading + trailing space — `' ceo '` matches "CEO," and
 *  "Senior CEO" but not "Director" (which would otherwise contain
 *  "cto" as a raw substring).
 *
 *  First match wins across categories, so the priority order is the
 *  decision tree: `executive` beats `engineering` for "CTO";
 *  `executive` beats `sales` for "VP of Sales"; `engineering` beats
 *  `support` for "Support Engineer".
 *
 *  Maintenance: extending a category is a one-line keyword addition.
 *  Always include surrounding spaces. Multi-word keywords use the
 *  natural English word order (`' business development '`, not the
 *  reverse). */
const CATEGORY_KEYWORDS: ReadonlyArray<{
  category: RoleCategory;
  keywords: ReadonlyArray<string>;
}> = [
  // Executive — C-suite + leadership tier. Wins over function so
  // "VP of Engineering" → executive (not engineering).
  {
    category: 'executive',
    keywords: [
      ' ceo ',
      ' cto ',
      ' cfo ',
      ' coo ',
      ' cmo ',
      ' cpo ',
      ' cro ',
      ' chro ',
      ' ciso ',
      ' cdo ',
      ' chief ',
      ' founder ',
      ' co founder ', // hyphens normalise to spaces
      ' cofounder ',
      ' president ',
      ' partner ',
      ' managing director ',
      ' svp ',
      ' evp ',
      ' vp ',
      ' vice president ',
    ],
  },
  // Engineering — explicit IC + technical-lead titles.
  {
    category: 'engineering',
    keywords: [
      ' engineer ',
      ' engineers ',
      ' engineering ',
      ' developer ',
      ' programmer ',
      ' architect ',
      ' devops ',
      ' sre ',
      ' site reliability ',
      ' platform engineer ',
      ' infrastructure ',
      ' tech lead ',
      ' staff eng ',
      ' principal eng ',
    ],
  },
  // Product — PM / designers / UX.
  {
    category: 'product',
    keywords: [
      ' product manager ',
      ' product owner ',
      ' product lead ',
      ' product designer ',
      ' designer ',
      ' design lead ',
      ' ux ',
      ' user experience ',
      ' user interface ',
    ],
  },
  // Sales — IC sales + BD.
  {
    category: 'sales',
    keywords: [
      ' sales ',
      ' business development ',
      ' bd ',
      ' bdr ',
      ' sdr ',
      ' account executive ',
      ' account manager ',
      ' account director ',
      ' ae ',
    ],
  },
  // Marketing — growth + content + brand + comms.
  {
    category: 'marketing',
    keywords: [
      ' marketing ',
      ' growth ',
      ' content ',
      ' brand ',
      ' communications ',
      ' comms ',
      ' public relations ',
      ' pr ',
      ' social media ',
      ' community ',
    ],
  },
  // Operations — back-office / corporate functions.
  {
    category: 'operations',
    keywords: [
      ' operations ',
      ' ops ',
      ' finance ',
      ' accountant ',
      ' controller ',
      ' legal ',
      ' counsel ',
      ' attorney ',
      ' people ',
      ' hr ',
      ' human resources ',
      ' recruiter ',
      ' talent ',
      ' admin ',
      ' office manager ',
    ],
  },
  // Support — customer-facing post-sale.
  {
    category: 'support',
    keywords: [
      ' support ',
      ' customer success ',
      ' cs ',
      ' services ',
      ' client services ',
      ' customer experience ',
      ' customer care ',
    ],
  },
  // Research — research / data / science.
  {
    category: 'research',
    keywords: [
      ' research ',
      ' scientist ',
      ' researcher ',
      ' analyst ',
      ' data ',
      ' machine learning ',
      ' ml ',
      ' ai ',
    ],
  },
];

/** Map a free-form title to one of the closed `RoleCategory` buckets.
 *  Pure function — runs zero LLM tokens, zero SQL. Returns one of
 *  `ROLE_CATEGORIES` for any input string.
 *
 *  Word-boundary matching: the title is lowercased, non-alphanumeric
 *  characters are replaced with single spaces, the result is trimmed
 *  + padded with leading + trailing spaces. Each keyword in the
 *  priority-ordered table carries its own surrounding spaces, so
 *  "CTO" matches `' cto '` cleanly without "Director" matching it
 *  via the `cto` substring inside "diRECTOR". */
export const categorizeRole = (title: string): RoleCategory => {
  const normalized =
    ' ' + title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  if (normalized === '  ') return 'other';
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    for (const kw of keywords) {
      if (normalized.includes(kw)) return category;
    }
  }
  return 'other';
};

const MAIL_FROM_KEY = 'from';

const senderOf = (hot: Record<string, unknown>): string => {
  const from = hot[MAIL_FROM_KEY];
  if (typeof from !== 'string') return '';
  return canonicalOne(from);
};

/** Pull the most-recent inbound mail body where the contact is the
 *  sender. Duplicated from `company.ts` per the codebase's
 *  third-caller-extracts convention; extracts to a shared
 *  `_inbound-mail.ts` when a third consumer ships. */
const findRecentInboundBody = async (
  ctx: HousekeepingContext,
  addresses: readonly string[],
): Promise<string | null> => {
  if (addresses.length === 0 || !ctx.blobs) return null;
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_mail_%'`,
    )
    .all() as Array<{ name: string }>;
  let best:
    | { received_at: number; body_inline: string | null; blob_hash: string | null }
    | null = null;
  for (const { name: table } of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT received_at, hot_fields, body_inline, blob_hash FROM "${table}"
          WHERE ${sqlLikeAny('hot_fields', addresses.length)}
          ORDER BY received_at DESC
          LIMIT 50`,
      )
      .all(...likeAnyParams(addresses)) as Array<{
        received_at: number;
        hot_fields: string;
        body_inline: string | null;
        blob_hash: string | null;
      }>;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
      } catch {
        continue;
      }
      // D-205 #3.5 — inbound from ANY address the contact answers to.
      if (!addresses.includes(senderOf(parsed))) continue;
      const hasInline = typeof row.body_inline === 'string' && row.body_inline.length > 0;
      const hasBlob = typeof row.blob_hash === 'string' && row.blob_hash.length > 0;
      if (!hasInline && !hasBlob) continue;
      if (!best || row.received_at > best.received_at) {
        best = {
          received_at: row.received_at,
          body_inline: row.body_inline,
          blob_hash: row.blob_hash,
        };
      }
    }
  }
  if (best === null) return null;
  if (typeof best.body_inline === 'string' && best.body_inline.length > 0) {
    return best.body_inline;
  }
  if (typeof best.blob_hash === 'string' && best.blob_hash.length > 0) {
    const buf = await ctx.blobs.get(best.blob_hash);
    if (buf === null) return null;
    return buf.toString('utf8');
  }
  return null;
};

/** Coerce ai-extract's `title` field. Mirrors `company`'s
 *  `parseCompanyNameOutput` shape: `null` is a valid LLM outcome
 *  ("no signature found"), strings get trimmed + capped, anything
 *  else throws the closed-shape guarantee. */
const parseTitleOutput = (
  raw: unknown,
):
  | { ok: true; title: string | null }
  | { ok: false } => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false };
  }
  const obj = raw as Record<string, unknown>;
  const value = obj.title;
  if (value === null || value === undefined) return { ok: true, title: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, title: null };
  return {
    ok: true,
    title: trimmed.slice(0, MAX_TITLE_CHARS),
  };
};

export const roleProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  // D-136 P3 — harness skip-rule version-hash invalidation.
  producer_version_hash: baseProducerVersionHash,
  topic: 'role',
  source_scope: 'contact',
  ai_surface: 'chat',
  scope_read_declaration: [
    {
      collection: 'data.contact',
      // `merged_into`: the signature-body search reads the merge graph to widen
      // itself across the contact's absorbed addresses (D-205 #3.5).
      sample_field_paths: ['email', 'merged_into'],
    },
    {
      collection: 'data.mail',
      sample_field_paths: ['from', 'received_at', 'body_inline'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    if (!ctx.llmWithMeta) {
      throw new Error(
        'role_producer_misconfigured: ctx.llmWithMeta is required for AI-driven producers',
      );
    }
    if (!ctx.blobs) {
      throw new Error(
        'role_producer_misconfigured: ctx.blobs is required for body resolution',
      );
    }
    const email = source_record.data.email;
    if (!email) return null;
    const now = ctx.now();

    // D-205 #3.5 — the signature search spans every address the contact answers to.
    const body = await findRecentInboundBody(ctx, contactAddresses(ctx, email));
    if (body === null) return null;
    const trimmed = body.trim();
    if (trimmed.length < MIN_BODY_CHARS) return null;

    const { result, model_id } = await ctx.llmWithMeta(aiExtractManifest, {
      'llm.data': truncateForLlm(trimmed),
      'llm.fields': ['title'],
      'llm.context': SIGNATURE_PARSE_CONTEXT,
      'llm.model_hint': 'fast',
    });
    const parsed = parseTitleOutput(result);
    if (!parsed.ok) {
      throw new Error(
        `role_output_invalid: ai-extract returned non-conformant shape for contact '${email}'`,
      );
    }
    if (parsed.title === null) {
      // AI ran but found no title in the signature — no row.
      // Same null-return convention as `purpose` / `action_items` /
      // `summary` for missing-body cases. The audit record of the
      // call still goes through the harness's run accounting.
      return null;
    }
    const category = categorizeRole(parsed.title);
    const value: RoleValue = {
      title: parsed.title,
      category,
      reasoning: `Parsed from signature on a recent message from ${email}; categorized as ${category}.`,
      computed_at: now,
    };
    return {
      value,
      // D-136 P3 — bistemporal stamping. `role` is a perspective topic
      // (per-contact, aggregated over signatures from many mails). The
      // producer reads the freshest body to derive a current title;
      // event_at anchors on `now` because the *inference* is fresh —
      // there is no single source mail event that anchors this output.
      // A future P3.1 pass may switch to the source mail's received_at
      // for stricter D-120 chronology; today the wrapper falls back to
      // ctx.now() for perspective producers without a single anchor.
      event_at: now,
      model_id,
      ingredient_slug: 'ai-extract',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};

export {
  MAX_TITLE_CHARS,
  MIN_BODY_CHARS as ROLE_MIN_BODY_CHARS,
  CONFIDENCE_SIGNATURE_PARSE as ROLE_CONFIDENCE_SIGNATURE_PARSE,
  ROLE_CATEGORIES,
};
