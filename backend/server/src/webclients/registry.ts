/** D-148 § A.4.2 — server-side webclient connection registry.
 *
 *  Tracks the per-webclient WS connection state the server uses to:
 *
 *    - Drive the realtime broadcast bus's per-pair fan-out — one
 *      payload, fan to every connected webclient under the same
 *      `client_token_id`.
 *    - Surface webclient presence + cert pin status in Settings →
 *      Server → Clients.
 *    - Bind approval nonces to a specific `(approval_id,
 *      responder_client_id)` tuple so a leaked nonce on one client
 *      cannot resolve approvals on another.
 *
 *  In-memory; survives only as long as the server process does.
 *  Webclient bearer tokens persist (via `client_tokens` from D-148
 *  P2); the registry repopulates on webclient reconnect.
 */

export interface WebclientConnectionRecord {
  client_token_id: string;
  client_label?: string;
  /** Active WS session id; rotates on each reconnect. */
  session_id: string;
  /** Unix-ms of the current connection's start. */
  online_since: number;
  /** Last server-observed inbound frame; the keepalive ticker
   *  advances this. */
  last_seen_at: number;
  /** Cert fingerprint the webclient presented at handshake. Two-pin
   *  rotation (current vs next) is resolved before the handshake
   *  reaches this record; the registry only sees the resolved
   *  current fingerprint. */
  observed_cert_fingerprint?: string;
}

export interface WebclientRegistry {
  /** Record a fresh connection. Replaces any prior entry for the
   *  same `client_token_id` (reconnect semantics — fresh session id
   *  is canonical). */
  attach(record: WebclientConnectionRecord): void;
  /** Drop a connection. Idempotent on absent entry. */
  detach(client_token_id: string): void;
  /** Mark a heartbeat tick. */
  touch(client_token_id: string, at: number): void;
  /** Snapshot — used by Settings + the broadcast fan-out. */
  list(): WebclientConnectionRecord[];
  /** Look up by token id. */
  get(client_token_id: string): WebclientConnectionRecord | null;
  /** Subset by session id (used by the approval-respond rpc to
   *  cross-check that the resolved client matches the active
   *  session — defense-in-depth on the nonce binding). */
  bySession(session_id: string): WebclientConnectionRecord | null;
  /** Wipe all connections (server shutdown / test reset). */
  clear(): void;
}

export const createWebclientRegistry = (): WebclientRegistry => {
  const records = new Map<string, WebclientConnectionRecord>();
  return {
    attach(record) {
      records.set(record.client_token_id, record);
    },
    detach(client_token_id) {
      records.delete(client_token_id);
    },
    touch(client_token_id, at) {
      const entry = records.get(client_token_id);
      if (entry) entry.last_seen_at = at;
    },
    list() {
      return [...records.values()];
    },
    get(client_token_id) {
      return records.get(client_token_id) ?? null;
    },
    bySession(session_id) {
      for (const r of records.values()) {
        if (r.session_id === session_id) return r;
      }
      return null;
    },
    clear() {
      records.clear();
    },
  };
};
