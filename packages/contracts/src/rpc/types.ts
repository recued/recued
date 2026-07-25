/** RPC method registry types.
 *
 *  A registry is a map from method name → `{ request; response }`. Any
 *  client — extension-to-server over WS, extension-to-service-worker
 *  over `chrome.runtime.sendMessage`, or extension-to-Worker over
 *  HTTPS — can be parameterised by a registry to get typed dispatch.
 *
 *  Single source of truth: the registry type lives in contracts so
 *  both ends of the wire import the same definition. Adding a new
 *  method is a single edit to the relevant registry; both the caller
 *  and the handler compile-check against it.
 *
 *  ────────────────────────────────────────────────────────────────
 *  Conventions
 *  ────────────────────────────────────────────────────────────────
 *
 *  Method names: `<scope>.<action>` in lowerCamel, with optional
 *  sub-scope for CRUD clusters (`auth.migrate.status`). No verbs
 *  like "get/set/list" when the scope + noun already implies it
 *  (`sync.config`, not `sync.getConfig`) — but we keep existing names
 *  verbatim during migration to avoid protocol churn.
 *
 *  Payload shape: every method takes exactly ONE request object (may
 *  be `void` for no-arg methods) and returns exactly ONE response
 *  object. Batching is its own method (`cache.putMany`) — never an
 *  array argument to a singular method.
 *
 *  Null semantics: use `T | null` for "not configured" / "does not
 *  exist" responses (e.g., `sync.config`, `auth.state`). Clients that
 *  need to distinguish from error cases can destructure safely.
 */

/** Shape of a single method entry in a registry. */
export interface RpcMethodSpec<Req = unknown, Res = unknown> {
  request: Req;
  response: Res;
}

/** A registry is a map from dotted method names to their specs.
 *  Declared as a plain `Record` so both `interface X extends RpcRegistry`
 *  and `type X = { ... }` satisfy the shape. */
export type RpcRegistry = Record<string, RpcMethodSpec>;

/** Extract the request type for a given method. */
export type RpcRequest<R, M extends keyof R> =
  R[M] extends RpcMethodSpec<infer Req, infer _Res> ? Req : never;

/** Extract the response type for a given method. */
export type RpcResponse<R, M extends keyof R> =
  R[M] extends RpcMethodSpec<infer _Req, infer Res> ? Res : never;

/** Per-call options. Applies uniformly across transports — each client
 *  honours what it can (WS honours `timeout`; HTTPS honours all three). */
export interface RpcCallOptions {
  /** Override the default timeout for this single call, in ms. */
  timeout?: number;
  /** Abort the call if the signal is triggered. */
  signal?: AbortSignal;
  /** Free-form tag surfaced to middleware (logs, telemetry). */
  tag?: string;
}

/** Typed dispatch function. A `Conn<R>` can call any method in `R` with
 *  compile-time checking on the request and the inferred response type.
 *
 *  Three overloads:
 *    - no-arg methods (request: `void`) — no second argument required.
 *    - no-arg methods with options only.
 *    - methods with a payload (+ optional options).
 *
 *  Callers never pass `undefined` explicitly; TypeScript picks the
 *  correct overload based on the method's request type. */
export interface Conn<R> {
  <M extends NoArgMethods<R>>(method: M): Promise<RpcResponse<R, M>>;
  <M extends NoArgMethods<R>>(method: M, payload: void, options: RpcCallOptions): Promise<RpcResponse<R, M>>;
  <M extends keyof R>(
    method: M,
    payload: RpcRequest<R, M>,
    options?: RpcCallOptions,
  ): Promise<RpcResponse<R, M>>;
}

/** Methods whose request type is `void` OR an empty object `{}` —
 *  callable without a payload. The empty-object case matters for
 *  registries derived from discriminated unions like
 *  `Omit<{kind:'x'}, 'kind'>`, which becomes `{}` rather than `void`. */
export type NoArgMethods<R> = {
  [M in keyof R]: R[M] extends RpcMethodSpec<infer Req, infer _Res>
    ? (Req extends void ? M : keyof Req extends never ? M : never)
    : never;
}[keyof R];

/** Normalised rpc error. Clients should translate transport-specific
 *  errors into this shape before throwing. */
export class RpcError extends Error {
  constructor(
    /** Stable code, e.g. `unauthorized`, `not_configured`, `timeout`,
     *  `transport`. Check this in callers instead of the message. */
    public readonly code: string,
    message: string,
    /** HTTP-like numeric status when available. */
    public readonly status?: number,
    /** The method that failed — useful for logs/telemetry. */
    public readonly method?: string,
    /** Structured per-code error metadata. Surfaces in the wire-side
     *  error envelope alongside `code` + `message` so renderers can
     *  switch on typed fields instead of parsing the message text.
     *
     *  Codex W3.FU P2 fold — `/ws` lockout errors carry
     *  `{ required_phrase, active_ws_connections }` so the modal
     *  renderer doesn't have to parse-then-trust the message. Adding
     *  fields here doesn't break older clients (they ignore unknown
     *  envelope keys). */
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Middleware type: wrap an existing conn to add logging, auth, etc.
 *  `next(method, payload, options)` invokes the underlying conn.
 *  Middlewares compose right-to-left (outermost wraps first). */
export type RpcMiddleware<R> = (
  next: (method: keyof R, payload?: unknown, options?: RpcCallOptions) => Promise<unknown>,
) => (method: keyof R, payload?: unknown, options?: RpcCallOptions) => Promise<unknown>;
