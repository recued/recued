/** D-128 Phase 5 — "About this entity" detail panel.
 *
 *  Vendor-pluggable template that renders one platform-resident or
 *  warehouse-resident entity's:
 *
 *    1. Header — display_name from the vendor-entity registry, or a
 *       scope-only fallback when no registry entry exists yet.
 *    2. Meta snapshot card — meta_fields from `ConnectionVendorEntity`
 *       projected against the freshest `EnrichmentMeta` on disk.
 *       Renders type-aware (`date_ms` → ISO date, `string[]` → comma
 *       list, etc.) so vendor Ds get a polished card from one
 *       registry edit.
 *    3. Enrichments section — one card per topic with current value
 *       summary, freshness badge, AI-model badge when applicable.
 *    4. Timeline section — chronological feed across mail / calendar
 *       / annotation / link / memory / enrichment sources from the
 *       D-120 P5 + D-128 P5 widened `data.timeline()` primitive.
 *
 *  CONNECTION_VENDOR_ENTITIES ships empty at D-128 — vendor Ds (D-129
 *  HubSpot, D-130 Salesforce) populate the registry to bring this to
 *  life. The panel renders gracefully without a registry entry: a
 *  raw (scope, target_id) header + the enrichments + timeline still
 *  surface, just without the typed meta card.
 *
 *  Pure render module. Host wires the data loader (timeline rpc +
 *  enrichment list rpc) outside this file. XSS defense: every
 *  user-supplied value passes through `e()`.
 *
 *  Spec: D-128 §A.4 + Phase 5. */

import {
  type ConnectionVendorEntity,
  type ConnectionVendorEntityMetaField,
  type EnrichmentMeta,
  type TimelineEntry,
  type TimelineRollup,
} from '@recued/contracts';
import { e } from '../template.js';
import { renderProvenanceAttribution } from '../reference-provenance.js';

/** Per-topic enrichment summary the panel renders as one card. The
 *  shape mirrors what a host derives from `enrichment.list` rpc rows
 *  — value + freshness + author. */
export interface EnrichmentSummary {
  topic: string;
  value: unknown;
  /** Producer identifier — `system.housekeeping.<topic>` for the
   *  built-in producers, recipe slug for recipe-authored rows. */
  authored_by: string;
  /** Wall-clock when the producer last wrote this row. Drives the
   *  "snapshotted Xm ago" relative-time badge. */
  authored_at: number;
  /** D-136 P2 — three-state staleness class. `'stale'` / `'expired'`
   *  surface a 'pending re-derivation' / 'expired' badge respectively;
   *  `'fresh'` shows none. Renamed from D-122's binary `stale: boolean`. */
  staleness_class: 'fresh' | 'stale' | 'expired';
  /** D-136 P2 — ingredient slug invoked by the producer. AI-surface
   *  producers stamp `'ai-classify'` / `'ai-score'` / etc.;
   *  deterministic producers leave this null. */
  ingredient_slug: string | null;
  /** D-136 P2 — resolved provider model id (`'gpt-4o-mini'`,
   *  `'claude-haiku-4-5'`, …). Drives the model badge visibility.
   *  Populated by the ForceLayer resolver at producer call time once
   *  P3 retrofits the wrapper; NULL until then. */
  model_id: string | null;
  /** Optional human-readable label for the topic — `EnrichmentDefinition.name`.
   *  When absent, falls back to the topic identifier. */
  display_name?: string;
  /** Optional one-line description — `EnrichmentDefinition.description`.
   *  Surfaces under the topic label as supplementary copy. */
  description?: string;
}

export type EntityDetailPanelHeadingLevel = 2 | 3 | 4;
type EntityDetailSectionHeadingLevel = 3 | 4 | 5;
type EntityDetailCardHeadingLevel = 4 | 5 | 6;
type EntityDetailHeadingLevel =
  | EntityDetailPanelHeadingLevel
  | EntityDetailSectionHeadingLevel
  | EntityDetailCardHeadingLevel;

const renderHeading = (
  level: EntityDetailHeadingLevel,
  className: string,
  content: string,
): string => `<h${level} class="${className}">${content}</h${level}>`;

export interface EntityDetailPanelProps {
  /** Canonical scope (closed-list `mail` / `contact` / `calendar` /
   *  `file` OR a four-segment `connection.api.<vendor>.<entity>`).
   *  Drives the header fallback when `vendorEntity` is null. */
  scope: string;
  /** Platform-native or warehouse-canonical id. Opaque to Recued. */
  target_id: string;
  /** Vendor-entity registry entry for the scope. Null when the
   *  vendor D hasn't registered yet — header degrades to scope-only,
   *  meta card switches to a raw key/value list (every meta field
   *  the snapshot carries surfaces, no type-aware formatting). */
  vendorEntity: ConnectionVendorEntity | null;
  /** Latest meta snapshot for the target. Null when no producer has
   *  written a row + meta yet (closed-list warehouse scopes always
   *  carry NULL meta — meta is the platform-reference compute slot
   *  per D-128 §A.2). */
  metaSnapshot: EnrichmentMeta | null;
  /** Per-topic enrichment cards. Hosts pre-collapse multiple authors
   *  per topic to the freshest before passing in. */
  enrichments: ReadonlyArray<EnrichmentSummary>;
  /** Mixed-source timeline feed for the entity, newest first. */
  timelineEntries: ReadonlyArray<TimelineEntry>;
  /** D-226 — per-pack standing aggregates from the same `data.timeline`
   *  response. Undefined ⇒ the section is omitted entirely (the collection has
   *  no declared roots); `[]` ⇒ it renders "nothing tracks this contact". */
  rollups?: ReadonlyArray<TimelineRollup>;
  /** Wall-clock now for relative-time formatting. Tests pass a fixed
   *  timestamp so renders stay deterministic. */
  now: number;
  /** Heading level for the panel title. Defaults to 2 for standalone route
   *  use. Nested hosts can pass 3 or 4; section and card headings move down
   *  with it so the panel never promotes content above its host section. */
  headingLevel?: EntityDetailPanelHeadingLevel;
  /** When false, the Snapshot (meta) section is omitted entirely.
   *  Meta is the platform-reference compute slot (D-128 §A.2), so hosts
   *  drilling native closed-list warehouse scopes (`mail` / `calendar` /
   *  `file` / `contact`) pass false — the "install a pack" unregistered
   *  hint is misleading there (those scopes have no vendor pack). Defaults
   *  to true: the rich card for registered platform-reference entities,
   *  the install-pack hint for unregistered ones. */
  showMetaSection?: boolean;
  /** Optional per-timeline-entry run-link href builder. Returns a href
   *  (e.g. `'#runs?run_id=…'`) for entries that carry a recipe run, or
   *  null otherwise. When it returns a string the entry renders an
   *  "Open run" link. The host owns the routing convention; the panel
   *  escapes the href. Default undefined → no run links. */
  runHref?: (entry: TimelineEntry) => string | null;
  /** Optional per-timeline-entry payload summariser. Returns a one-line
   *  human summary of the entry's payload (e.g. a mail subject) or null
   *  to omit. The panel escapes the result. Default undefined → the
   *  compact source / kind / time row only. */
  summarizePayload?: (entry: TimelineEntry) => string | null;
}

// ────────────────────────────────────────────────────────────────
// Header
// ────────────────────────────────────────────────────────────────

const renderHeader = (
  scope: string,
  target_id: string,
  vendorEntity: ConnectionVendorEntity | null,
  headingLevel: EntityDetailPanelHeadingLevel,
): string => {
  if (vendorEntity !== null) {
    return `
      <header class="memory-entity-detail-header">
        ${renderHeading(
          headingLevel,
          'memory-entity-detail-title',
          `About this ${e(vendorEntity.display_name)}`,
        )}
        <p class="memory-entity-detail-subtitle">
          <code class="memory-entity-detail-scope">${e(vendorEntity.scope)}</code>
          ·
          <code class="memory-entity-detail-target">${e(target_id)}</code>
        </p>
      </header>
    `;
  }
  // No registry entry — fall back to a scope-only header. The hint
  // surfaces in the meta section (see below) so the user understands
  // why the rich card is missing.
  return `
    <header class="memory-entity-detail-header memory-entity-detail-header--unregistered">
      ${renderHeading(
        headingLevel,
        'memory-entity-detail-title',
        `About <code>${e(target_id)}</code>`,
      )}
      <p class="memory-entity-detail-subtitle">
        <code class="memory-entity-detail-scope">${e(scope)}</code>
      </p>
    </header>
  `;
};

// ────────────────────────────────────────────────────────────────
// Meta snapshot card
// ────────────────────────────────────────────────────────────────

/** Render one meta_field's value with type-aware formatting.
 *  `date_ms` → ISO date (no time, since vendor close_dates rarely
 *  carry meaningful hours); `string[]` → comma-separated list;
 *  `string` / `number` → escaped scalar. Missing fields surface as
 *  `—` so the card layout stays stable regardless of producer
 *  fill rate. */
export const formatMetaFieldValue = (
  field: ConnectionVendorEntityMetaField,
  raw: unknown,
): string => {
  if (raw === undefined || raw === null) return '—';
  switch (field.type) {
    case 'date_ms': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return '—';
      // ISO date (YYYY-MM-DD) — no time component. Vendor close_dates
      // are typically day-precision; the time is render-noise.
      return new Date(raw).toISOString().slice(0, 10);
    }
    case 'string[]': {
      if (!Array.isArray(raw)) return '—';
      return raw.filter((v) => typeof v === 'string').join(', ') || '—';
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return '—';
      return raw.toString();
    }
    case 'string': {
      if (typeof raw !== 'string') return '—';
      return raw;
    }
    default: {
      // Future-compat: unknown type → JSON-stringify as a defensive
      // fallback. Existing types are exhaustive at D-128 close.
      return JSON.stringify(raw);
    }
  }
};

/** Walk a dotted meta_field key against the meta object's nested
 *  shape. `'key_dates.close_date'` reads `meta.key_dates.close_date`;
 *  `'name'` reads `meta.name`. Returns undefined when any path
 *  segment is missing or non-object. */
const readMetaPath = (meta: EnrichmentMeta, key: string): unknown => {
  const segments = key.split('.');
  let current: unknown = meta;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const renderMetaCardRegistered = (
  vendorEntity: ConnectionVendorEntity,
  metaSnapshot: EnrichmentMeta | null,
): string => {
  if (metaSnapshot === null) {
    return `
      <p class="memory-entity-detail-meta-empty">
        Snapshot pending — no producer has reconciled this entity yet.
      </p>
    `;
  }
  const rows = vendorEntity.meta_fields
    .map((field) => {
      const raw = readMetaPath(metaSnapshot, field.key);
      const value = formatMetaFieldValue(field, raw);
      return `
        <div class="memory-entity-detail-meta-row" data-key="${e(field.key)}">
          <dt class="memory-entity-detail-meta-key" title="${e(field.description)}">
            ${e(field.key)}
          </dt>
          <dd class="memory-entity-detail-meta-value">${e(value)}</dd>
        </div>
      `;
    })
    .join('');
  return `
    <dl class="memory-entity-detail-meta-list">
      ${rows}
    </dl>
  `;
};

/** Fallback meta render when no vendor-entity entry exists.
 *  Surfaces every key/value the snapshot carries verbatim so the
 *  user can still read what the reconciler wrote, with a hint to
 *  install the relevant vendor pack. Excludes the bistemporal
 *  stamping fields (`snapshot_at`, `snapshot_hash`) — they're
 *  infrastructure, not user-facing. */
const renderMetaCardUnregistered = (
  scope: string,
  metaSnapshot: EnrichmentMeta | null,
): string => {
  const hint = `
    <p class="memory-entity-detail-meta-hint">
      No vendor-entity registry entry for <code>${e(scope)}</code>. Install
      the matching marketplace pack to enable typed rendering.
    </p>
  `;
  if (metaSnapshot === null) return hint;
  const entries = Object.entries(metaSnapshot).filter(
    ([key]) => key !== 'snapshot_at' && key !== 'snapshot_hash',
  );
  if (entries.length === 0) return hint;
  const rows = entries
    .map(([key, value]) => {
      const formatted =
        value === null || value === undefined
          ? '—'
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      return `
        <div class="memory-entity-detail-meta-row" data-key="${e(key)}">
          <dt class="memory-entity-detail-meta-key">${e(key)}</dt>
          <dd class="memory-entity-detail-meta-value">${e(formatted)}</dd>
        </div>
      `;
    })
    .join('');
  return `
    ${hint}
    <dl class="memory-entity-detail-meta-list memory-entity-detail-meta-list--raw">
      ${rows}
    </dl>
  `;
};

const renderMetaSection = (
  scope: string,
  vendorEntity: ConnectionVendorEntity | null,
  metaSnapshot: EnrichmentMeta | null,
  headingLevel: EntityDetailSectionHeadingLevel,
): string => {
  const body =
    vendorEntity !== null
      ? renderMetaCardRegistered(vendorEntity, metaSnapshot)
      : renderMetaCardUnregistered(scope, metaSnapshot);
  return `
    <section class="memory-entity-detail-section memory-entity-detail-section--meta">
      ${renderHeading(headingLevel, 'memory-entity-detail-section-title', 'Snapshot')}
      ${body}
    </section>
  `;
};

// ────────────────────────────────────────────────────────────────
// Enrichments section — one card per topic
// ────────────────────────────────────────────────────────────────

/** Format an enrichment value for the card summary. Heuristic: scalar
 *  values render verbatim; objects with a primary numeric field
 *  (`score`, `confidence`) render that scalar with a hint chip; other
 *  objects pretty-print one shallow key/value per line up to a small
 *  cap so the card stays compact. The full value is always available
 *  via the click-through "View raw value" affordance the host
 *  binds. */
export const summarizeEnrichmentValue = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.score === 'number') return `score ${obj.score}`;
    if (typeof obj.confidence === 'number') {
      return `confidence ${(obj.confidence * 100).toFixed(0)}%`;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    return keys.slice(0, 3).join(', ') + (keys.length > 3 ? `, +${keys.length - 3} more` : '');
  }
  return JSON.stringify(value);
};

const formatRelativeTime = (epochMs: number, now: number): string => {
  const diff = now - epochMs;
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
};

const renderEnrichmentCard = (
  enrichment: EnrichmentSummary,
  now: number,
  headingLevel: EntityDetailCardHeadingLevel,
): string => {
  const summary = summarizeEnrichmentValue(enrichment.value);
  const label = enrichment.display_name ?? enrichment.topic;
  const description = enrichment.description
    ? `<p class="memory-enrichment-card-description">${e(enrichment.description)}</p>`
    : '';
  const staleBadge =
    enrichment.staleness_class === 'stale'
      ? `<span class="memory-enrichment-card-badge memory-enrichment-card-badge--stale">stale</span>`
      : enrichment.staleness_class === 'expired'
        ? `<span class="memory-enrichment-card-badge memory-enrichment-card-badge--stale">expired</span>`
        : '';
  // D-136 P2 — prefer the resolved model id when populated (post-P3);
  // fall back to the ingredient slug for AI-surface rows from
  // pre-P3 producers (slug is what's stamped today). Deterministic
  // producers leave both null and skip the badge.
  const modelBadgeText = enrichment.model_id ?? enrichment.ingredient_slug;
  const modelBadge = modelBadgeText
    ? `<span class="memory-enrichment-card-badge memory-enrichment-card-badge--model">${e(modelBadgeText)}</span>`
    : '';
  return `
    <article class="memory-enrichment-card" data-topic="${e(enrichment.topic)}">
      <header class="memory-enrichment-card-header">
        ${renderHeading(headingLevel, 'memory-enrichment-card-title', e(label))}
        <div class="memory-enrichment-card-badges">${staleBadge}${modelBadge}</div>
      </header>
      ${description}
      <p class="memory-enrichment-card-summary">${e(summary)}</p>
      <footer class="memory-enrichment-card-footer">
        <span class="memory-enrichment-card-author">${e(enrichment.authored_by)}</span>
        <span class="memory-enrichment-card-time">${e(formatRelativeTime(enrichment.authored_at, now))}</span>
      </footer>
    </article>
  `;
};

const renderEnrichmentsSection = (
  enrichments: ReadonlyArray<EnrichmentSummary>,
  now: number,
  headingLevel: EntityDetailSectionHeadingLevel,
  cardHeadingLevel: EntityDetailCardHeadingLevel,
): string => {
  if (enrichments.length === 0) {
    return `
      <section class="memory-entity-detail-section memory-entity-detail-section--enrichments">
        ${renderHeading(headingLevel, 'memory-entity-detail-section-title', 'Enrichments')}
        <p class="memory-entity-detail-empty">No enrichments yet.</p>
      </section>
    `;
  }
  const cards = enrichments
    .map((enrichment) => renderEnrichmentCard(enrichment, now, cardHeadingLevel))
    .join('');
  return `
    <section class="memory-entity-detail-section memory-entity-detail-section--enrichments">
      ${renderHeading(headingLevel, 'memory-entity-detail-section-title', 'Enrichments')}
      <div class="memory-enrichment-card-grid">${cards}</div>
    </section>
  `;
};

// ────────────────────────────────────────────────────────────────
// Timeline section — chronological mixed-source feed
// ────────────────────────────────────────────────────────────────

/** Map a timeline source to a one-word badge label. Mirrors the
 *  TIMELINE_SOURCES enum in `@recued/contracts` so a future addition
 *  surfaces as the literal source string until this map widens. */
const SOURCE_LABELS: Record<string, string> = {
  mail: 'mail',
  calendar: 'calendar',
  file: 'file',
  webhook: 'webhook',
  service: 'service',
  annotation: 'annotation',
  link: 'link',
  memory: 'memory',
  enrichment: 'enrichment',
};

const renderTimelineEntry = (
  entry: TimelineEntry,
  now: number,
  runHref?: (entry: TimelineEntry) => string | null,
  summarizePayload?: (entry: TimelineEntry) => string | null,
): string => {
  const label = SOURCE_LABELS[entry.source] ?? entry.source;
  const recipeBadge = entry.recipe_slug
    ? `<span class="memory-timeline-entry-recipe">${e(entry.recipe_slug)}</span>`
    : '';
  const attribution = renderProvenanceAttribution(entry.attribution, {
    className: 'memory-timeline-entry-attribution',
    ariaLabel: 'Entry provenance',
  });
  // Host-supplied payload summary (e.g. a mail subject) — keeps the row
  // scannable beyond source/kind/time. Escaped here; the callback returns
  // a plain string.
  const summary = summarizePayload?.(entry);
  const summaryLine =
    summary !== undefined && summary !== null && summary.length > 0
      ? `<span class="memory-timeline-entry-summary">${e(summary)}</span>`
      : '';
  // Host-supplied run link — the host owns the routing href convention.
  const href = runHref?.(entry);
  const runLink =
    href !== undefined && href !== null && href.length > 0
      ? `<a class="memory-timeline-entry-run-link" href="${e(href)}">Open run</a>`
      : '';
  return `
    <li class="memory-timeline-entry"
        data-source="${e(entry.source)}"
        data-kind="${e(entry.kind)}">
      <span class="memory-timeline-entry-source">${e(label)}</span>
      <span class="memory-timeline-entry-kind">${e(entry.kind)}</span>
      <span class="memory-timeline-entry-time">${e(formatRelativeTime(entry.ts, now))}</span>
      ${recipeBadge}
      ${attribution}
      ${summaryLine}
      ${runLink}
    </li>
  `;
};

/** D-226 — what each installed pack says about this identity, right now.
 *
 *  ⛔ Rendered ABOVE the feed and never inside it. A rollup is a standing
 *  aggregate with no event time; putting it in the chronology would either
 *  claim a moment it did not happen at or sit permanently at the top. "Where
 *  things stand" and "what happened" are two questions, and the panel answers
 *  them in two places.
 *
 *  ⛔ `complete: false` is rendered LOUDLY. The pack's walk hit a bound, so the
 *  numbers are a FLOOR, not a total — and a partial figure read as a total is
 *  the exact failure this whole path was built to avoid. It must never look
 *  like an ordinary value.
 *
 *  ⚠ Every pack that declares onto the root appears here with no per-pack UI
 *  work: the declaration IS the registration, server-side and here. */
export const renderRollupsSection = (
  rollups: ReadonlyArray<TimelineRollup> | undefined,
  headingLevel: EntityDetailSectionHeadingLevel = 3,
  cardHeadingLevel: EntityDetailCardHeadingLevel = 4,
): string => {
  // Absent (the collection has no rollup surface) renders NOTHING; an empty
  // array (nothing declares onto this identity) says so. Same distinction the
  // wire makes, carried to the pixel.
  if (rollups === undefined) return '';
  if (rollups.length === 0) {
    return `
      <section class="memory-entity-detail-section memory-entity-detail-section--rollups">
        ${renderHeading(headingLevel, 'memory-entity-detail-section-title', 'Where things stand')}
        <p class="memory-entity-detail-empty">No installed pack tracks anything for this contact.</p>
      </section>
    `;
  }
  const cards = rollups.map((rollup) => {
    const label = rollup.label ?? rollup.pack_slug;
    const rows = Object.entries(rollup.value)
      .map(([key, value]) => `
        <div class="memory-rollup-row">
          <span class="memory-rollup-key">${e(key)}</span>
          <span class="memory-rollup-value">${e(summarizeEnrichmentValue(value))}</span>
        </div>
      `).join('');
    const partial = rollup.complete
      ? ''
      : `<p class="memory-rollup-partial" role="status">Partial — at least this much. ${
          e(rollup.incomplete_reason ?? 'the pack could not walk every row')}</p>`;
    return `
      <article class="memory-rollup-card${rollup.complete ? '' : ' memory-rollup-card--partial'}">
        <header class="memory-rollup-card-header">
          ${renderHeading(cardHeadingLevel, 'memory-rollup-card-title', e(label))}
          ${rollup.complete ? '' : '<span class="memory-rollup-badge">floor</span>'}
        </header>
        ${rows === '' ? '<p class="memory-entity-detail-empty">Nothing yet.</p>' : `<div class="memory-rollup-rows">${rows}</div>`}
        ${partial}
        <footer class="memory-rollup-card-footer">${e(rollup.publisher)}/${e(rollup.pack_slug)}</footer>
      </article>
    `;
  }).join('');
  return `
    <section class="memory-entity-detail-section memory-entity-detail-section--rollups">
      ${renderHeading(headingLevel, 'memory-entity-detail-section-title', 'Where things stand')}
      <div class="memory-rollup-grid">${cards}</div>
    </section>
  `;
};

/** D-210 step 3 — exported so a host that renders its OWN entity header
 *  (the collection explorer's calendar detail) can slot JUST the timeline
 *  section without the full panel's header/meta/enrichments. The full
 *  `renderEntityDetailPanel` still composes it internally. Styles ship in
 *  `ENTITY_DETAIL_PANEL_STYLES` — the host must bundle that constant. */
export const renderTimelineSection = (
  entries: ReadonlyArray<TimelineEntry>,
  now: number,
  runHref?: (entry: TimelineEntry) => string | null,
  summarizePayload?: (entry: TimelineEntry) => string | null,
  headingLevel: EntityDetailSectionHeadingLevel = 3,
): string => {
  if (entries.length === 0) {
    return `
      <section class="memory-entity-detail-section memory-entity-detail-section--timeline">
        ${renderHeading(headingLevel, 'memory-entity-detail-section-title', 'Timeline')}
        <p class="memory-entity-detail-empty">No timeline events yet.</p>
      </section>
    `;
  }
  const items = entries
    .map((entry) => renderTimelineEntry(entry, now, runHref, summarizePayload))
    .join('');
  return `
    <section class="memory-entity-detail-section memory-entity-detail-section--timeline">
      ${renderHeading(headingLevel, 'memory-entity-detail-section-title', 'Timeline')}
      <ol class="memory-timeline-feed">${items}</ol>
    </section>
  `;
};

// ────────────────────────────────────────────────────────────────
// Top-level render
// ────────────────────────────────────────────────────────────────

export const renderEntityDetailPanel = (props: EntityDetailPanelProps): string => {
  const headingLevel = props.headingLevel ?? 2;
  const sectionHeadingLevel = (headingLevel + 1) as EntityDetailSectionHeadingLevel;
  const cardHeadingLevel = (headingLevel + 2) as EntityDetailCardHeadingLevel;
  return `
    <article class="memory-entity-detail-panel"
             data-scope="${e(props.scope)}"
             data-target-id="${e(props.target_id)}">
      ${renderHeader(props.scope, props.target_id, props.vendorEntity, headingLevel)}
      ${props.showMetaSection === false
        ? ''
        : renderMetaSection(
            props.scope,
            props.vendorEntity,
            props.metaSnapshot,
            sectionHeadingLevel,
          )}
      ${renderEnrichmentsSection(
        props.enrichments,
        props.now,
        sectionHeadingLevel,
        cardHeadingLevel,
      )}
      ${renderRollupsSection(props.rollups, sectionHeadingLevel, cardHeadingLevel)}
      ${renderTimelineSection(
        props.timelineEntries,
        props.now,
        props.runHref,
        props.summarizePayload,
        sectionHeadingLevel,
      )}
    </article>
  `;
};

// ────────────────────────────────────────────────────────────────
// Derivation helpers — exported so hosts can collapse raw rpc rows
// into the panel's structured props with one call.
// ────────────────────────────────────────────────────────────────

/** Pick the freshest meta snapshot from a list of enrichment rows.
 *  Returns null when every row's meta is null (closed-list warehouse
 *  scopes never carry meta) or when the input is empty. Hosts pass
 *  the result to `metaSnapshot`. */
export const pickFreshestMetaSnapshot = (
  rows: ReadonlyArray<{ meta: EnrichmentMeta | null; ingested_at: number }>,
): EnrichmentMeta | null => {
  let best: EnrichmentMeta | null = null;
  let bestTs = -Infinity;
  for (const row of rows) {
    if (row.meta === null) continue;
    const ts = row.meta.snapshot_at ?? row.ingested_at;
    if (ts > bestTs) {
      bestTs = ts;
      best = row.meta;
    }
  }
  return best;
};

/** Collapse multiple per-topic rows (one per author) to the freshest
 *  per topic. Hosts that fetch via `enrichment.list` with
 *  `fresh_only: true` and a single producer per topic may skip this;
 *  hosts that surface every author's row pass them through. */
export const collapseToFreshestPerTopic = <T extends { topic: string; authored_at: number }>(
  rows: ReadonlyArray<T>,
): T[] => {
  const byTopic = new Map<string, T>();
  for (const row of rows) {
    const existing = byTopic.get(row.topic);
    if (!existing || row.authored_at > existing.authored_at) {
      byTopic.set(row.topic, row);
    }
  }
  return [...byTopic.values()];
};

// ────────────────────────────────────────────────────────────────
// Styles — token-based, dark-safe. Hosts bundle this constant into
// their own marker-guarded `<style>` tag (mirrors WORK_ENTITY_PAGE_STYLES).
// The panel ships nowhere with its own injection; the consumer owns it.
// ────────────────────────────────────────────────────────────────

/** Component-local rules. A host rendering timeline attribution also injects
 * `REFERENCE_PROVENANCE_STYLES`; the Data route owns that shared dependency. */
export const ENTITY_DETAIL_PANEL_STYLES = `
.memory-entity-detail-panel { min-width: 0; display: flex; flex-direction: column; gap: 18px; color: var(--fg); font-size: 13px; }
.memory-entity-detail-header { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.memory-entity-detail-title { margin: 0; overflow-wrap: anywhere; font-size: 16px; font-weight: 600; }
.memory-entity-detail-subtitle { min-width: 0; margin: 0; color: var(--fg-muted); font-size: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
.memory-entity-detail-scope, .memory-entity-detail-target { min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.memory-entity-detail-section { display: flex; flex-direction: column; gap: 8px; }
.memory-entity-detail-section-title { margin: 0; font-size: 13px; font-weight: 600; }
.memory-entity-detail-empty, .memory-entity-detail-meta-empty, .memory-entity-detail-meta-hint { margin: 0; color: var(--fg-muted); }
.memory-entity-detail-meta-list { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
.memory-entity-detail-meta-row { display: contents; }
.memory-entity-detail-meta-key { color: var(--fg-muted); font-size: 12px; }
.memory-entity-detail-meta-value { margin: 0; font-variant-numeric: tabular-nums; }

.memory-enrichment-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.memory-enrichment-card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-sunk); }
.memory-enrichment-card-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.memory-enrichment-card-title { margin: 0; font-size: 13px; font-weight: 600; }
.memory-enrichment-card-badges { display: flex; gap: 4px; flex-wrap: wrap; }
.memory-enrichment-card-badge { padding: 1px 6px; border-radius: 999px; font-size: 10px; border: 1px solid var(--border); color: var(--fg-muted); }
.memory-enrichment-card-badge--stale { color: var(--danger); border-color: currentColor; }
.memory-enrichment-card-badge--model { color: var(--accent); border-color: currentColor; }
.memory-enrichment-card-description { margin: 0; color: var(--fg-muted); font-size: 11px; }
.memory-enrichment-card-summary { margin: 0; font-weight: 600; }
.memory-enrichment-card-footer { display: flex; justify-content: space-between; gap: 8px; color: var(--fg-muted); font-size: 11px; }

.memory-rollup-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.memory-rollup-card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-sunk); }
.memory-rollup-card--partial { border-color: var(--danger); }
.memory-rollup-card-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.memory-rollup-card-title { margin: 0; font-size: 13px; font-weight: 600; }
.memory-rollup-badge { padding: 1px 6px; border-radius: 999px; font-size: 10px; border: 1px solid currentColor; color: var(--danger); text-transform: uppercase; letter-spacing: 0.04em; }
.memory-rollup-rows { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.memory-rollup-row { display: contents; }
.memory-rollup-key { color: var(--fg-muted); font-size: 12px; }
.memory-rollup-value { font-weight: 600; font-variant-numeric: tabular-nums; }
.memory-rollup-partial { margin: 0; color: var(--danger); font-size: 11px; }
.memory-rollup-card-footer { color: var(--fg-muted); font-size: 11px; font-variant-numeric: tabular-nums; }

.memory-timeline-feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.memory-timeline-entry { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.memory-timeline-entry-source { font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; color: var(--accent); }
.memory-timeline-entry-kind { color: var(--fg); }
.memory-timeline-entry-time { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.memory-timeline-entry-recipe { color: var(--fg-muted); font-size: 11px; }
.memory-timeline-entry-attribution { width: 100%; }
.memory-timeline-entry-summary { color: var(--fg-muted); width: 100%; }
.memory-timeline-entry-run-link { color: var(--accent); text-decoration: none; }
.memory-timeline-entry-run-link:hover { text-decoration: underline; }
`;
