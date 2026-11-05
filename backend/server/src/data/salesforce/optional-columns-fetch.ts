/** D-338 §15 — a Salesforce query that names a column the org cannot give is asked again
 *  without it.
 *
 *  SOQL answers a column the connected user may not see (a profile hides it), or one the
 *  object does not have, with a 400 for the whole query. The canonical searches SELECT every
 *  field the registry maps (`entityFieldsFromRegistry`), so a profile hiding `Title` or
 *  `Birthdate` failed that org's every contact search, and `ForecastAmount`, which is not on
 *  the standard Opportunity, its every deal search. The registry marks such fields
 *  `select_if_present`. This fetch, under the connection API handler, asks a refused query
 *  again without them, and keeps for a day, per org and object, what had to go.
 *
 *  ⛔ Never decided from the refusal's words: SOQL echoes the whole query first, which names
 *  every column asked for. A retry that is answered is the proof; one that is refused too
 *  leaves the first refusal to the caller, as before.
 *  ⛔ A column the rest of the query uses (a filter on `Title`) is never dropped: the
 *  query would still be refused, and a dropped filter would change which records match.
 *  ⛔ Shared per fetch (`withSalesforceOptionalColumns`): the handler's OAuth refresh
 *  coalesces by fetch identity, as `withConnectionRecoveryFetch` does. */

import { CONNECTION_VENDOR_ENTITIES, type ConnectionVendorEntity } from '@recued/contracts';
import { discardResponseBody } from '@recued/ingredients';

/** How long an org's dropped columns are believed before it is asked in full again, so a
 *  profile changed to show a field is read within a day. */
export const OPTIONAL_COLUMNS_RECHECK_MS = 24 * 60 * 60 * 1000;
const QUERY_PATH = /^\/services\/data\/v\d+(?:\.\d+)?\/query\/?$/u;
const QUERY_SHAPE = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)(\b[\s\S]*)$/iu;
const PLAIN_COLUMN = /^[A-Za-z_][A-Za-z0-9_.]*$/u;
/** Queries no drop could help, kept so a recipe that runs every few minutes does not ask
 *  three times on each run. Bounded; the oldest goes first. */
const MAX_KEPT_REFUSALS = 200;

/** Lower-cased Salesforce object → its `select_if_present` columns, in registry order. */
export const salesforceOptionalColumns = (
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, string[]>();
  for (const entry of registry) {
    if (entry.vendor !== 'salesforce') continue;
    const columns = entry.meta_fields.flatMap((field) =>
      field.select_if_present === true && field.source_path !== undefined ? [field.source_path] : []);
    if (columns.length > 0) out.set(entry.entity.toLowerCase(), columns);
  }
  return out;
};

interface QueryPlan {
  /** `<origin>|<object>`: one org's one object. */
  readonly key: string;
  readonly url: URL;
  readonly soql: string;
  readonly select: readonly string[];
  readonly object: string;
  readonly rest: string;
  /** The optional columns this query SELECTs and uses nowhere else. */
  readonly droppable: readonly string[];
}

const sameColumn = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** A column as a whole word of the query (a relationship path's dots taken literally). */
const usedIn = (text: string, column: string): boolean =>
  new RegExp(`\\b${escapeRegExp(column)}\\b`, 'iu').test(text);

/** The query this request carries, when it SELECTs an optional column; null for every other
 *  request, which passes through untouched. */
const planOf = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  optional: ReadonlyMap<string, readonly string[]>,
): QueryPlan | null => {
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return null;
  if (typeof input !== 'string' && !(input instanceof URL)) return null;
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    return null;
  }
  if (!QUERY_PATH.test(url.pathname)) return null;
  const soql = url.searchParams.get('q');
  if (soql === null) return null;
  const shape = QUERY_SHAPE.exec(soql);
  if (shape === null) return null;
  const select = shape[1]!.split(',').map((column) => column.trim());
  // A function, an alias or a subquery: not a list this can rewrite.
  if (select.some((column) => !PLAIN_COLUMN.test(column))) return null;
  const object = shape[2]!;
  const rest = shape[3] ?? '';
  const columns = optional.get(object.toLowerCase());
  if (columns === undefined) return null;
  const droppable = columns.filter((column) =>
    select.some((selected) => sameColumn(selected, column))
    && !usedIn(rest, column));
  if (droppable.length === 0) return null;
  return { key: `${url.origin}|${object.toLowerCase()}`, url, soql, select, object, rest, droppable };
};

/** The same request without `drop` in its SELECT. */
const requestWithout = (plan: QueryPlan, drop: readonly string[]): string => {
  const kept = plan.select.filter((column) => !drop.some((dropped) => sameColumn(dropped, column)));
  const url = new URL(plan.url);
  url.searchParams.set('q', `SELECT ${kept.join(', ')} FROM ${plan.object}${plan.rest}`);
  return url.toString();
};

/** What to try without, in order: each column alone, then all of them, so an org hiding
 *  only `Birthdate` keeps its `Title`. */
const dropsToTry = (droppable: readonly string[]): ReadonlyArray<readonly string[]> =>
  droppable.length === 1 ? [droppable] : [...droppable.map((column) => [column]), droppable];

/** The fetch itself. Tests pass a clock; the server shares one per fetch through
 *  `withSalesforceOptionalColumns`. */
export const createSalesforceOptionalColumnsFetch = (
  fetchImpl: typeof fetch,
  options: { readonly now?: () => number; readonly optional?: ReadonlyMap<string, readonly string[]> } = {},
): typeof fetch => {
  const now = options.now ?? Date.now;
  const optional = options.optional ?? salesforceOptionalColumns();
  const dropped = new Map<string, { readonly drop: readonly string[]; readonly at: number }>();
  const refused = new Map<string, number>();
  const fresh = (at: number): boolean => now() - at < OPTIONAL_COLUMNS_RECHECK_MS;

  return async (input, init) => {
    const plan = planOf(input, init, optional);
    if (plan === null) return fetchImpl(input, init);

    const known = dropped.get(plan.key);
    if (known !== undefined && fresh(known.at)) {
      const answer = await fetchImpl(requestWithout(plan, known.drop), init);
      if (answer.status !== 400) return answer;
      // Refused without them too: the org changed. Ask in full, as the first time.
      discardResponseBody(answer);
      dropped.delete(plan.key);
    }

    const first = await fetchImpl(input, init);
    if (first.status !== 400) return first;
    const refusalKey = `${plan.url.origin}|${plan.soql}`;
    const refusedAt = refused.get(refusalKey);
    if (refusedAt !== undefined && fresh(refusedAt)) return first;

    for (const drop of dropsToTry(plan.droppable)) {
      const retry = await fetchImpl(requestWithout(plan, drop), init);
      if (retry.ok) {
        dropped.set(plan.key, { drop, at: now() });
        discardResponseBody(first);
        return retry;
      }
      discardResponseBody(retry);
      // Not a refusal of the query (an expired session, a limit): stop asking.
      if (retry.status !== 400) break;
    }
    refused.delete(refusalKey);
    refused.set(refusalKey, now());
    if (refused.size > MAX_KEPT_REFUSALS) refused.delete(refused.keys().next().value!);
    return first;
  };
};

const shared = new WeakMap<typeof fetch, typeof fetch>();

/** One per fetch, so every executor sharing a fetch shares the wrapper's identity (the
 *  handler's OAuth refresh coalescing keys on it) and what it has learned of each org. */
export const withSalesforceOptionalColumns = (fetchImpl: typeof fetch): typeof fetch => {
  const existing = shared.get(fetchImpl);
  if (existing !== undefined) return existing;
  const made = createSalesforceOptionalColumnsFetch(fetchImpl);
  shared.set(fetchImpl, made);
  return made;
};
