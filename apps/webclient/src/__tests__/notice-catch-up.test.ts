/** A notice the owner was not looking at is shown once when they are back (`notice-catch-up.ts`).
 *
 *  Driven through the module's real seams — the bus subscription, the `notification.recent`
 *  read, the browser storage, the page's visibility and the timers — with fakes that remember
 *  what they were given, so a reload is a NEW follower over the SAME storage. */

import { describe, expect, it } from 'vitest';
import type { ServerRecentNotification } from '@recued/contracts';

import {
  NOTICE_CATCH_UP_AFTER_LIVE_MS,
  NOTICE_CATCH_UP_BACKDATE_MS,
  NOTICE_CATCH_UP_CONNECT_DELAY_MS,
  NOTICE_CATCH_UP_READ_LIMIT,
  NOTICE_CATCH_UP_RETRY_INITIAL_MS,
  NOTICE_CATCH_UP_SETTLE_MS,
  followNoticeCatchUp,
  type NoticeCatchUpStorage,
  type NoticeCatchUpToast,
} from '../notice-catch-up.js';

const T0 = 1_792_000_000_000;

const notice = (id: string, fired_at: number, over: Partial<ServerRecentNotification> = {}): ServerRecentNotification => ({
  id,
  title: `Title ${id}`,
  text: `Text ${id}.`,
  fired_at,
  ...over,
});

/** The world one browser profile lives in: what the server keeps, and what the page holds. */
const world = () => {
  let history: ServerRecentNotification[] = [];
  const store = new Map<string, string>();
  const storage: NoticeCatchUpStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
  };
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  let clock = T0;
  let reads = 0;
  let failing = 0;
  let failCode: string | undefined;
  return {
    storage,
    store,
    get reads() { return reads; },
    failNextRead: (times = 1, code?: string) => { failing = times; failCode = code; },
    /** The server records a notice (newest first, as `notification.recent` answers). */
    fire: (row: ServerRecentNotification) => { history = [row, ...history].sort((a, b) => b.fired_at - a.fired_at); },
    listRecent: async ({ limit }: { limit: number }) => {
      reads += 1;
      if (failing > 0) {
        failing -= 1;
        throw Object.assign(new Error('refused'), failCode === undefined ? {} : { code: failCode });
      }
      return { notifications: history.slice(0, limit) };
    },
    setTimer: (run: () => void, ms: number) => {
      const timer = { at: clock + ms, run, live: true };
      timers.push(timer);
      return { cancel: () => { timer.live = false; } };
    },
    now: () => clock,
    /** Let time pass, running the timers that fall due, and the promises they free. */
    advance: async (ms: number) => {
      const until = clock + ms;
      for (;;) {
        for (let n = 0; n < 10; n += 1) await Promise.resolve();
        const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        clock = due.at;
        due.run();
      }
      clock = until;
      for (let n = 0; n < 10; n += 1) await Promise.resolve();
    },
  };
};

type World = ReturnType<typeof world>;

/** One page load: a follower over the world's storage, with its own bus and visibility. */
const page = (w: World, opts: { visible?: boolean } = {}) => {
  const shown: NoticeCatchUpToast[] = [];
  let visible = opts.visible ?? true;
  const visibleListeners: Array<() => void> = [];
  let notifyListener: ((event: { title?: string; text: string }) => void) | null = null;
  const errors: unknown[] = [];
  const follower = followNoticeCatchUp({
    subscribe: ((kind: string, listener: (event: { title?: string; text: string }) => void) => {
      if (kind === 'notification.notify') notifyListener = listener;
      return () => { notifyListener = null; };
    }) as never,
    listRecent: w.listRecent,
    present: (toast) => { shown.push(toast); },
    storage: w.storage,
    isVisible: () => visible,
    onBecameVisible: (listener) => {
      visibleListeners.push(listener);
      return () => {};
    },
    setTimer: w.setTimer,
    now: w.now,
    formatWhen: (fired_at) => `at T+${String((fired_at - T0) / 1_000)}s`,
    onError: (error) => { errors.push(error); },
  });
  return {
    follower,
    shown,
    errors,
    /** A live frame reaches this page (the server fired a notice while it was connected). */
    live: (row: ServerRecentNotification) => notifyListener?.({ ...(row.title !== undefined ? { title: row.title } : {}), text: row.text }),
    hide: () => { visible = false; },
    show: () => {
      visible = true;
      for (const listener of visibleListeners) listener();
    },
  };
};

/** Connect a page and let its catch-up finish. */
const connect = async (w: World, p: ReturnType<typeof page>): Promise<void> => {
  p.follower.setConnected(true);
  await w.advance(NOTICE_CATCH_UP_CONNECT_DELAY_MS + NOTICE_CATCH_UP_SETTLE_MS);
};

/** A browser that has run this before: its first page load records where the history stood. */
const seasoned = async (w: World): Promise<void> => {
  const first = page(w);
  await connect(w, first);
  first.follower.dispose();
};

describe('the first run in a browser', () => {
  it('records where the history stands and shows nothing — not the history it never saw', async () => {
    const w = world();
    w.fire(notice('a', T0 - 3_600_000));
    w.fire(notice('b', T0 - 60_000));
    const p = page(w);
    await connect(w, p);

    expect(p.shown).toEqual([]);
    expect(w.store.size).toBe(1);
  });
});

describe('a first visit that is short', () => {
  it('still records where the history stands, so the next visit shows what came in between', async () => {
    const w = world();
    w.fire(notice('old', T0 - 60_000));
    const first = page(w);
    first.follower.setConnected(true);
    // The read is answered; the owner leaves before anything else could happen.
    await w.advance(NOTICE_CATCH_UP_CONNECT_DELAY_MS);
    first.follower.dispose();

    w.fire(notice('dana', T0 + 30_000));
    const second = page(w);
    await connect(w, second);
    expect(second.shown.map((toast) => toast.title)).toEqual(['Title dana']);
  });
});

describe('a notice sent while the app was closed', () => {
  it('is shown on the next visit, kept until dismissed, with when it was sent and its in-app link', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('dana', T0 + 120_000, {
      title: 'A buyer could not pay for Freelance Client Kit',
      text: 'Someone sent your form “Buy the kit”. Recued will not repeat this notice for an hour.',
      link_url: 'https://me.example/#settings/seller/offers/detail/client-kit',
      ui_link_url: '#settings/seller/offers/detail/client-kit',
    }));
    await w.advance(300_000);

    const p = page(w);
    await connect(w, p);

    expect(p.shown).toEqual([{
      title: 'A buyer could not pay for Freelance Client Kit',
      text: 'Someone sent your form “Buy the kit”. Recued will not repeat this notice for an hour. Sent at T+120s.',
      // The in-app address, so it opens in the app the owner is using.
      link_url: '#settings/seller/offers/detail/client-kit',
      sticky: true,
    }]);
  });

  it('is shown once: the next visit does not show it again', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('dana', T0 + 1_000));
    const first = page(w);
    await connect(w, first);
    expect(first.shown).toHaveLength(1);
    first.follower.dispose();

    const second = page(w);
    await connect(w, second);
    expect(second.shown).toEqual([]);
  });

  it('falls back to the notice’s own link when it has no in-app one', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('ext', T0 + 1_000, { link_url: 'https://status.example.com/' }));
    const p = page(w);
    await connect(w, p);
    expect(p.shown[0]?.link_url).toBe('https://status.example.com/');
  });

  it('shows several in the order they came, the newest last so it lands on top', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('one', T0 + 1_000));
    w.fire(notice('two', T0 + 2_000));
    const p = page(w);
    await connect(w, p);
    expect(p.shown.map((toast) => toast.title)).toEqual(['Title one', 'Title two']);
  });

  it('folds more than three into one card naming the rest, so none is pushed off unseen', async () => {
    const w = world();
    await seasoned(w);
    for (let n = 1; n <= 6; n += 1) w.fire(notice(`n${String(n)}`, T0 + n * 1_000));
    const p = page(w);
    await connect(w, p);

    expect(p.shown).toHaveLength(3);
    expect(p.shown[0]).toEqual({
      title: 'Earlier notices',
      text: '4 earlier notices came while you were away: “Title n1”, “Title n2”, “Title n3” and “Title n4”.',
      sticky: true,
    });
    expect(p.shown.slice(1).map((toast) => toast.title)).toEqual(['Title n5', 'Title n6']);
  });

  it('says "or more" when a full page of history does not reach back to the last one seen', async () => {
    const w = world();
    await seasoned(w);
    for (let n = 1; n <= NOTICE_CATCH_UP_READ_LIMIT + 5; n += 1) w.fire(notice(`n${String(n)}`, T0 + n * 1_000));
    const p = page(w);
    await connect(w, p);
    expect(p.shown[0]?.text).toMatch(/^48 or more earlier notices came while you were away\. The latest: /);
  });

  it('catches up a notice dated a little before one already shown (an email-chat notice is dated when it fell due)', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('late', T0 + 600_000));
    const first = page(w);
    await connect(w, first);
    first.follower.dispose();
    // Written after `late` was shown, dated before it.
    w.fire(notice('backdated', T0 + 600_000 - 60_000));
    const second = page(w);
    await connect(w, second);
    expect(second.shown.map((toast) => toast.title)).toEqual(['Title backdated']);
    // Beyond the window, the time alone decides.
    expect(NOTICE_CATCH_UP_BACKDATE_MS).toBeGreaterThan(60_000);
  });
});

describe('a notice the owner saw live', () => {
  it('is not shown again, and the history moves past it', async () => {
    const w = world();
    await seasoned(w);
    const p = page(w);
    await connect(w, p);
    const row = notice('seen', T0 + 10_000);
    w.fire(row);
    p.live(row);
    await w.advance(NOTICE_CATCH_UP_AFTER_LIVE_MS + NOTICE_CATCH_UP_SETTLE_MS);
    expect(p.shown).toEqual([]);
    p.follower.dispose();

    // A reload later: still not shown.
    const again = page(w);
    await connect(w, again);
    expect(again.shown).toEqual([]);
  });

  it('is not shown again even when the page closes before the history is read', async () => {
    const w = world();
    await seasoned(w);
    const p = page(w);
    await connect(w, p);
    const row = notice('seen', T0 + 10_000);
    w.fire(row);
    p.live(row);
    p.follower.dispose();

    const reload = page(w);
    await connect(w, reload);
    expect(reload.shown).toEqual([]);
  });

  it('matches by what it says, so a second identical notice the owner did NOT see is still shown', async () => {
    const w = world();
    await seasoned(w);
    const p = page(w);
    await connect(w, p);
    const first = notice('t1', T0 + 10_000, { title: 'Today', text: 'Two things are due today.' });
    w.fire(first);
    p.live(first);
    p.hide();
    const second = notice('t2', T0 + 20_000, { title: 'Today', text: 'Two things are due today.' });
    w.fire(second);
    p.live(second);
    p.show();
    await w.advance(NOTICE_CATCH_UP_SETTLE_MS);
    expect(p.shown.map((toast) => toast.text)).toEqual(['Two things are due today. Sent at T+20s.']);
  });
});

describe('a notice that came while the tab was in the background', () => {
  it('is shown when the owner comes back to the tab', async () => {
    const w = world();
    await seasoned(w);
    const p = page(w);
    await connect(w, p);
    p.hide();
    const row = notice('bg', T0 + 30_000);
    w.fire(row);
    p.live(row);
    await w.advance(60_000);
    expect(p.shown).toEqual([]);

    p.show();
    await w.advance(NOTICE_CATCH_UP_SETTLE_MS);
    expect(p.shown.map((toast) => toast.title)).toEqual(['Title bg']);
  });

  it('does not read the history at all on coming back when nothing came', async () => {
    const w = world();
    await seasoned(w);
    const p = page(w);
    await connect(w, p);
    const before = w.reads;
    p.hide();
    p.show();
    await w.advance(NOTICE_CATCH_UP_SETTLE_MS);
    expect(w.reads).toBe(before);
  });

  it('waits for the owner when the app connects in the background', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('away', T0 + 1_000));
    const p = page(w, { visible: false });
    const before = w.reads;
    await connect(w, p);
    expect(w.reads).toBe(before);
    expect(p.shown).toEqual([]);

    p.show();
    await w.advance(NOTICE_CATCH_UP_SETTLE_MS);
    expect(p.shown.map((toast) => toast.title)).toEqual(['Title away']);
  });
});

describe('when something goes wrong', () => {
  it('loses nothing to a failed read: the notice still comes', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('dana', T0 + 1_000));
    const p = page(w);
    w.failNextRead();
    await connect(w, p);
    expect(p.shown).toEqual([]);
    expect(p.errors).toHaveLength(1);

    p.hide();
    p.show();
    await w.advance(NOTICE_CATCH_UP_SETTLE_MS);
    expect(p.shown.map((toast) => toast.title)).toEqual(['Title dana']);
  });

  it('asks again by itself when a busy server refuses the read, without waiting for the owner to leave and come back', async () => {
    const w = world();
    await seasoned(w);
    w.fire(notice('dana', T0 + 1_000));
    const p = page(w);
    const before = w.reads;
    // A page that loads busy is answered `rpc_overloaded` — found live.
    w.failNextRead(2, 'rpc_overloaded');
    p.follower.setConnected(true);
    await w.advance(0);
    // Not during the page's own startup burst.
    expect(w.reads - before).toBe(0);
    await w.advance(NOTICE_CATCH_UP_CONNECT_DELAY_MS);
    expect(w.reads - before).toBe(1);

    // Backed off: 1 s, then 2 s — and nothing in between.
    await w.advance(NOTICE_CATCH_UP_RETRY_INITIAL_MS - 1);
    expect(w.reads - before).toBe(1);
    await w.advance(1);
    expect(w.reads - before).toBe(2);
    await w.advance(2 * NOTICE_CATCH_UP_RETRY_INITIAL_MS - 1);
    expect(w.reads - before).toBe(2);
    expect(p.shown).toEqual([]);
    await w.advance(1 + NOTICE_CATCH_UP_SETTLE_MS);
    expect(w.reads - before).toBe(3);
    expect(p.shown.map((toast) => toast.title)).toEqual(['Title dana']);
  });

  it('does not keep asking a server that cannot answer at all', async () => {
    const w = world();
    await seasoned(w);
    const p = page(w);
    w.failNextRead(100, 'unknown_method');
    await connect(w, p);
    const after = w.reads;
    await w.advance(120_000);
    expect(w.reads).toBe(after);
  });

  it('does not show again what another tab of this profile already showed', async () => {
    const w = world();
    await seasoned(w);
    const tabA = page(w);
    const tabB = page(w, { visible: false });
    await connect(w, tabA);
    await connect(w, tabB);
    w.fire(notice('x', T0 + 50_000));
    tabA.hide();
    tabA.show();
    tabA.follower.setConnected(true);
    await w.advance(NOTICE_CATCH_UP_CONNECT_DELAY_MS + NOTICE_CATCH_UP_SETTLE_MS);
    expect(tabA.shown.map((toast) => toast.title)).toEqual(['Title x']);

    tabB.show();
    await w.advance(NOTICE_CATCH_UP_SETTLE_MS);
    expect(tabB.shown).toEqual([]);
  });

  it('still works for the life of the page when the browser keeps nothing', async () => {
    const w = world();
    const broken: NoticeCatchUpStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    const shown: NoticeCatchUpToast[] = [];
    const follower = followNoticeCatchUp({
      subscribe: (() => () => {}) as never,
      listRecent: w.listRecent,
      present: (toast) => { shown.push(toast); },
      storage: broken,
      isVisible: () => true,
      setTimer: w.setTimer,
      now: w.now,
      onError: () => {},
    });
    follower.setConnected(true);
    await w.advance(NOTICE_CATCH_UP_CONNECT_DELAY_MS + NOTICE_CATCH_UP_SETTLE_MS);
    w.fire(notice('later', T0 + 90_000));
    follower.setConnected(false);
    follower.setConnected(true);
    await w.advance(NOTICE_CATCH_UP_CONNECT_DELAY_MS + NOTICE_CATCH_UP_SETTLE_MS);
    expect(shown.map((toast) => toast.title)).toEqual(['Title later']);
  });
});
