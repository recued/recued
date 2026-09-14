/** Same-tab continuity for a deliberate server-profile switch.
 *
 * A server switch is a full document reload because every live surface is
 * bound to one server. The URL itself carries the broad return area; this
 * module strips server-owned record ids before reload and ordinarily bridges
 * only the opaque target profile id through sessionStorage. A recovery return
 * may additionally carry the same canonical, scrubbed landing hash already in
 * the address bar plus a closed-list posture saying whether source-owned
 * detail was withheld. The target can distinguish that arrival once without
 * persisting a server address, profile name, record id, credential, or draft.
 */

import {
  parseShellRoute,
  serializeShellRoute,
} from './route.js';

export const SERVER_SWITCH_CONTINUITY_SESSION_KEY =
  'recued.webclient.server-switch-continuity.v1';

const RETIRED_MARKER = '0';
const MAX_PROFILE_ID_LENGTH = 256;

// Only closed-list navigation vocabulary may cross the server boundary.
// Preserving an arbitrary first segment would retain legacy record ids (most
// notably `#automation/<recipe-id>`) even if the target route later ignored it.
const SAFE_FIRST_SEGMENTS: Readonly<
  Partial<
    Record<ReturnType<typeof parseShellRoute>['surface'], ReadonlySet<string>>
  >
> = {
  settings: new Set([
    'account', 'backup', 'ai-models', 'seller', 'updates', 'housekeeping',
    'work-entities', 'privacy', 'devices', 'notifications', 'server',
  ]),
  connections: new Set(['mail', 'calendar', 'file', 'others', 'webhooks']),
  data: new Set([
    'contact', 'task', 'note', 'commitment', 'project', 'booking',
    'form_response', 'webhook', 'mail', 'calendar', 'crm', 'files',
    'annotation', 'link', 'shared', 'memory',
  ]),
  automation: new Set(['auto-run', 'triggers', 'schedules', 'dishes']),
  reception: new Set(['inbox', 'records', 'abuse', 'endpoints']),
};

export type ServerSwitchContinuityStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

/** Privacy-safe description of what the origin could preserve. It never names
 * a record, draft, session, run, connection, or other server-owned identity. */
export type RecoveryReturnContext = 'area' | 'detail_withheld';

export const isRecoveryReturnContext = (
  value: unknown,
): value is RecoveryReturnContext =>
  value === 'area' || value === 'detail_withheld';

export interface ServerSwitchArrival {
  readonly targetProfileId: string;
  /** Present only for a one-shot recovery return. Already canonical and free
   * of source-server record identities. */
  readonly recoveryReturnLandingHash?: string;
  /** Present on newly-armed returns; absent on the compatible v2 marker. */
  readonly recoveryReturnContext?: RecoveryReturnContext;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
};

const resolveStorage = (
  storage?: ServerSwitchContinuityStorage | null,
): ServerSwitchContinuityStorage | undefined => {
  if (storage === null) return undefined;
  if (storage !== undefined) return storage;
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } catch {
    return undefined;
  }
};

const validProfileId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_PROFILE_ID_LENGTH;

/** Make a marker inert before removing it. Privacy modes can permit a write
 * while denying deletion; the inert value can never replay an arrival. */
const retireMarker = (
  storage: ServerSwitchContinuityStorage | undefined,
): void => {
  if (storage === undefined) return;
  try {
    storage.setItem(SERVER_SWITCH_CONTINUITY_SESSION_KEY, RETIRED_MARKER);
    try {
      storage.removeItem(SERVER_SWITCH_CONTINUITY_SESSION_KEY);
    } catch {
      /* the marker is already inert */
    }
  } catch {
    try {
      storage.removeItem(SERVER_SWITCH_CONTINUITY_SESSION_KEY);
    } catch {
      /* best-effort retirement in denied storage */
    }
  }
};

/** Keep the same product area while removing identifiers whose meaning belongs
 * to the source server. Generic subviews (Settings section, Connections lane,
 * Data tab, etc.) remain useful on the target; detail records do not. */
export const safeServerSwitchLandingHash = (hash: string): string => {
  const route = parseShellRoute(hash);
  const first = route.segments[0];
  switch (route.surface) {
    case 'settings':
    case 'connections':
    case 'data':
    case 'automation':
    case 'reception': {
      const safeFirst = first !== undefined
        && SAFE_FIRST_SEGMENTS[route.surface]?.has(first) === true
        ? first
        : undefined;
      return serializeShellRoute(route.surface, safeFirst);
    }
    case 'kitchen':
      return first === 'recipe'
        ? serializeShellRoute('recipes')
        : serializeShellRoute('kitchen', 'pack');
    default:
      return serializeShellRoute(route.surface);
  }
};

const validSafeLandingHash = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 512
  && safeServerSwitchLandingHash(value) === value;

const SURFACE_LABELS: Readonly<Record<
  ReturnType<typeof parseShellRoute>['surface'],
  string
>> = {
  reception: 'Reception',
  settings: 'Settings',
  approvals: 'Approvals',
  kitchen: 'Kitchen',
  contracts: 'Contracts',
  connections: 'Connections',
  packs: 'Packs',
  recipes: 'Recipes',
  automation: 'Automation',
  data: 'Data',
  logs: 'Runs',
  stats: 'Stats',
  chat: 'Chat',
  mail: 'Mail',
};

const SAFE_SUBVIEW_LABELS: Readonly<Record<string, string>> = {
  account: 'Account',
  backup: 'Backup',
  'ai-models': 'AI models',
  seller: 'Seller',
  updates: 'Updates',
  housekeeping: 'Housekeeping',
  'work-entities': 'Your things',
  privacy: 'Privacy',
  devices: 'Devices',
  notifications: 'Notifications',
  server: 'Server',
  mail: 'Mail',
  calendar: 'Calendar',
  file: 'Files',
  others: 'Other connections',
  webhooks: 'Webhooks',
  contact: 'Contacts',
  task: 'Tasks',
  note: 'Notes',
  commitment: 'Commitments',
  project: 'Projects',
  booking: 'Bookings',
  form_response: 'Form responses',
  webhook: 'Webhooks',
  crm: 'CRM',
  files: 'Files',
  annotation: 'Annotations',
  link: 'Links',
  shared: 'Shared',
  memory: 'Memory',
  'auto-run': 'Auto-run',
  triggers: 'Triggers',
  schedules: 'Schedules',
  dishes: 'Dishes',
  inbox: 'Inbox',
  records: 'Records',
  abuse: 'Abuse',
  endpoints: 'Endpoints',
  pack: 'Pack builder',
};

/** Human-facing label for an already-scrubbed landing. It never exposes raw
 * segments: only the same closed-list vocabulary the scrubber preserves. */
export const serverSwitchLandingAreaLabel = (hash: string): string => {
  const canonical = safeServerSwitchLandingHash(hash);
  const route = parseShellRoute(canonical);
  const surface = SURFACE_LABELS[route.surface];
  const subview = route.segments[0] === undefined
    ? undefined
    : SAFE_SUBVIEW_LABELS[route.segments[0]];
  return subview === undefined ? surface : `${surface} · ${subview}`;
};

export interface RequestServerSwitchReloadOptions {
  readonly targetProfileId: string;
  /** Marks this switch as a recovery return. Must be canonical scrubber output;
   * invalid detail-bearing hashes fail before reload and are never persisted. */
  readonly recoveryReturnLandingHash?: string;
  /** Closed-list context posture paired with `recoveryReturnLandingHash`.
   * Omitted only for a compatible legacy return. */
  readonly recoveryReturnContext?: RecoveryReturnContext;
  /** Test/privacy seam. null disables the marker but still reloads. */
  readonly storage?: ServerSwitchContinuityStorage | null;
  /** Defaults to the current browser location reload. */
  readonly reload?: () => void;
}

/** Arm the one-shot target immediately before reloading. Storage denial only
 * removes the receipt; it never blocks an otherwise safe switch. */
export const requestServerSwitchReload = (
  options: RequestServerSwitchReloadOptions,
): void => {
  if (!validProfileId(options.targetProfileId)) {
    throw new Error('That server is no longer one you can use.');
  }
  if (
    options.recoveryReturnLandingHash !== undefined
    && !validSafeLandingHash(options.recoveryReturnLandingHash)
  ) {
    throw new Error('It is no longer safe to go back there.');
  }
  if (
    options.recoveryReturnContext !== undefined
    && (
      options.recoveryReturnLandingHash === undefined
      || !isRecoveryReturnContext(options.recoveryReturnContext)
    )
  ) {
    throw new Error('Recued can no longer take you back there.');
  }
  const storage = resolveStorage(options.storage);
  let markerArmed = false;
  if (storage !== undefined) {
    try {
      storage.setItem(
        SERVER_SWITCH_CONTINUITY_SESSION_KEY,
        JSON.stringify(options.recoveryReturnLandingHash === undefined
          ? {
              v: 1,
              target_profile_id: options.targetProfileId,
            }
          : options.recoveryReturnContext === undefined
            ? {
                v: 2,
                target_profile_id: options.targetProfileId,
                kind: 'recovery_return',
                landing_hash: options.recoveryReturnLandingHash,
              }
            : {
                v: 3,
                target_profile_id: options.targetProfileId,
                kind: 'recovery_return',
                landing_hash: options.recoveryReturnLandingHash,
                return_context: options.recoveryReturnContext,
              }),
      );
      markerArmed = true;
    } catch {
      /* continuity degrades to a normal switch reload */
    }
  }

  const browserLocation = options.reload === undefined
    ? (globalThis as { location?: Location }).location
    : undefined;
  const reload = options.reload
    ?? (browserLocation === undefined
      ? undefined
      : () => browserLocation.reload());
  if (reload === undefined) {
    if (markerArmed) retireMarker(storage);
    throw new Error('This tab cannot reload by itself.');
  }
  try {
    reload();
  } catch (error) {
    if (markerArmed) retireMarker(storage);
    throw error;
  }
};

/** Consume and retire the prior switch before trusting its contents. Unknown,
 * stale, or malformed values never earn an arrival confirmation. */
export const consumeServerSwitchArrival = (
  storage?: ServerSwitchContinuityStorage | null,
): ServerSwitchArrival | null => {
  const resolved = resolveStorage(storage);
  if (resolved === undefined) return null;
  let raw: string | null = null;
  try {
    raw = resolved.getItem(SERVER_SWITCH_CONTINUITY_SESSION_KEY);
  } catch {
    retireMarker(resolved);
    return null;
  }
  if (raw === null) return null;
  retireMarker(resolved);
  if (raw === RETIRED_MARKER) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (
      hasExactKeys(parsed, ['v', 'target_profile_id'])
      && parsed.v === 1
      && validProfileId(parsed.target_profile_id)
    ) return { targetProfileId: parsed.target_profile_id };
    if (
      hasExactKeys(parsed, [
        'v',
        'target_profile_id',
        'kind',
        'landing_hash',
      ])
      && parsed.v === 2
      && parsed.kind === 'recovery_return'
      && validProfileId(parsed.target_profile_id)
      && validSafeLandingHash(parsed.landing_hash)
    ) {
      return {
        targetProfileId: parsed.target_profile_id,
        recoveryReturnLandingHash: parsed.landing_hash,
      };
    }
    if (
      hasExactKeys(parsed, [
        'v',
        'target_profile_id',
        'kind',
        'landing_hash',
        'return_context',
      ])
      && parsed.v === 3
      && parsed.kind === 'recovery_return'
      && validProfileId(parsed.target_profile_id)
      && validSafeLandingHash(parsed.landing_hash)
      && isRecoveryReturnContext(parsed.return_context)
    ) {
      return {
        targetProfileId: parsed.target_profile_id,
        recoveryReturnLandingHash: parsed.landing_hash,
        recoveryReturnContext: parsed.return_context,
      };
    }
    return null;
  } catch {
    return null;
  }
};
