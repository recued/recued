/** Notices the owner was not looking at when they came — shown when they are back.
 *
 *  A one-way notice (`notification.notify`) reaches the webclient as a six-second toast, and
 *  that is its only surface here: the durable Settings feed was retired (R31 delta D — a notice
 *  is not audit material, and an ask, which is, has `#approvals`). So an owner whose app was
 *  closed, offline or in a background tab when a notice came never saw it — a buyer a selling
 *  form turned away, a webhook that stopped — unless a Bridge or a messenger was set up.
 *
 *  This keeps R31's ruling and closes the hole: no feed, no history page. Each notice is seen
 *  ONCE — live when the owner is looking, otherwise the next time they are. On connecting, and
 *  on coming back to a hidden tab, it reads `notification.recent` (the history the server keeps
 *  for the Bridge) and shows every notice newer than the last one this browser accounted for,
 *  each kept until dismissed, with when it was sent and its link.
 *
 *  ## What "seen" means
 *
 *  A live frame that arrives while the page is VISIBLE was seen: its toast showed. The frame
 *  carries no id (`ServerRecentNotification` says so), so it is matched to its history row by
 *  what it says — title and text, which both are built from the same message. A frame that
 *  arrives while the page is HIDDEN was not seen; its row is caught up on return.
 *
 *  ⚠ The first time a browser runs this, nothing is shown: there is no "last seen" yet, and
 *  showing the whole history to a newly paired browser would repeat everything the owner
 *  already saw elsewhere. That read only records where the history stands.
 *
 *  Spec: D-169 § N.5 #3 (the live surface); D-207 (the turned-away
 *  notice this was built for). */

import type { ServerRecentNotification } from '@recued/contracts';

import type { BroadcastSubscriber } from './realtime/subscriber.js';

export const NOTICE_CATCH_UP_STORAGE_KEY = 'recued.notice-catch-up.v1';
/** How much history one catch-up reads — the server's own default page. */
export const NOTICE_CATCH_UP_READ_LIMIT = 50;
/** How many missed notices are shown one by one. More than this become one summary card: the
 *  toast stack shows four at most, and a fifth would push the oldest off unread. */
export const NOTICE_CATCH_UP_SHOWN_MAX = 3;
/** After a read, how long to wait before deciding what was missed: a notice written just
 *  before the read may have its live toast still on the way. */
export const NOTICE_CATCH_UP_SETTLE_MS = 1_500;
/** After a live notice the owner saw, how long until the history is read to record it. */
export const NOTICE_CATCH_UP_AFTER_LIVE_MS = 2_000;
/** After connecting, how long to wait before reading the history. A page that loads fires its
 *  own reads at once — Settings 88 in a live load, past the server's 64 running calls per client — and a
 *  missed notice is not urgent, so this read goes after that burst instead of ahead of reads the
 *  page needs. Before the call client held calls past that limit (`rpc-conn.ts`), a read in the
 *  burst was refused outright (found live, 2026-10-22: the Seller page's own read). */
export const NOTICE_CATCH_UP_CONNECT_DELAY_MS = 2_500;
/** A failed history read is tried again while connected: first after this, doubling to the
 *  max. ⚠ Not optional: a read that waited for the next reconnect would leave the notice it was
 *  there to show unshown. Found live, 2026-10-22, when a busy page load answered the read
 *  `rpc_overloaded`. The call client now sends a refused call again by itself, so this covers
 *  what it cannot: a timeout, a dropped connection, a server busy for a call's whole wait. */
export const NOTICE_CATCH_UP_RETRY_INITIAL_MS = 1_000;
export const NOTICE_CATCH_UP_RETRY_MAX_MS = 30_000;
/** Refusals that another try cannot change. */
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(['unknown_method', 'not_configured', 'permission_denied']);
/** A live notice not matched to its history row by then never will be. */
const LIVE_SEEN_TTL_MS = 10 * 60_000;
const LIVE_SEEN_MAX = 50;
/** How far behind the newest notice a history row may be dated and still be caught up. ⚠ Not
 *  every notice is dated when it is written: the email-chat notices carry the time they fell
 *  due (`mail-chat-door/answers.ts`), so a row can land behind one already accounted for. Rows
 *  inside this window are told apart by id, not by time. */
export const NOTICE_CATCH_UP_BACKDATE_MS = 15 * 60_000;
const ACCOUNTED_MAX = 200;

/** The small synchronous part of `Storage`, so a test or a namespaced adapter can stand in. */
export interface NoticeCatchUpStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One missed notice, as the toast stack takes it. */
export interface NoticeCatchUpToast {
  readonly title?: string;
  readonly text: string;
  readonly link_url?: string;
  readonly sticky: true;
}

export interface NoticeCatchUpOptions {
  subscribe: BroadcastSubscriber['on'];
  listRecent: (args: { limit: number }) => Promise<{ notifications: ServerRecentNotification[] }>;
  present: (toast: NoticeCatchUpToast) => void;
  storage?: NoticeCatchUpStorage;
  storageKey?: string;
  /** Is the owner looking at this page? Defaults to `document.visibilityState`. */
  isVisible?: () => boolean;
  /** Call `listener` whenever the page becomes visible; returns an unsubscribe. */
  onBecameVisible?: (listener: () => void) => () => void;
  setTimer?: (handler: () => void, ms: number) => { cancel: () => void };
  now?: () => number;
  /** "at 10:02" / "on Tue 20 Oct at 10:02" — injectable so tests do not depend on a zone. */
  formatWhen?: (fired_at: number, now: number) => string;
  onError?: (error: unknown) => void;
}

export interface NoticeCatchUp {
  /** Connected ⇒ catch up now (or when the page is next visible). */
  setConnected(connected: boolean): void;
  /** Read the history and show what was missed. Concurrent calls share one read. */
  catchUp(): Promise<void>;
  dispose(): void;
}

interface Mark {
  /** The newest `fired_at` accounted for. */
  readonly through: number;
  /** Every notice accounted for within `NOTICE_CATCH_UP_BACKDATE_MS` of `through`, as
   *  `[id, fired_at]`. Older than that, `through` alone decides. */
  readonly ids: ReadonlyArray<readonly [string, number]>;
}

interface LiveSeen {
  readonly fp: string;
  readonly at: number;
}

const fingerprint = (title: unknown, text: unknown): string =>
  `${typeof title === 'string' ? title.trim() : ''}\u0000${typeof text === 'string' ? text.trim() : ''}`;

const readStored = (
  storage: NoticeCatchUpStorage | undefined,
  key: string,
  report: (error: unknown) => void,
): { mark: Mark | null; live: LiveSeen[] } => {
  if (storage === undefined) return { mark: null, live: [] };
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { mark: null, live: [] };
    const parsed = JSON.parse(raw) as { version?: unknown; through?: unknown; ids?: unknown; live?: unknown };
    if (parsed?.version !== 1 || typeof parsed.through !== 'number' || !Number.isFinite(parsed.through)) {
      return { mark: null, live: [] };
    }
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((entry): entry is [string, number] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number')
        .slice(-ACCOUNTED_MAX)
      : [];
    const live = Array.isArray(parsed.live)
      ? parsed.live.filter((entry): entry is LiveSeen =>
        entry !== null && typeof entry === 'object'
        && typeof (entry as LiveSeen).fp === 'string' && typeof (entry as LiveSeen).at === 'number')
        .slice(-LIVE_SEEN_MAX)
      : [];
    return { mark: { through: parsed.through, ids }, live };
  } catch (error) {
    report(error);
    return { mark: null, live: [] };
  }
};

const defaultFormatWhen = (fired_at: number, now: number): string => {
  const at = new Date(fired_at);
  try {
    const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (at.toDateString() === new Date(now).toDateString()) return `at ${time}`;
    const day = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return `on ${day} at ${time}`;
  } catch {
    return `at ${at.toISOString()}`;
  }
};

const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** The card for the missed notices too many to show one by one: how many, and the latest few
 *  by title. "Or more" when the history read did not reach back to the last one seen. */
const summaryText = (folded: readonly ServerRecentNotification[], more: boolean): string => {
  const titles = folded.slice(-5).map((row) => `“${(row.title ?? row.text).trim()}”`);
  if (folded.length === 0) return 'Older notices came while you were away, too many to show here.';
  const count = more ? `${folded.length} or more earlier notices` : folded.length === 1 ? '1 earlier notice' : `${folded.length} earlier notices`;
  return folded.length > titles.length || more
    ? `${count} came while you were away. The latest: ${listed(titles)}.`
    : `${count} came while you were away: ${listed(titles)}.`;
};

const sentence = (text: string): string => {
  const trimmed = text.trim();
  return trimmed === '' || /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

export const followNoticeCatchUp = (options: NoticeCatchUpOptions): NoticeCatchUp => {
  const storageKey = options.storageKey ?? NOTICE_CATCH_UP_STORAGE_KEY;
  const now = options.now ?? (() => Date.now());
  const formatWhen = options.formatWhen ?? defaultFormatWhen;
  const setTimer = options.setTimer ?? ((handler, ms) => {
    const id = globalThis.setTimeout(handler, ms);
    return { cancel: () => globalThis.clearTimeout(id) };
  });
  const isVisible = options.isVisible ?? (() => {
    const doc = (globalThis as { document?: { visibilityState?: string } }).document;
    return doc?.visibilityState === undefined || doc.visibilityState === 'visible';
  });
  let disposed = false;
  const report = (error: unknown): void => {
    if (disposed) return;
    try { options.onError?.(error); } catch { /* telemetry must not re-enter */ }
  };

  const stored = readStored(options.storage, storageKey, report);
  let mark: Mark | null = stored.mark;
  let liveSeen: LiveSeen[] = stored.live;
  let connected = false;
  /** Something may have been missed: a (re)connect, or a notice that came while hidden. */
  let owed = false;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let afterLive: { cancel: () => void } | null = null;
  let retryTimer: { cancel: () => void } | null = null;
  let retryDelay = NOTICE_CATCH_UP_RETRY_INITIAL_MS;
  let connectTimer: { cancel: () => void } | null = null;

  const cancelRetry = (): void => {
    retryTimer?.cancel();
    retryTimer = null;
  };

  const scheduleRetry = (error: unknown): void => {
    const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && PERMANENT_REFUSALS.has(code)) return;
    if (disposed || !connected || retryTimer !== null) return;
    const delay = retryDelay;
    retryDelay = Math.min(NOTICE_CATCH_UP_RETRY_MAX_MS, retryDelay * 2);
    retryTimer = setTimer(() => {
      retryTimer = null;
      catchUpIfLooking();
    }, delay);
  };

  const persist = (): void => {
    if (options.storage === undefined || mark === null) return;
    try {
      options.storage.setItem(storageKey, JSON.stringify({
        version: 1,
        through: mark.through,
        ids: mark.ids,
        live: liveSeen,
      }));
    } catch (error) {
      report(error);
    }
  };

  /** A mark through `through` that remembers `entries`, pruned to the backdate window. */
  const markOf = (through: number, entries: Iterable<readonly [string, number]>): Mark => {
    const byId = new Map<string, number>();
    for (const [id, fired_at] of entries) {
      if (fired_at > through - NOTICE_CATCH_UP_BACKDATE_MS) byId.set(id, fired_at);
    }
    return {
      through,
      ids: [...byId.entries()].sort((a, b) => a[1] - b[1]).slice(-ACCOUNTED_MAX),
    };
  };

  /** Another tab of this profile may have moved the mark on: never move it back. */
  const adoptStoredMark = (): void => {
    const latest = readStored(options.storage, storageKey, report).mark;
    if (latest === null) return;
    if (mark === null) {
      mark = latest;
      return;
    }
    mark = markOf(Math.max(mark.through, latest.through), [...mark.ids, ...latest.ids]);
  };

  const isNewer = (row: ServerRecentNotification, at: Mark): boolean =>
    row.fired_at > at.through - NOTICE_CATCH_UP_BACKDATE_MS
    && !at.ids.some(([id]) => id === row.id);

  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimer(resolve, ms);
  });

  const presentMissed = (missed: readonly ServerRecentNotification[], more: boolean): void => {
    const at = now();
    const shown = missed.length > NOTICE_CATCH_UP_SHOWN_MAX
      ? missed.slice(missed.length - (NOTICE_CATCH_UP_SHOWN_MAX - 1))
      : missed;
    const folded = missed.slice(0, missed.length - shown.length);
    // Oldest first: the stack puts each new card on top, so the newest ends up first.
    if (folded.length > 0 || more) options.present({ title: 'Earlier notices', text: summaryText(folded, more), sticky: true });
    for (const row of shown) {
      const link = row.ui_link_url ?? row.link_url;
      options.present({
        ...(row.title !== undefined && row.title.trim() !== '' ? { title: row.title } : {}),
        text: `${sentence(row.text)} Sent ${formatWhen(row.fired_at, at)}.`,
        ...(link !== undefined ? { link_url: link } : {}),
        sticky: true,
      });
    }
  };

  const runCatchUp = async (): Promise<void> => {
    const read = await options.listRecent({ limit: NOTICE_CATCH_UP_READ_LIMIT });
    if (disposed) return;
    const rows = Array.isArray(read?.notifications)
      ? read.notifications.filter((row) =>
        row !== null && typeof row === 'object' && typeof row.id === 'string'
        && typeof row.text === 'string' && typeof row.fired_at === 'number')
      : [];
    const newest = rows.reduce((max, row) => Math.max(max, row.fired_at), Number.NEGATIVE_INFINITY);
    adoptStoredMark();
    if (mark === null) {
      // First run in this browser: record where the history stands, show nothing — and at
      // once. ⛔ Not after the settle wait below: a first visit that leaves inside it saves no
      // mark, and the NEXT visit is a first run too and swallows what came in between (found
      // live, 2026-10-22: a buyer turned away between two short visits was never shown).
      mark = rows.length === 0
        ? { through: 0, ids: [] }
        : markOf(newest, rows.map((row) => [row.id, row.fired_at] as const));
      liveSeen = [];
      persist();
      return;
    }
    // Let a live toast for a notice written just before the read land first.
    await wait(NOTICE_CATCH_UP_SETTLE_MS);
    if (disposed) return;
    adoptStoredMark();
    const cutoff = now() - LIVE_SEEN_TTL_MS;
    liveSeen = liveSeen.filter((entry) => entry.at >= cutoff);
    const current = mark;
    const fresh = rows.filter((row) => isNewer(row, current)).sort((a, b) => a.fired_at - b.fired_at);
    const missed: ServerRecentNotification[] = [];
    for (const row of fresh) {
      const fp = fingerprint(row.title, row.text);
      const seen = liveSeen.findIndex((entry) => entry.fp === fp);
      if (seen >= 0) liveSeen.splice(seen, 1);
      else missed.push(row);
    }
    // A full page that is all new may not reach back to the mark: say "or more".
    const more = rows.length >= NOTICE_CATCH_UP_READ_LIMIT && fresh.length === rows.length;
    if (fresh.length > 0) {
      mark = markOf(
        Math.max(current.through, newest),
        [...current.ids, ...fresh.map((row) => [row.id, row.fired_at] as const)],
      );
    }
    persist();
    if (missed.length > 0) presentMissed(missed, more);
  };

  const catchUp = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight !== null) {
      again = true;
      return inFlight;
    }
    owed = false;
    inFlight = (async () => {
      try {
        do {
          again = false;
          await runCatchUp();
        } while (again && !disposed);
        retryDelay = NOTICE_CATCH_UP_RETRY_INITIAL_MS;
      } catch (error) {
        // The read failed: ask again shortly. Nothing else needs remembering — a reconnect owes
        // a read anyway, and a refusal no retry can change will not change on a tab switch.
        report(error);
        inFlight = null;
        scheduleRetry(error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  function catchUpIfLooking(): void {
    if (disposed || !connected) return;
    if (isVisible()) void catchUp();
    else owed = true;
  }

  const unsubscribeNotify = options.subscribe('notification.notify', (event) => {
    if (disposed || typeof event.text !== 'string') return;
    if (!isVisible()) {
      // Its toast came and went unseen: catch it up when the owner is back.
      owed = true;
      return;
    }
    liveSeen.push({ fp: fingerprint(event.title, event.text), at: now() });
    if (liveSeen.length > LIVE_SEEN_MAX) liveSeen.splice(0, liveSeen.length - LIVE_SEEN_MAX);
    persist();
    // Read the history shortly, so the mark moves past what the owner just saw.
    afterLive?.cancel();
    afterLive = setTimer(() => {
      afterLive = null;
      if (connected && isVisible()) void catchUp();
    }, NOTICE_CATCH_UP_AFTER_LIVE_MS);
  });

  const unsubscribeVisible = options.onBecameVisible?.(() => {
    // During the connect wait the timer reads; coming back to the tab then adds nothing.
    if (owed && connectTimer === null) catchUpIfLooking();
  }) ?? (() => {});

  return {
    setConnected: (next) => {
      if (disposed) return;
      connected = next;
      connectTimer?.cancel();
      connectTimer = null;
      if (next) {
        owed = true;
        connectTimer = setTimer(() => {
          connectTimer = null;
          catchUpIfLooking();
        }, NOTICE_CATCH_UP_CONNECT_DELAY_MS);
      } else {
        // A reconnect asks afresh; a retry timed for the old socket would only add a read.
        cancelRetry();
        retryDelay = NOTICE_CATCH_UP_RETRY_INITIAL_MS;
      }
    },
    catchUp,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      afterLive?.cancel();
      afterLive = null;
      connectTimer?.cancel();
      connectTimer = null;
      cancelRetry();
      for (const stop of [unsubscribeNotify, unsubscribeVisible]) {
        try { stop(); } catch { /* one cannot strand the other */ }
      }
    },
  };
};
