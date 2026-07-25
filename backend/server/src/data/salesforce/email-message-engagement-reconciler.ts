/** D-139 Phase 1b — Salesforce EmailMessage engagement reconciler.
 *
 *  Mirror-shape with the HubSpot email reconciler — same mail-twin
 *  matcher (Message-ID preferred → 'exact'; from+to+sent_at triple
 *  fallback → 'probable') + body-state machine. Direction comes from
 *  Salesforce's `Incoming` boolean per § A.3.3 (true → 'inbound';
 *  false → 'outbound').
 *
 *  Lifecycle is always `'point_in_time'` per § A.3.6 — Salesforce
 *  EmailMessage represents sent/received emails (no scheduled or
 *  draft state in this SObject; drafts are a separate construct).
 *  `event_at = MessageDate` per § A.3.1.
 *
 *  EmailMessageRelation drives multi-recipient fan-out when
 *  available; ToAddress fallback parses comma/semicolon-separated
 *  string. When EmailMessageRelation is unavailable, the substrate
 *  flags `coverage.sources_unavailable: ['salesforce.email_message_relation']`
 *  on every downstream enrichment.
 *
 *  Spec: D-139 § A.1, § A.3, § A.3.1, § A.3.2, § A.3.3,
 *  § A.3.5, § A.3.6, § A.3.7. */

import {
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_EMAIL_MESSAGE_FIELDS,
  type ConnectionRecord,
  type DedupeConfidence,
  composePlatformRecordTargetId,
  type Direction,
  type EngagementRow,
} from '@recued/contracts';

import type {
  ContactIdentityExpansion,
  ContactRedirectLookup,
  EngagementStore,
} from '../../storage/engagement-store.js';
import type {
  ReconciliationCadence,
  SlimRecord,
  WebhookProcessor,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  byteSizeOf,
  canonicalizeEmail,
  deriveSalesforceAuthorship,
  deriveSalesforceEmailDirection,
  deriveSalesforceEmailMessageLifecycleState,
  ENGAGEMENT_BODY_INLINE_MAX_BYTES,
  extractIsoOffsetTzHint,
  parseEmailList,
  parseIsoMs,
  pickBodyPreview as pickBodyPreviewShared,
  readSalesforceBoolean,
  readSalesforceId,
  salesforceEngagementTargetIdFor,
  type SalesforceAuthorshipDeps,
} from './engagement-shared.js';
import {
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from './_salesforce-search.js';
import { resolveEngagementTzHint } from '../hubspot/engagement-shared.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

// D-184 Decision 2 — the ingest-time mail-twin matcher (`MailTwinMatch` /
// `MailTwinMatcherInput` / `MailTwinFinder` / `mailTwinFinder` dep) was
// REMOVED, mirroring the HubSpot email reconciler. Exact RFC822 Message-ID
// twins resolve LIVE at read time in the `data.contact.engagements`
// resolver (against `data.mail`'s `rfc_message_id` hot field); the ingest
// stores the CRM row + its `meta.message_id` only and never pre-binds a
// `mail_twin` edge or `body_state: 'mail_link'`. Probable twin
// materialization is deferred (owner 2026-06-18).

export interface SalesforceEmailMessageEngagementSlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

export interface SalesforceEmailMessageEngagementReconcilerDeps {
  search: SalesforceSearchDeps;
  engagementStore: EngagementStore;
  resolveContactRedirect?: ContactRedirectLookup;
  expandContactIdentity?: ContactIdentityExpansion;
  authorship: SalesforceAuthorshipDeps;
  prefsTimezone?: () => string | null | undefined;
  defaultTzHint?: string;
  /** When false, EmailMessageRelationReconciler runs separately and
   *  emits per-junction edges. When true (default), the parent
   *  reconciler emits ToAddress fan-out from the comma-separated
   *  string with `coverage.sources_unavailable` flagged. */
  emailMessageRelationFallbackEdges?: boolean;
  now?: () => number;
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class SalesforceEmailMessageEngagementReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'email_message' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: SalesforceEmailMessageEngagementReconcilerDeps;

  constructor(deps: SalesforceEmailMessageEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SalesforceEmailMessageEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildEmailMessageEngagementSoql(cursor, pageLimit);
    for await (const raw of searchSalesforceObjects(
      connection,
      { soql },
      this.deps.search,
    )) {
      const modifiedAt = parseIsoMs(raw.LastModifiedDate);
      if (modifiedAt === null) continue;
      const id = readSalesforceId(raw.Id);
      if (id === null) continue;
      yield {
        id: salesforceEngagementTargetIdFor('email_message', id),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  ingest(
    connection_id: string,
    slim: SalesforceEmailMessageEngagementSlimRecord,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    // D-184 Decision 2 — no ingest-time mail-twin matching; the resolver
    // flips body_state → 'mail_link' live on an RFC822 Message-ID twin.
    const row = projectEmailMessageEngagementRow(connection_id, slim._raw, {
      now: this.now(),
      authorship: this.deps.authorship,
      defaultTzHint: this.deps.defaultTzHint,
      prefsTimezone: this.deps.prefsTimezone,
    });

    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    const edges: Array<Parameters<EngagementStore['upsertEdge']>[0]> = [];
    // EmailMessage doesn't carry an OwnerId — Salesforce uses
    // CreatedById as the owner-equivalent for outbound messages and
    // doesn't surface a per-message owner for inbound.
    const createdBy = readSalesforceId(slim._raw.CreatedById);
    if (createdBy !== null) {
      edges.push({
        connection_id,
        engagement_target_id: row.target_id,
        edge_type: 'owner',
        target_kind: 'user',
        target_id: `salesforce_user:${createdBy}`,
        vendor: 'salesforce',
        created_at: this.now(),
      });
    }
    const fallbackEnabled =
      this.deps.emailMessageRelationFallbackEdges !== false;
    if (fallbackEnabled) {
      // Parse FromAddress + ToAddress + CcAddress into per-recipient
      // contact edges. Substrate caveat: best-effort recipient split —
      // EmailMessageRelation is the canonical surface; this fallback
      // populates `coverage.sources_unavailable: ['salesforce.email_message_relation']`
      // on downstream enrichments.
      const fromEmail = canonicalizeEmail(
        typeof slim._raw.FromAddress === 'string' ? slim._raw.FromAddress : null,
      );
      const toEmails = parseEmailList(
        typeof slim._raw.ToAddress === 'string' ? slim._raw.ToAddress : '',
      );
      const ccEmails = parseEmailList(
        typeof slim._raw.CcAddress === 'string' ? slim._raw.CcAddress : '',
      );
      const allContactEmails = new Set<string>();
      if (fromEmail !== null) allContactEmails.add(fromEmail);
      for (const e of toEmails) allContactEmails.add(e);
      for (const e of ccEmails) allContactEmails.add(e);
      for (const email of allContactEmails) {
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: 'contact',
          target_kind: 'data.contact',
          target_id: email,
          vendor: 'salesforce',
          created_at: this.now(),
          resolveContactRedirect,
        });
      }
      const relatedToId = readSalesforceId(slim._raw.RelatedToId);
      if (relatedToId !== null) {
        const isOpportunity = relatedToId.startsWith('006');
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: isOpportunity ? 'deal' : 'account',
          target_kind: 'connection.api',
          target_id: composePlatformRecordTargetId(
            'salesforce',
            isOpportunity ? 'opportunity' : 'account',
            connection_id,
            relatedToId,
          ),
          vendor: 'salesforce',
          created_at: this.now(),
        });
      }
    }

    const result = this.deps.engagementStore.ingestEngagementWithEdges({
      row,
      edges,
      now: this.now(),
    });
    return {
      row: result.row,
      emittedEdgeCount: result.edges_upserted,
      edgesTombstoned: result.edges_tombstoned,
      staleModstamp: result.stale_modstamp,
    };
  }

  /** D-184 — harness self-ingest hook (see task reconciler). SF SOQL walk
   *  carries every field (no per-record fetch), so it keeps the harness
   *  default `pages` api-call accounting. The cast to the concrete slim
   *  type is sound — the harness only feeds back what `listUpdatedSince`
   *  yielded. */
  selfIngest(
    _connection: ConnectionRecord,
    connection_name: string,
    record: SlimRecord,
  ): void {
    this.ingest(
      connection_name,
      record as SalesforceEmailMessageEngagementSlimRecord,
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// SOQL composition
// ────────────────────────────────────────────────────────────────

export const buildEmailMessageEngagementSoql = (
  cursor: number,
  limit: number,
): string => {
  const fields = SALESFORCE_EMAIL_MESSAGE_FIELDS.join(', ');
  const baseClauses = [`SELECT ${fields}`, `FROM EmailMessage`];
  if (cursor > 0) {
    baseClauses.push(`WHERE LastModifiedDate >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY LastModifiedDate ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

// ────────────────────────────────────────────────────────────────
// Pure projection
// ────────────────────────────────────────────────────────────────

export interface ProjectEmailMessageEngagementRowInput {
  now: number;
  authorship: SalesforceAuthorshipDeps;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectEmailMessageEngagementRow = (
  connection_id: string,
  raw: RawSalesforceRecord,
  input: ProjectEmailMessageEngagementRowInput,
): EngagementRow => {
  const lifecycle_state = deriveSalesforceEmailMessageLifecycleState();
  const messageDate = parseIsoMs(raw.MessageDate);
  const event_at = messageDate;
  const vendor_created_at = parseIsoMs(raw.CreatedDate) ?? input.now;
  const vendor_modified_at =
    parseIsoMs(raw.LastModifiedDate) ?? vendor_created_at;
  const vendorTzHint =
    extractIsoOffsetTzHint(raw.MessageDate) ??
    extractIsoOffsetTzHint(raw.LastModifiedDate);

  const incoming = readSalesforceBoolean(raw.Incoming);
  const direction: Direction = deriveSalesforceEmailDirection(incoming);
  const authorship = deriveSalesforceAuthorship({
    ownerId: raw.CreatedById, // EmailMessage has no Owner; use CreatedById
    createdById: raw.CreatedById,
    deps: input.authorship,
  });

  const meta: Record<string, unknown> = {};
  if (typeof raw.Subject === 'string' && raw.Subject.length > 0) {
    meta.subject = raw.Subject;
  }
  const fromEmail = canonicalizeEmail(
    typeof raw.FromAddress === 'string' ? raw.FromAddress : null,
  );
  if (fromEmail !== null) meta.from_email = fromEmail;
  if (typeof raw.FromName === 'string' && raw.FromName.length > 0) {
    meta.from_name = raw.FromName;
  }
  const toEmails = parseEmailList(
    typeof raw.ToAddress === 'string' ? raw.ToAddress : '',
  );
  if (toEmails.length > 0) meta.to_emails = toEmails;
  const ccEmails = parseEmailList(
    typeof raw.CcAddress === 'string' ? raw.CcAddress : '',
  );
  if (ccEmails.length > 0) meta.cc_emails = ccEmails;
  if (messageDate !== null) meta.message_date = messageDate;
  if (incoming !== null) meta.incoming = incoming ? 'true' : 'false';
  const hasAttachment = readSalesforceBoolean(raw.HasAttachment);
  if (hasAttachment !== null) {
    meta.has_attachment = hasAttachment ? 'true' : 'false';
  }
  if (typeof raw.MessageIdentifier === 'string' && raw.MessageIdentifier.length > 0) {
    meta.message_id = raw.MessageIdentifier;
  }
  if (typeof raw.ThreadIdentifier === 'string' && raw.ThreadIdentifier.length > 0) {
    meta.thread_id = raw.ThreadIdentifier;
  }
  const relatedToId = readSalesforceId(raw.RelatedToId);
  if (relatedToId !== null) meta.related_to_id = relatedToId;
  const text = typeof raw.TextBody === 'string' ? raw.TextBody : '';
  const html = typeof raw.HtmlBody === 'string' ? raw.HtmlBody : '';
  const body = text.length > 0 ? text : html;
  const bodyPreview = pickBodyPreviewShared(body);
  if (bodyPreview !== null) meta.body_preview = bodyPreview;

  // D-184 Decision 2 — body_state from CRM body only at ingest; 'mail_link'
  // is applied live in the resolver on a Message-ID twin.
  const { body_state, body_inline, body_truncation_offset } = pickBodyState(body);

  const dedupe_confidence: DedupeConfidence = 'none';

  const row: EngagementRow = {
    connection_id,
    target_id: salesforceEngagementTargetIdFor(
      'email_message',
      readSalesforceId(raw.Id) ?? '',
    ),
    vendor: 'salesforce',
    entity: 'email_message',
    meta,
    mirror_blob_hash: null,
    authorship,
    direction,
    dedupe_confidence,
    lifecycle_state,
    event_at,
    vendor_created_at,
    vendor_modified_at,
    ingested_at: input.now,
    body_state,
  };
  if (typeof raw.SystemModstamp === 'string')
    row.vendor_modstamp = raw.SystemModstamp;
  else if (typeof raw.LastModifiedDate === 'string')
    row.vendor_modstamp = raw.LastModifiedDate;
  if (typeof raw.MessageDate === 'string') {
    row.vendor_raw_timestamp = raw.MessageDate;
  }

  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint,
    calendarAdapterTzHint: input.defaultTzHint,
    prefsTimezone: input.prefsTimezone,
  });
  row.event_at_tz_hint = resolvedTz.tz;
  if (resolvedTz.inferred) row.event_at_tz_inferred = true;
  if (body_inline !== undefined) row.body_inline = body_inline;
  if (body_truncation_offset !== undefined)
    row.body_truncation_offset = body_truncation_offset;
  return row;
};

// ────────────────────────────────────────────────────────────────
// Body-state machine
// ────────────────────────────────────────────────────────────────

const pickBodyState = (
  body: string,
): {
  body_state: 'none' | 'inline_body' | 'truncated_inline';
  body_inline?: string;
  body_truncation_offset?: number;
} => {
  if (body.length === 0) return { body_state: 'none' };
  const byteLength = byteSizeOf(body);
  if (byteLength <= ENGAGEMENT_BODY_INLINE_MAX_BYTES) {
    return { body_state: 'inline_body', body_inline: body };
  }
  const truncated = body.slice(
    0,
    Math.floor(ENGAGEMENT_BODY_INLINE_MAX_BYTES / 2),
  );
  return {
    body_state: 'truncated_inline',
    body_inline: truncated,
    body_truncation_offset: byteLength,
  };
};
