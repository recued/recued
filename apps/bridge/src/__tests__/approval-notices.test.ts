/** A pending approval, as an OS notification on this Bridge (`approval-notices.ts`). */

import { describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_NOTICE_DEFAULT_TITLE,
  APPROVAL_NOTICE_MESSAGE,
  APPROVAL_NOTICES_SHOWN_CAP,
  approvalNoticeId,
  askIdOfApprovalNotice,
  createApprovalNotices,
} from '../notifications/approval-notices.js';
import { createChromeBridgeLocalStore } from '../storage/local-store.js';

const ASK = 'ask-6f1c2c1e-9a5b-4b8e-8f0e-1d2c3b4a5f60';
const OTHER = 'ask-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** `chrome.storage.local`, behind the Bridge's own store: what is kept must be on its closed list. */
const storage = () => {
  const data: Record<string, unknown> = {};
  const store = createChromeBridgeLocalStore({
    async get(keys) { return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])); },
    async set(items) { Object.assign(data, items); },
    async remove(keys) { for (const k of keys) delete data[k]; },
    async clear() { for (const k of Object.keys(data)) delete data[k]; },
  });
  return { store, data };
};

const world = (notify: boolean | (() => Promise<boolean>) = true, kept = storage()) => {
  const created: Array<{ id: string; title: string; message: string }> = [];
  const cleared: string[] = [];
  const readNotifySwitch = vi.fn(typeof notify === 'function' ? notify : async () => notify);
  const notices = createApprovalNotices({
    notifications: {
      async create(id, options) { created.push({ id, title: options.title, message: options.message }); return id; },
      async clear(id) { cleared.push(id); return true; },
    },
    storage: kept.store,
    readNotifySwitch,
    icon_url: 'icons/logo.svg',
  });
  return { notices, created, cleared, readNotifySwitch, kept };
};

describe('an approval as an OS notification on this Bridge', () => {
  it('is shown once, with its title and a fixed line, never its text, while Notify is on', async () => {
    const w = world();
    // The whole bus event, as the service worker passes it: its text names the event.
    const heard = { ask_id: ASK, title: 'Approve: Remove a calendar event — cannot be undone',
      text: '"Dentist" is waiting for your approval.' };
    await w.notices.asked(heard);
    expect(w.created).toEqual([{ id: approvalNoticeId(ASK),
      title: 'Approve: Remove a calendar event — cannot be undone', message: APPROVAL_NOTICE_MESSAGE }]);
    // The server sends it again (a restart's sweep, the vault's unlock, quiet hours' end).
    await w.notices.asked({ ask_id: ASK, title: 'Approve: Remove a calendar event — cannot be undone' });
    expect(w.created).toHaveLength(1);
    expect(w.readNotifySwitch).toHaveBeenCalledTimes(1);
  });

  it('is not shown again by a restarted service worker, which keeps what was shown', async () => {
    const first = world();
    await first.notices.asked({ ask_id: ASK });
    const restarted = world(true, first.kept);
    await restarted.notices.asked({ ask_id: ASK });
    expect(restarted.created).toEqual([]);
    await restarted.notices.asked({ ask_id: OTHER });
    expect(restarted.created.map((n) => n.id)).toEqual([approvalNoticeId(OTHER)]);
  });

  it('is not shown while Notify is off, and is once it is turned on', async () => {
    let on = false;
    const w = world(async () => on);
    await w.notices.asked({ ask_id: ASK });
    expect(w.created).toEqual([]);
    on = true;
    await w.notices.asked({ ask_id: OTHER });
    expect(w.created).toEqual([]);
    // The switch changed (`notification.bridge_mode_changed`, or a reconnect): it is read again.
    w.notices.forgetSwitch();
    await w.notices.asked({ ask_id: OTHER });
    expect(w.created.map((n) => n.id)).toEqual([approvalNoticeId(OTHER)]);
    expect(w.readNotifySwitch).toHaveBeenCalledTimes(2);
  });

  it('a switch that cannot be read shows nothing, and is read again at the next approval', async () => {
    let fails = true;
    const w = world(async () => { if (fails) throw new Error('rpc closed'); return true; });
    await expect(w.notices.asked({ ask_id: ASK })).resolves.toBeUndefined();
    expect(w.created).toEqual([]);
    fails = false;
    await w.notices.asked({ ask_id: ASK });
    expect(w.created.map((n) => n.id)).toEqual([approvalNoticeId(ASK)]);
  });

  it('a reminder is no approval here, and an approval with no title gets a plain one', async () => {
    const w = world();
    await w.notices.asked({ ask_id: ASK, title: 'Water the plants', reminder: true });
    expect(w.created).toEqual([]);
    await w.notices.asked({ ask_id: OTHER, title: '  ' });
    expect(w.created).toEqual([{ id: approvalNoticeId(OTHER), title: APPROVAL_NOTICE_DEFAULT_TITLE, message: APPROVAL_NOTICE_MESSAGE }]);
  });

  it('closed, its notification goes, and its mark with it', async () => {
    const w = world();
    await w.notices.asked({ ask_id: ASK });
    await w.notices.closed(ASK);
    expect(w.cleared).toEqual([approvalNoticeId(ASK)]);
    // Its mark went: had the server sent it again, it would show, as a new one.
    await w.notices.asked({ ask_id: ASK });
    expect(w.created).toHaveLength(2);
  });

  it('remembers at most the latest approvals shown', async () => {
    const w = world();
    const ids = Array.from({ length: APPROVAL_NOTICES_SHOWN_CAP + 1 }, (_, i) => `ask-${String(i).padStart(4, '0')}`);
    for (const id of ids) await w.notices.asked({ ask_id: id });
    const kept = w.kept.data.approval_notices_shown as string[];
    expect(kept).toHaveLength(APPROVAL_NOTICES_SHOWN_CAP);
    expect(kept[0]).toBe(ids[1]);
  });

  it('what was shown is a field the Bridge declares, which its inspection includes and its clear drops', async () => {
    const w = world();
    await w.notices.asked({ ask_id: ASK });
    expect(w.kept.data).toEqual({ approval_notices_shown: [ASK] });
    expect((await w.kept.store.inspect()).approval_notices_shown).toEqual([ASK]);
    await w.kept.store.clear();
    expect(w.kept.data).toEqual({});
    // Cleared, an approval still waiting shows again.
    await world(true, w.kept).notices.asked({ ask_id: ASK });
    expect(w.kept.data).toEqual({ approval_notices_shown: [ASK] });
  });

  it('an id the server would not mint is neither shown nor routed', async () => {
    const w = world();
    await w.notices.asked({ ask_id: 'ask-<script>' });
    expect(w.created).toEqual([]);
    expect(askIdOfApprovalNotice(approvalNoticeId(ASK))).toBe(ASK);
    expect(askIdOfApprovalNotice('recued-approval-x')).toBeUndefined();
    expect(askIdOfApprovalNotice('recued-reminder-ab')).toBeUndefined();
  });
});
