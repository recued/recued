/** D-343 slice 4 (ruling 19) with D-340 slice 2 — where Close the day lives: in Today's "Daily
 *  stream", under its tabs, once the server's streams took over the Agenda; and no longer in
 *  Settings, which keeps its card only on a server from before them.
 *
 *  ⛔ WHY THIS FILE. The card moved from Settings to Today on 2026-11-07, and nothing the sweep runs
 *  checked where it is: the Playwright specs mount it alone (`close-day.spec.ts`) or in the dialog
 *  through a harness (`stream.spec.ts`), and the sweep runs no Playwright. The live drive still
 *  looked in Settings and failed there for two days. So the real route opens the real dialog
 *  here, on a small fake document, and the real card decides whether it shows. */
import type {
  ProactiveToday,
  SituationAgendaStatus,
  SituationStreamPreview,
  SituationStreamSettings,
  SituationStreamStatus,
} from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { CLOSE_DAY_PANEL_ATTR, mountCloseDayPanel } from '../../settings/close-day-panel.js';
import { bootstrapTodayRoute } from '../bootstrap-today-route.js';
import { STREAM_DIALOG_ATTR } from '../stream-panel.js';
import type { TodayCallers } from '../today-controller.js';

/** What the route, the stream's dialog and the card use of a document, and nothing else. */
class FakeEl {
  hidden = false; disabled = false; checked = false; required = false; open = false;
  value = ''; type = ''; name = ''; id = ''; className = ''; tabIndex = 0;
  readonly validity = { badInput: false };
  readonly attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private text = '';
  private html = '';
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly tagName: string, readonly ownerDocument: FakeDoc) {}
  get parentElement(): FakeEl | null { return this.parent; }
  get nextElementSibling(): FakeEl | null {
    const siblings = this.parent?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get options(): FakeEl[] { return this.children.filter((child) => child.tagName === 'OPTION'); }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.html = ''; this.children = []; }
  get innerHTML(): string { return this.html; }
  set innerHTML(value: string) { this.html = value; this.text = ''; this.children = []; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, String(value)); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  hasAttribute(key: string): boolean { return this.attrs.has(key); }
  removeAttribute(key: string): void { this.attrs.delete(key); }
  toggleAttribute(key: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(key);
    if (on) this.attrs.set(key, ''); else this.attrs.delete(key);
    return on;
  }
  appendChild(child: FakeEl): FakeEl { child.remove(); child.parent = this; this.children.push(child); return child; }
  append(...children: Array<FakeEl | string>): void {
    for (const child of children) if (typeof child === 'string') this.text += child; else this.appendChild(child);
  }
  insertBefore(child: FakeEl, before: FakeEl | null): FakeEl {
    child.remove(); child.parent = this;
    const at = before === null ? -1 : this.children.indexOf(before);
    if (at === -1) this.children.push(child); else this.children.splice(at, 0, child);
    return child;
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((one) => one !== listener));
  }
  focus(): void { this.ownerDocument.activeElement = this; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  closest(): null { return null; }
  /** Every element under this one, in document order. */
  all(): FakeEl[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  /** `[attr]` and `tag[attr]`: all the route's own lookups and these tests ask for. */
  querySelector(selector: string): FakeEl | null {
    const match = /^([a-z]*)\[([^\]=]+)\]$/u.exec(selector);
    if (match === null) return null;
    return this.all().find((el) => (match[1] === '' || el.tagName === match[1]!.toUpperCase()) && el.attrs.has(match[2]!)) ?? null;
  }
}

interface FakeDoc {
  activeElement: FakeEl | null;
  body: FakeEl;
  head: FakeEl;
  visibilityState: string;
  createElement: (tag: string) => FakeEl;
  defaultView: { setInterval: () => number; clearInterval: () => void };
  addEventListener: () => void;
  removeEventListener: () => void;
}

const fakeDocument = (): FakeDoc => {
  const doc = {
    activeElement: null, visibilityState: 'visible',
    defaultView: { setInterval: () => 1, clearInterval: () => undefined },
    addEventListener: () => undefined, removeEventListener: () => undefined,
  } as unknown as FakeDoc;
  doc.createElement = (tag: string) => new FakeEl(tag.toUpperCase(), doc);
  doc.body = doc.createElement('body');
  doc.head = doc.createElement('head');
  return doc;
};

const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

const streamStatus = (settings: Partial<SituationStreamSettings>): SituationStreamStatus => ({
  settings: { enabled: false, time: '07:30', day: 'today', weekday: 1, agenda: true, coming_up: true, look_ahead_days: 7,
    suggestions: false, due_today: false, include_private: false, reminders: false, channels: null, ...settings },
  last_run: null, last_sent: null, pending: 0, uncertain: 0,
});
/** The Agenda's status, as `yours.agenda` reads it: with the streams that took over, Close the day, both or neither. */
const agendaStatus = (has: { streams: boolean; closeDay: boolean }): SituationAgendaStatus => ({
  settings: { enabled: true, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 },
  last_run: null, last_sent: null, pending: 0, uncertain: 0,
  ...(has.closeDay ? { close_day: { settings: { enabled: false, time: '21:00' }, last_run: null, last_sent: null, pending: 0, uncertain: 0 } } : {}),
  ...(has.streams ? { streams: {
    daily: { ...streamStatus({ enabled: true, time: '07:00', coming_up: false }), next_at: Date.parse('2026-11-09T07:00:00Z'), time_zone: 'UTC' },
    weekly: streamStatus({ enabled: true, time: '08:00', agenda: false }),
  } } : {}),
});
const preview: SituationStreamPreview = { title: 'Your day · Mon 9 Nov', counts: { states: 0, agenda: 1, due_today: 0, coming_up: 0 },
  text: 'Agenda\n07:00 Run 5 km' };
const proactive: ProactiveToday = { situations: { clusters: [], omitted: 0, ambiguous: [] }, occurrences: [], proposal_count: 0,
  newest_proposal: null, unmatched_replies: [], phone_ready: true, stream: true, close_day: true };

/** Today, mounted as the shell mounts it, with its "Daily stream" opened as its button opens it. */
const openDailyStream = async (status: SituationAgendaStatus, wired: { closeDay: boolean } = { closeDay: true }) => {
  const doc = fakeDocument();
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const route = bootstrapTodayRoute({
    container: container as never,
    now: () => Date.parse('2026-11-09T20:00:00Z'),
    callers: {
      collectionListInstancesCaller: async () => ({ instances: [] }),
      workEntitySourceListCaller: async () => ({ sources: [{ id: 'recued.task', top_tier_kind: 'task', label: 'Tasks' }] }),
      workEntityListCaller: async () => ({ entities: [], total: 0 }),
      proactiveTodayCaller: async () => proactive,
      stream: {
        read: async () => status,
        save: async () => ({}),
        sendNow: async () => ({}),
        preview: async () => preview,
        channels: async () => [{ channel: 'in_app', label: 'The app' }],
        ...(wired.closeDay ? { closeDay: { save: async () => ({}), sendNow: async () => ({}) } } : {}),
      },
    } as unknown as TodayCallers,
  });
  await route.whenLoaded();
  route.openStream();
  await settle();
  const dialog = doc.body.querySelector(`dialog[${STREAM_DIALOG_ATTR}]`);
  return { doc, route, dialog, card: dialog?.querySelector(`[${CLOSE_DAY_PANEL_ATTR}]`) ?? null };
};

const checkbox = (card: FakeEl): FakeEl | undefined =>
  card.all().find((el) => el.tagName === 'INPUT' && el.attrs.get('aria-label') === 'Ask me each evening what I did');

describe('Close the day lives in Today\'s "Daily stream" once the streams took over (D-340 slice 2)', () => {
  it('shows its card in the dialog, under the tabs, with its switch, going where the daily stream goes', async () => {
    const { route, dialog, card } = await openDailyStream(agendaStatus({ streams: true, closeDay: true }));
    expect(dialog?.open).toBe(true);
    expect(card).not.toBeNull();
    expect(card!.hidden).toBe(false);
    expect(checkbox(card!)).toBeDefined();
    expect(card!.textContent).toContain('sent where your daily stream goes');
    route.dispose();
  });

  it('is gone from Settings on that server, and stays there on one from before the streams', async () => {
    const inSettings = async (status: SituationAgendaStatus) => {
      const doc = fakeDocument();
      const host = doc.createElement('section');
      mountCloseDayPanel({ host: host as never, document: doc as never, read: async () => status, save: async () => ({}), sendNow: async () => ({}) });
      await settle();
      return host.querySelector(`[${CLOSE_DAY_PANEL_ATTR}]`);
    };
    // The streams took over: Today holds it, and Settings' card leaves.
    expect(await inSettings(agendaStatus({ streams: true, closeDay: true }))).toBeNull();
    // A server from before them: Settings keeps it, beside the Agenda.
    const kept = await inSettings(agendaStatus({ streams: false, closeDay: true }));
    expect(kept?.hidden).toBe(false);
    expect(checkbox(kept!)).toBeDefined();
    expect(kept!.textContent).toContain('sent where your Agenda goes');
  });

  it('is in neither place on a server that names no Close the day, and the dialog holds none a shell did not wire', async () => {
    const unnamed = await openDailyStream(agendaStatus({ streams: true, closeDay: false }));
    expect(unnamed.dialog?.open).toBe(true);
    expect(unnamed.card).toBeNull();
    unnamed.route.dispose();
    const unwired = await openDailyStream(agendaStatus({ streams: true, closeDay: true }), { closeDay: false });
    expect(unwired.dialog?.open).toBe(true);
    expect(unwired.card).toBeNull();
    unwired.route.dispose();
  });
});
