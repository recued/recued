/** Vendor OAuth permissions are separate from Recued operation grants. */
export interface PackVendorPermissionConnection {
  name: string; display_name: string;
  authentication: 'direct_oauth' | 'broker' | 'other' | 'unknown';
  coverage: 'covered' | 'missing' | 'unknown';
  granted_scopes?: string[]; missing_scopes: string[];
}
export interface PackVendorPermissionChange {
  pack_slug: string; pack_name: string; slot: string;
  vendor?: string; api_base?: string;
  /** Absent means the installed requirements could not be reconstructed. */
  previous_scopes?: string[];
  required_scopes: string[]; added_scopes?: string[]; removed_scopes?: string[];
  current_connections: string[];
  /** The installer forwards the dialog's selected account to this pack. */
  uses_selected_connection?: boolean;
  connections: PackVendorPermissionConnection[];
}
export interface PackVendorPermissionReview {
  fingerprint: string;
  resolved: boolean;
  changes: PackVendorPermissionChange[];
}
export interface PackVendorPermissionConsent {
  fingerprint: string;
  /** Explicitly permits installation before all vendor grants are confirmed. */
  reconnect_later: boolean;
}
export const isPackVendorPermissionReview = (value: unknown): value is PackVendorPermissionReview => {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 512
    && v.every(s => typeof s === 'string' && s.length <= 4096);
  const label = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && v.length <= 4096;
  return record(value) && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && typeof value.resolved === 'boolean' && Array.isArray(value.changes) && value.changes.length <= 512
    && value.changes.every(change => record(change) && label(change.pack_slug) && label(change.pack_name) && label(change.slot)
      && (change.vendor === undefined || label(change.vendor)) && (change.api_base === undefined || label(change.api_base))
      && strings(change.required_scopes) && strings(change.current_connections)
      && (change.uses_selected_connection === undefined || typeof change.uses_selected_connection === 'boolean')
      && (change.previous_scopes === undefined || strings(change.previous_scopes))
      && (change.added_scopes === undefined || strings(change.added_scopes))
      && (change.removed_scopes === undefined || strings(change.removed_scopes))
      && Array.isArray(change.connections) && change.connections.length <= 512
      && change.connections.every(connection => record(connection) && label(connection.name) && label(connection.display_name)
        && typeof connection.authentication === 'string' && ['direct_oauth', 'broker', 'other', 'unknown'].includes(connection.authentication)
        && typeof connection.coverage === 'string' && ['covered', 'missing', 'unknown'].includes(connection.coverage) && strings(connection.missing_scopes)
        && (connection.granted_scopes === undefined || strings(connection.granted_scopes))
        && (value.resolved || connection.coverage === 'unknown')
        && (connection.coverage === 'unknown' ? connection.missing_scopes.length === 0
          : connection.granted_scopes !== undefined && (connection.coverage === 'covered'
            ? connection.missing_scopes.length === 0 : connection.missing_scopes.length > 0))));
};
