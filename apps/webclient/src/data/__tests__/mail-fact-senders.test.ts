/** D-315 §6.5 — Senders without a template, as the tab shows them. */

import { describe, expect, it, vi } from 'vitest';

import type { MailFactSendersResult } from '@recued/contracts';

import { createMailFactSenders, type MailFactSenderCallers } from '../mail-fact-senders.js';

const ACTION = 'data-recued-data-action';

const result = (over: Partial<MailFactSendersResult> = {}): MailFactSendersResult => ({
  senders: [{
    address: 'news@club.example',
    count: 3,
    subjects: [{ subject: 'Club news #12', count: 2 }, { subject: 'Your membership renews', count: 1 }],
    newest: { slug: 'work', record_id: 'mail:9', from: 'news@club.example', subject: 'Club news #12', at: 1 },
  }],
  dismissed: [],
  days: 30,
  scanned: 40,
  ...over,
});

const el = (attrs: Record<string, string>) => ({ getAttribute: (name: string) => attrs[name] ?? null }) as unknown as HTMLElement;

const harness = (callers: MailFactSenderCallers, canMakeTemplate = true) => {
  const makeTemplate = vi.fn();
  const render = vi.fn();
  const focus = vi.fn();
  const view = createMailFactSenders({
    callers, actionAttr: ACTION, render, focus, makeTemplate, canMakeTemplate,
  });
  return { view, makeTemplate, render, focus };
};

const FOCUS = 'data-recued-mail-facts-focus';

const sender = (address: string, record_id: string): MailFactSendersResult['senders'][number] => ({
  address,
  count: 2,
  subjects: [{ subject: `From ${address}`, count: 2 }],
  newest: { slug: 'work', record_id, from: address, subject: `From ${address}`, at: 1 },
});

describe('Senders without a template', () => {
  it('shows each sender, how much mail, and its common subjects', async () => {
    const { view } = harness({ listSenders: async () => result() });
    await view.refresh();
    const html = view.render();
    expect(html).toContain('news@club.example');
    expect(html).toContain('3 emails');
    expect(html).toContain('Club news #12 <span class="mail-facts-subtle">× 2</span>');
    expect(html).toContain('Your membership renews');
  });

  it('opens the editor on the sender’s newest email', async () => {
    const { view, makeTemplate } = harness({ listSenders: async () => result() });
    await view.refresh();
    view.handleAction('mail-facts-snd-make', el({ 'data-slug': 'work', 'data-record-id': 'mail:9' }));
    expect(makeTemplate).toHaveBeenCalledWith({ slug: 'work', record_id: 'mail:9' });
  });

  it('offers no template button when the editor cannot open an email', async () => {
    const { view } = harness({ listSenders: async () => result() }, false);
    await view.refresh();
    expect(view.render()).not.toContain('Make a template');
  });

  it('dismisses a sender, and shows it again', async () => {
    let dismissed: string[] = [];
    const dismissSender = vi.fn(async (args: { address: string; dismissed: boolean }) => {
      dismissed = args.dismissed ? [args.address] : [];
      return args;
    });
    const { view } = harness({
      listSenders: async () => result(dismissed.length > 0 ? { senders: [], dismissed } : {}),
      dismissSender,
    });
    await view.refresh();
    view.handleAction('mail-facts-snd-dismiss', el({ 'data-address': 'news@club.example' }));
    await vi.waitFor(() => expect(view.render()).toContain('Dismissed (1)'));
    expect(view.render()).toContain('No sender without a template in the last 30 days (40 emails counted).');
    view.handleAction('mail-facts-snd-restore', el({ 'data-address': 'news@club.example' }));
    await vi.waitFor(() => expect(dismissSender).toHaveBeenLastCalledWith({ address: 'news@club.example', dismissed: false }));
    await vi.waitFor(() => expect(view.render()).toContain('3 emails'));
  });

  // Focus goes where the owner can go on from, and that place must exist once
  // the list is drawn again: a key naming nothing leaves focus on the body.
  it('puts focus, after a dismissal or a sender shown again, on something the list still has', async () => {
    let senders = [sender('a@shop.example', 'mail:1'), sender('b@shop.example', 'mail:2')];
    let dismissed: string[] = [];
    const dismissSender = vi.fn(async (args: { address: string; dismissed: boolean }) => {
      const moved = [...senders, ...dismissed.map((address) => sender(address, 'mail:9'))].find((s) => s.address === args.address)!;
      senders = args.dismissed ? senders.filter((s) => s.address !== args.address) : [...senders, moved];
      dismissed = args.dismissed ? [...dismissed, args.address] : dismissed.filter((address) => address !== args.address);
      return args;
    });
    const h = harness({ listSenders: async () => result({ senders, dismissed }), dismissSender });
    const focusedExists = () => {
      const key = h.focus.mock.calls.at(-1)?.[0] as string;
      expect(h.view.render()).toContain(`${FOCUS}="${key}"`);
      return key;
    };
    await h.view.refresh();

    // The first dismissed: the sender that takes its place.
    h.view.handleAction('mail-facts-snd-dismiss', el({ 'data-address': 'a@shop.example' }));
    await vi.waitFor(() => expect(h.view.render()).toContain('Dismissed (1)'));
    expect(focusedExists()).toBe('snd:make:b@shop.example');
    // The last dismissed: the list of those dismissed.
    h.view.handleAction('mail-facts-snd-dismiss', el({ 'data-address': 'b@shop.example' }));
    await vi.waitFor(() => expect(h.view.render()).toContain('Dismissed (2)'));
    expect(focusedExists()).toBe('snd:dismissed');
    // Shown again: its own row.
    h.view.handleAction('mail-facts-snd-restore', el({ 'data-address': 'a@shop.example' }));
    await vi.waitFor(() => expect(h.view.render()).toContain('Dismissed (1)'));
    expect(focusedExists()).toBe('snd:make:a@shop.example');
  });

  it('puts focus on Dismiss when no template can be made, and on the tab when nothing is left', async () => {
    let senders = [sender('a@shop.example', 'mail:1')];
    let dismissed: string[] = [];
    const dismissSender = vi.fn(async (args: { address: string; dismissed: boolean }) => {
      senders = args.dismissed ? [] : [sender(args.address, 'mail:1')];
      dismissed = args.dismissed ? [args.address] : [];
      return args;
    });
    const h = harness({ listSenders: async () => result({ senders, dismissed }), dismissSender }, false);
    await h.view.refresh();
    h.view.handleAction('mail-facts-snd-dismiss', el({ 'data-address': 'a@shop.example' }));
    await vi.waitFor(() => expect(h.view.render()).toContain('Dismissed (1)'));
    h.view.handleAction('mail-facts-snd-restore', el({ 'data-address': 'a@shop.example' }));
    await vi.waitFor(() => expect(h.view.render()).not.toContain('Dismissed ('));
    const key = h.focus.mock.calls.at(-1)?.[0] as string;
    expect(key).toBe('snd:dismiss:a@shop.example');
    expect(h.view.render()).toContain(`${FOCUS}="${key}"`);

    // Dismissed, and the server lists none dismissed after all: the tab.
    const gone = harness({
      listSenders: vi.fn()
        .mockResolvedValueOnce(result({ senders: [sender('a@shop.example', 'mail:1')] }))
        .mockResolvedValue(result({ senders: [], dismissed: [] })),
      dismissSender: async (args) => args,
    });
    await gone.view.refresh();
    gone.view.handleAction('mail-facts-snd-dismiss', el({ 'data-address': 'a@shop.example' }));
    await vi.waitFor(() => expect(gone.focus).toHaveBeenCalled());
    expect(gone.focus).toHaveBeenLastCalledWith('view:senders');
  });

  it('keeps “Dismissed” open or shut across repaints, and opening it repaints nothing', async () => {
    const h = harness({ listSenders: async () => result({ dismissed: ['old@shop.example'] }), dismissSender: async (args) => args });
    await h.view.refresh();
    expect(h.view.render()).toContain('<details class="mail-facts-advanced">');
    h.render.mockClear();
    h.view.handleAction('mail-facts-snd-dismissed-toggle', el({}));
    expect(h.render).not.toHaveBeenCalled();
    await h.view.refresh(true);
    expect(h.view.render()).toContain('<details class="mail-facts-advanced" open>');
    expect(h.view.hasInFlightWork()).toBe(false);
  });

  it('says what went wrong', async () => {
    const { view } = harness({ listSenders: async () => { throw new Error('boom'); } });
    await view.refresh();
    expect(view.render()).toContain('role="alert"');
  });
});
