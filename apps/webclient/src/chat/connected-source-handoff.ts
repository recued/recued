import type { CollectionAuthState } from '@recued/contracts';
import {
  ACCOUNT_SLUG_REGEX,
  findAccountLane,
  findAccountProvider,
  type AccountLaneId,
} from '@recued/ui-shared';

import {
  serializeShellRoute,
  type ShellRoute,
} from '../shell/route.js';

export const CHAT_CONNECTED_SOURCE_SEGMENT = 'source';

/** Durable context carried from a successful foundational connection into
 * Chat. The live list RPC remains authoritative for readiness; the hash only
 * identifies which source the owner explicitly chose to use next. */
export interface ChatConnectedSource {
  readonly lane: AccountLaneId;
  readonly providerId: string;
  readonly slug: string;
}

const ACCOUNT_LANE_IDS: ReadonlySet<string> = new Set([
  'mail',
  'calendar',
  'file',
]);

export const parseChatConnectedSource = (
  route: ShellRoute,
): ChatConnectedSource | null => {
  if (
    route.surface !== 'chat'
    || route.segments.length !== 4
    || route.segments[0] !== CHAT_CONNECTED_SOURCE_SEGMENT
  ) return null;
  const lane = route.segments[1] ?? '';
  const providerId = route.segments[2]?.trim() ?? '';
  const slug = route.segments[3]?.trim() ?? '';
  if (
    !ACCOUNT_LANE_IDS.has(lane)
    || providerId.length === 0
    || !ACCOUNT_SLUG_REGEX.test(slug)
  ) return null;
  const accountLane = findAccountLane(lane as AccountLaneId);
  if (
    accountLane === undefined
    || findAccountProvider(accountLane, providerId) === undefined
  ) return null;
  return { lane: lane as AccountLaneId, providerId, slug };
};

export const serializeChatConnectedSource = (
  source: ChatConnectedSource,
): string => serializeShellRoute(
  'chat',
  CHAT_CONNECTED_SOURCE_SEGMENT,
  source.lane,
  source.providerId,
  source.slug,
);

export const serializeConnectedSourceChatSetup = (
  source: ChatConnectedSource,
): string => serializeShellRoute(
  'settings',
  'ai-models',
  'setup',
  CHAT_CONNECTED_SOURCE_SEGMENT,
  source.lane,
  source.providerId,
  source.slug,
);

export const parseConnectedSourceChatSetup = (
  route: ShellRoute,
): ChatConnectedSource | null => {
  if (
    route.surface !== 'settings'
    || route.segments.length !== 6
    || route.segments[0] !== 'ai-models'
    || route.segments[1] !== 'setup'
    || route.segments[2] !== CHAT_CONNECTED_SOURCE_SEGMENT
  ) return null;
  return parseChatConnectedSource({
    surface: 'chat',
    segments: [
      CHAT_CONNECTED_SOURCE_SEGMENT,
      route.segments[3] ?? '',
      route.segments[4] ?? '',
      route.segments[5] ?? '',
    ],
  });
};

export const connectedSourceConnectionHref = (
  source: ChatConnectedSource,
): string => serializeShellRoute('connections', source.lane, source.slug);

export type ChatConnectedSourceStatusState =
  | 'pending'
  | 'ready'
  | 'attention'
  | 'missing';

export interface ChatConnectedSourceStatus {
  readonly state: ChatConnectedSourceStatusState;
  readonly identity: string;
  readonly authState?: CollectionAuthState;
  readonly lastSyncedAt?: number | null;
}

/** Structural subset shared by mail, calendar, and file list rows. */
export interface ChatConnectedSourceStatusRow {
  readonly slug: string;
  readonly adapter_type: string;
  readonly auth_state: CollectionAuthState;
  readonly last_synced_at: number | null;
  readonly account_email?: string;
}

export const projectChatConnectedSourceStatus = (
  source: ChatConnectedSource,
  rows: ReadonlyArray<ChatConnectedSourceStatusRow>,
): ChatConnectedSourceStatus => {
  const row = rows.find(
    (candidate) => candidate.slug === source.slug
      && candidate.adapter_type === source.providerId,
  );
  if (row === undefined) return { state: 'missing', identity: source.slug };
  const identity = row.account_email?.trim() || source.slug;
  if (row.auth_state !== 'healthy') {
    return {
      state: 'attention',
      identity,
      authState: row.auth_state,
      lastSyncedAt: row.last_synced_at,
    };
  }
  return row.last_synced_at === null
    ? { state: 'pending', identity, authState: row.auth_state, lastSyncedAt: null }
    : {
        state: 'ready',
        identity,
        authState: row.auth_state,
        lastSyncedAt: row.last_synced_at,
      };
};

export const connectedSourceProviderLabel = (
  source: ChatConnectedSource,
): string => {
  const lane = findAccountLane(source.lane);
  return lane === undefined
    ? source.providerId
    : findAccountProvider(lane, source.providerId)?.label ?? source.providerId;
};

/** A useful, source-anchored draft. It is filled only after the live list says
 * the first sync completed, and is never sent without an explicit user action. */
export const connectedSourceStarterPrompt = (
  source: ChatConnectedSource,
): string => {
  if (source.lane === 'mail') {
    return `Using my ${source.slug} mailbox, summarize what needs my attention and suggest the next three actions.`;
  }
  if (source.lane === 'calendar') {
    return `Using my ${source.slug} calendar, show what needs my attention this week and help me prepare.`;
  }
  return `Using my ${source.slug} files, summarize the most important recent information and suggest what to do next.`;
};
