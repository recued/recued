/** D-338 §15 — a Salesforce query naming a column the org cannot give is asked again without
 *  it. The org here is a model of SOQL: a query that names a hidden column ANYWHERE is
 *  refused whole, with a 400; every other query is answered. */

import { describe, expect, it } from 'vitest';

import {
  OPTIONAL_COLUMNS_RECHECK_MS,
  createSalesforceOptionalColumnsFetch,
  salesforceOptionalColumns,
  withSalesforceOptionalColumns,
} from '../data/salesforce/optional-columns-fetch.js';

const BASE = 'https://acme.my.salesforce.com';
/** What the canonical searches send (`deriveVendorSearchArgs`, the registry's rows). */
const CONTACT_SOQL = 'SELECT Id, Email, FirstName, LastName, LeadSource, OwnerId, AccountId, LastActivityDate, Phone, Title, '
  + 'MailingStreet, MailingCity, MailingState, MailingPostalCode, MailingCountry, Birthdate FROM Contact LIMIT 1000';
const DEAL_SOQL = 'SELECT Id, Name, StageName, Amount, OwnerId, CloseDate, CreatedDate, ForecastAmount, IsClosed, IsWon, '
  + 'Probability, NextStep FROM Opportunity LIMIT 1000';

const queryUrl = (soql: string): string => `${BASE}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
const soqlOf = (url: string): string => new URL(url).searchParams.get('q') ?? '';
const selectOf = (url: string): string[] => /^SELECT (.+?) FROM /u.exec(soqlOf(url))?.[1]!.split(', ') ?? [];
const GET = { method: 'GET' } as const;

const org = (initiallyHidden: readonly string[]) => {
  const hidden = new Set(initiallyHidden);
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
    if (new URL(url).pathname.endsWith('/query')) {
      const soql = soqlOf(url);
      if ([...hidden].some((column) => new RegExp(`\\b${column}\\b`, 'u').test(soql))) {
        return new Response(JSON.stringify([{ message: `\n${soql}\n^\nERROR`, errorCode: 'INVALID_FIELD' }]), { status: 400 });
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const queries = () => calls.filter((call) => call.startsWith('GET ') && call.includes('/query?')).map((call) => call.slice(4));
  return { hidden, calls, queries, fetchImpl };
};

describe('D-338 §15 — the registry names what a Salesforce query asks for only where the org has it', () => {
  it('Title and Birthdate on a contact, ForecastAmount on an opportunity, and nothing else', () => {
    expect(Object.fromEntries(salesforceOptionalColumns())).toEqual({
      opportunity: ['ForecastAmount'],
      contact: ['Title', 'Birthdate'],
    });
  });
});

describe('D-338 §15 — a refused query is asked again without the columns the org cannot give', () => {
  it('an org hiding Birthdate: answered without it, Title kept, and its next search asks without it at once', async () => {
    const sf = org(['Birthdate']);
    const f = createSalesforceOptionalColumnsFetch(sf.fetchImpl);
    expect((await f(queryUrl(CONTACT_SOQL), GET)).status).toBe(200);
    // In full (refused), without Title (still refused), without Birthdate (answered).
    expect(sf.queries().map((url) => [selectOf(url).includes('Title'), selectOf(url).includes('Birthdate')]))
      .toEqual([[true, true], [false, true], [true, false]]);
    expect((await f(queryUrl(CONTACT_SOQL), GET)).status).toBe(200);
    expect(sf.queries()).toHaveLength(4);
    expect(selectOf(sf.queries()[3]!)).toContain('Title');
    expect(selectOf(sf.queries()[3]!)).not.toContain('Birthdate');
  });

  it('an org hiding Title keeps Birthdate, and one hiding both is asked without both', async () => {
    const titleOnly = org(['Title']);
    expect((await createSalesforceOptionalColumnsFetch(titleOnly.fetchImpl)(queryUrl(CONTACT_SOQL), GET)).status).toBe(200);
    expect(titleOnly.queries()).toHaveLength(2);
    expect(selectOf(titleOnly.queries()[1]!)).toContain('Birthdate');
    const both = org(['Title', 'Birthdate']);
    expect((await createSalesforceOptionalColumnsFetch(both.fetchImpl)(queryUrl(CONTACT_SOQL), GET)).status).toBe(200);
    expect(both.queries()).toHaveLength(4);
    expect(selectOf(both.queries()[3]!).filter((column) => column === 'Title' || column === 'Birthdate')).toEqual([]);
  });

  it('a deal search in an org whose Opportunity has no ForecastAmount', async () => {
    const sf = org(['ForecastAmount']);
    expect((await createSalesforceOptionalColumnsFetch(sf.fetchImpl)(queryUrl(DEAL_SOQL), GET)).status).toBe(200);
    expect(sf.queries().map((url) => selectOf(url).includes('ForecastAmount'))).toEqual([true, false]);
  });

  it('a query refused for another column is refused as it was, and the next run of it is not asked three more times', async () => {
    const sf = org(['LeadSource']);
    const f = createSalesforceOptionalColumnsFetch(sf.fetchImpl);
    const first = await f(queryUrl(CONTACT_SOQL), GET);
    expect(first.status).toBe(400);
    // The caller gets the first refusal, the one for the query it sent.
    expect(await first.json()).toMatchObject([{ message: expect.stringContaining('Birthdate FROM Contact') }]);
    expect(sf.queries()).toHaveLength(4);
    expect((await f(queryUrl(CONTACT_SOQL), GET)).status).toBe(400);
    expect(sf.queries()).toHaveLength(5);
  });

  it('a column the rest of the query uses is never dropped', async () => {
    const sf = org(['Title']);
    const filtered = CONTACT_SOQL.replace(' LIMIT 1000', " WHERE Title LIKE '%CEO%' LIMIT 1000");
    expect((await createSalesforceOptionalColumnsFetch(sf.fetchImpl)(queryUrl(filtered), GET)).status).toBe(400);
    expect(sf.queries().length).toBeGreaterThan(1);
    for (const url of sf.queries()) {
      expect(selectOf(url)).toContain('Title');
      expect(soqlOf(url)).toContain("WHERE Title LIKE '%CEO%'");
    }
  });

  it('a day on, the org is asked in full again, so a profile changed to show the field is read', async () => {
    let clock = 1_800_000_000_000;
    const sf = org(['Birthdate']);
    const f = createSalesforceOptionalColumnsFetch(sf.fetchImpl, { now: () => clock });
    await f(queryUrl(CONTACT_SOQL), GET);
    sf.hidden.delete('Birthdate');
    await f(queryUrl(CONTACT_SOQL), GET);
    expect(selectOf(sf.queries().at(-1)!)).not.toContain('Birthdate');
    clock += OPTIONAL_COLUMNS_RECHECK_MS;
    expect((await f(queryUrl(CONTACT_SOQL), GET)).status).toBe(200);
    expect(selectOf(sf.queries().at(-1)!)).toContain('Birthdate');
  });

  it('an org that changed is asked in full again, at once', async () => {
    const sf = org(['Birthdate']);
    const f = createSalesforceOptionalColumnsFetch(sf.fetchImpl);
    await f(queryUrl(CONTACT_SOQL), GET);
    sf.hidden.add('Title');
    const before = sf.queries().length;
    expect((await f(queryUrl(CONTACT_SOQL), GET)).status).toBe(200);
    // Without Birthdate (refused now), in full, without Title, without Birthdate, without both.
    expect(sf.queries().length - before).toBe(5);
    expect(selectOf(sf.queries().at(-1)!).filter((column) => column === 'Title' || column === 'Birthdate')).toEqual([]);
  });
});

describe('D-338 §15 — every other request passes through untouched', () => {
  it('a write, a record read, an object with no optional column, a SELECT with a function', async () => {
    const sf = org(['Birthdate', 'Industry']);
    const f = createSalesforceOptionalColumnsFetch(sf.fetchImpl);
    await f(queryUrl(CONTACT_SOQL), { method: 'POST' });
    await f(`${BASE}/services/data/v60.0/sobjects/Contact/003A0000005XYZAB`, GET);
    expect((await f(queryUrl('SELECT Id, Industry FROM Account LIMIT 10'), GET)).status).toBe(400);
    expect((await f(queryUrl('SELECT COUNT(Id), Birthdate FROM Contact'), GET)).status).toBe(400);
    expect(sf.calls).toHaveLength(4);
    expect(sf.calls.map((call) => call.split(' ')[0])).toEqual(['POST', 'GET', 'GET', 'GET']);
  });

  it('one wrapper per fetch: the handler coalesces its OAuth refreshes by fetch identity', () => {
    const one = org([]).fetchImpl;
    const other = org([]).fetchImpl;
    expect(withSalesforceOptionalColumns(one)).toBe(withSalesforceOptionalColumns(one));
    expect(withSalesforceOptionalColumns(one)).not.toBe(withSalesforceOptionalColumns(other));
  });
});
