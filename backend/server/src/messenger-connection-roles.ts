/** What a messenger CONNECTION can do — the declared vendor ceiling narrowed by
 *  the mode that row actually runs.
 *
 *  Two consumers ask this about a live row (the messenger turn and the
 *  commitment funnel) and both already hold a connection store, so the read
 *  lives here once rather than being spelled at each gate. Discord is the only
 *  vendor whose answer moves with the mode today — its Gateway carries ordinary
 *  messages, its Interactions webhook does not — and that is exactly the kind of
 *  fact that goes stale when it is restated per call site.
 *
 *  Three outcomes, and the middle one is the point:
 *    - an UNDECLARED vendor is a positive "no" — nothing declares it, so every
 *      axis is false;
 *    - a row that cannot be read (no store, missing, unparseable) returns
 *      `null`: "not my answer to give". It is NOT permission. Every caller has
 *      a stricter, more specific gate immediately behind this one — the turn
 *      re-resolves the credential and the bound conversation, the funnel needs
 *      the row's match patterns — and refusing HERE would replace an accurate
 *      diagnosis ("no credential / recipient enrolled") with a wrong one
 *      ("declares no messenger role"). An operator reads that line;
 *    - a readable row resolves through its `ingress_mode`, and a malformed one
 *      falls to the FLOOR via the shared resolver's `null`, because an
 *      unresolvable mode is not evidence of a capability. */

import {
  getMessengerVendorDeclaration,
  resolveMessengerConnectionIngressMode,
  resolveMessengerVendorRoles,
  type ChannelRoles,
} from '@recued/contracts';

import type { ConnectionStoreSqlite } from './storage/connection-store.js';

const NO_ROLES: ChannelRoles = {
  notification: false,
  approval: false,
  messenger: false,
};

export const readMessengerConnectionRoles = (
  store: ConnectionStoreSqlite | undefined,
  vendor: string,
  connectionName: string,
): ChannelRoles | null => {
  const declaration = getMessengerVendorDeclaration(vendor);
  if (declaration === null) return NO_ROLES;
  // Only read the row when the answer can actually depend on it. A vendor that
  // declares no narrowing has the same roles in every mode, so touching the
  // store would buy nothing and cost something real: a second read of a row the
  // caller is about to read anyway, and with it a window where the role gate and
  // the credential gate see different rows.
  if (declaration.ingress.mode_roles === undefined) return { ...declaration.roles };
  if (store === undefined) return null;
  let row: { config_json: string } | null;
  try {
    row = store.get('notification', connectionName);
  } catch {
    return null;
  }
  if (row === null) return null;
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    return null;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  return resolveMessengerVendorRoles(
    declaration,
    resolveMessengerConnectionIngressMode(declaration, config as Record<string, unknown>),
  );
};

/** The gate form: refuse only on a POSITIVE no. `null` (mode unestablished)
 *  falls through to the caller's stricter gate — see the header. */
export const messengerConnectionRefusesTurn = (
  store: ConnectionStoreSqlite | undefined,
  vendor: string,
  connectionName: string,
): boolean => readMessengerConnectionRoles(store, vendor, connectionName)?.messenger === false;
