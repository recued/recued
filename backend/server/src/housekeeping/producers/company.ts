/** D-131 A.10 — `company` enrichment producer.
 *
 *  First AI-driven contact-scope housekeeping topic + first
 *  signature-parse producer. `dependent` policy keyed on the contact's
 *  canonical email; combines a deterministic email-domain signal with
 *  optional AI signature parsing of a recent inbound mail body.
 *
 *  Three branches drive the output:
 *
 *    1. **Free-mail provider** — `gmail.com`, `yahoo.com`, etc. The
 *       domain itself is the only signal; `company_name: null`,
 *       `confidence: 0`, no LLM call. Recipes filter these out via
 *       `domain_category`.
 *    2. **Business domain, no AI body / AI not wired** — falls back to
 *       a crude `domain → name` derivation (`acme-corp.com` →
 *       `Acme Corp`). `confidence: 0.4`, `source: 'domain_only'`.
 *    3. **Business domain + AI signature parse** — pulls the most-recent
 *       inbound mail body for this contact, asks `ai-extract` for the
 *       company mentioned in the signature block, returns it at
 *       `confidence: 0.85`. When AI returns null/empty (no signature
 *       in the body), falls through to branch 2.
 *
 *  Mirrors the AI-producer contract:
 *
 *    - Positive `estimate_per_record_tokens()` + `ai_surface: 'chat'`
 *      flips the harness's AI-surface gate; D-132 trust state defaults
 *      to `'manual'` per the registry entry, `pool_policy: 'free_only'`.
 *    - Contact source-record hash flips when `last_interaction` /
 *      `interaction_count` change (D-131 A.4 `hashContactRecord`), so
 *      a contact gaining new mail re-runs the producer + picks up the
 *      newer signature on the next cycle.
 *    - LLM resolution failure throws (or yields softly when the harness
 *      catches `AI_LLM_UNAVAILABLE` for pool-policy mismatches per
 *      D-132 P2 `runProduce`).
 *    - Per-D-133, the persisted `value.confidence` is consumed by the
 *      `confidence_drift_signal` task once 100 baseline samples
 *      accumulate, providing silent-regression detection for free.
 *
 *  Why deterministic-fallback when `ctx.llm` is absent (departing from
 *  `summary` / `purpose` / `action_items` which throw): unlike those
 *  pure-AI producers, `company` always has a usable signal — the
 *  domain itself. Returning a low-confidence row beats returning none
 *  when AI is paused or unavailable; recipes filter on
 *  `confidence > 0.5` to skip the deterministic fallback when they
 *  need higher signal. */

import {
  computeProducerVersionHash,
  type ContactRecord,
  type IngredientManifest,
} from '@recued/contracts';

/** D-136 P3 — producer-version hash. */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'company:1',
  model_id: '',
  // v2: `ai-extract` began sending `llm.context` (SIGNATURE_PARSE_CONTEXT) — v1 rows
  // were extracted without it.
  prompt_template_hash: 'company_extract_v2',
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
import { FREE_MAIL_DOMAINS } from './_free-mail-domains.js';
import { truncateForLlm } from './_mail-body.js';
import { listCollectionDataTables } from '../../collections/table.js';

/** Minimum body length for which signature parsing is worth running.
 *  Sub-100-char messages rarely carry a signature block; below the
 *  floor we skip the AI call entirely + fall back to deterministic. */
const MIN_BODY_CHARS = 100;

/** Per-record token estimate exposed to the Run-Now cost preview.
 *  ~250 (roughly: ~200 input — body fragment containing signature
 *  area + ~50 structured output: short company name string). Conservative
 *  bias toward over-reporting. Free-mail / no-body branches don't call
 *  the LLM, so the realised average is lower than this estimate. */
const TOKEN_ESTIMATE_PER_RECORD = 250;

/** Cap company name length at 100 chars. Longer outputs from the LLM
 *  are almost always hallucinations or run-on sentences; the cap is a
 *  producer-side guard rather than enforcing strict shape on the
 *  permissive `ai-extract` contract. */
const MAX_COMPANY_NAME_CHARS = 100;

/** Confidence levels per branch — kept as named constants because they
 *  drive the persisted `confidence` column that D-133 PSI reads. Future
 *  tweaks to the gradients want to be intentional + visible. */
const CONFIDENCE_FREE_MAIL = 0;
const CONFIDENCE_DOMAIN_ONLY = 0.4;
const CONFIDENCE_SIGNATURE_PARSE = 0.85;

/** Inline `IngredientManifest` matching `community/ingredients/ai-extract.json`.
 *  Local to the producer for the same reason as `summary` / `purpose` /
 *  `action_items`: the housekeeping path doesn't depend on the
 *  marketplace ingredient store. */
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

/** Priority rule for ai-extract. Pinned in `llm.context` rather than
 *  the prompt so the producer owns its extraction policy: only return
 *  a name if it's explicitly mentioned in the body's signature block,
 *  not derived from the domain or the From-header. The deterministic
 *  fallback covers the domain case + we don't want the LLM
 *  double-counting that signal at higher confidence. */
const SIGNATURE_PARSE_CONTEXT =
  'Look at the email signature block (typically at the end after a "--", ' +
  '"Sent from", "Best", "Regards", or similar closing). Extract only the ' +
  'company / organisation the sender is explicitly affiliated with. Return ' +
  'null if no clear company is named in a signature. Do NOT guess the ' +
  'company from the email domain or the sender name alone — only return ' +
  'a value when the signature itself names it.';

const MAIL_FROM_KEY = 'from';

const senderOf = (hot: Record<string, unknown>): string => {
  const from = hot[MAIL_FROM_KEY];
  if (typeof from !== 'string') return '';
  return canonicalOne(from);
};

/** Return the domain part (`acme.com` from `bob@acme.com`). Empty
 *  string when the input lacks `@` — caller short-circuits. */
export const extractDomain = (email: string): string => {
  const at = email.indexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1);
};

/** Crude domain → company name fallback. Splits the apex label on
 *  `-` / `_`, capitalizes each token. `acme-corp.com` → `Acme Corp`;
 *  `google.com` → `Google`; `nyt.com` → `Nyt`. Returns null when the
 *  apex label is empty or all-numeric. The deterministic-only branch
 *  emits this at `confidence: 0.4` — recipes raising the bar to
 *  signature-confidence (`> 0.5`) skip these rows automatically. */
export const domainToCompanyName = (domain: string): string | null => {
  const parts = domain.split('.');
  const apex = parts[0];
  if (!apex || apex.length === 0) return null;
  const tokens = apex.split(/[-_]/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  // All-numeric labels (rare; usually IP-based hosts the user typed by
  // mistake) get rejected — `123.example.com` shouldn't render as `123`.
  if (tokens.every((t) => /^\d+$/.test(t))) return null;
  return tokens
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .join(' ');
};

/** Pull the most-recent inbound mail body where the contact is the
 *  sender. Returns the body string (resolved through inline-or-CAS) or
 *  null when no usable body was found. Looks across every
 *  `collection_mail_*` table — same prefix-scan approach the other
 *  contact-scope producers use.
 *
 *  `LIMIT 50` per table caps the per-table scan; we sort DESC by
 *  `received_at` so the first row that's actually FROM the contact +
 *  has a body wins. The 50 cap is a defense against pathological
 *  per-table volumes; in typical mailboxes the most-recent inbound is
 *  in the first few rows. */
const findRecentInboundBody = async (
  ctx: HousekeepingContext,
  addresses: readonly string[],
): Promise<string | null> => {
  if (addresses.length === 0 || !ctx.blobs) return null;
  const tables = listCollectionDataTables(ctx.db, 'mail');
  let best:
    | { received_at: number; body_inline: string | null; blob_hash: string | null }
    | null = null;
  for (const table of tables) {
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
      // Only inbound mail — we want THIS contact's signature, not the
      // user's. Outbound mail TO/CC the contact lacks the signal.
      // D-205 #3.5 — inbound from ANY address the contact answers to; a
      // signature block sent from an address they later merged away is still
      // their signature.
      if (!addresses.includes(senderOf(parsed))) continue;
      // Skip rows with neither body source — they can't yield text.
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

/** Coerce ai-extract's `company_name` field. ai-extract returns
 *  `null` per-field when the LLM finds no signal — that's a valid
 *  outcome here ("no signature found"), so the producer treats it as
 *  "fall through to deterministic" rather than throwing. Strings get
 *  trimmed + capped. Anything else (number, array, object) throws
 *  the closed-shape guarantee. */
const parseCompanyNameOutput = (
  raw: unknown,
):
  | { ok: true; company_name: string | null }
  | { ok: false } => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false };
  }
  const obj = raw as Record<string, unknown>;
  const value = obj.company_name;
  if (value === null || value === undefined) return { ok: true, company_name: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, company_name: null };
  return {
    ok: true,
    company_name: trimmed.slice(0, MAX_COMPANY_NAME_CHARS),
  };
};

interface BuiltCompanyValue {
  domain: string;
  company_name: string | null;
  source: 'signature_parse' | 'domain_only';
  domain_category: 'free_mail' | 'business';
  reasoning: string;
  computed_at: number;
}

const buildFreeMailValue = (domain: string, now: number): BuiltCompanyValue => ({
  domain,
  company_name: null,
  source: 'domain_only',
  domain_category: 'free_mail',
  reasoning: `Free-mail provider (${domain}); no business signal extractable.`,
  computed_at: now,
});

const buildDomainOnlyValue = (
  domain: string,
  fallback: string | null,
  now: number,
  reasonHint: 'no_body' | 'no_signature' | 'no_llm',
): BuiltCompanyValue => {
  let reasoning: string;
  if (fallback === null) {
    reasoning = `Domain ${domain} carried no derivable company name.`;
  } else if (reasonHint === 'no_body') {
    reasoning = `Inferred from domain (${domain}); no recent body available to parse.`;
  } else if (reasonHint === 'no_signature') {
    reasoning = `Inferred from domain (${domain}); recent body had no extractable signature.`;
  } else {
    reasoning = `Inferred from domain (${domain}); AI signature parsing not available.`;
  }
  return {
    domain,
    company_name: fallback,
    source: 'domain_only',
    domain_category: 'business',
    reasoning,
    computed_at: now,
  };
};

const buildSignatureParseValue = (
  domain: string,
  company_name: string,
  email: string,
  now: number,
): BuiltCompanyValue => ({
  domain,
  company_name,
  source: 'signature_parse',
  domain_category: 'business',
  reasoning: `Parsed from signature on a recent message from ${email}.`,
  computed_at: now,
});

export const companyProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  // D-136 P3 — harness skip-rule version-hash invalidation.
  producer_version_hash: baseProducerVersionHash,
  topic: 'company',
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
    const email = source_record.data.email;
    if (!email) return null;
    const domain = extractDomain(email);
    if (domain === '') return null;
    const now = ctx.now();

    // D-136 P3 — bistemporal stamping for `company` is `now` because it's
    // a perspective topic with no single source-record clock. The
    // producer-version hash + ingredient_slug stamp on every output;
    // model_id only stamps when the AI branch fires.
    const baseOutputMetadata = {
      event_at: now,
      ingredient_slug: 'ai-extract',
      producer_version_hash: baseProducerVersionHash,
    } as const;

    // Branch 1: free-mail provider — short-circuit, no AI call.
    if (FREE_MAIL_DOMAINS.has(domain)) {
      return { value: buildFreeMailValue(domain, now), ...baseOutputMetadata };
    }

    // Branch 2/3: business domain. Always have a deterministic fallback.
    const fallback = domainToCompanyName(domain);

    // No LLM wired (test harness, AI paused at the wiring layer, or
    // legacy boot path) → deterministic-only. Unlike pure-AI producers
    // that throw on missing ctx.llmWithMeta, `company` always carries the
    // domain signal so a low-confidence row still beats no row.
    if (!ctx.llmWithMeta) {
      return {
        value: buildDomainOnlyValue(domain, fallback, now, 'no_llm'),
        ...baseOutputMetadata,
      };
    }

    // D-205 #3.5 — the signature search spans every address the contact answers
    // to. (`domain` above deliberately stays the SURVIVOR's own address: the
    // company signal is where they are reachable NOW, not where they used to be.)
    const body = await findRecentInboundBody(ctx, contactAddresses(ctx, email));
    if (body === null) {
      return {
        value: buildDomainOnlyValue(domain, fallback, now, 'no_body'),
        ...baseOutputMetadata,
      };
    }
    const trimmed = body.trim();
    if (trimmed.length < MIN_BODY_CHARS) {
      return {
        value: buildDomainOnlyValue(domain, fallback, now, 'no_body'),
        ...baseOutputMetadata,
      };
    }

    const { result, model_id } = await ctx.llmWithMeta(aiExtractManifest, {
      'llm.data': truncateForLlm(trimmed),
      'llm.fields': ['company_name'],
      'llm.context': SIGNATURE_PARSE_CONTEXT,
      'llm.model_hint': 'fast',
    });
    const parsed = parseCompanyNameOutput(result);
    if (!parsed.ok) {
      throw new Error(
        `company_output_invalid: ai-extract returned non-conformant shape for contact '${email}'`,
      );
    }
    if (parsed.company_name === null) {
      // AI ran but found no signature in the body — fall through to
      // deterministic with the `no_signature` reasoning so the audit
      // trail records that the LLM was consulted + decided not to
      // claim a name.
      return {
        value: buildDomainOnlyValue(domain, fallback, now, 'no_signature'),
        ...baseOutputMetadata,
        model_id,
      };
    }
    return {
      value: buildSignatureParseValue(domain, parsed.company_name, email, now),
      ...baseOutputMetadata,
      model_id,
    };
  },
};

export {
  MAX_COMPANY_NAME_CHARS,
  MIN_BODY_CHARS,
  CONFIDENCE_FREE_MAIL,
  CONFIDENCE_DOMAIN_ONLY,
  CONFIDENCE_SIGNATURE_PARSE,
};
export { FREE_MAIL_DOMAINS } from './_free-mail-domains.js';
