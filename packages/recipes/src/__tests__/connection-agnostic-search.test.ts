import { describe, expect, it } from 'vitest';
import {
  canonicalFilterableFields,
  DEFAULT_SEARCH_LIMIT,
  deriveVendorSearchArgs,
  type SearchArgsResult,
} from '@recued/recipes';
import { PAGINATION_MAX_RECORDS } from '@recued/contracts';
import type { EntityFieldRow } from '@recued/contracts';

const entityField = (
  row: Pick<EntityFieldRow, 'entity' | 'field_path' | 'maps_to'> & Partial<EntityFieldRow>,
): EntityFieldRow => ({
  type: 'string',
  reviewed: true,
  ...row,
});

const hubspotDealRows = (): EntityFieldRow[] => [
  entityField({ entity: 'deal', field_path: 'properties.dealname', maps_to: 'name' }),
  entityField({ entity: 'deal', field_path: 'properties.dealstage', maps_to: 'stage' }),
  entityField({ entity: 'deal', field_path: 'properties.amount', maps_to: 'amount', type: 'number' }),
  entityField({ entity: 'deal', field_path: 'properties.hubspot_owner_id', maps_to: 'owner' }),
  entityField({
    entity: 'deal',
    field_path: 'properties.closedate',
    maps_to: 'key_dates.close_date',
    type: 'datetime',
  }),
];

const salesforceOpportunityRows = (): EntityFieldRow[] => [
  entityField({ entity: 'opportunity', field_path: 'Name', maps_to: 'name' }),
  entityField({ entity: 'opportunity', field_path: 'StageName', maps_to: 'stage' }),
  entityField({ entity: 'opportunity', field_path: 'Amount', maps_to: 'amount', type: 'number' }),
  entityField({ entity: 'opportunity', field_path: 'OwnerId', maps_to: 'owner' }),
  entityField({
    entity: 'opportunity',
    field_path: 'CloseDate',
    maps_to: 'key_dates.close_date',
    type: 'datetime',
  }),
];

const pipedriveDealRows = (): EntityFieldRow[] => [
  entityField({ entity: 'deal', field_path: 'id', maps_to: 'id', type: 'number' }),
  entityField({ entity: 'deal', field_path: 'title', maps_to: 'name' }),
  entityField({ entity: 'deal', field_path: 'stage_id', maps_to: 'stage' }),
  entityField({ entity: 'deal', field_path: 'value', maps_to: 'amount', type: 'number' }),
  entityField({ entity: 'deal', field_path: 'owner_id', maps_to: 'owner' }),
  entityField({ entity: 'deal', field_path: 'status', maps_to: 'close_state' }),
  entityField({
    entity: 'deal',
    field_path: 'update_time',
    maps_to: 'updated_at',
    type: 'datetime',
    date_granularity: 'datetime',
  }),
];

// The builder is now selected by the catalog-declared search DIALECT
// (`SearchStyle`), not the vendor id — `hubspot_search` for the HubSpot
// filterGroups body, `soql` for Salesforce SOQL.
const hubspotSearch = (rawArgs: Record<string, unknown>): SearchArgsResult =>
  deriveVendorSearchArgs('hubspot_search', 'deal', hubspotDealRows(), rawArgs);

const salesforceSearch = (rawArgs: Record<string, unknown>): SearchArgsResult =>
  deriveVendorSearchArgs('soql', 'opportunity', salesforceOpportunityRows(), rawArgs);

const pipedriveSearch = (rawArgs: Record<string, unknown>): SearchArgsResult =>
  deriveVendorSearchArgs('pipedrive_filter', 'deal', pipedriveDealRows(), rawArgs);

const salesforceRowsWithFieldPath = (
  canonicalField: string,
  fieldPath: string,
): EntityFieldRow[] =>
  salesforceOpportunityRows().map((row) => (
    row.maps_to === canonicalField ? { ...row, field_path: fieldPath } : row
  ));

const expectOk = (result: SearchArgsResult): Record<string, unknown> => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.args;
};

const expectFailure = (result: SearchArgsResult, reasonSubstring: string): void => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected failure, received ${JSON.stringify(result.args)}`);
  expect(result.reason).not.toBe('');
  expect(result.reason).toContain(reasonSubstring);
};

const salesforceBaseSelect = 'SELECT Id, Name, StageName, Amount, OwnerId, CloseDate FROM Opportunity';

describe('deriveVendorSearchArgs - HubSpot search body', () => {
  it('derives selected properties and limit from canonical args', () => {
    const args = expectOk(hubspotSearch({ limit: 50 }));

    expect(args).toEqual({
      'body.properties': ['dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'closedate'],
      'body.limit': 50,
    });
    expect('body.filterGroups' in args).toBe(false);
    expect('body.sorts' in args).toBe(false);
  });

  it('requests the hs_object_id property mirror for the canonical id row (R2 step 6 — never the top-level id)', () => {
    // The REAL HubSpot registry id row reads `properties.hs_object_id`
    // (HubSpot's property mirror of the record id) so the search body's
    // properties list stays pure property names. A flat-path 3p row on
    // this dialect passes through verbatim — its paths ARE its names.
    const rows = [
      entityField({ entity: 'deal', field_path: 'properties.hs_object_id', maps_to: 'id' }),
      ...hubspotDealRows(),
    ];
    const args = expectOk(deriveVendorSearchArgs('hubspot_search', 'deal', rows, { limit: 50 }));

    expect(args['body.properties']).toEqual([
      'hs_object_id', 'dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'closedate',
    ]);
  });

  it('uses the default search limit when omitted', () => {
    const args = expectOk(hubspotSearch({}));

    expect(args['body.limit']).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it('maps a not_equal filter to a HubSpot filter group', () => {
    const args = expectOk(
      hubspotSearch({
        filter: { field: 'stage', operator: 'not_equal', value: 'closedwon' },
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'dealstage', operator: 'NEQ', value: 'closedwon' }],
      },
    ]);
  });

  it('maps an AND array to one filter group with two filters', () => {
    const args = expectOk(
      hubspotSearch({
        filter: [
          { field: 'stage', operator: 'not_equal', value: 'closedwon' },
          { field: 'owner', operator: 'equal', value: '12345' },
        ],
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [
          { propertyName: 'dealstage', operator: 'NEQ', value: 'closedwon' },
          { propertyName: 'hubspot_owner_id', operator: 'EQ', value: '12345' },
        ],
      },
    ]);
  });

  it('maps a single AND-group array to one byte-identical HubSpot filter group', () => {
    const args = expectOk(
      hubspotSearch({
        filter: [{ field: 'stage', operator: 'equal', value: 'closedwon' }],
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }],
      },
    ]);
  });

  it('maps OR filter groups to multiple HubSpot filterGroups entries', () => {
    const args = expectOk(
      hubspotSearch({
        filter: {
          any: [
            { field: 'stage', operator: 'equal', value: 'closedwon' },
            { field: 'amount', operator: 'greater', value: 100000 },
          ],
        },
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }],
      },
      {
        filters: [{ propertyName: 'amount', operator: 'GT', value: '100000' }],
      },
    ]);
  });

  it('maps OR groups with an AND-group element to HubSpot filterGroups', () => {
    const args = expectOk(
      hubspotSearch({
        filter: {
          any: [
            [
              { field: 'stage', operator: 'equal', value: 'x' },
              { field: 'amount', operator: 'greater', value: 5 },
            ],
            { field: 'stage', operator: 'equal', value: 'y' },
          ],
        },
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [
          { propertyName: 'dealstage', operator: 'EQ', value: 'x' },
          { propertyName: 'amount', operator: 'GT', value: '5' },
        ],
      },
      {
        filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'y' }],
      },
    ]);
  });

  it('collapses a single-element OR filter to one HubSpot filterGroups entry', () => {
    const args = expectOk(
      hubspotSearch({
        filter: { any: [{ field: 'stage', operator: 'equal', value: 'closedwon' }] },
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }],
      },
    ]);
  });

  it.each([
    ['equal', 'EQ'],
    ['greater', 'GT'],
    ['greater_or_equal', 'GTE'],
    ['less', 'LT'],
    ['less_or_equal', 'LTE'],
    ['contains', 'CONTAINS_TOKEN'],
    ['not_contains', 'NOT_CONTAINS_TOKEN'],
  ] as const)('maps operator %s to %s', (operator, hubspotOperator) => {
    const args = expectOk(
      hubspotSearch({
        filter: { field: 'stage', operator, value: 'closedwon' },
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'dealstage', operator: hubspotOperator, value: 'closedwon' }],
      },
    ]);
  });

  it('maps unary null operators without value fields', () => {
    const nullArgs = expectOk(
      hubspotSearch({
        filter: { field: 'stage', operator: 'is_null' },
      }),
    );
    const notNullArgs = expectOk(
      hubspotSearch({
        filter: { field: 'stage', operator: 'is_not_null' },
      }),
    );

    expect(nullArgs['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'dealstage', operator: 'NOT_HAS_PROPERTY' }],
      },
    ]);
    expect(notNullArgs['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'dealstage', operator: 'HAS_PROPERTY' }],
      },
    ]);
  });

  it('maps array operators to plural stringified values', () => {
    const inArgs = expectOk(
      hubspotSearch({
        filter: { field: 'amount', operator: 'in', value: [10000, 25000] },
      }),
    );
    const notInArgs = expectOk(
      hubspotSearch({
        filter: { field: 'amount', operator: 'not_in', value: [10000, 25000] },
      }),
    );

    expect(inArgs['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'amount', operator: 'IN', values: ['10000', '25000'] }],
      },
    ]);
    expect(notInArgs['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'amount', operator: 'NOT_IN', values: ['10000', '25000'] }],
      },
    ]);
  });

  it('stringifies number filter values', () => {
    const args = expectOk(
      hubspotSearch({
        filter: { field: 'amount', operator: 'greater', value: 30000 },
      }),
    );

    expect(args['body.filterGroups']).toEqual([
      {
        filters: [{ propertyName: 'amount', operator: 'GT', value: '30000' }],
      },
    ]);
  });

  it('maps datetime sort fields and default sort direction', () => {
    const descArgs = expectOk(
      hubspotSearch({
        sort: { field: 'key_dates.close_date', direction: 'desc' },
      }),
    );
    const defaultArgs = expectOk(
      hubspotSearch({
        sort: { field: 'key_dates.close_date' },
      }),
    );

    expect(descArgs['body.sorts']).toEqual([
      { propertyName: 'closedate', direction: 'DESCENDING' },
    ]);
    expect(defaultArgs['body.sorts']).toEqual([
      { propertyName: 'closedate', direction: 'ASCENDING' },
    ]);
  });

  it('accepts exotic property names because HubSpot search args are JSON-shaped', () => {
    const exoticProperty = "amount), (SELECT Id FROM Account; Name LIKE '%";
    const args = expectOk(
      deriveVendorSearchArgs(
        'hubspot_search',
        'deal',
        [
          entityField({
            entity: 'deal',
            field_path: `properties.${exoticProperty}`,
            maps_to: 'amount',
            type: 'number',
          }),
        ],
        {
          filter: { field: 'amount', operator: 'greater', value: 10 },
          sort: { field: 'amount', direction: 'desc' },
        },
      ),
    );

    expect(args).toEqual({
      'body.properties': [exoticProperty],
      'body.limit': DEFAULT_SEARCH_LIMIT,
      'body.filterGroups': [
        {
          filters: [{ propertyName: exoticProperty, operator: 'GT', value: '10' }],
        },
      ],
      'body.sorts': [
        { propertyName: exoticProperty, direction: 'DESCENDING' },
      ],
    });
  });
});

describe('deriveVendorSearchArgs - Salesforce SOQL', () => {
  it('derives SELECT + FROM, and caps LIMIT at the walk-all ceiling (ignoring the per-page hint)', () => {
    // Walk-all: SOQL has no per-page size knob (the Query API auto-batches +
    // returns `nextRecordsUrl`), so the canonical `limit` page-size HINT does NOT
    // bound Salesforce — the builder emits `LIMIT <PAGINATION_MAX_RECORDS>` to cap
    // the SET at the source, and the gateway's `soql_query_locator` follower walks
    // the locator to assemble it. A small `limit` (25) does not shrink the SOQL LIMIT.
    const args = expectOk(salesforceSearch({ limit: 25 }));

    expect(args).toEqual({
      'query.q': `${salesforceBaseSelect} LIMIT ${PAGINATION_MAX_RECORDS}`,
    });
  });

  it('formats string equality filters with SOQL quoting and escaping', () => {
    const prospectingArgs = expectOk(
      salesforceSearch({
        filter: { field: 'stage', operator: 'equal', value: 'Prospecting' },
      }),
    );
    const escapedArgs = expectOk(
      salesforceSearch({
        filter: { field: 'stage', operator: 'equal', value: "O'Brien" },
      }),
    );

    expect(prospectingArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE StageName = 'Prospecting' LIMIT ${PAGINATION_MAX_RECORDS}`);
    expect(escapedArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE StageName = 'O\\'Brien' LIMIT ${PAGINATION_MAX_RECORDS}`);
  });

  it('formats a single AND-group array without SOQL OR parentheses', () => {
    const args = expectOk(
      salesforceSearch({
        filter: [{ field: 'stage', operator: 'equal', value: 'x' }],
      }),
    );

    expect(args['query.q']).toContain("WHERE StageName = 'x'");
    expect(args['query.q']).not.toContain('(StageName');
  });

  it('formats OR filter groups with parenthesized SOQL AND-groups', () => {
    const args = expectOk(
      salesforceSearch({
        filter: {
          any: [
            { field: 'stage', operator: 'equal', value: 'x' },
            { field: 'amount', operator: 'greater', value: 5 },
          ],
        },
      }),
    );

    expect(args['query.q']).toContain("WHERE (StageName = 'x') OR (Amount > 5)");
  });

  it('collapses a single-element OR filter to unparenthesized SOQL', () => {
    const args = expectOk(
      salesforceSearch({
        filter: { any: [{ field: 'stage', operator: 'equal', value: 'x' }] },
      }),
    );

    expect(args['query.q']).toBe(`${salesforceBaseSelect} WHERE StageName = 'x' LIMIT ${PAGINATION_MAX_RECORDS}`);
    expect(args['query.q']).not.toContain('(StageName');
  });

  it('formats number filters without quotes', () => {
    const args = expectOk(
      salesforceSearch({
        filter: { field: 'amount', operator: 'greater', value: 30000 },
      }),
    );

    expect(args['query.q']).toBe(`${salesforceBaseSelect} WHERE Amount > 30000 LIMIT ${PAGINATION_MAX_RECORDS}`);
  });

  it('formats null predicates', () => {
    const nullArgs = expectOk(
      salesforceSearch({
        filter: { field: 'stage', operator: 'is_null' },
      }),
    );
    const notNullArgs = expectOk(
      salesforceSearch({
        filter: { field: 'stage', operator: 'is_not_null' },
      }),
    );

    expect(nullArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE StageName = null LIMIT ${PAGINATION_MAX_RECORDS}`);
    expect(notNullArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE StageName != null LIMIT ${PAGINATION_MAX_RECORDS}`);
  });

  it('formats IN and NOT IN predicates', () => {
    const inArgs = expectOk(
      salesforceSearch({
        filter: { field: 'stage', operator: 'in', value: ['a', 'b'] },
      }),
    );
    const notInArgs = expectOk(
      salesforceSearch({
        filter: { field: 'stage', operator: 'not_in', value: ['a', 'b'] },
      }),
    );

    expect(inArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE StageName IN ('a', 'b') LIMIT ${PAGINATION_MAX_RECORDS}`);
    expect(notInArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE StageName NOT IN ('a', 'b') LIMIT ${PAGINATION_MAX_RECORDS}`);
  });

  it('formats contains predicates as LIKE', () => {
    const containsArgs = expectOk(
      salesforceSearch({
        filter: { field: 'name', operator: 'contains', value: 'acme' },
      }),
    );
    const notContainsArgs = expectOk(
      salesforceSearch({
        filter: { field: 'name', operator: 'not_contains', value: 'acme' },
      }),
    );

    expect(containsArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE Name LIKE '%acme%' LIMIT ${PAGINATION_MAX_RECORDS}`);
    expect(notContainsArgs['query.q']).toBe(`${salesforceBaseSelect} WHERE (NOT Name LIKE '%acme%') LIMIT ${PAGINATION_MAX_RECORDS}`);
  });

  it('orders clauses as SELECT, FROM, WHERE, ORDER BY, LIMIT', () => {
    const args = expectOk(
      salesforceSearch({
        limit: 7,
        filter: { field: 'stage', operator: 'equal', value: 'Prospecting' },
        sort: { field: 'key_dates.close_date', direction: 'desc' },
      }),
    );

    // LIMIT is the walk-all ceiling, not the per-page `limit` hint (see above) —
    // the clause ORDER is what this test pins.
    expect(args['query.q']).toBe(
      `${salesforceBaseSelect} WHERE StageName = 'Prospecting' ORDER BY CloseDate DESC LIMIT ${PAGINATION_MAX_RECORDS}`,
    );
  });

  it.each([
    [
      'FROM object',
      "Opportunity WHERE Id != null OR Name LIKE '%",
      () => deriveVendorSearchArgs(
        'soql',
        "opportunity WHERE Id != null OR Name LIKE '%",
        salesforceOpportunityRows(),
        {},
      ),
    ],
    [
      'SELECT field',
      "Name FROM Opportunity WHERE Id != null OR Name LIKE '%",
      () => deriveVendorSearchArgs(
        'soql',
        'opportunity',
        salesforceRowsWithFieldPath('name', "Name FROM Opportunity WHERE Id != null OR Name LIKE '%"),
        {},
      ),
    ],
    [
      'filter field',
      'StageName; SELECT Id FROM Account',
      () => deriveVendorSearchArgs(
        'soql',
        'opportunity',
        salesforceRowsWithFieldPath('stage', 'StageName; SELECT Id FROM Account'),
        { filter: { field: 'stage', operator: 'equal', value: 'Prospecting' } },
      ),
    ],
    [
      'sort field',
      'Amount), (SELECT Id FROM Account',
      () => deriveVendorSearchArgs(
        'soql',
        'opportunity',
        salesforceRowsWithFieldPath('amount', 'Amount), (SELECT Id FROM Account'),
        { sort: { field: 'amount', direction: 'desc' } },
      ),
    ],
  ] as const)('fails closed when the SOQL %s identifier is unsafe', (_label, identifier, build) => {
    const result = build();

    expectFailure(result, 'SOQL identifier');
    if (!result.ok) {
      expect(result.reason).toContain(identifier);
    }
  });

  it('allows benign relationship paths in SELECT and ORDER BY', () => {
    const args = expectOk(
      deriveVendorSearchArgs(
        'soql',
        'opportunity',
        [
          entityField({ entity: 'opportunity', field_path: 'Name', maps_to: 'name' }),
          entityField({ entity: 'opportunity', field_path: 'Account.Name', maps_to: 'account_name' }),
        ],
        { sort: { field: 'account_name', direction: 'desc' } },
      ),
    );

    expect(args['query.q']).toBe(
      `SELECT Id, Name, Account.Name FROM Opportunity ORDER BY Account.Name DESC LIMIT ${PAGINATION_MAX_RECORDS}`,
    );
  });
});

describe('deriveVendorSearchArgs - Pipedrive list params', () => {
  it('derives the per-page limit query param and clamps it to the Pipedrive page size', () => {
    const args = expectOk(pipedriveSearch({ limit: 500 }));

    expect(args).toEqual({ 'query.limit': 50 });
  });

  it('maps supported equality filters to Pipedrive query params', () => {
    const args = expectOk(
      pipedriveSearch({
        filter: [
          { field: 'owner', operator: 'equal', value: '42' },
          { field: 'close_state', operator: 'equal', value: 'open' },
        ],
      }),
    );

    expect(args).toEqual({
      'query.limit': 50,
      'query.owner_id': '42',
      'query.status': 'open',
    });
  });

  it('fails closed on a close_state filter value outside the declared enum (D-190 Slice 2)', () => {
    // `close_state` is server-filterable on Pipedrive (backs `status`), so the literal
    // value reaches validation — a value outside `['open','won','lost']` fails closed so
    // the AI/author can't issue a query the vendor can't satisfy.
    expectFailure(
      pipedriveSearch({ filter: { field: 'close_state', operator: 'equal', value: 'success' } }),
      'is not a declared value',
    );
    // a declared value still passes.
    expectOk(pipedriveSearch({ filter: { field: 'close_state', operator: 'equal', value: 'won' } }));
  });

  it('maps id equality/in filters to the comma-separated ids query param', () => {
    const single = expectOk(
      pipedriveSearch({ filter: { field: 'id', operator: 'equal', value: 123 } }),
    );
    const list = expectOk(
      pipedriveSearch({ filter: { field: 'id', operator: 'in', value: [123, 456] } }),
    );

    expect(single['query.ids']).toBe('123');
    expect(list['query.ids']).toBe('123,456');
  });

  it('maps updated_at range filters to updated_since / updated_until', () => {
    const args = expectOk(
      pipedriveSearch({
        filter: [
          { field: 'updated_at', operator: 'greater_or_equal', value: '2026-01-01T12:00:00Z' },
          { field: 'updated_at', operator: 'less', value: '2026-02-01T12:00:00Z' },
        ],
      }),
    );

    expect(args).toMatchObject({
      'query.updated_since': '2026-01-01T12:00:00Z',
      'query.updated_until': '2026-02-01T12:00:00Z',
    });
  });

  it('emits sort_by and sort_direction for flat Pipedrive fields', () => {
    const args = expectOk(
      pipedriveSearch({ sort: { field: 'updated_at', direction: 'desc' } }),
    );

    expect(args).toMatchObject({
      'query.sort_by': 'update_time',
      'query.sort_direction': 'desc',
    });
  });

  it('fails closed for unsupported Pipedrive OR groups and operators', () => {
    expectFailure(
      pipedriveSearch({
        filter: {
          any: [
            { field: 'owner', operator: 'equal', value: '42' },
            { field: 'close_state', operator: 'equal', value: 'open' },
          ],
        },
      }),
      'OR filter groups',
    );
    expectFailure(
      pipedriveSearch({ filter: { field: 'name', operator: 'contains', value: 'acme' } }),
      'supports equality filters only',
    );
  });
});

describe('deriveVendorSearchArgs - fail closed validation', () => {
  it('fails closed when the catalog declares no search style', () => {
    expectFailure(
      deriveVendorSearchArgs(undefined, 'deal', hubspotDealRows(), {}),
      'no canonical search-query builder',
    );
  });

  it('fails closed for an unknown search style', () => {
    expectFailure(
      deriveVendorSearchArgs(
        'not_a_dialect' as Parameters<typeof deriveVendorSearchArgs>[0],
        'deal',
        hubspotDealRows(),
        {},
      ),
      'no canonical search-query builder',
    );
  });

  it.each([
    ['properties', { properties: ['dealname'] }],
    ['filters', { filters: [] }],
  ] as const)('rejects unknown top-level arg key %s', (_key, rawArgs) => {
    expectFailure(hubspotSearch(rawArgs), 'not a canonical search arg');
  });

  it.each([0, -1, 1.5, '10'] as const)('rejects invalid limit %s', (limit) => {
    expectFailure(hubspotSearch({ limit }), 'positive integer');
  });

  it('rejects an empty OR filter groups array', () => {
    expectFailure(
      hubspotSearch({
        filter: { any: [] },
      }),
      'non-empty',
    );
  });

  it('rejects an empty OR filter group', () => {
    expectFailure(
      hubspotSearch({
        filter: { any: [[]] },
      }),
      'at least one condition',
    );
  });

  it('rejects a non-array OR filter groups value', () => {
    expectFailure(
      hubspotSearch({
        filter: { any: 'x' },
      }),
      'non-empty array',
    );
  });

  it('rejects an invalid operator in a later OR filter group', () => {
    expectFailure(
      hubspotSearch({
        filter: {
          any: [
            { field: 'stage', operator: 'equal', value: 'x' },
            { field: 'stage', operator: 'BOGUS', value: 'y' },
          ],
        },
      }),
      'BOGUS',
    );
  });

  it('rejects a ref-valued filter in a later OR filter group', () => {
    expectFailure(
      hubspotSearch({
        filter: {
          any: [
            { field: 'stage', operator: 'equal', value: 'x' },
            { field: 'amount', operator: 'greater', value: '{{config.x}}' },
          ],
        },
      }),
      'ref-valued filter',
    );
  });

  it.each([
    [
      'datetime-without-granularity',
      hubspotDealRows(),
      { field: 'key_dates.close_date', operator: 'equal', value: '2026-06-08' },
      'date granularity',
    ],
    [
      'json',
      [
        ...hubspotDealRows(),
        entityField({ entity: 'deal', field_path: 'properties.metadata', maps_to: 'metadata', type: 'json' }),
      ],
      { field: 'metadata', operator: 'equal', value: { source: 'import' } },
      'object/json type',
    ],
    [
      'derived',
      hubspotDealRows(),
      { field: 'derived_score', operator: 'equal', value: 'hot' },
      'does not map to a vendor field',
    ],
  ] as const)('rejects a %s field in a later OR filter group', (_label, rows, secondGroup, reason) => {
    expectFailure(
      deriveVendorSearchArgs('hubspot_search', 'deal', rows, {
        filter: {
          any: [
            { field: 'stage', operator: 'equal', value: 'x' },
            secondGroup,
          ],
        },
      }),
      reason,
    );
  });

  it('rejects an unknown filter operator', () => {
    expectFailure(
      hubspotSearch({
        filter: { field: 'stage', operator: 'is_empty', value: 'closedwon' },
      }),
      'is_empty',
    );
  });

  it('rejects bad operator value shape', () => {
    expectFailure(
      hubspotSearch({
        filter: { field: 'stage', operator: 'is_null', value: 'closedwon' },
      }),
      'takes no value',
    );
    expectFailure(
      hubspotSearch({
        filter: { field: 'stage', operator: 'in', value: 'closedwon' },
      }),
      'non-empty array value',
    );
    expectFailure(
      hubspotSearch({
        filter: { field: 'stage', operator: 'in', value: [] },
      }),
      'non-empty array value',
    );
    expectFailure(
      hubspotSearch({
        filter: { field: 'stage', operator: 'equal' },
      }),
      'requires a value',
    );
  });

  it.each([
    ['hubspot_search', 'deal', hubspotDealRows()],
    ['soql', 'opportunity', salesforceOpportunityRows()],
  ] as const)('rejects datetime filters when the field declares no date granularity for %s', (style, vendorEntity, rows) => {
    // The shared fixtures type close_date as `datetime` but declare no
    // `date_granularity`, so a server-side date filter fails closed (G2): both
    // vendors need the right date literal form, which isn't derivable from the type.
    expectFailure(
      deriveVendorSearchArgs(style, vendorEntity, rows, {
        filter: { field: 'key_dates.close_date', operator: 'equal', value: '2026-06-08' },
      }),
      'date granularity',
    );
  });

  // B1 — a NON-string field ref stays rejected (it would splice UNQUOTED into SOQL;
  // a typed runtime escape is a later slice). Both dialects fail closed uniformly so a
  // connection-agnostic recipe behaves the same on every vendor.
  it.each([
    ['hubspot_search', 'deal', hubspotDealRows()],
    ['soql', 'opportunity', salesforceOpportunityRows()],
  ] as const)('rejects a ref on a number field for %s', (style, vendorEntity, rows) => {
    expectFailure(
      deriveVendorSearchArgs(style, vendorEntity, rows, {
        filter: { field: 'amount', operator: 'greater', value: '{{config.min}}' },
      }),
      'number field',
    );
    expectFailure(
      deriveVendorSearchArgs(style, vendorEntity, rows, {
        filter: { field: 'amount', operator: 'in', value: [100, '{{config.min}}'] },
      }),
      'number field',
    );
  });

  // B1 — an interpolation / nested / malformed ref value can't be escaped as a unit
  // (one hint escapes the whole resolved value, not surrounding literal text).
  it.each([
    ['hubspot_search', 'deal', hubspotDealRows()],
    ['soql', 'opportunity', salesforceOpportunityRows()],
  ] as const)('rejects an interpolation (text mixed with a ref) for %s', (style, vendorEntity, rows) => {
    expectFailure(
      deriveVendorSearchArgs(style, vendorEntity, rows, {
        filter: { field: 'stage', operator: 'equal', value: 'prefix-{{config.stage}}' },
      }),
      'single {{ref}}',
    );
    // A pre-hinted ref is rejected too (a hint on a comparand is meaningless, and would
    // resolve inconsistently across vendors) — only a clean {{ns.path}} is threaded.
    expectFailure(
      deriveVendorSearchArgs(style, vendorEntity, rows, {
        filter: { field: 'stage', operator: 'equal', value: '{{config.stage:number}}' },
      }),
      'single {{ref}}',
    );
    // Fail CLOSED at install for a malformed / unresolvable ref (namespace-less,
    // unknown namespace, or whitespace) — these would otherwise emit an unresolvable
    // `{{…:soql_string}}` placeholder that breaks the query at the vendor.
    for (const bad of ['{{config}}', '{{bogus.stage}}', '{{ }}']) {
      expectFailure(
        deriveVendorSearchArgs(style, vendorEntity, rows, {
          filter: { field: 'stage', operator: 'equal', value: bad },
        }),
        'single {{ref}}',
      );
    }
  });

  it('rejects literal type mismatches', () => {
    expectFailure(
      hubspotSearch({
        filter: { field: 'amount', operator: 'equal', value: 'lots' },
      }),
      'must be a number literal',
    );
  });

  it.each(['contains', 'not_contains'] as const)('rejects %s on non-string fields', (operator) => {
    expectFailure(
      hubspotSearch({
        filter: { field: 'amount', operator, value: 30000 },
      }),
      'requires a string field',
    );
  });

  it('rejects unmapped filter and sort fields', () => {
    expectFailure(
      hubspotSearch({
        filter: { field: 'bogus', operator: 'equal', value: 'x' },
      }),
      "filter references canonical field 'bogus'",
    );
    expectFailure(
      hubspotSearch({
        sort: { field: 'bogus' },
      }),
      "sort references canonical field 'bogus'",
    );
  });

  it('rejects OR filter objects that mix condition keys with the OR-groups key', () => {
    expectFailure(
      hubspotSearch({
        filter: {
          field: 'stage',
          operator: 'equal',
          value: 'x',
          any: [{ field: 'stage', operator: 'equal', value: 'y' }],
        },
      }),
      'mixes',
    );
  });

  it('rejects an unsafe SOQL filter identifier referenced only by a later OR group', () => {
    expectFailure(
      deriveVendorSearchArgs(
        'soql',
        'opportunity',
        salesforceRowsWithFieldPath('amount', 'Amount; DROP'),
        {
          filter: {
            any: [
              { field: 'stage', operator: 'equal', value: 'x' },
              { field: 'amount', operator: 'greater', value: 5 },
            ],
          },
        },
      ),
      'SOQL identifier',
    );
  });

  it('allows sorting on datetime fields for both vendors', () => {
    const hubspotArgs = expectOk(
      hubspotSearch({
        sort: { field: 'key_dates.close_date', direction: 'desc' },
      }),
    );
    const salesforceArgs = expectOk(
      salesforceSearch({
        sort: { field: 'key_dates.close_date', direction: 'desc' },
      }),
    );

    expect(hubspotArgs['body.sorts']).toEqual([
      { propertyName: 'closedate', direction: 'DESCENDING' },
    ]);
    expect(salesforceArgs['query.q']).toBe(`${salesforceBaseSelect} ORDER BY CloseDate DESC LIMIT ${PAGINATION_MAX_RECORDS}`);
  });
});

describe('deriveVendorSearchArgs - a COMPUTED (derivation) field is SELECTable but not server-side filter/sort', () => {
  // A derived row: `field_path` carries only the PRIMARY closed flag; the derivation
  // computes the tri-state from two flags. It is projectable + SELECTable, but it is
  // NOT a single vendor field to filter / ORDER BY on server-side.
  const isClosedRow = (closedPath: string, wonPath: string): EntityFieldRow =>
    entityField({
      entity: 'deal', field_path: closedPath, maps_to: 'close_state',
      derivation: { kind: 'closed_state', closed_path: closedPath, won_path: wonPath },
    });
  const hsRows = (): EntityFieldRow[] => [
    ...hubspotDealRows(),
    isClosedRow('properties.hs_is_closed', 'properties.hs_is_closed_won'),
  ];
  const sfRows = (): EntityFieldRow[] => [
    ...salesforceOpportunityRows(),
    isClosedRow('IsClosed', 'IsWon'),
  ];

  it('the SELECT fetches BOTH derivation input flags (rowSelectPaths expansion)', () => {
    const args = expectOk(deriveVendorSearchArgs('hubspot_search', 'deal', hsRows(), {}));
    expect(args['body.properties']).toEqual(
      expect.arrayContaining(['hs_is_closed', 'hs_is_closed_won']),
    );
    // soql: both flags land in the SELECT clause too.
    const soql = expectOk(deriveVendorSearchArgs('soql', 'opportunity', sfRows(), {}));
    expect(soql['query.q']).toContain('IsClosed');
    expect(soql['query.q']).toContain('IsWon');
  });

  it('a FILTER on a derived field fails closed (hubspot + soql)', () => {
    expectFailure(
      deriveVendorSearchArgs('hubspot_search', 'deal', hsRows(), {
        filter: { field: 'close_state', operator: 'equal', value: 'open' },
      }),
      'COMPUTED (derived)',
    );
    expectFailure(
      deriveVendorSearchArgs('soql', 'opportunity', sfRows(), {
        filter: { field: 'close_state', operator: 'equal', value: 'open' },
      }),
      'COMPUTED (derived)',
    );
  });

  it('a SORT on a derived field fails closed (hubspot + soql)', () => {
    expectFailure(
      deriveVendorSearchArgs('hubspot_search', 'deal', hsRows(), {
        sort: { field: 'close_state', direction: 'desc' },
      }),
      'COMPUTED (derived)',
    );
    expectFailure(
      deriveVendorSearchArgs('soql', 'opportunity', sfRows(), {
        sort: { field: 'close_state', direction: 'asc' },
      }),
      'COMPUTED (derived)',
    );
  });
});

describe('deriveVendorSearchArgs — datetime filters (G2 request side)', () => {
  // Realistic granular fixtures mirroring the registry: close_date is a DATE field
  // on both vendors, created_at a DATETIME field.
  const datedHubspotRows = (): EntityFieldRow[] => [
    entityField({ entity: 'deal', field_path: 'properties.dealname', maps_to: 'name' }),
    entityField({ entity: 'deal', field_path: 'properties.amount', maps_to: 'amount', type: 'number' }),
    entityField({ entity: 'deal', field_path: 'properties.closedate', maps_to: 'key_dates.close_date', type: 'datetime', date_granularity: 'date' }),
    entityField({ entity: 'deal', field_path: 'properties.createdate', maps_to: 'key_dates.created_at', type: 'datetime', date_granularity: 'datetime' }),
  ];
  const datedSalesforceRows = (): EntityFieldRow[] => [
    entityField({ entity: 'opportunity', field_path: 'Name', maps_to: 'name' }),
    entityField({ entity: 'opportunity', field_path: 'Amount', maps_to: 'amount', type: 'number' }),
    entityField({ entity: 'opportunity', field_path: 'CloseDate', maps_to: 'key_dates.close_date', type: 'datetime', date_granularity: 'date' }),
    entityField({ entity: 'opportunity', field_path: 'CreatedDate', maps_to: 'key_dates.created_at', type: 'datetime', date_granularity: 'datetime' }),
  ];
  const hsDated = (rawArgs: Record<string, unknown>): SearchArgsResult =>
    deriveVendorSearchArgs('hubspot_search', 'deal', datedHubspotRows(), rawArgs);
  const sfDated = (rawArgs: Record<string, unknown>): SearchArgsResult =>
    deriveVendorSearchArgs('soql', 'opportunity', datedSalesforceRows(), rawArgs);

  it('formats a DATE-granularity filter as YYYY-MM-DD (HubSpot string value + UNQUOTED SOQL literal)', () => {
    const hs = expectOk(hsDated({ filter: { field: 'key_dates.close_date', operator: 'less', value: '2026-01-01' } }));
    expect(hs['body.filterGroups']).toEqual([
      { filters: [{ propertyName: 'closedate', operator: 'LT', value: '2026-01-01' }] },
    ]);
    const sf = expectOk(sfDated({ filter: { field: 'key_dates.close_date', operator: 'less', value: '2026-01-01' } }));
    expect(sf['query.q']).toContain('WHERE CloseDate < 2026-01-01 ');
    // SOQL date literals are UNQUOTED — no single quotes around the value.
    expect(sf['query.q']).not.toContain("'2026-01-01'");
  });

  it('formats a DATETIME-granularity filter as full ISO-Z (both vendors)', () => {
    const hs = expectOk(hsDated({ filter: { field: 'key_dates.created_at', operator: 'greater_or_equal', value: '2026-03-15T14:30:00Z' } }));
    expect(hs['body.filterGroups']).toEqual([
      { filters: [{ propertyName: 'createdate', operator: 'GTE', value: '2026-03-15T14:30:00Z' }] },
    ]);
    const sf = expectOk(sfDated({ filter: { field: 'key_dates.created_at', operator: 'greater_or_equal', value: '2026-03-15T14:30:00Z' } }));
    expect(sf['query.q']).toContain('WHERE CreatedDate >= 2026-03-15T14:30:00Z ');
  });

  it('normalizes an epoch-ms threshold to the field granularity', () => {
    const ms = 1735689600000; // 2025-01-01T00:00:00.000Z
    const hsDate = expectOk(hsDated({ filter: { field: 'key_dates.close_date', operator: 'equal', value: ms } }));
    expect(hsDate['body.filterGroups']).toEqual([
      { filters: [{ propertyName: 'closedate', operator: 'EQ', value: '2025-01-01' }] },
    ]);
    const sfDt = expectOk(sfDated({ filter: { field: 'key_dates.created_at', operator: 'equal', value: ms } }));
    expect(sfDt['query.q']).toContain('WHERE CreatedDate = 2025-01-01T00:00:00Z ');
  });

  it('supports a datetime field in IN and unary operators', () => {
    const hsIn = expectOk(hsDated({ filter: { field: 'key_dates.close_date', operator: 'in', value: ['2026-01-01', '2026-02-01'] } }));
    expect(hsIn['body.filterGroups']).toEqual([
      { filters: [{ propertyName: 'closedate', operator: 'IN', values: ['2026-01-01', '2026-02-01'] }] },
    ]);
    const sfNull = expectOk(sfDated({ filter: { field: 'key_dates.close_date', operator: 'is_not_null' } }));
    expect(sfNull['query.q']).toContain('WHERE CloseDate != null');
  });

  it('rejects an unparseable datetime threshold', () => {
    expectFailure(hsDated({ filter: { field: 'key_dates.close_date', operator: 'less', value: 'not-a-date' } }), 'ISO date');
    expectFailure(sfDated({ filter: { field: 'key_dates.created_at', operator: 'less', value: '' } }), 'ISO date');
  });

  it('rejects an out-of-range epoch-ms threshold (fails closed, never throws / emits an expanded year)', () => {
    // A finite-but-absurd ms would make new Date(ms).toISOString() throw RangeError
    // or emit a `±YYYYYY` expanded year — both must fail closed, not crash.
    expectFailure(hsDated({ filter: { field: 'key_dates.close_date', operator: 'less', value: 1e20 } }), 'ISO date');
    expectFailure(sfDated({ filter: { field: 'key_dates.created_at', operator: 'greater', value: -1e20 } }), 'ISO date');
  });
});

describe('deriveVendorSearchArgs — string-field {{ref}} filters (B1)', () => {
  // A PURE {{ref}} on a STRING field is threaded through both dialects: HubSpot rides
  // it as a JSON body value (resolved at runtime, injection-safe like a write body);
  // Salesforce emits it carrying a `soql_string` / `soql_like` escape hint the resolver
  // applies at interpolation. The runtime escape itself is proven in the contracts
  // resolve test (resolveDeep over the emitted query.q); here we assert the BUILD output.

  it('HubSpot rides a string ref as the JSON filter value verbatim', () => {
    const args = expectOk(
      hubspotSearch({ filter: { field: 'stage', operator: 'equal', value: '{{config.stage}}' } }),
    );
    expect(args['body.filterGroups']).toEqual([
      { filters: [{ propertyName: 'dealstage', operator: 'EQ', value: '{{config.stage}}' }] },
    ]);
  });

  it('HubSpot rides string refs inside an IN values array (mixed literal + ref)', () => {
    const args = expectOk(
      hubspotSearch({ filter: { field: 'stage', operator: 'in', value: ['Prospecting', '{{config.stage}}'] } }),
    );
    expect(args['body.filterGroups']).toEqual([
      { filters: [{ propertyName: 'dealstage', operator: 'IN', values: ['Prospecting', '{{config.stage}}'] }] },
    ]);
  });

  it('HubSpot rides a string ref as a contains filter value', () => {
    const args = expectOk(
      hubspotSearch({ filter: { field: 'name', operator: 'contains', value: '{{config.q}}' } }),
    );
    expect(args['body.filterGroups']).toEqual([
      { filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: '{{config.q}}' }] },
    ]);
  });

  it('SOQL emits a string ref with the soql_string escape hint (binary)', () => {
    const args = expectOk(
      salesforceSearch({ filter: { field: 'stage', operator: 'equal', value: '{{config.stage}}' } }),
    );
    expect(args['query.q']).toBe(
      `${salesforceBaseSelect} WHERE StageName = {{config.stage:soql_string}} LIMIT ${PAGINATION_MAX_RECORDS}`,
    );
  });

  it('SOQL emits soql_string-hinted refs per element in an IN list (mixed literal + ref)', () => {
    const args = expectOk(
      salesforceSearch({ filter: { field: 'stage', operator: 'in', value: ['Prospecting', '{{config.stage}}'] } }),
    );
    expect(args['query.q']).toBe(
      `${salesforceBaseSelect} WHERE StageName IN ('Prospecting', {{config.stage:soql_string}}) ` +
        `LIMIT ${PAGINATION_MAX_RECORDS}`,
    );
  });

  it('SOQL emits a string ref with the soql_like escape hint (contains / not_contains)', () => {
    const containsArgs = expectOk(
      salesforceSearch({ filter: { field: 'name', operator: 'contains', value: '{{config.q}}' } }),
    );
    expect(containsArgs['query.q']).toBe(
      `${salesforceBaseSelect} WHERE Name LIKE {{config.q:soql_like}} LIMIT ${PAGINATION_MAX_RECORDS}`,
    );
    const notContainsArgs = expectOk(
      salesforceSearch({ filter: { field: 'name', operator: 'not_contains', value: '{{config.q}}' } }),
    );
    expect(notContainsArgs['query.q']).toBe(
      `${salesforceBaseSelect} WHERE (NOT Name LIKE {{config.q:soql_like}}) LIMIT ${PAGINATION_MAX_RECORDS}`,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// D-190 Slice 4 — canonicalFilterableFields (the queryability rule as a function)
// + the fail-closed filter/sort reject naming the server-filterable set.
// ────────────────────────────────────────────────────────────────

/** HubSpot deal rows + the `close_state` DERIVATION (two booleans) — the registry
 *  shape, where close_state is read-only / never server-filterable. */
const hubspotDealRowsWithCloseState = (): EntityFieldRow[] => [
  ...hubspotDealRows(),
  entityField({
    entity: 'deal',
    field_path: 'properties.hs_is_closed',
    maps_to: 'close_state',
    derivation: {
      kind: 'closed_state',
      closed_path: 'properties.hs_is_closed',
      won_path: 'properties.hs_is_closed_won',
    },
  }),
];

const sortedFilterable = (
  searchStyle: Parameters<typeof canonicalFilterableFields>[0],
  vendorEntity: string,
  rows: EntityFieldRow[],
): string[] => [...canonicalFilterableFields(searchStyle, vendorEntity, rows)].sort();

describe('canonicalFilterableFields - the queryability rule per dialect', () => {
  it('HubSpot search filters any single-source property (datetime needs granularity)', () => {
    // close_date here is datetime WITHOUT granularity → not filterable (matches the
    // resolver's fail-closed gate); the rest are plain single-source fields.
    expect(sortedFilterable('hubspot_search', 'deal', hubspotDealRows())).toEqual([
      'amount', 'name', 'owner', 'stage',
    ]);
  });

  it('HubSpot filters a datetime field once it declares granularity', () => {
    const rows = hubspotDealRows().map((r) =>
      r.maps_to === 'key_dates.close_date' ? { ...r, date_granularity: 'date' as const } : r,
    );
    expect(
      canonicalFilterableFields('hubspot_search', 'deal', rows).has('key_dates.close_date'),
    ).toBe(true);
  });

  it('Salesforce filters safe SOQL identifiers, never an unsafe one', () => {
    expect(sortedFilterable('soql', 'opportunity', salesforceOpportunityRows())).toEqual([
      'amount', 'name', 'owner', 'stage',
    ]);
    const unsafe = [
      ...salesforceOpportunityRows(),
      entityField({ entity: 'opportunity', field_path: 'Bad-Field', maps_to: 'weird' }),
    ];
    expect(canonicalFilterableFields('soql', 'opportunity', unsafe).has('weird')).toBe(false);
  });

  it('Pipedrive filters only its whitelisted params + id/update_time (not name/amount)', () => {
    // name→title and amount→value are NOT Pipedrive query params → read-only; close_state
    // →status IS (the one vendor that can server-filter it), updated_at→update_time is a
    // range param, id is the `ids` special case.
    expect(sortedFilterable('pipedrive_filter', 'deal', pipedriveDealRows())).toEqual([
      'close_state', 'id', 'owner', 'stage', 'updated_at',
    ]);
  });

  it('excludes a DERIVED canonical field (close_state on HubSpot/SF is read-only)', () => {
    const set = canonicalFilterableFields('hubspot_search', 'deal', hubspotDealRowsWithCloseState());
    expect(set.has('close_state')).toBe(false);
    expect(set.has('name')).toBe(true);
  });

  it('excludes an object/json field', () => {
    const rows = [
      ...hubspotDealRows(),
      entityField({ entity: 'deal', field_path: 'properties.metadata', maps_to: 'metadata', type: 'json' }),
    ];
    expect(canonicalFilterableFields('hubspot_search', 'deal', rows).has('metadata')).toBe(false);
  });

  it('is empty when the catalog declares no search dialect', () => {
    expect(canonicalFilterableFields(undefined, 'deal', hubspotDealRows()).size).toBe(0);
  });
});

describe('deriveVendorSearchArgs - a filter/sort reject names the server-filterable set (D-190 Slice 4)', () => {
  it('a DERIVED-field filter reject lists what CAN be pushed down (and not the derived field)', () => {
    const result = deriveVendorSearchArgs('hubspot_search', 'deal', hubspotDealRowsWithCloseState(), {
      filter: { field: 'close_state', operator: 'equal', value: 'won' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('COMPUTED (derived)');
    const hint = result.reason.slice(result.reason.indexOf('server-filterable canonical fields on this connection:'));
    expect(hint).not.toBe('');
    expect(hint).toContain('name');
    expect(hint).toContain('owner');
    // close_state is the derived field — it must NOT appear in the pushable list.
    expect(hint).not.toContain('close_state');
  });

  it('an UNMAPPED-field filter reject lists the server-filterable set', () => {
    expectFailure(
      hubspotSearch({ filter: { field: 'not_a_field', operator: 'equal', value: 'x' } }),
      'server-filterable canonical fields on this connection:',
    );
  });

  it('a DERIVED-field sort reject lists the server-filterable set', () => {
    const result = deriveVendorSearchArgs('hubspot_search', 'deal', hubspotDealRowsWithCloseState(), {
      sort: { field: 'close_state', direction: 'desc' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('cannot sort on canonical field');
    expect(result.reason).toContain('server-filterable canonical fields on this connection:');
  });
});
