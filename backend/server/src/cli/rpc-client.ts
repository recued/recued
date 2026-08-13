/** Local-daemon rpc client for CLI subcommands.
 *
 *  Opens a short-lived WebSocket to the running recued-server, sends
 *  one rpc, awaits the response, closes. Uses the realm_token from the
 *  server's SQLite — which is readable by anyone with filesystem access
 *  to the DB file, which is the same population that runs CLI commands.
 *
 *  Scope: single-shot rpc per connection. For a persistent connection,
 *  use the existing pair-ws client pattern the extension uses.
 */

import { WebSocket } from 'ws';
import { openDatabase } from '../open-database.js';

export interface RpcCallOptions {
  dbPath: string;
  port: number;
  method: string;
  args?: Record<string, unknown>;
  /** Overall timeout (connection + rpc + close). Default 30s. */
  timeoutMs?: number;
}

export class RpcError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Read the persisted realm_token from the server's SQLite DB.
 *  Throws if the DB has never been initialized. */
const readRealmToken = async (dbPath: string): Promise<string> => {
  const db = await openDatabase(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT value FROM server_config WHERE key = 'realm_token'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      throw new RpcError(
        'no_realm_token',
        'server has never been started — no realm token in server_config. Start the daemon first.',
      );
    }
    return row.value;
  } finally {
    db.close();
  }
};

/** Call a single rpc method against the local daemon. Resolves with the
 *  response body, or rejects with an RpcError on any failure. */
export const callLocalRpc = async <T = unknown>(options: RpcCallOptions): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  // Stable per-process id — consecutive CLI calls reconnect AS the same
  // admin instance, so the ws-server's register path treats a fresh ws
  // with the same instance_id as a reconnect (no instance-limit trip
  // from back-to-back `recued-server llm …` invocations).
  const instanceId = `cli-admin-${process.pid}`;

  let realm: string;
  try {
    realm = await readRealmToken(options.dbPath);
  } catch (err) {
    return Promise.reject(err);
  }

  // ⛔ The bearer goes in the AUTHORIZATION HEADER, not the URL. This is a Node
  // `ws` client, so unlike a browser it can set request headers — and a URL is
  // where secrets get written down (process listings, any layer that logs a
  // connect target). Loopback makes the exposure small, not zero, and there is
  // no reason to take it: `extractRealm` checks the header FIRST.
  const url = `ws://127.0.0.1:${options.port}/ws`;
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
      try { ws.close(); } catch { /* ignore */ }
    };

    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${realm}` } });
    const timer = setTimeout(() => {
      settle(() => reject(new RpcError('timeout', `rpc call to ${options.method} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    ws.on('open', () => {
      // Register first (server expects this before it treats us as a
      // legitimate rpc client).
      ws.send(JSON.stringify({
        type: 'register',
        instance_id: instanceId,
        display_name: 'recued CLI',
      }));
      ws.send(JSON.stringify({
        type: 'rpc',
        request_id: requestId,
        method: options.method,
        args: options.args ?? {},
      }));
    });

    ws.on('message', (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'rpc_result' && msg.request_id === requestId) {
        clearTimeout(timer);
        if (msg.error) {
          const err = msg.error as { code?: string; message?: string };
          settle(() => reject(new RpcError(
            err.code ?? 'rpc_error',
            err.message ?? 'rpc failed',
            typeof msg.status === 'number' ? msg.status : undefined,
          )));
          return;
        }
        settle(() => resolve((msg.result ?? {}) as T));
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(() => reject(new RpcError('connection_error', err.message)));
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        settle(() => reject(new RpcError('connection_closed', 'ws closed before rpc response')));
      }
    });
  });
};
