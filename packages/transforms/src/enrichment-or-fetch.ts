/** D-125 Phase 6.2 — `enrichment-or-fetch` transform.
 *
 *  Convention transform behind the kernel + recued-core lint rule
 *  (P6.3). Reads `data.<collection>.<id>.<topic>` or
 *  `connection.<kind>.<name>.<topic>` refs through the enrichment
 *  layer first; returns `{ value: null, source: 'miss' | 'stale' |
 *  'low_trust' }` so the recipe's next step can fetch fresh and
 *  `enrichment-upsert` dual-write.
 *
 *  Step shape:
 *    {
 *      "id": "company_summary",
 *      "transform": "enrichment-or-fetch",
 *      "ref": "data.contact.{{step.email}}.company_summary",
 *      "trust_min": 0.8,         // optional, default ENRICHMENT_TRUST_MIN_DEFAULT
 *      "max_age_ms": 86400000,   // optional, no max-age check when omitted
 *      "fallback_step": "fetch_company_summary"  // optional, echoed in output
 *    }
 *
 *  Output shape:
 *    {
 *      "value": <enrichment value | null>,
 *      "source": 'enrichment' | 'miss' | 'stale' | 'low_trust' |
 *                'unparseable_ref' | 'no_runtime',
 *      "confidence": <number when source === 'enrichment' && row had confidence>,
 *      "fallback": <fallback_step echo when source !== 'enrichment'>
 *    }
 *
 *  Spec: docs/d-125-spec.md §"Phase 6: Enrichment substrate convention". */

import {
  ENRICHMENT_TRUST_MIN_DEFAULT,
  composeEnrichmentScope,
  isEnrichmentTopic,
  type EnrichmentNamespace,
  type EnrichmentScope,
  type EnrichmentTopic,
} from '@recued/contracts';
import type { TransformFn, EnrichmentRowSnapshot } from './types.js';

interface ParsedEnrichmentRef {
  scope: EnrichmentScope;
  target_id: string;
  topic: EnrichmentTopic;
  drill: string[];
}

const DATA_COLLECTIONS = new Set(['mail', 'contact', 'calendar', 'file']);
const CONNECTION_KINDS = new Set(['api', 'mcp', 'notification']);
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Parse a recipe ref into the `(scope, target_id, topic, drill)`
 *  tuple the transform needs. The ref shape is intentionally loose —
 *  target_ids commonly contain dots (emails, paths) so the parser
 *  walks backward to find a registered enrichment topic and treats
 *  everything between the collection and that topic as the target_id.
 *  Drill segments past the topic are returned verbatim so callers
 *  can resolve into a JSON sub-field of the enrichment value. */
const parseRef = (ref: string): ParsedEnrichmentRef | null => {
  let namespace: EnrichmentNamespace;
  let body: string;
  if (ref.startsWith('data.')) {
    namespace = 'data';
    body = ref.substring('data.'.length);
  } else if (ref.startsWith('connection.')) {
    namespace = 'connection';
    body = ref.substring('connection.'.length);
  } else {
    return null;
  }

  const segments = body.split('.');
  if (segments.length < 3) return null;

  const collection = segments[0]!;
  if (namespace === 'data' && !DATA_COLLECTIONS.has(collection)) return null;
  if (namespace === 'connection' && !CONNECTION_KINDS.has(collection)) return null;

  // Walk backward to the first registered topic; everything before it
  // (after the collection segment) is the target_id.
  let topicIdx = -1;
  for (let i = segments.length - 1; i >= 2; i -= 1) {
    if (isEnrichmentTopic(segments[i]!)) {
      topicIdx = i;
      break;
    }
  }
  if (topicIdx < 0) return null;

  const topic = segments[topicIdx]! as EnrichmentTopic;
  const target_id = segments.slice(1, topicIdx).join('.');
  if (target_id.length === 0) return null;

  let scope: EnrichmentScope;
  try {
    scope = composeEnrichmentScope(namespace, collection);
  } catch {
    return null;
  }

  return {
    scope,
    target_id,
    topic,
    drill: segments.slice(topicIdx + 1),
  };
};

/** Source tag the renderer / `skip_when` evaluates. Recipe authors
 *  branch on `step.<id>.value is_null` (any non-`'enrichment'` source
 *  yields null) and may inspect `step.<id>.source` for telemetry. */
type EnrichmentOrFetchSource =
  | 'enrichment'
  | 'miss'
  | 'stale'
  | 'low_trust'
  | 'unparseable_ref'
  | 'no_runtime';

interface EnrichmentOrFetchOutput {
  value: unknown;
  source: EnrichmentOrFetchSource;
  confidence?: number;
  fallback?: string;
}

const drillInto = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let cursor: unknown = value;
  for (const segment of path) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(segment)) return undefined;
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

/** Sources `confidence` from the row JSON when present. The shared
 *  schema doesn't carry a top-level confidence column today (P6.1's
 *  no-SQL-migration constraint) — producers opt in by writing
 *  `value.confidence` in `[0, 1]`. Rows without it fall through the
 *  trust gate (treated as "no signal", i.e. trusted). */
const extractConfidence = (snapshot: EnrichmentRowSnapshot): number | null => {
  if (snapshot.confidence !== null) return snapshot.confidence;
  const value = snapshot.value;
  if (value === null || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>).confidence;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return candidate;
  }
  return null;
};

export const enrichmentOrFetch: TransformFn = (params, ctx): EnrichmentOrFetchOutput => {
  const ref = typeof params.ref === 'string' ? params.ref : null;
  const trust_min = typeof params.trust_min === 'number'
    && Number.isFinite(params.trust_min)
    ? params.trust_min
    : ENRICHMENT_TRUST_MIN_DEFAULT;
  const max_age_ms = typeof params.max_age_ms === 'number'
    && Number.isFinite(params.max_age_ms)
    ? params.max_age_ms
    : undefined;
  const fallback_step = typeof params.fallback_step === 'string'
    ? params.fallback_step
    : undefined;

  if (ref === null) {
    return makeFallback('unparseable_ref', fallback_step);
  }
  const parsed = parseRef(ref);
  if (parsed === null) {
    return makeFallback('unparseable_ref', fallback_step);
  }
  if (!ctx.readEnrichmentRow) {
    return makeFallback('no_runtime', fallback_step);
  }

  const row = ctx.readEnrichmentRow(parsed.topic, parsed.scope, parsed.target_id);
  if (row === null) {
    return makeFallback('miss', fallback_step);
  }

  if (row.stale) {
    return makeFallback('stale', fallback_step);
  }

  const ageMs = ctx.now().getTime() - (row.event_at ?? row.ingested_at);
  if (max_age_ms !== undefined && ageMs > max_age_ms) {
    return makeFallback('stale', fallback_step);
  }

  const confidence = extractConfidence(row);
  if (confidence !== null && confidence < trust_min) {
    return makeFallback('low_trust', fallback_step);
  }

  const value = parsed.drill.length === 0
    ? row.value
    : drillInto(row.value, parsed.drill);

  const out: EnrichmentOrFetchOutput = {
    value: value ?? null,
    source: 'enrichment',
  };
  if (confidence !== null) out.confidence = confidence;
  return out;
};

const makeFallback = (
  source: EnrichmentOrFetchSource,
  fallback_step: string | undefined,
): EnrichmentOrFetchOutput => {
  const out: EnrichmentOrFetchOutput = { value: null, source };
  if (fallback_step !== undefined) out.fallback = fallback_step;
  return out;
};
