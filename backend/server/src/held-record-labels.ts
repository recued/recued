/** D-336 (spec §50) — how an approval names the CRM records a held call changes.
 *
 *  A change to a CRM record waits for the owner when the caller is an AI app, or when the
 *  owner's rule says to ask. Its approval named the record only by its id:
 *  `hubspot_contact_hubspot_51` on the card and, once the gateway has given the call the
 *  vendor's own id, `contact_id: 51` in the ask. Neither says whose record it is. Recued keeps a
 *  copy of each connected CRM's records (the CRM mirror, D-190), so a record id the held call
 *  carries reads `Mia Whitfield (HubSpot Contact)`, at any depth and under any argument, and so
 *  does the vendor's own id under the argument that carried it. Survey row 5 (spec §41).
 *
 *  Display only, as the people labels are (`held-people-labels.ts`): written into the owner's
 *  approval, never into what the caller is told. A record the mirror does not hold keeps its
 *  id, and a lookup that fails costs the label, never the hold. */

import {
  ANY_ARGUMENT, composePlatformRecordTargetId, composeVendorEntityScope, parsePlatformRecordTargetId,
  recordIdArgKind, type ApprovalValueLabels, type ConnectionVendorEntity,
} from '@recued/contracts';

import { resolveConnectionVendor, type ConnectionStoreSqlite } from './storage/connection-store.js';
import type { CrmRecordMirrorStore } from './storage/crm-record-mirror-store.js';

/** What the labels read records through. */
export interface RecordLookups {
  readonly mirror: Pick<CrmRecordMirrorStore, 'listForConnection'> | undefined;
  /** The vendors and kinds of record ids are read against, pack-declared ones included
   *  (`liveVendorRegistry`). */
  readonly registry: ReadonlyArray<ConnectionVendorEntity>;
}

/** The held call's own record, where its operation names the argument that carries it
 *  (`record_id_arg`). The gateway has given that argument the vendor's own id before the call
 *  is held, so the id is read back on this connection, as the kind of record the argument
 *  names: `contact_id: 51` on `hubspot-main` is `hubspot_contact_hubspot-main_51`. */
export interface HeldRecordArgument {
  readonly argument: string;
  /** The connection's vendor; undefined ⇒ nothing to read it as. */
  readonly vendor: string | undefined;
  readonly connection_name: string;
}

/** The held call's own record argument, from its operation's `record_id_arg` and the connection
 *  it is held on, or undefined when the call names no record argument or no connection. */
export const heldRecordArgument = (
  argument: string | undefined,
  connection_name: string | undefined,
  connections: Pick<ConnectionStoreSqlite, 'get'> | undefined,
): HeldRecordArgument | undefined => {
  if (argument === undefined || connection_name === undefined || connection_name === '') return undefined;
  let vendor: string | undefined;
  try {
    vendor = connections === undefined
      ? undefined
      : resolveConnectionVendor(connections.get('api', connection_name) ?? { config_json: '' });
  } catch {
    vendor = undefined;
  }
  return { argument, vendor, connection_name };
};

/** Bounds: a held call is read as far as a person reads it, never as far as it goes. */
const MAX_DEPTH = 8;
const MAX_STRINGS = 500;
const MAX_LOOKUPS = 100;

export const heldRecordValueLabels = (
  held: readonly unknown[],
  lookups: RecordLookups,
  own?: HeldRecordArgument,
): ApprovalValueLabels | undefined => {
  const { mirror, registry } = lookups;
  if (mirror === undefined) return undefined;
  const anywhere = new Map<string, string>();
  /** The vendor's own id under the argument that carried the record's: `null` where one
   *  argument's id names two records (two connections of one vendor), so neither is named. */
  const byArgument = new Map<string, Map<string, string | null>>();
  const known = new Map<string, string | null>();
  let strings = 0;
  let lookupsDone = 0;
  const labelOf = (value: string): string | undefined => {
    if (known.has(value)) return known.get(value) ?? undefined;
    let label: string | undefined;
    const parsed = parsePlatformRecordTargetId(value, registry);
    if (parsed !== null && lookupsDone < MAX_LOOKUPS) {
      lookupsDone += 1;
      try {
        // The connection's rows from this id on: the record, and any whose id extends it.
        const row = mirror.listForConnection(composeVendorEntityScope(parsed.vendor, parsed.entity), value)
          .find((candidate) => candidate.target_id === value);
        const name = (row?.meta as Readonly<Record<string, unknown>> | undefined)?.['name'];
        const kind = registry.find((entry) => entry.vendor === parsed.vendor && entry.entity === parsed.entity)
          ?.display_name;
        if (typeof name === 'string' && name.trim() !== '' && name.trim() !== value) {
          label = `${name.trim()} (${kind ?? `${parsed.vendor} ${parsed.entity}`})`;
        }
      } catch {
        // A label is never worth the hold.
      }
    }
    known.set(value, label ?? null);
    return label;
  };
  const nameUnder = (argument: string, native: string, label: string): void => {
    const ids = byArgument.get(argument) ?? new Map<string, string | null>();
    byArgument.set(argument, ids);
    ids.set(native, ids.has(native) && ids.get(native) !== label ? null : label);
  };
  const visit = (value: unknown, argument: string | undefined, depth: number): void => {
    if (strings >= MAX_STRINGS) return;
    if (typeof value === 'string') {
      strings += 1;
      const label = labelOf(value);
      if (label === undefined) return;
      anywhere.set(value, label);
      const native = parsePlatformRecordTargetId(value, registry)?.native_id;
      if (argument !== undefined && native !== undefined) nameUnder(argument, native, label);
      return;
    }
    if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const member of value) visit(member, argument, depth + 1);
      return;
    }
    for (const [key, member] of Object.entries(value)) visit(member, key, depth + 1);
  };
  for (const args of held) visit(args, undefined, 0);
  // The call's own record, by the vendor's id the gateway gave it: in the operation's arguments,
  // or a catalog step's (`{ operation, args }`).
  const kind = own === undefined ? undefined : recordIdArgKind(own.argument);
  if (own !== undefined && own.vendor !== undefined && kind !== undefined
    && registry.some((entry) => entry.vendor === own.vendor && entry.entity === kind)) {
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    for (const args of held) {
      for (const native of [record(args)?.[own.argument], record(record(args)?.['args'])?.[own.argument]]) {
        if (typeof native !== 'string' || native === '' || parsePlatformRecordTargetId(native, registry) !== null) continue;
        let id: string;
        try {
          id = composePlatformRecordTargetId(own.vendor, kind, own.connection_name, native);
        } catch {
          continue;
        }
        const label = labelOf(id);
        if (label !== undefined) nameUnder(own.argument, native, label);
      }
    }
  }
  if (anywhere.size === 0 && byArgument.size === 0) return undefined;
  const labels: Record<string, Record<string, string>> = {};
  for (const [argument, ids] of byArgument) {
    const named = [...ids].filter((entry): entry is [string, string] => entry[1] !== null);
    if (named.length > 0) labels[argument] = Object.fromEntries(named);
  }
  if (anywhere.size > 0) labels[ANY_ARGUMENT] = Object.fromEntries(anywhere);
  return Object.keys(labels).length > 0 ? labels : undefined;
};
