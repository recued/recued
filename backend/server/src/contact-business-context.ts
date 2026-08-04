/** Metadata-only, zero-AI business relationship projection for one contact.
 *
 * This joins facts Recued already owns at read time. It writes no cache/table,
 * returns no titles/bodies/company names, and treats incomplete zeroes as unknown
 * through explicit coverage. Positive rows remain useful even under partial
 * coverage. */

import {
  canonicalizeEmail,
  crmRefFields,
  type ContactBusinessContextCoverage,
  type ContactBusinessContextResult,
  type ContactBusinessRelationshipFamily,
  type ContactBusinessRelationshipSummary,
  type EnrichmentScope,
} from '@recued/contracts';

import type {
  CalendarParticipantRelationshipCounts,
} from './collections/calendar/calendar-table.js';
import type { ContactStore } from './storage/contact-store.js';
import type { CrmRecordMirrorStore } from './storage/crm-record-mirror-store.js';
import type {
  WorkEntityContactRelationshipSummary,
  WorkEntityRelationshipCounts,
  WorkEntityStore,
} from './storage/work-entity-store.js';

export interface ContactBusinessContextCrmSource {
  source_id: string;
  scope: EnrichmentScope;
}

/** Narrow read view shared by the live server calendar stack and the standalone
 * MCP process's table-only calendar views. It deliberately has no provider,
 * sync, mutation, or retention surface. */
export interface ContactBusinessContextCalendarReader {
  instances: {
    list(platform: 'calendar'): readonly { slug: string }[];
  };
  listLive(): ReadonlyArray<{
    slug: string;
    table: {
      summarizeParticipant(
        emails: readonly string[],
        as_of: number,
      ): CalendarParticipantRelationshipCounts;
    };
  }>;
}

export interface ContactBusinessContextDeps {
  contacts: Pick<
    ContactStore,
    | 'resolveCanonicalEmail'
    | 'get'
    | 'addressSet'
    | 'countCompanyPeers'
  >;
  workEntities?: Pick<
    WorkEntityStore,
    'summarizeContactRelationships' | 'listSources'
  >;
  calendars?: ContactBusinessContextCalendarReader;
  crmMirror?: Pick<CrmRecordMirrorStore, 'listByRef'>;
  getBoundCrmSources?: () => readonly ContactBusinessContextCrmSource[];
}

const zeroRelation = (
  coverage: ContactBusinessContextCoverage,
): ContactBusinessRelationshipSummary => ({
  active_count: 0,
  historical_count: 0,
  observed_count: 0,
  coverage,
});

const relation = (
  counts: WorkEntityRelationshipCounts,
  coverage: ContactBusinessContextCoverage,
): ContactBusinessRelationshipSummary => ({ ...counts, coverage });

const workCoverage = (
  store: Pick<WorkEntityStore, 'listSources'>,
  kind: 'task' | 'booking' | 'project',
): ContactBusinessContextCoverage => {
  const enabled = store.listSources(kind).filter((source) => source.enabled !== false);
  if (enabled.length === 0) return 'not_configured';
  // Only Recued's local built-in is structurally complete. Connection/adapter
  // mirrors have no universal sync-complete/freshness bit; read-through stores
  // no rows at all. Their positive rows are useful, but a zero remains partial.
  return enabled.some((source) => (
    source.source_kind !== 'builtin' || source.sync_posture === 'read_through'
  ))
    ? 'partial'
    : 'complete';
};

const summarizeWork = (
  deps: ContactBusinessContextDeps,
  contact_id: string | undefined,
  emails: readonly string[],
): {
  tasks: ContactBusinessRelationshipSummary;
  bookings: ContactBusinessRelationshipSummary;
  projects: ContactBusinessRelationshipSummary;
} => {
  if (!deps.workEntities) {
    return {
      tasks: zeroRelation('unavailable'),
      bookings: zeroRelation('unavailable'),
      projects: zeroRelation('unavailable'),
    };
  }
  const summary: WorkEntityContactRelationshipSummary =
    deps.workEntities.summarizeContactRelationships({
      ...(contact_id ? { contact_id } : {}),
      emails,
    });
  const coverage = (kind: 'task' | 'booking' | 'project') => {
    const base = workCoverage(deps.workEntities!, kind);
    return !contact_id && base !== 'not_configured' ? 'partial' : base;
  };
  return {
    tasks: relation(
      summary.tasks,
      coverage('task'),
    ),
    bookings: relation(
      summary.bookings,
      coverage('booking'),
    ),
    projects: relation(
      summary.projects,
      coverage('project'),
    ),
  };
};

const summarizeCalendar = (
  deps: ContactBusinessContextDeps,
  emails: readonly string[],
  as_of: number,
): ContactBusinessRelationshipSummary => {
  if (!deps.calendars) return zeroRelation('unavailable');
  const enrolled = deps.calendars.instances.list('calendar');
  if (enrolled.length === 0) return zeroRelation('not_configured');
  const live = new Map(deps.calendars.listLive().map((collection) => [collection.slug, collection]));
  let active_count = 0;
  let historical_count = 0;
  let observed_count = 0;
  let liveCount = 0;
  for (const instance of enrolled) {
    const collection = live.get(instance.slug);
    if (!collection) continue;
    liveCount += 1;
    const counts = collection.table.summarizeParticipant(emails, as_of);
    active_count += counts.active_count;
    historical_count += counts.historical_count;
    observed_count += counts.observed_count;
  }
  return {
    active_count,
    historical_count,
    observed_count,
    // Provider scans and retention are configured windows, so even a stable
    // backfill cursor cannot prove all-time absence. Positive rows remain
    // useful; no live enrolled collection is explicitly unavailable.
    coverage: liveCount > 0 ? 'partial' : 'unavailable',
  };
};

const summarizeDeals = (
  deps: ContactBusinessContextDeps,
  platformIds: readonly { vendor: string; platform_id: string }[],
): ContactBusinessRelationshipSummary => {
  if (!deps.crmMirror || !deps.getBoundCrmSources) {
    return zeroRelation('unavailable');
  }
  const sources = deps.getBoundCrmSources();
  if (sources.length === 0) return zeroRelation('not_configured');
  const ref = crmRefFields('deal').find((candidate) => candidate.entity === 'contact');
  if (!ref) return zeroRelation('unavailable');

  let active_count = 0;
  let historical_count = 0;
  let observed_count = 0;
  // CRM association models are not uniformly property-backed (HubSpot and
  // Salesforce can associate through separate endpoints), so even a fully
  // walked mirror cannot prove a zero across every vendor. Keep coverage
  // partial; positive reverse-reference rows are still deterministic evidence.
  for (const source of sources) {
    for (const platformId of platformIds) {
      if (platformId.vendor !== source.source_id) continue;
      const result = deps.crmMirror.listByRef(source.scope, {
        field: ref.field,
        value: platformId.platform_id,
        limit: 200,
      });
      observed_count += result.total;
      for (const row of result.rows) {
        const closeState = (row.meta as Record<string, unknown>)['close_state'];
        if (closeState === 'open') active_count += 1;
        else if (closeState === 'won' || closeState === 'lost') historical_count += 1;
      }
    }
  }
  return {
    active_count,
    historical_count,
    observed_count,
    coverage: 'partial',
  };
};

const familyLists = (
  relations: ReadonlyArray<
    readonly [ContactBusinessRelationshipFamily, ContactBusinessRelationshipSummary]
  >,
): {
  active: ContactBusinessRelationshipFamily[];
  historical: ContactBusinessRelationshipFamily[];
} => {
  const active: ContactBusinessRelationshipFamily[] = [];
  const historical: ContactBusinessRelationshipFamily[] = [];
  for (const [name, summary] of relations) {
    if (summary.active_count > 0) active.push(name);
    if (summary.historical_count > 0) {
      historical.push(name);
    }
  }
  return { active, historical };
};

export const resolveContactBusinessContext = (
  deps: ContactBusinessContextDeps,
  input: { email: string; as_of: number; known_before_at: number },
): ContactBusinessContextResult => {
  const canonicalInput = canonicalizeEmail(input.email);
  if (!canonicalInput) throw new Error('contact-business-context: email is invalid');
  if (!Number.isFinite(input.as_of) || input.as_of < 0) {
    throw new Error('contact-business-context: as_of must be a non-negative finite number');
  }
  if (!Number.isFinite(input.known_before_at)
      || input.known_before_at < 0
      || input.known_before_at > input.as_of) {
    throw new Error(
      'contact-business-context: known_before_at must be a non-negative finite number no later than as_of',
    );
  }

  const canonical = deps.contacts.resolveCanonicalEmail(canonicalInput).canonical_email;
  const contact = deps.contacts.get(canonical);
  const addresses = [...new Set([
    input.email.trim().toLowerCase(),
    canonicalInput,
    canonical,
    ...(contact ? deps.contacts.addressSet(canonical) : []),
  ].filter((email) => email.length > 0))];
  // Even without a contact id, exact-email task/project rows are positive
  // evidence. Their zero stays partial because opaque-id joins are unavailable.
  const work = summarizeWork(deps, contact?.contact_id, addresses);
  const { tasks, bookings, projects } = work;
  const calendar = summarizeCalendar(deps, addresses, input.as_of);
  const deals = summarizeDeals(deps, contact?.platform_ids ?? []);

  const same_company_contact_count = contact?.company_norm && contact.contact_id
    ? deps.contacts.countCompanyPeers(contact.company_norm, contact.contact_id)
    : 0;
  const authoritativeProjection = Object.values(
    contact?.projection_provenance ?? {},
  ).some((provenance) => (
    provenance.source === 'manual'
    || provenance.source === 'user_confirmed'
    || provenance.source === 'vendor_meta'
    || provenance.source === 'contact_book'
  ));
  const identity: ContactBusinessContextResult['identity'] = {
    coverage: 'partial',
    resolved: contact !== null,
    known_before: contact !== null && contact.first_seen < input.known_before_at,
    authoritative: contact !== null && (
      contact.source === 'manual'
      || contact.source === 'contact_book'
      || contact.source === 'crm_import'
      || authoritativeProjection
      || (contact.platform_ids?.length ?? 0) > 0
    ),
    company_known: typeof contact?.company === 'string' && contact.company.length > 0,
    same_company: same_company_contact_count > 0,
    same_company_contact_count,
    ...(contact?.company_source ? { company_source: contact.company_source } : {}),
  };
  const families = familyLists([
    ['deals', deals],
    ['tasks', tasks],
    ['calendar', calendar],
    ['bookings', bookings],
    ['projects', projects],
  ]);
  const level: ContactBusinessContextResult['level'] = families.active.length > 0
    ? 'active'
    : families.historical.length > 0
      ? 'historical'
      : identity.known_before
          || identity.authoritative
          || identity.company_known
          || identity.same_company
        ? 'known'
        : 'none';

  return {
    as_of: input.as_of,
    known_before_at: input.known_before_at,
    identity,
    deals,
    tasks,
    calendar,
    bookings,
    projects,
    level,
    active_families: families.active,
    historical_families: families.historical,
  };
};
