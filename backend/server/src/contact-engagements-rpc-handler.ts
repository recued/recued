/** D-139 P5 — `data.contact.engagements.list` pair-RPC handler.
 *
 *  Exposes the contact-rooted engagement-evidence resolver
 *  (`EngagementStore.resolveEngagementsForContact`) to the owner's own
 *  paired clients / recipes. This is the FULL-shape channel — rows carry
 *  `body_inline` + `vendor_raw_timestamp` (the engagement.ts header calls
 *  it out: "the internal rpc + the WS-rpc surface return the full row
 *  shape; only MCP reads project through the privacy rule"). The MCP
 *  channel (`mcp/contact-engagements.ts`) reuses the same validation +
 *  resolve core here, then projects each row through
 *  `projectEngagementRowForMCP` (body stripped by default).
 *
 *  Registered-client gated: the paired read runs WITHOUT any MCP privacy
 *  gate, so that visibility decision is enforced by an actual registered-
 *  local-UI boundary — mirrors `timeline-rpc-handler.ts`.
 *
 *  Spec: docs/d-139-spec.md § A.5.1 + § P1a.1 ("server-internal SQL view
 *  + rpc surface (`data.contact.engagements.list`)"). */

import {
  RpcError,
  type DedupeAcceptance,
  type EngagementsResolverArgs,
  type EngagementsResolverResult,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import {
  EngagementCursorInvalidError,
  EngagementInvalidError,
  type EngagementStore,
} from './storage/engagement-store.js';
import type { EngagementsResolverDepsBuilder } from './engagement-resolver-deps.js';

/** Shared by the WS-rpc + MCP channels. */
export interface ContactEngagementsResolveDeps {
  engagementStore: Pick<EngagementStore, 'resolveEngagementsForContact'>;
  /** Per-call deps builder (`buildEngagementsResolverDeps`). */
  resolverDeps: EngagementsResolverDepsBuilder;
}

const DEDUPE_ACCEPTANCE_VALUES: ReadonlySet<string> = new Set([
  'exact_only',
  'probable',
  'all',
]);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

/** Project an untyped rpc/MCP frame into a sanitized
 *  `EngagementsResolverArgs`. Only recognized fields are copied; unknown
 *  fields are dropped. The resolver's SQL is fully parameterized, so an
 *  out-of-enum string (e.g. an invalid `authorship`) simply matches no
 *  rows rather than being a correctness/security hazard — we still reject
 *  the few fields whose wrong TYPE would be a caller error. */
export const projectEngagementsResolverArgs = (
  raw: Record<string, unknown>,
): EngagementsResolverArgs => {
  if (typeof raw.email !== 'string' || raw.email.length === 0) {
    throw new RpcError(
      'bad_request',
      'data.contact.engagements.list: email is required',
    );
  }
  const args: EngagementsResolverArgs = { email: raw.email };
  if (typeof raw.since === 'number') args.since = raw.since;
  if (typeof raw.until === 'number') args.until = raw.until;
  // D-192 — vendor is a pass-through filter (like `authorship` / `direction`
  // below): the resolver's SQL is fully parameterized, so an out-of-registry
  // vendor simply matches no rows. No closed-union enum gate — a pack-declared
  // engagement vendor filters correctly with no code edit.
  if (typeof raw.vendor === 'string' && raw.vendor.length > 0) {
    args.vendor = raw.vendor;
  }
  if (typeof raw.connection_id === 'string') args.connection_id = raw.connection_id;
  if (isStringArray(raw.authorship))
    args.authorship = raw.authorship as EngagementsResolverArgs['authorship'];
  if (isStringArray(raw.direction))
    args.direction = raw.direction as EngagementsResolverArgs['direction'];
  if (isStringArray(raw.lifecycle_state))
    args.lifecycle_state =
      raw.lifecycle_state as EngagementsResolverArgs['lifecycle_state'];
  if (
    typeof raw.dedupe_acceptance === 'string' &&
    DEDUPE_ACCEPTANCE_VALUES.has(raw.dedupe_acceptance)
  ) {
    args.dedupe_acceptance = raw.dedupe_acceptance as DedupeAcceptance;
  }
  if (typeof raw.page_size === 'number') args.page_size = raw.page_size;
  if (typeof raw.cursor === 'string') args.cursor = raw.cursor;
  if (typeof raw.include_deleted === 'boolean')
    args.include_deleted = raw.include_deleted;
  return args;
};

/** Validate + resolve. Shared by both channels. Maps the resolver's
 *  typed errors onto `RpcError`s the dispatcher / MCP layer surface. */
export const runContactEngagementsResolver = (
  deps: ContactEngagementsResolveDeps,
  raw: Record<string, unknown>,
): EngagementsResolverResult => {
  const args = projectEngagementsResolverArgs(raw);
  try {
    return deps.engagementStore.resolveEngagementsForContact(
      args,
      deps.resolverDeps(args),
    );
  } catch (err) {
    if (err instanceof EngagementCursorInvalidError) {
      throw new RpcError(
        'bad_request',
        `data.contact.engagements.list: ${err.message}`,
      );
    }
    if (err instanceof EngagementInvalidError) {
      throw new RpcError(
        'bad_request',
        `data.contact.engagements.list: ${err.message}`,
      );
    }
    throw err;
  }
};

/** Require a registered paired client — the full-shape read runs WITHOUT
 *  the MCP privacy gate, so a real registered-local-UI boundary MUST
 *  enforce the visibility decision (mirrors `timeline-rpc-handler.ts`). */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'data.contact.engagements.list requires a registered paired client',
      401,
    );
  }
};

type ContactEngagementsRpcMethods = 'data.contact.engagements.list';

export const makeContactEngagementsRpcHandlers = (
  deps: ContactEngagementsResolveDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, ContactEngagementsRpcMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['data.contact.engagements.list'],
    handlers: {
      'data.contact.engagements.list': async (args, client) => {
        requireRegisteredClient(client);
        // The dispatcher hands `args` as raw JSON typed at the registry
        // shape; `runContactEngagementsResolver` re-projects + validates.
        return runContactEngagementsResolver(
          deps,
          args as unknown as Record<string, unknown>,
        );
      },
    },
  };
};
