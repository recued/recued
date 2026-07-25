/** D-192 S4c3 — Dataverse (Dynamics 365) OData v4 change-tracking delta mechanics.
 *
 *  The entity-agnostic half of the Dynamics engagement leaf: the authenticated
 *  fetch, the OData-v4 page parse, the deleted-entity classify, and the 410-resync
 *  detection — everything `drainIdKeyedDelta` (the file-source Kernel-A spine) needs
 *  as its three closures. Dataverse's Web API is OData v4, so the page envelope is
 *  byte-identical to Microsoft Graph's (`value` / `@odata.nextLink` /
 *  `@odata.deltaLink`) — this mirrors `file-source-adapters/onedrive.ts`'s
 *  `parseGraphDeltaPage` verbatim; only the tombstone shape differs (Graph uses a
 *  `deleted` facet on a driveItem; Dataverse change-tracking emits a
 *  `$deletedEntity` reference with `{ id, reason:'deleted' }`).
 *
 *  Change tracking: a normal entity-set query carrying the `Prefer:
 *  odata.track-changes` header returns a final page with an `@odata.deltaLink`; that
 *  link, GET'd next cycle, returns only the changes since. All four activity
 *  entities (email/appointment/phonecall/task) share `activityid` as their primary
 *  key (they are `activitypointer` subtypes), so the classify is uniform across them.
 *
 *  Spec: `docs/d-192-engagement-facet.md` (S4c3); survey Wall-D leaf. */

import type { Classify, DeltaPage, IdKeyedDeltaDeps, ItemClass } from '../../file-source-adapters/id-keyed-delta.js';

// ────────────────────────────────────────────────────────────────
// Fetch abstraction (injected — real `fetch` in prod, a fake in tests)
// ────────────────────────────────────────────────────────────────

export interface DynamicsFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export type DynamicsFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<DynamicsFetchResponse>;

/** A Dataverse Web API error carrying the HTTP status + best-effort OData error
 *  code, so `isDataverseResync` can split a stale-deltaLink reset (410) from a real
 *  failure. */
export class DataverseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'DataverseError';
  }
}

/** Pull `error.code` from a Dataverse error body (best-effort) so a reset can be
 *  detected even if a proxy rewrites the status. */
const dataverseErrorCode = (text: string): string | undefined => {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

/** Authenticated OData GET. Carries `Prefer: odata.track-changes` on every request
 *  — required on the from-scratch query to open change tracking; harmless on a
 *  `nextLink`/`deltaLink` continue (the tracking rides in the URL). `OData-Version`
 *  + `Accept` pin v4 JSON; the lookup-annotation preference surfaces the
 *  `@Microsoft.Dynamics.CRM.lookuplogicalname` hints the edge mapper reads. */
export const dataverseGet = async (
  fetchImpl: DynamicsFetch,
  url: string,
  token: string,
): Promise<unknown> => {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'OData-Version': '4.0',
      'OData-MaxVersion': '4.0',
      Prefer: 'odata.track-changes,odata.include-annotations="Microsoft.Dynamics.CRM.lookuplogicalname"',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DataverseError(res.status, dataverseErrorCode(text), `dataverse GET ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
};

// ────────────────────────────────────────────────────────────────
// Page parse (OData v4 envelope — identical to Graph's)
// ────────────────────────────────────────────────────────────────

/** Parse + STRICTLY validate one Dataverse delta page. Throws (never coerces a
 *  malformed body to `[]`) so a proxy-corrupted 200 can't masquerade as a complete
 *  empty walk — `drainIdKeyedDelta`'s undrained-suppression relies on this throw.
 *  `@odata.nextLink` → `nextRef` (GET'd directly); `@odata.deltaLink` → `watermark`
 *  (the terminal page's next-cycle cursor). */
export const parseDataverseDeltaPage = (res: unknown): DeltaPage => {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new DataverseError(0, undefined, 'dataverse delta response is not an object');
  }
  const obj = res as Record<string, unknown>;
  if (!Array.isArray(obj.value)) {
    throw new DataverseError(0, undefined, 'dataverse delta response has no value array');
  }
  const nextRaw = obj['@odata.nextLink'];
  const deltaRaw = obj['@odata.deltaLink'];
  const nextRef = typeof nextRaw === 'string' && nextRaw.length > 0 ? nextRaw : undefined;
  const watermark = typeof deltaRaw === 'string' && deltaRaw.length > 0 ? deltaRaw : undefined;
  return {
    items: obj.value,
    ...(nextRef !== undefined ? { nextRef } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// Classify (deleted-entity vs activity — uniform across activity types)
// ────────────────────────────────────────────────────────────────

const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Classify one Dataverse delta item. A DELETED reference is guarded FIRST (an item
 *  carrying a deleted marker is a removal): change tracking emits it as
 *  `{ '@odata.context': '…/$deletedEntity', id: '<guid>', reason: 'deleted' }` — the
 *  GUID lives in `id` (not `activityid`). A live activity is a `file` keyed on
 *  `activityid` (the same GUID a deleted ref carries, so last-wins folds an
 *  add-then-delete correctly). An id-less item is unmatchable (`skip` — a full
 *  re-baseline backstops it). */
export const classifyDataverseActivity: Classify = (item): ItemClass => {
  if (item === null || typeof item !== 'object') return { kind: 'skip' };
  const it = item as Record<string, unknown>;
  const context = it['@odata.context'];
  const isDeleted =
    it.reason === 'deleted'
    || (typeof context === 'string' && context.includes('$deletedEntity'))
    || (it['@removed'] !== undefined && it['@removed'] !== null);
  if (isDeleted) {
    const id = nonEmptyString(it.id) ?? nonEmptyString(it.activityid);
    return id !== undefined ? { kind: 'deleted', id } : { kind: 'skip' };
  }
  const activityId = nonEmptyString(it.activityid);
  if (activityId === undefined) return { kind: 'skip' }; // not a keyable activity row
  return { kind: 'file', id: activityId, row: it };
};

// ────────────────────────────────────────────────────────────────
// Reset detection
// ────────────────────────────────────────────────────────────────

/** Dataverse's stale-deltaLink signal — continuing from a too-old / invalid
 *  `@odata.deltaLink` returns HTTP 410 Gone. The generic reconciler recovers by
 *  re-draining from a fresh from-scratch query. The 410 STATUS is primary; a body
 *  error code is a defensive secondary in case a proxy rewrites the status. */
export const isDataverseResync = (err: unknown): boolean =>
  err instanceof DataverseError
  && (err.status === 410 || (err.code !== undefined && err.code.toLowerCase().includes('expired')));

// ────────────────────────────────────────────────────────────────
// Delta deps assembly
// ────────────────────────────────────────────────────────────────

/** Build the `IdKeyedDeltaDeps` (`fetchPage` / `parsePage` / `classify`) for a
 *  Dataverse delta feed — the three closures `drainIdKeyedDelta` folds. `fetchPage`
 *  closes over the connection's bearer token. */
export const buildDataverseDeltaDeps = (
  fetchImpl: DynamicsFetch,
  token: string,
): IdKeyedDeltaDeps => ({
  fetchPage: (ref: string): Promise<unknown> => dataverseGet(fetchImpl, ref, token),
  parsePage: parseDataverseDeltaPage,
  classify: classifyDataverseActivity,
});
