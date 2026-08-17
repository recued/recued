/** D-238 — the Microsoft Teams ingress runner (Graph short-poll).
 *
 *  Its own module rather than a fourth entry in `local-runners.ts`, because it
 *  differs from the three there in the two ways that matter and would otherwise
 *  be buried:
 *
 *  1. ⛔ **It resolves a CREDENTIAL PER POLL, not once at start.** Slack /
 *     Telegram / Discord hold a static bot token for the runner's lifetime.
 *     Teams holds a Graph delegated token that expires in about an hour, so a
 *     token captured at `start()` is dead within the hour and every poll after
 *     that 401s forever. `getAccessToken` is the same refresher-backed resolver
 *     the send path uses (D-238 § 2a), called on each tick.
 *  2. **There is no long-poll.** `getUpdates` holds a connection ~25s and
 *     returns the moment a message lands; Graph has no equivalent, so this is a
 *     timed short-poll. That is a smaller difference than it sounds — see the
 *     cadence note below.
 *
 *  Everything else deliberately mirrors `createTelegramPollRunner`: the cursor
 *  advances ONLY after the shared dispatcher resolves, so a storage failure or a
 *  paused server is retried rather than acknowledged and lost; the in-memory
 *  cursor stays behind the durable write for the same reason.
 *
 *  Design + the Graph facts it rests on: D-238 § 3a. */

import { makeBoundedOriginApiFetch } from '../bounded-origin-http-fetcher.js';
import type { MessengerWebhookDispatch } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import type { MessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import type {
  MessengerIngressRunnerState,
  MessengerLocalIngressRunner,
} from './local-runners.js';

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/** Graph's documented ceiling is ONE request per second per app per tenant on a
 *  given chat. This is the floor we refuse to go below, not a target. */
export const TEAMS_POLL_MIN_INTERVAL_MS = 1_000;

/** Default tick. Two seconds sits at half the throttle ceiling and is
 *  imperceptible in practice: an approval answered here is consumed by a turn
 *  whose own LLM latency is seconds, and every messenger vendor already carries
 *  1–2s of transport overhead. Buying 1s of latency at double the request volume
 *  (~86k/day/chat vs ~43k) is not a trade worth making by default. */
export const TEAMS_POLL_DEFAULT_INTERVAL_MS = 2_000;

/** Graph caps `$top` at 50. */
const TEAMS_PAGE_SIZE = 50;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** ⛔⛔ THE TRAP, and the reason this is one function rather than two strings.
 *
 *  Graph documents: *"You can only filter results if the request URL contains
 *  the `$orderby` and `$filter` query parameters configured for the SAME
 *  property; otherwise, the `$filter` query option is IGNORED."*
 *
 *  Ignored — not rejected. A drifted pair returns the whole recent history on
 *  every tick, forever, while the poll looks perfectly healthy and the cursor
 *  appears to work. Emitting both from one place with one property name is what
 *  makes the pair unable to drift; the sibling test asserts they agree in the
 *  COMPOSED url, because that is the only artifact where a drift would show. */
const CURSOR_PROPERTY = 'lastModifiedDateTime';

export const buildTeamsPollUrl = (chatId: string, cursorIso: string): string => {
  // ⚠ Hand-encoded rather than `URLSearchParams`, and the reason is one
  // character: `URLSearchParams.toString()` emits `+` for a space (it is
  // form-encoding), while `encodeURIComponent` emits `%20`. Both are legal in a
  // query string, but an OData `$filter` is a value with SIGNIFICANT spaces
  // (`lastModifiedDateTime gt 2024-…`), and `%20` is the encoding every Graph
  // example uses. Not worth discovering the difference against a live tenant.
  const query = [
    `$top=${TEAMS_PAGE_SIZE}`,
    // Descending is the ONLY order Graph supports here; the page is reversed
    // before dispatch (see `run`) so the cursor never skips.
    `$orderby=${encodeURIComponent(`${CURSOR_PROPERTY} desc`)}`,
    `$filter=${encodeURIComponent(`${CURSOR_PROPERTY} gt ${cursorIso}`)}`,
  ].join('&');
  return `${GRAPH_API_BASE}/chats/${encodeURIComponent(chatId)}/messages?${query}`;
};

/** The composite dedup key. ⛔ NOT the bare `id`: `chatMessage.id` is epoch
 *  MILLISECONDS as a string, and Microsoft enforces its uniqueness only WITHIN a
 *  chat (a colliding `createdDateTime` fails 409). It is a per-chat sequence
 *  number wearing a timestamp's clothes, so two different chats can carry the
 *  same value. `chatId` rides on every message, so the composite is free. */
export const teamsInboundId = (chatId: string, messageId: string): string =>
  `${chatId}:${messageId}`;

interface GraphChatMessage {
  id?: unknown;
  chatId?: unknown;
  messageType?: unknown;
  lastModifiedDateTime?: unknown;
  from?: unknown;
}

/** Is this a message a human actually wrote?
 *
 *  Graph interleaves `systemEventMessage` rows (someone renamed the chat, a
 *  member joined) into the same feed. They carry `from: null` and a non-`message`
 *  `messageType`. Both are checked: the pair is belt-and-braces because a system
 *  row reaching an answer parser as if it were a reply is the failure that would
 *  be hardest to explain afterwards.
 *
 *  ⚠ What this does NOT do is exclude RECUED'S OWN posts, and it cannot: the
 *  Graph credential is DELEGATED, so Recued posts as the owner and its asks are
 *  indistinguishable from the owner's replies by sender. Harmless while nothing
 *  consumes these (no text-answer parser exists — spec § 1), but it is a real
 *  constraint on building one: correlate by the ask's own message id, never by
 *  "who sent it". */
export const isTeamsUserMessage = (message: GraphChatMessage): boolean => {
  if (message.messageType !== 'message') return false;
  const from = message.from;
  return from !== null && typeof from === 'object';
};

export interface TeamsPollRunnerOptions {
  connectionName: string;
  credentialFingerprint: string;
  /** The bound chat (`19:…@thread.v2`). */
  chatId: string;
  /** ⛔ A PROVIDER, not a token — see the module header. Resolves through the
   *  D-238 § 2a refresher, so each tick uses a credential that is still valid.
   *  Returning null (no row, locked keystore) is a transient skip, not a fatal
   *  error: the connection may simply not be unlocked yet. */
  getAccessToken: () => Promise<string | null>;
  dispatch: MessengerWebhookDispatch;
  stateStore: MessengerIngressStateStore;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  onState?: (state: MessengerIngressRunnerState, detail?: string) => void;
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const waitFor = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Build the Teams ingress runner. */
export const createTeamsPollRunner = (
  options: TeamsPollRunnerOptions,
): MessengerLocalIngressRunner => {
  const fetchImpl = options.fetchImpl ?? makeBoundedOriginApiFetch();
  const now = options.now ?? Date.now;
  const interval = Math.max(
    TEAMS_POLL_MIN_INTERVAL_MS,
    options.pollIntervalMs ?? TEAMS_POLL_DEFAULT_INTERVAL_MS,
  );
  const controller = new AbortController();
  let task: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    let attempt = 0;
    let cursor: string | null = null;

    // 🔑 A fresh enrolment starts at NOW, never at the beginning of the chat.
    // Backfilling history would replay every message the owner has ever sent
    // into a dispatcher that treats them as new — and on a busy chat, page
    // through months of it before catching up.
    const loadCursor = (): string => {
      const saved = options.stateStore.get('teams', options.connectionName);
      if (
        saved?.mode === 'poll'
        && saved.credential_fingerprint === options.credentialFingerprint
        && typeof saved.state.cursor === 'string'
        && saved.state.cursor.length > 0
      ) {
        return saved.state.cursor;
      }
      return new Date(now()).toISOString();
    };

    while (!controller.signal.aborted) {
      try {
        if (cursor === null) {
          cursor = loadCursor();
          options.onState?.('connecting');
        }

        const token = await options.getAccessToken();
        if (token === null) {
          // Not an error: the keystore may not be unlocked yet, or the row may
          // have been removed while we were mid-flight. Back off and re-ask.
          options.onState?.('retrying', 'no usable credential yet');
          if (!await waitFor(interval, controller.signal)) break;
          continue;
        }

        const response = await fetchImpl(buildTeamsPollUrl(options.chatId, cursor), {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: controller.signal,
        });

        if (response.status === 429) {
          // Graph's own backpressure. Honour `Retry-After` when present rather
          // than applying our generic curve to a limit the provider is naming.
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1_000
            : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt++);
          options.onState?.('retrying', 'throttled by Graph');
          if (!await waitFor(waitMs, controller.signal)) break;
          continue;
        }

        if (!response.ok) {
          throw new Error(`Teams poll: http ${response.status}`);
        }

        const envelope = (await response.json()) as {
          value?: unknown;
          '@odata.nextLink'?: unknown;
        };
        const page = Array.isArray(envelope.value) ? envelope.value : [];
        // ⛔ A page is capped at 50 and ordered NEWEST-FIRST, so a full page may
        // be hiding older qualifying messages behind `@odata.nextLink`. Advancing
        // the cursor to the newest of this page would put those permanently
        // behind the next `gt` filter — an approval reply that silently never
        // arrives. When more remains, dispatch this page WITHOUT advancing past
        // it and come back immediately; the composite dedup key makes the re-read
        // harmless, and the backlog drains oldest-reachable-first over successive
        // ticks until the page is no longer full.
        const hasMore = typeof envelope['@odata.nextLink'] === 'string';
        options.onState?.('active');
        attempt = 0;

        // ⛔ Graph returns DESC and offers no ascending order. Dispatch oldest
        // first so the cursor only ever moves forward through a contiguous run:
        // advancing to the newest of a page and THEN failing partway would skip
        // every older message in it permanently.
        for (const raw of [...page].reverse()) {
          if (controller.signal.aborted) return;
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const message = raw as GraphChatMessage;
          const id = typeof message.id === 'string' ? message.id : null;
          const modified = typeof message.lastModifiedDateTime === 'string'
            ? message.lastModifiedDateTime
            : null;
          if (id === null || modified === null) continue;

          if (isTeamsUserMessage(message)) {
            const chatId = typeof message.chatId === 'string' && message.chatId.length > 0
              ? message.chatId
              : options.chatId;
            await options.dispatch({
              connection_name: options.connectionName,
              payload: raw,
              message_id: teamsInboundId(chatId, id),
            } as Parameters<MessengerWebhookDispatch>[0]);
          }

          // Advance past this message either way — a skipped system row must not
          // be re-read forever — but only AFTER any dispatch resolved, and only
          // through the durable write. The in-memory cursor stays behind it so a
          // storage failure re-reads rather than silently losing the message.
          //
          // ⛔ NOT while a further page exists: this page is the NEWEST 50, so
          // moving the cursor forward now would strand everything older that is
          // still unread. Those messages were still dispatched above — the dedup
          // key covers the re-read — the cursor simply waits.
          if (hasMore) continue;
          options.stateStore.put({
            vendor: 'teams',
            connection_name: options.connectionName,
            mode: 'poll',
            credential_fingerprint: options.credentialFingerprint,
            state: { cursor: modified },
          });
          cursor = modified;
        }

        // A truncated page means there is a backlog; come straight back for it
        // rather than idling a full tick per 50 messages.
        if (hasMore) continue;
        if (!await waitFor(interval, controller.signal)) break;
      } catch (error) {
        if (controller.signal.aborted) break;
        const detail = errorMessage(error);
        options.onState?.('retrying', detail);
        options.log?.('warn', 'Teams polling failed; retrying', {
          connection_name: options.connectionName,
          error: detail,
        });
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt++);
        if (!await waitFor(backoff, controller.signal)) break;
      }
    }
    options.onState?.('stopped');
  };

  return {
    start() {
      if (task !== null) return;
      task = run();
    },
    async stop() {
      controller.abort();
      await task;
      options.onState?.('stopped');
    },
  };
};
