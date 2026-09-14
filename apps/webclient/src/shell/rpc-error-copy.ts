/** Webclient RPC-error presentation — one place that turns an rpc error
 *  into user-facing copy + a coarse class for presentation routing.
 *
 *  ── Why it exists ───────────────────────────────────────────────────
 *  Connection error codes are MINTED in one place (`realtime/rpc-conn.ts`
 *  — `server_offline`, `connection_lost`, `timeout`, `transport`, …) with
 *  raw, debug-shaped messages (`webclient rpc: method 'approval.list' did
 *  not respond within 30000ms`). Before this module ~28 surfaces rendered
 *  those messages VERBATIM via a copy-pasted `err.message` idiom, so the
 *  method name, the `30000ms`, and the code leaked straight to the user —
 *  and every surface independently shouted the same "server is down" fact
 *  with different wording.
 *
 *  This centralizes the mapping so:
 *    1. users never see method names / millisecond timeouts / codes
 *       (Tier 1 — humanize), and
 *    2. surfaces can tell a CONNECTION-caused failure (defer to the one
 *       global offline banner — quiet treatment) from a REAL per-operation
 *       error (show it inline) via `connectionCaused` (Tier 2 — coordinate).
 *
 *  ── Not a banner ────────────────────────────────────────────────────
 *  This only classifies + phrases. The decision of WHAT to render
 *  (suppress and defer to the banner, keep stale data, show an inline
 *  note) lives in each surface — it's a presentation choice, not a string.
 *
 *  Copy is plain + calm (no persona — Recued is just Recued) and never
 *  embeds the rpc method, a timeout duration, or an error code. */

import { RpcError } from '@recued/contracts';
import { isConnectionBlockedByBrowserOrigin } from '../net/insecure-origin.js';

/** Coarse class for presentation routing. */
export type RpcErrorKind =
  /** The server is unreachable — socket down / never delivered. */
  | 'offline'
  /** The socket is up but the call didn't get a reply in time. */
  | 'unresponsive'
  /** The call was dispatched but the connection dropped before its reply;
   *  its outcome is unknown (don't blind-retry a non-idempotent write). */
  | 'in_doubt'
  /** The bearer was rejected — the re-pair funnel owns recovery. */
  | 'auth'
  /** Caller-aborted or the conn was torn down — usually suppress. */
  | 'cancelled'
  /** A real per-operation error from the server (validation, not-found, …). */
  | 'error';

export interface ClassifiedRpcError {
  kind: RpcErrorKind;
  /** User-facing copy — never contains a method name, a timeout duration,
   *  or an error code. Safe to show verbatim. */
  copy: string;
  /** The underlying rpc error code (for a `data-*` attr / telemetry — NOT
   *  for display). `null` when the value wasn't an rpc error. */
  code: string | null;
  /** True when the failure is caused by the connection (server unreachable
   *  / unresponsive / dropped), so the surface should defer to the global
   *  offline banner rather than shouting its own raw error. False for a
   *  real per-operation error the user needs to see inline. */
  connectionCaused: boolean;
  /** True for caller-abort / teardown races a surface should normally show
   *  nothing for (not even a quiet hint). */
  suppressible: boolean;
}

/** The connection codes `rpc-conn.ts` mints, mapped to calm copy. Anything
 *  not here is treated as a real per-operation error (its server message is
 *  shown as-is). */
const CONNECTION_COPY: Record<
  string,
  { kind: RpcErrorKind; copy: string; suppressible: boolean }
> = {
  server_offline: {
    kind: 'offline',
    copy: "Can't reach your server right now.",
    suppressible: false,
  },
  transport: {
    kind: 'offline',
    copy: "Can't reach your server right now.",
    suppressible: false,
  },
  timeout: {
    kind: 'unresponsive',
    copy: "Your server isn't responding right now.",
    suppressible: false,
  },
  // Pre-emptive sibling of `timeout`: the connection-status controller saw
  // the server go silent (no heartbeat while the socket is up — a half-open
  // restart), so a NEW call fast-fails here rather than waiting the full 30s
  // for a `timeout`. Same calm "isn't responding" copy — it auto-recovers,
  // nothing for the user to do but retry in a moment.
  server_unresponsive: {
    kind: 'unresponsive',
    copy: "Your server isn't responding right now.",
    suppressible: false,
  },
  connection_lost: {
    kind: 'in_doubt',
    copy: 'The connection dropped before this finished, so Recued does not know what happened.',
    suppressible: false,
  },
  webclient_reauth_required: {
    kind: 'auth',
    copy: 'This browser has to be paired again.',
    suppressible: false,
  },
  // Teardown / caller-abort — not a server problem; surfaces normally show
  // nothing. `connectionCaused` stays false so they aren't mistaken for an
  // outage, but `suppressible` tells a surface to skip even a quiet hint.
  transport_disposed: {
    kind: 'cancelled',
    copy: 'Connection closed.',
    suppressible: true,
  },
  aborted: {
    kind: 'cancelled',
    copy: 'Cancelled.',
    suppressible: true,
  },
};

/** The one connection cause the server can never report, because the browser
 *  refuses the socket before the server sees it. See `net/insecure-origin.ts`. */
const BLOCKED_BY_BROWSER_COPY =
  'Your browser blocked this. This page is safe (https), but your '
  + 'server’s address is not. Open Recued from your server’s own address, '
  + 'or give your server a certificate.';

const codeOf = (err: unknown): string | null => {
  if (err instanceof RpcError) return err.code;
  // Structural fallback — an RpcError that crossed a module boundary, or a
  // hand-shaped `{ code }`. We never trust a non-string code.
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return null;
};

const rawMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Classify an rpc error into a presentation-ready shape. Accepts
 *  `unknown` so every `catch (err)` site can call it directly. */
export const classifyRpcError = (err: unknown): ClassifiedRpcError => {
  const code = codeOf(err);
  if (code !== null) {
    const mapped = CONNECTION_COPY[code];
    if (mapped !== undefined) {
      // ⛔ REFINE THE ONE VERDICT THAT WAS WRONG. `offline` is what a browser-
      // blocked socket and a genuinely unreachable server BOTH produce (close
      // 1006, no status, no headers), so this copy was telling owners their
      // server was down while it sat there answering. Only `offline` is
      // narrowed: `timeout` / `unresponsive` / `auth` / `cancelled` are each
      // diagnosed on their own evidence and must not be overwritten.
      const copy = mapped.kind === 'offline' && isConnectionBlockedByBrowserOrigin()
        ? BLOCKED_BY_BROWSER_COPY
        : mapped.copy;
      return {
        kind: mapped.kind,
        copy,
        code,
        // Everything mapped except the caller-abort/teardown pair is a
        // genuine connection cause that should defer to the banner.
        connectionCaused: mapped.kind !== 'cancelled',
        suppressible: mapped.suppressible,
      };
    }
    // A real server error code (validation / not-found / not-configured / …)
    // — its message is the server's own copy, safe to show inline.
    return {
      kind: 'error',
      copy: rawMessage(err),
      code,
      connectionCaused: false,
      suppressible: false,
    };
  }
  // A non-rpc error (a thrown Error from a file read, JSON parse, etc.).
  return {
    kind: 'error',
    copy: rawMessage(err),
    code: null,
    connectionCaused: false,
    suppressible: false,
  };
};

/** Convenience for sites that only want the humanized string (the Tier 1
 *  drop-in for the old `errMessage`). Surfaces that need to coordinate with
 *  the offline banner should use `classifyRpcError` and branch on
 *  `connectionCaused` instead. */
export const humanizeRpcError = (err: unknown): string =>
  classifyRpcError(err).copy;

/** One classified error a surface is currently holding, with the context
 *  label to prefix it with when it's a real (inline-shown) error. */
export interface SurfaceErrorEntry {
  error: ClassifiedRpcError;
  /** Short context to prefix the error with, e.g. "Couldn't load approvals"
   *  → "Couldn't load approvals: <copy>". Omit (or empty) to show the
   *  humanized copy bare. Used for inline errors (real, or any action). */
  label?: string;
  /** Where the error came from. `'action'` = a user-initiated call (send,
   *  approve, submit) — ALWAYS shown inline so the user gets feedback their
   *  action failed, even when connection-caused and even with data present.
   *  `'load'` (the default) = a background load/subscribe — connection-caused
   *  ones defer to the global offline banner. */
  origin?: 'action' | 'load';
}

export interface SurfaceErrorDisplay {
  /** The text to render in the surface's error slot. */
  text: string;
  /** True → a calm connection note (style muted; the global offline banner
   *  is the loud signal). False → a real per-operation error (style as one). */
  connectionCaused: boolean;
}

/** Decide what, if anything, a surface should render in its error slot given
 *  the errors it's holding + whether it has data worth keeping. This is the
 *  Tier 2 coordination policy in one place so every surface behaves the same:
 *
 *   - Teardown/abort (`suppressible`) errors are ignored entirely.
 *   - A REAL per-operation error always shows inline (humanized, labelled) —
 *     the user needs it, and it isn't what the banner is about.
 *   - When only CONNECTION errors remain, defer to the global offline banner:
 *     keep last-known data (return `null` → show nothing) when there is data,
 *     or a single calm line when the surface has nothing to show (so an empty
 *     panel reads "can't reach your server", not a misleading "nothing here"). */
export const resolveSurfaceErrorDisplay = (
  entries: ReadonlyArray<SurfaceErrorEntry | null>,
  opts: { hasData: boolean },
): SurfaceErrorDisplay | null => {
  const present = entries.filter(
    (e): e is SurfaceErrorEntry => e !== null && !e.error.suppressible,
  );
  const labelled = (e: SurfaceErrorEntry): string =>
    e.label !== undefined && e.label !== ''
      ? `${e.label}: ${e.error.copy}`
      : e.error.copy;
  // Inline = anything the user must see regardless of the banner: a REAL
  // per-operation error, OR any user ACTION failure (even a connection one —
  // "your send / approval didn't go through", and the in-doubt warning).
  const inline = present.filter(
    (e) => e.origin === 'action' || !e.error.connectionCaused,
  );
  if (inline.length > 0) {
    // Style as an alert (not the muted "deferring" tone) — it needs attention.
    return { text: inline.map(labelled).join(' '), connectionCaused: false };
  }
  // Only background connection-caused load/subscribe errors remain → defer to
  // the global offline banner.
  const connection = present; // (every remaining entry is connection-caused load)
  if (connection.length === 0) return null;
  if (opts.hasData) return null; // keep the stale data; the banner explains it
  return { text: connection[0]!.error.copy, connectionCaused: true };
};
