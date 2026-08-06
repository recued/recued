/** Open the booted server's vault so the autonomous schedulers can be driven.
 *
 *  ⛔ THE BENCH SEED SHIPS SEALED, ON PURPOSE. `seed.mjs` says so in its own
 *  output — "vault left uninitialized — run.ts does auth.init per task". Its
 *  keyfile carries `server_identity` + `publisher_identity` and no
 *  `server_vault` key, so `autoUnlockServerVaultFromKeyfile` returns
 *  `'skipped'` and the realm boots ENROLLED BUT SEALED. Every vault-gated
 *  autonomous path then no-ops correctly: the cron and auto-run ticks return
 *  `[]` at their first line, and the housekeeping idle probe skips.
 *
 *  That is why the audit's first scheduler drive produced three confident
 *  findings against a scheduler behaving exactly as designed.
 *
 *  The bench's own answer is an rpc, not a different seed file: pair over
 *  `/auth/pair` with the recovery key, then `auth.init` (uninitialized) or
 *  `auth.unlock` (locked). Because the harness boots the server IN-PROCESS,
 *  that rpc unlocks the very `KeyManager` instance the schedulers read — there
 *  is no exported instance to reach directly, and adding one would be a
 *  production change made for a test.
 *
 *  ⚠ The recovery key is a live 24-word key. It is read in-process and never
 *  logged, never returned, and never included in any report. */

import { readFileSync } from 'node:fs';

/** Matches the bench's own constant so a seed initialised by either path
 *  unlocks with the same password. */
const BENCH_PASSWORD = 'bench-password-substrate';

export type VaultOpenOutcome =
  | {
      readonly ok: true;
      readonly via: 'init' | 'unlock' | 'already-unlocked';
      /** Live authenticated connection — the caller closes it. */
      readonly conn: RpcConn;
    }
  | { readonly ok: false; readonly reason: string };

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Minimal WS rpc client (exported so the pack installer reuses the
 *  authenticated connection rather than pairing twice). — the same envelope shape the bench uses
 *  (`{ type: 'rpc', request_id, method, args }` → `rpc_result` / `rpc_error`). */
export class RpcConn {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRpc>();
  /** Every non-rpc frame the server pushed, in arrival order.
   *
   *  ⛔ This is what makes an OUTBOUND-ONLY subsystem assertable. The
   *  server-heartbeat emitter persists no watermark — its progress IS the
   *  send — so from the database side there is nothing to compare cycle N
   *  against N+1. A paired client is the other end of that send. */
  readonly broadcasts: Array<Record<string, unknown>> = [];

  constructor(port: number, token: string) {
    this.ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    );
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (process.env.HORIZON_RPC_DEBUG === '1') {
        console.error('[rpc-frame]', JSON.stringify(msg).slice(0, 600));
      }
      const id = msg.request_id as string | undefined;
      if (id === undefined) {
        this.broadcasts.push(msg);
        return;
      }
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      // ⛔ THE SERVER PUTS ERRORS INSIDE `rpc_result`, not in a separate
      // `rpc_error` frame: `{ type: 'rpc_result', request_id, error: {...} }`.
      // The first version of this client only read `msg.result` on
      // `rpc_result`, so every failed rpc RESOLVED WITH `undefined` — a
      // `pack_not_installed` refusal surfaced to the harness as
      // "success=false: result=null" with the real message thrown away.
      // A client that turns errors into silent nulls is the same defect class
      // this whole audit exists to find.
      const err = msg.error as { code?: string; message?: string } | undefined;
      if (err !== undefined) {
        waiter.reject(new Error(
          err.code ? `${err.code}: ${err.message ?? ''}` : err.message ?? 'rpc error',
        ));
        return;
      }
      if (msg.type === 'rpc_result') waiter.resolve(msg.result);
      else if (msg.type === 'rpc_error') {
        waiter.reject(new Error('rpc error'));
      }
    });
    this.ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('ws closed'));
      this.pending.clear();
    });
  }

  open(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new Error('ws open timeout')),
        timeoutMs,
      );
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); }, { once: true });
    });
  }

  rpc(method: string, args?: unknown, timeoutMs = 20_000): Promise<unknown> {
    const request_id = `hz${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          type: 'rpc',
          request_id,
          method,
          ...(args !== undefined ? { args } : {}),
        }),
      );
      setTimeout(() => {
        if (this.pending.delete(request_id)) {
          reject(new Error(`rpc ${method} timeout`));
        }
      }, timeoutMs);
    });
  }

  /** Resolve once a pushed frame matches. Broadcasts already received count —
   *  a turn can complete before the caller starts waiting. */
  waitForBroadcast(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const existing = this.broadcasts.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const hit = this.broadcasts.find(predicate);
        if (hit) {
          clearInterval(poll);
          resolve(hit);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          reject(new Error('broadcast wait timeout'));
        }
      }, 100);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* best effort */
    }
  }
}

/** Mint a canonical `<token_id>.<bearer>` over `/auth/pair`. */
const pairForToken = async (
  port: number,
  recoveryKey: string,
): Promise<string> => {
  const res = await fetch(`http://127.0.0.1:${port}/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recoveryKey,
      clientKind: 'cli',
      instanceId: `horizon-audit-${process.pid}`,
      displayName: 'horizon-audit',
    }),
    signal: AbortSignal.timeout(8_000),
  });
  let json: { token_id?: unknown; bearer?: unknown; error?: { message?: string } } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* non-JSON body — the guard below reports it */
  }
  const token_id = typeof json.token_id === 'string' ? json.token_id : '';
  const bearer = typeof json.bearer === 'string' ? json.bearer : '';
  if (!res.ok || !token_id || !bearer) {
    throw new Error(
      `/auth/pair ${res.status}: ${json.error?.message ?? 'no token in response'}`,
    );
  }
  return `${token_id}.${bearer}`;
};

export const openServerVault = async (input: {
  port: number;
  /** Path to the seed's 24-word recovery key. Read here, never logged. */
  recoveryKeyPath: string;
}): Promise<VaultOpenOutcome> => {
  let recoveryKey: string;
  try {
    recoveryKey = readFileSync(input.recoveryKeyPath, 'utf8').trim();
  } catch (err) {
    return {
      ok: false,
      reason: `could not read the recovery key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (recoveryKey.split(/\s+/).length < 12) {
    return { ok: false, reason: 'recovery key file is not a 12/24-word mnemonic' };
  }

  let conn: RpcConn | undefined;
  try {
    const token = await pairForToken(input.port, recoveryKey);
    conn = new RpcConn(input.port, token);
    await conn.open();
    const state = (await conn.rpc('auth.state')) as { state?: string };
    if (state.state === 'unlocked') {
      return { ok: true, via: 'already-unlocked', conn };
    }
    if (state.state === 'uninitialized') {
      await conn.rpc('auth.init', { password: BENCH_PASSWORD });
      return { ok: true, via: 'init', conn };
    }
    // `locked` — the recovery key opens the persisted bundle. The bench falls
    // back to the password for a realm it initialised itself.
    try {
      await conn.rpc('auth.unlock', { recoveryKey });
    } catch {
      await conn.rpc('auth.unlock', { password: BENCH_PASSWORD });
    }
    return { ok: true, via: 'unlock', conn };
  } catch (err) {
    // ⚠ Never let the key reach a message. Only the error's own text.
    conn?.close();
    return {
      ok: false,
      reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
};
