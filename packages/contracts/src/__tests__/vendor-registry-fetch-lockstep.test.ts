/**
 * THREE lists govern a vendor field; only two were ever tied together.
 *
 *   1. `CONNECTION_VENDOR_ENTITIES[].meta_fields` — the canonical vocabulary.
 *   2. `CANONICAL_CRM_FIELD_SCHEMA`               — its contract.
 *   3. `HUBSPOT_*_PROPERTIES` / `SALESFORCE_*_FIELDS` — what the RECONCILERS
 *      actually fetch, which is what lands in the mirror's `meta` snapshot.
 *
 * (1) and (2) are cross-checked at module load and throw on drift. (3) is pinned
 * only by its own exact-array ratchets, and NOTHING relates it to (1) — so a
 * registry field with no fetch entry is invisible to the mirror while working
 * perfectly on the canonical op path, which derives its SELECT from (1).
 *
 * ⛔ THIS TEST EXISTS BECAUSE READING THE DIFFERENCE WAS NOT ENOUGH. Computing
 * the set difference between (1) and (3) and calling the result a bug produced a
 * WRONG finding that reached a committed decision entry: `ForecastAmount` is
 * omitted deliberately, and `opportunity-reconciler.ts` says so six lines above
 * the projection. A set difference tells you two lists disagree; it never tells
 * you WHY, and "why" is the whole content of the claim. So the divergences are
 * enumerated here WITH their reasons, and the test fails in BOTH directions:
 *
 *   · a NEW divergence (a registry field nobody fetches) fails — the real class;
 *   · a STALE exception (declared, no longer divergent) also fails, so the list
 *     cannot rot into a permanent waiver.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_VENDOR_ENTITIES,
  HUBSPOT_DEAL_PROPERTIES,
  HUBSPOT_CONTACT_PROPERTIES,
  HUBSPOT_COMPANY_PROPERTIES,
  SALESFORCE_OPPORTUNITY_FIELDS,
  SALESFORCE_CONTACT_FIELDS,
  SALESFORCE_ACCOUNT_FIELDS,
} from '../index.js';

/** A registry `source_path` the reconciler deliberately does not fetch. Every
 *  entry states WHY, because that is the fact a set difference cannot carry. */
interface DeclaredDivergence {
  readonly canonical: string;
  readonly reason: string;
}

interface Pair {
  readonly vendor: string;
  readonly entity: string;
  readonly constant: string;
  readonly fetched: readonly string[];
  readonly declared: readonly DeclaredDivergence[];
}

/** HubSpot returns a record's own id on every object regardless of the
 *  `properties` list, so `hs_object_id` never needs requesting. */
const HS_OBJECT_ID: DeclaredDivergence = {
  canonical: 'id',
  reason: 'HubSpot returns the record id on every object regardless of the properties list',
};

const PAIRS: readonly Pair[] = [
  {
    vendor: 'hubspot', entity: 'deal',
    constant: 'HUBSPOT_DEAL_PROPERTIES', fetched: HUBSPOT_DEAL_PROPERTIES,
    declared: [HS_OBJECT_ID],
  },
  {
    vendor: 'hubspot', entity: 'contact',
    constant: 'HUBSPOT_CONTACT_PROPERTIES', fetched: HUBSPOT_CONTACT_PROPERTIES,
    declared: [
      HS_OBJECT_ID,
      {
        canonical: 'job_title',
        reason:
          'shipped registry-only: the canonical op path and the canonical poll carry it, '
          + 'the mirror does not until someone decides whether it joins computeContactHash '
          + '(which re-hashes every mirrored row and fires a one-time cascade over live data)',
      },
      {
        canonical: 'industry',
        reason: 'same registry-only posture as job_title; the portable home is account.industry',
      },
    ],
  },
  {
    vendor: 'hubspot', entity: 'company',
    constant: 'HUBSPOT_COMPANY_PROPERTIES', fetched: HUBSPOT_COMPANY_PROPERTIES,
    declared: [HS_OBJECT_ID],
  },
  {
    vendor: 'salesforce', entity: 'opportunity',
    constant: 'SALESFORCE_OPPORTUNITY_FIELDS', fetched: SALESFORCE_OPPORTUNITY_FIELDS,
    declared: [{
      canonical: 'forecast_amount',
      reason:
        'NOT on the standard Opportunity SOQL projection — Forecasting lives in separate '
        + 'objects, and SOQL HARD-FAILS on an unknown field, so SELECTing it would break the '
        + 'whole reconciler for every org without it. Projected only when an org response '
        + 'happens to carry it (opportunity-reconciler.ts)',
    }],
  },
  {
    vendor: 'salesforce', entity: 'contact',
    constant: 'SALESFORCE_CONTACT_FIELDS', fetched: SALESFORCE_CONTACT_FIELDS,
    declared: [{
      canonical: 'job_title',
      reason: 'the Salesforce half of the same registry-only posture as hubspot.contact.job_title',
    }],
  },
  {
    vendor: 'salesforce', entity: 'account',
    constant: 'SALESFORCE_ACCOUNT_FIELDS', fetched: SALESFORCE_ACCOUNT_FIELDS,
    declared: [],
  },
];

const bare = (path: string): string =>
  (path.startsWith('properties.') ? path.slice('properties.'.length) : path);

/** Registry fields that name a single vendor column. A DERIVED field has no
 *  `source_path` and nothing to fetch, so it is out of scope by construction. */
const sourceBackedFields = (vendor: string, entity: string) => {
  const entry = CONNECTION_VENDOR_ENTITIES.find(
    (e) => e.vendor === vendor && e.entity === entity,
  );
  expect(entry, `${vendor}.${entity} is not registered`).toBeDefined();
  return (entry?.meta_fields ?? [])
    .filter((f) => f.source_path !== undefined && f.derivation === undefined)
    .map((f) => ({ canonical: f.key, column: bare(f.source_path as string) }));
};

describe('the registry and the reconciler fetch lists stay in lockstep', () => {
  for (const pair of PAIRS) {
    const label = `${pair.vendor}.${pair.entity} ↔ ${pair.constant}`;

    it(`${label} — every registry field is fetched, or declared as not`, () => {
      const fetched = new Set(pair.fetched);
      const declared = new Set(pair.declared.map((d) => d.canonical));
      const undeclaredGaps = sourceBackedFields(pair.vendor, pair.entity)
        .filter((f) => !fetched.has(f.column) && !declared.has(f.canonical))
        .map((f) => `${f.canonical} <- ${f.column}`);

      // A new registry field the reconciler does not fetch is invisible to the
      // mirror. That is either an oversight or a deliberate posture — and this
      // test's whole point is that it must be SAID which, right here.
      expect(undeclaredGaps, `${label}: registry fields absent from ${pair.constant} and `
        + `not declared above. Add the column to ${pair.constant}, or add a DeclaredDivergence `
        + 'stating why the reconciler does not fetch it.').toEqual([]);
    });

    it(`${label} — no declared divergence has gone stale`, () => {
      const fetched = new Set(pair.fetched);
      const byCanonical = new Map(
        sourceBackedFields(pair.vendor, pair.entity).map((f) => [f.canonical, f.column]),
      );
      const stale = pair.declared.filter((d) => {
        const column = byCanonical.get(d.canonical);
        // Gone from the registry entirely, or now genuinely fetched.
        return column === undefined || fetched.has(column);
      }).map((d) => d.canonical);

      // Without this arm the exception list only ever grows, and a waiver that
      // outlives its reason is indistinguishable from one that never had one.
      expect(stale, `${label}: these divergences are declared but no longer diverge — `
        + 'the field is fetched now, or is gone from the registry. Remove the entry.')
        .toEqual([]);
    });
  }

  it('every declared divergence states a reason', () => {
    for (const pair of PAIRS) {
      for (const d of pair.declared) {
        expect(d.reason.length, `${pair.constant}: ${d.canonical} has no reason`)
          .toBeGreaterThan(30);
      }
    }
  });

  it('covers every CRM-alias entity the reconcilers mirror', () => {
    const covered = new Set(PAIRS.map((p) => `${p.vendor}.${p.entity}`));
    const mirrored = CONNECTION_VENDOR_ENTITIES
      .filter((e) => e.crm_alias !== undefined && ['hubspot', 'salesforce'].includes(e.vendor))
      .map((e) => `${e.vendor}.${e.entity}`);
    // A new first-party CRM entity must arrive with its fetch list paired, or
    // this ratchet silently stops covering it.
    expect(mirrored.filter((m) => !covered.has(m))).toEqual([]);
  });
});
