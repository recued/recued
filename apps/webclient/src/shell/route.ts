/**
 * §D.shell — the webclient's central deep-link router (R16, 2026-06-20).
 *
 * ONE hash scheme the shell owns: `#surface/subview/item[/subtab]`.
 *   #connections/mail/<account-id>  ·  #settings/ai-models  ·  #contracts/<id>/ops
 *
 * Replaces the prior split scheme — `#surface` for top routes PLUS a
 * per-surface `?key=value` query tail parsed by one-off helpers
 * (`parse{Runs,Recipes,Settings,Automation}…FromHash`). Every surface now
 * reads its slice off the parsed `ShellRoute.segments` and writes links via
 * `serializeShellRoute(...)`, so list→detail selections survive a refresh /
 * back-forward and can be cross-linked (R15 "used by pack X", the approvals
 * deep queue, Home "needs you" → the item).
 *
 * Segments are POSITIONAL, not typed — their meaning is the SURFACE's to
 * interpret: `#contracts/<id>/ops` puts the id at segment 0 and the tab at
 * segment 1, while `#connections/mail/<id>` puts the lane at 0 and the
 * account at 1. The router only splits + (de)serializes; the
 * `shellSubview/shellItem/shellSubtab` aliases name segments 0/1/2 after the
 * §D.shell vocabulary for surfaces that prefer it.
 */

import type { ChatDataDiagnosisRelationship } from '@recued/contracts';

/** Closed-list of route ids the shell can mount. Adding a surface — a top
 *  route like `approvals` (D-169 P2) — is a single entry here + a single case
 *  in the bootstrap's `mountRoute`. */
export const WEBCLIENT_ROUTE_IDS = [
  'reception',
  'settings',
  'approvals',
  'kitchen',
  'contracts',
  'connections',
  'packs',
  'recipes',
  'automation',
  'data',
  'logs',
  // D-250 § D7 / § Open 10 — the owner's OWN metrics. Beside Logs in the review
  // section, NOT under Server (operational configuration) and not replacing Chat as the
  // landing. ⚠ Deliberately no per-tag route: § C6 dropped the overlay, so the full
  // ranked list lives at recued.com/explore and this surface shows only your own numbers.
  'stats',
  'chat',
  // D-145 PA7 / D-172 P2 — the mail compose host. NOT a mail client: a mailbox
  // roster plus the compose window. D-174 D12 puts email's long-term home in
  // Chat; this is the first host, and `mountMailCompose` is shaped so Chat
  // becomes the second without moving it.
  'mail',
] as const;
export type WebclientRouteId = (typeof WEBCLIENT_ROUTE_IDS)[number];
const WEBCLIENT_ROUTE_ID_SET: ReadonlySet<string> = new Set(WEBCLIENT_ROUTE_IDS);

/** The shell's default route. An empty or unknown hash falls through here.
 *  §D.L1 (shell-frame Step 5): the chat home is the default landing — it
 *  replaced the retired cockpit (`home`) + the retired `#compose` route. */
export const WEBCLIENT_DEFAULT_ROUTE: WebclientRouteId = 'chat';

/** A parsed hash: the resolved top-level surface + its (decoded) path tail. */
export interface ShellRoute {
  /** Always a valid route id — an unknown surface degrades to the default. */
  readonly surface: WebclientRouteId;
  /** Decoded path segments after the surface. `#contracts/<id>/ops` ⇒
   *  `['<id>', 'ops']`; `#logs` ⇒ `[]`. */
  readonly segments: readonly string[];
}

/** Strip a leading `#` and a leading `/` so `#/chat`, `#chat`, and
 *  `chat` all normalize to the same body. */
const stripHashPrefix = (hash: string): string => {
  const noHash = hash.startsWith('#') ? hash.slice(1) : hash;
  return noHash.startsWith('/') ? noHash.slice(1) : noHash;
};

/** `decodeURIComponent`, but a malformed segment (a lone `%`) returns itself
 *  rather than throwing — the router must never reject a hash. */
const decodeSegment = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** Parse a URL hash into its surface + decoded segment tail. */
export const parseShellRoute = (hash: string): ShellRoute => {
  const parts = stripHashPrefix(hash).split('/');
  // The surface tolerates (and discards) a stray legacy `?query` tail — so a
  // bookmarked `#logs?run_id=x` still resolves its surface rather than 404ing
  // to Home; the query value itself is dropped (pre-launch, no compat shim).
  const surfaceRaw = (parts[0] ?? '').split('?')[0] ?? '';
  const surface = WEBCLIENT_ROUTE_ID_SET.has(surfaceRaw)
    ? (surfaceRaw as WebclientRouteId)
    : WEBCLIENT_DEFAULT_ROUTE;
  const segments = parts
    .slice(1)
    .filter((part) => part.length > 0)
    .map(decodeSegment);
  return { surface, segments };
};

/** Resolve a hash to just its top-level surface (the route discriminator). */
export const parseRouteFromHash = (hash: string): WebclientRouteId =>
  parseShellRoute(hash).surface;

/** Segment 0 — the §D.shell "subview" (e.g. the Settings section, the
 *  Connections lane). `null` when absent. */
export const shellSubview = (route: ShellRoute): string | null =>
  route.segments[0] ?? null;
/** Segment 1 — the §D.shell "item" (e.g. the selected record id). */
export const shellItem = (route: ShellRoute): string | null =>
  route.segments[1] ?? null;
/** Segment 2 — the §D.shell "subtab" (e.g. a contract-detail tab). */
export const shellSubtab = (route: ShellRoute): string | null =>
  route.segments[2] ?? null;

/** Edit→Kitchen — the recipe id a `#kitchen/recipe/<id>` hash addresses (the
 *  recipe editor), or `null` for any other `#kitchen` hash (bare or the
 *  `#kitchen/pack[/<draft>]` pack-editor sibling). `recipe` is a reserved seg-0
 *  marker so it never collides with a pack draft id. Pure — the bootstrap's
 *  kitchen branch mounts the recipe editor iff this returns non-null. */
export const kitchenEditRecipeId = (route: ShellRoute): string | null =>
  route.surface === 'kitchen' && route.segments[0] === 'recipe'
    ? route.segments[1] ?? null
    : null;

/** Data -> Kitchen new-recipe context. `#kitchen/new/form-response/<id>`
 * addresses an UNSAVED recipe seed narrowed to one form definition. Keeping
 * `new` as a sibling of `recipe` means an installed recipe whose actual id is
 * `new` remains reachable at `#kitchen/recipe/new` without ambiguity. */
export type KitchenNewRecipeSeed =
  | {
      readonly kind: 'form_response';
      readonly form_definition_id: string;
    }
  /** D-219 item 2b — `#kitchen/new/execution-case/<draft_key>`. ⚠ The key
   *  addresses a draft the SETTINGS panel already generated and stashed; unlike
   *  the form-response seed, this route cannot rebuild its own recipe (that
   *  would spend the owner's model quota again), so an unmatched key is a
   *  not-found rather than a regeneration. */
  | {
      readonly kind: 'execution_case';
      readonly draft_key: string;
    };

export const kitchenNewRecipeSeed = (
  route: ShellRoute,
): KitchenNewRecipeSeed | null => {
  if (
    route.surface !== 'kitchen'
    || route.segments[0] !== 'new'
    || route.segments.length !== 3
  ) return null;
  const value = route.segments[2] ?? '';
  if (value.trim().length === 0) return null;
  if (route.segments[1] === 'form-response') {
    return { kind: 'form_response', form_definition_id: value };
  }
  if (route.segments[1] === 'execution-case') {
    return { kind: 'execution_case', draft_key: value };
  }
  return null;
};

/** Edit→Kitchen — the draft id a `#kitchen/pack/<draft_id>` hash addresses (the
 *  pack editor opened on that draft), or `null` for `#kitchen/pack` (a fresh
 *  pack editor) and bare `#kitchen`. `pack` is the reserved seg-0 marker for the
 *  pack-editor sibling of `#kitchen/recipe/<id>`. Pure — the bootstrap's kitchen
 *  branch passes this as the builder's `initialDraftId` (self-loads the draft)
 *  and canonicalizes bare `#kitchen` to `#kitchen/pack`. */
export const kitchenPackDraftId = (route: ShellRoute): string | null =>
  route.surface === 'kitchen' && route.segments[0] === 'pack'
    ? route.segments[1] ?? null
    : null;

/** Build a hash from a surface + an ordered segment tail. `null`/`undefined`/
 *  empty segments are dropped; each segment is URL-encoded so a value with a
 *  `/` (e.g. a `publisher/name` recipe id) round-trips through the path. */
export const serializeShellRoute = (
  surface: WebclientRouteId,
  ...segments: ReadonlyArray<string | null | undefined>
): string => {
  const tail = segments
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return tail.length > 0 ? `#${surface}/${tail}` : `#${surface}`;
};

/** Exact collection-explorer tabs a Chat record reference can address. */
export type SourceRecordDataTab = 'mail' | 'calendar' | 'files';

export interface ChatAnswerAddress {
  readonly sessionId: string;
  readonly messageId: string;
}

/** Durable address for an ordinary Chat conversation. Answer and plan
 * addresses extend this same `#chat/session/<id>` spine with a typed tail;
 * keeping the session-only form explicit lets history selection survive
 * reload/back without pretending that one message or action is focused. */
export interface ChatSessionAddress {
  readonly sessionId: string;
}

/** The strongest relationship the persisted execution provenance can truthfully
 * claim for an item. `involved` deliberately avoids claiming the exact record
 * changed when a legacy `execution.write` edge may describe a read input. */
export type DataVerificationRelationship = ChatDataDiagnosisRelationship;

/** Explicit owner choice after inspecting the Data view. Neither value is an
 * execution verdict: it only tells Chat whether the owner finished reviewing
 * what Data showed or wants help interpreting it. */
export type DataVerificationReviewResult =
  | 'reviewed'
  | 'needs_help';

export interface ChatDataVerificationReturn {
  readonly runId: string;
  readonly result: DataVerificationReviewResult;
  readonly relationship?: DataVerificationRelationship;
}

/** Durable address for one reviewed Chat action. `messageId` is only a
 * presentation fallback when the exact plan card can no longer be recovered;
 * it is never used as approval authority. */
export interface ChatPlanAddress {
  readonly sessionId: string;
  readonly planId: string;
  readonly messageId?: string;
  /** Presentation-only context from a Data review. This cannot approve, send,
   * or retry anything; Chat uses it only to explain the safe next step. */
  readonly dataVerification?: ChatDataVerificationReturn;
}

/** Durable address for one exact execution run, optionally retaining the Chat
 * action that opened it. The return address is presentation-only: it restores
 * the reviewed plan card but grants no approval or execution authority. */
export interface LogsRunAddress {
  readonly runId: string;
  readonly returnToChat?: ChatPlanAddress;
}

interface SourceRecordAddressBase {
  readonly tab: SourceRecordDataTab;
  readonly collectionSlug: string;
  readonly recordId: string;
}

/** Exact source records can return either to the Chat answer that cited them or
 * to the run outcome that asked the owner to verify them. Keeping the two
 * origins disjoint prevents a serializer from silently choosing one breadcrumb
 * when a malformed caller supplies both. */
export type SourceRecordAddress = SourceRecordAddressBase & (
  | {
      readonly returnToChat?: ChatAnswerAddress;
      readonly returnToRun?: never;
    }
  | {
      readonly returnToChat?: never;
      readonly returnToRun: LogsRunAddress;
      readonly verificationRelationship?: DataVerificationRelationship;
    }
);

/** Data tabs whose records are globally addressable without a connected-source
 * slug. Source mirrors use `SourceRecordVerificationAddress` below because a
 * record id can occur in more than one account. */
export type DataEntityVerificationTab =
  | 'contact'
  | 'form_response'
  | 'crm'
  | 'task'
  | 'note'
  | 'commitment'
  | 'project'
  | 'booking'
  | 'annotation'
  | 'link'
  | 'shared';

export interface DataEntityVerificationAddress {
  readonly tab: DataEntityVerificationTab;
  readonly entityId: string;
  readonly returnToRun: LogsRunAddress;
  readonly verificationRelationship?: DataVerificationRelationship;
}

/** A run knows the source collection + record id, but legacy provenance rows do
 * not retain the account slug. This address asks Data to resolve the id across
 * connected instances and only auto-open it when the match is unambiguous. */
export interface SourceRecordVerificationAddress {
  readonly tab: SourceRecordDataTab;
  readonly recordId: string;
  readonly returnToRun: LogsRunAddress;
  readonly verificationRelationship?: DataVerificationRelationship;
}

const SOURCE_RECORD_DATA_TABS: ReadonlySet<string> = new Set([
  'mail',
  'calendar',
  'files',
]);
const DATA_ENTITY_VERIFICATION_TABS: ReadonlySet<string> = new Set([
  'contact',
  'form_response',
  'crm',
  'task',
  'note',
  'commitment',
  'project',
  'booking',
  'annotation',
  'link',
  'shared',
]);
const DATA_VERIFICATION_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'action',
  'involved',
  'derived',
]);
const DATA_VERIFICATION_REVIEW_RESULTS: ReadonlySet<string> = new Set([
  'reviewed',
  'needs_help',
]);

export const serializeChatSessionAddress = (
  address: ChatSessionAddress,
): string => serializeShellRoute('chat', 'session', address.sessionId);

export const parseChatSessionAddress = (
  route: ShellRoute,
): ChatSessionAddress | null => {
  if (
    route.surface !== 'chat'
    || route.segments.length !== 2
    || route.segments[0] !== 'session'
  ) return null;
  const sessionId = route.segments[1] ?? '';
  return sessionId.length > 0 ? { sessionId } : null;
};

/** Durable route to one assistant answer. The explicit `answer` marker keeps
 * future session subviews unambiguous. */
export const serializeChatAnswerAddress = (
  address: ChatAnswerAddress,
): string => serializeShellRoute(
  'chat',
  'session',
  address.sessionId,
  'answer',
  address.messageId,
);

export const parseChatAnswerAddress = (
  route: ShellRoute,
): ChatAnswerAddress | null => {
  if (
    route.surface !== 'chat'
    || route.segments.length !== 4
    || route.segments[0] !== 'session'
    || route.segments[2] !== 'answer'
  ) return null;
  const sessionId = route.segments[1] ?? '';
  const messageId = route.segments[3] ?? '';
  return sessionId.length > 0 && messageId.length > 0
    ? { sessionId, messageId }
    : null;
};

/** Exact Chat action route segments. The optional Data-verification tail is
 * presentation context only: it can focus recovery guidance, but grants no
 * authority and starts no action. */
const chatPlanAddressSegments = (
  address: ChatPlanAddress,
): ReadonlyArray<string> => [
  'session',
  address.sessionId,
  'plan',
  address.planId,
  ...(address.messageId !== undefined
    ? ['answer', address.messageId]
    : []),
  ...(address.dataVerification !== undefined
    ? [
        'verification',
        address.dataVerification.result,
        'run',
        address.dataVerification.runId,
        ...(address.dataVerification.relationship === undefined
          ? []
          : ['relationship', address.dataVerification.relationship]),
      ]
    : []),
];

/** Exact Chat action route. Keeping the optional answer after the primary
 * plan segment makes the fallback explicit without conflating an action
 * handoff with the citation-return address above. */
export const serializeChatPlanAddress = (
  address: ChatPlanAddress,
): string => serializeShellRoute('chat', ...chatPlanAddressSegments(address));

export const parseChatPlanAddress = (
  route: ShellRoute,
): ChatPlanAddress | null => {
  if (
    route.surface !== 'chat'
    || route.segments[0] !== 'session'
    || route.segments[2] !== 'plan'
  ) return null;
  const sessionId = route.segments[1] ?? '';
  const planId = route.segments[3] ?? '';
  if (sessionId.length === 0 || planId.length === 0) return null;
  let cursor = 4;
  let messageId: string | undefined;
  if (route.segments[cursor] === 'answer') {
    messageId = route.segments[cursor + 1] ?? '';
    if (messageId.length === 0) return null;
    cursor += 2;
  }
  let dataVerification: ChatDataVerificationReturn | undefined;
  if (cursor < route.segments.length) {
    if (
      route.segments[cursor] !== 'verification'
      || route.segments[cursor + 2] !== 'run'
    ) return null;
    const result = route.segments[cursor + 1] ?? '';
    const runId = route.segments[cursor + 3] ?? '';
    if (
      !DATA_VERIFICATION_REVIEW_RESULTS.has(result)
      || runId.length === 0
    ) return null;
    cursor += 4;
    let relationship: DataVerificationRelationship | undefined;
    if (cursor < route.segments.length) {
      if (route.segments[cursor] !== 'relationship') return null;
      const candidate = route.segments[cursor + 1] ?? '';
      if (!DATA_VERIFICATION_RELATIONSHIPS.has(candidate)) return null;
      relationship = candidate as DataVerificationRelationship;
      cursor += 2;
    }
    dataVerification = {
      result: result as DataVerificationReviewResult,
      runId,
      ...(relationship !== undefined ? { relationship } : {}),
    };
  }
  if (cursor !== route.segments.length) return null;
  return {
    sessionId,
    planId,
    ...(messageId !== undefined ? { messageId } : {}),
    ...(dataVerification !== undefined ? { dataVerification } : {}),
  };
};

/** Exact Logs run route. The run stays in segment 0 for compatibility with
 * existing `#logs/<run_id>` bookmarks; an optional typed tail carries the
 * originating Chat plan through reloads and reconnects. */
const logsRunAddressSegments = (
  address: LogsRunAddress,
): ReadonlyArray<string> => [
  address.runId,
  ...(address.returnToChat === undefined
    ? []
    : [
        'return',
        'chat',
        ...chatPlanAddressSegments(address.returnToChat),
      ]),
];

export const serializeLogsRunAddress = (
  address: LogsRunAddress,
): string => serializeShellRoute('logs', ...logsRunAddressSegments(address));

/** Parse only run-detail routes — `active` and `recipe` remain Logs subviews.
 * A malformed return tail fails closed to `null`; the bootstrap can still
 * retain its legacy run-only fallback without trusting a partial Chat target. */
export const parseLogsRunAddress = (
  route: ShellRoute,
): LogsRunAddress | null => {
  const runId = route.segments[0] ?? '';
  if (
    route.surface !== 'logs'
    || runId.length === 0
    || runId === 'active'
    || runId === 'recipe'
  ) return null;
  if (route.segments.length === 1) return { runId };
  if (
    route.segments[1] !== 'return'
    || route.segments[2] !== 'chat'
  ) return null;
  const returnToChat = parseChatPlanAddress({
    surface: 'chat',
    segments: route.segments.slice(3),
  });
  return returnToChat === null ? null : { runId, returnToChat };
};

/** Exact, account-qualified Data record route. The `record` marker preserves
 * compatibility with legacy `#data/<tab>/<record_id>` links, while the
 * optional return tail makes the Chat round-trip explicit and shareable inside
 * the paired client. */
export const serializeSourceRecordAddress = (
  address: SourceRecordAddress,
): string => serializeShellRoute(
  'data',
  address.tab,
  'record',
  address.collectionSlug,
  address.recordId,
  ...(address.returnToChat !== undefined
    ? [
        'return',
        'chat',
        address.returnToChat.sessionId,
        address.returnToChat.messageId,
      ]
    : address.returnToRun !== undefined
      ? [
          ...(address.verificationRelationship === undefined
            ? []
            : ['relationship', address.verificationRelationship]),
          'return',
          'logs',
          ...logsRunAddressSegments(address.returnToRun),
        ]
      : []),
);

export const parseSourceRecordAddress = (
  route: ShellRoute,
): SourceRecordAddress | null => {
  if (
    route.surface !== 'data'
    || !SOURCE_RECORD_DATA_TABS.has(route.segments[0] ?? '')
    || route.segments[1] !== 'record'
    || route.segments.length < 4
  ) return null;
  const collectionSlug = route.segments[2] ?? '';
  const recordId = route.segments[3] ?? '';
  if (collectionSlug.length === 0 || recordId.length === 0) return null;
  if (route.segments.length === 4) {
    return {
      tab: route.segments[0] as SourceRecordDataTab,
      collectionSlug,
      recordId,
    };
  }
  let cursor = 4;
  let verificationRelationship: DataVerificationRelationship | undefined;
  if (route.segments[cursor] === 'relationship') {
    const candidate = route.segments[cursor + 1] ?? '';
    if (!DATA_VERIFICATION_RELATIONSHIPS.has(candidate)) return null;
    verificationRelationship = candidate as DataVerificationRelationship;
    cursor += 2;
  }
  if (route.segments[cursor] !== 'return') return null;
  if (
    verificationRelationship === undefined
    && route.segments[cursor + 1] === 'chat'
    && route.segments.length === cursor + 4
  ) {
    const sessionId = route.segments[cursor + 2] ?? '';
    const messageId = route.segments[cursor + 3] ?? '';
    if (sessionId.length === 0 || messageId.length === 0) return null;
    return {
      tab: route.segments[0] as SourceRecordDataTab,
      collectionSlug,
      recordId,
      returnToChat: { sessionId, messageId },
    };
  }
  if (route.segments[cursor + 1] !== 'logs') return null;
  const returnToRun = parseLogsRunAddress({
    surface: 'logs',
    segments: route.segments.slice(cursor + 2),
  });
  return returnToRun === null
    ? null
    : {
        tab: route.segments[0] as SourceRecordDataTab,
        collectionSlug,
        recordId,
        returnToRun,
        ...(verificationRelationship !== undefined
          ? { verificationRelationship }
          : {}),
      };
};

/** Exact Data entity reached from a run outcome. The explicit `item` marker
 * keeps it disjoint from legacy `#data/<tab>/<entity>` bookmarks, while the
 * typed Logs tail makes the verification round-trip reload-safe. */
export const serializeDataEntityVerificationAddress = (
  address: DataEntityVerificationAddress,
): string => serializeShellRoute(
  'data',
  address.tab,
  'item',
  address.entityId,
  ...(address.verificationRelationship === undefined
    ? []
    : ['relationship', address.verificationRelationship]),
  'return',
  'logs',
  ...logsRunAddressSegments(address.returnToRun),
);

export const parseDataEntityVerificationAddress = (
  route: ShellRoute,
): DataEntityVerificationAddress | null => {
  if (
    route.surface !== 'data'
    || !DATA_ENTITY_VERIFICATION_TABS.has(route.segments[0] ?? '')
    || route.segments[1] !== 'item'
  ) return null;
  const entityId = route.segments[2] ?? '';
  if (entityId.length === 0) return null;
  let cursor = 3;
  let verificationRelationship: DataVerificationRelationship | undefined;
  if (route.segments[cursor] === 'relationship') {
    const candidate = route.segments[cursor + 1] ?? '';
    if (!DATA_VERIFICATION_RELATIONSHIPS.has(candidate)) return null;
    verificationRelationship = candidate as DataVerificationRelationship;
    cursor += 2;
  }
  if (
    route.segments[cursor] !== 'return'
    || route.segments[cursor + 1] !== 'logs'
  ) return null;
  const returnToRun = parseLogsRunAddress({
    surface: 'logs',
    segments: route.segments.slice(cursor + 2),
  });
  return returnToRun === null
    ? null
    : {
        tab: route.segments[0] as DataEntityVerificationTab,
        entityId,
        returnToRun,
        ...(verificationRelationship !== undefined
          ? { verificationRelationship }
          : {}),
      };
};

/** Account-unqualified source record reached from a run outcome. Data resolves
 * the record across connected instances; ambiguous, unavailable, or missing
 * matches remain visible as an explicit choose-source/fallback state. */
export const serializeSourceRecordVerificationAddress = (
  address: SourceRecordVerificationAddress,
): string => serializeShellRoute(
  'data',
  address.tab,
  'verify',
  address.recordId,
  ...(address.verificationRelationship === undefined
    ? []
    : ['relationship', address.verificationRelationship]),
  'return',
  'logs',
  ...logsRunAddressSegments(address.returnToRun),
);

export const parseSourceRecordVerificationAddress = (
  route: ShellRoute,
): SourceRecordVerificationAddress | null => {
  if (
    route.surface !== 'data'
    || !SOURCE_RECORD_DATA_TABS.has(route.segments[0] ?? '')
    || route.segments[1] !== 'verify'
  ) return null;
  const recordId = route.segments[2] ?? '';
  if (recordId.length === 0) return null;
  let cursor = 3;
  let verificationRelationship: DataVerificationRelationship | undefined;
  if (route.segments[cursor] === 'relationship') {
    const candidate = route.segments[cursor + 1] ?? '';
    if (!DATA_VERIFICATION_RELATIONSHIPS.has(candidate)) return null;
    verificationRelationship = candidate as DataVerificationRelationship;
    cursor += 2;
  }
  if (
    route.segments[cursor] !== 'return'
    || route.segments[cursor + 1] !== 'logs'
  ) return null;
  const returnToRun = parseLogsRunAddress({
    surface: 'logs',
    segments: route.segments.slice(cursor + 2),
  });
  return returnToRun === null
    ? null
    : {
        tab: route.segments[0] as SourceRecordDataTab,
        recordId,
        returnToRun,
        ...(verificationRelationship !== undefined
          ? { verificationRelationship }
          : {}),
      };
};

/** Canonical serialized form of a raw hash — drops a leading `/`, a stray
 *  `?tail`, and empty segments, then re-encodes. Two hashes that mean the
 *  same route normalize equal, so the same-route remount check below doesn't
 *  fire on cosmetic differences. */
export const normalizeShellHash = (hash: string): string => {
  const route = parseShellRoute(hash);
  return serializeShellRoute(route.surface, ...route.segments);
};

/** Surfaces whose mount depends on a deep-link segment — navigating WITHIN
 *  the surface to a different segment must tear down + re-mount so the new
 *  `initial*` selection takes hold. Surfaces NOT listed here no-op on a
 *  same-surface hash change. Extend as each list→detail surface gains an
 *  addressable selection (R16 sequences Connections/Contracts/Data/… in). */
export const WEBCLIENT_DEEP_LINK_ROUTES: ReadonlySet<WebclientRouteId> =
  new Set<WebclientRouteId>([
    'recipes',
    'logs',
    'settings',
    'automation',
    'contracts',
    'connections',
    // R18 — external `#data/<tab>/<entity_id>` changes remount so the warehouse
    // explorer can hydrate a durable selection; in-page changes stay mounted.
    'data',
    // Set up Chat can detour from a durable thread through Settings and return
    // to `#chat/session/<id>`. Treat Chat as addressable so the shell's bare
    // `#chat` / New chat navigation also tears that restored thread down.
    'chat',
    // R19 — `#reception/<section>` (inbox · abuse · endpoints) re-mounts
    // on a section switch so the new `initialSection` takes; the deeper
    // endpoints segments (`#reception/endpoints/new|edit/<kind>`,
    // `#reception/endpoints/setup`, `#reception/endpoints/<id>`) remain durable
    // deep links. Production endpoint previews update in place; external
    // Back/Forward changes still rehydrate through this boundary.
    'reception',
    // R22 — external `#packs/<slug>[/use/<view>]` changes remount so pack and
    // runtime-view selections hydrate from a durable address. In-page changes
    // use the shared history controller and keep the live surface mounted.
    'packs',
    // Kitchen (Edit→Kitchen) — `#kitchen/recipe/<id>` (recipe editor) and
    // `#kitchen/pack[/<draft>]` (pack editor) are sibling authoring surfaces
    // under one route, so a hash change BETWEEN them (or to a different
    // recipe / draft) must tear down + re-mount to swap editors / reload the
    // selection. In-page draft selection uses the shared history controller,
    // so it never remounts — matching the packs precedent.
    'kitchen',
  ]);

/** Whether a same-surface navigation should re-mount: true iff `route` is a
 *  deep-link surface AND the two hashes resolve to different routes. */
export const shouldRemountForSameRoute = (
  route: WebclientRouteId,
  previousHash: string,
  nextHash: string,
): boolean =>
  (WEBCLIENT_DEEP_LINK_ROUTES.has(route)
    || (route === 'approvals' && [previousHash, nextHash].some(hash =>
      parseShellRoute(hash).segments[0] === 'preapproval')))
  && normalizeShellHash(previousHash) !== normalizeShellHash(nextHash);
