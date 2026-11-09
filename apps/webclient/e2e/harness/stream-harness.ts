/** Production streams' settings (D-340 slice 2) in their dialog over Today, with a server kept in
 *  memory: the Daily and Weekly tabs, Close the day under them, the preview and Send to. */
import type { SituationAgendaStatus, SituationStreamKind, SituationStreamPreview, SituationStreamSettings, SituationStreamStatus } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { openStreamDialog, STREAM_PANEL_STYLES } from '../../src/today/stream-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${STREAM_PANEL_STYLES}`;
document.head.appendChild(style);
// `?older=1`: a server from before Reminders (D-340 slice 3) and private items (slice 5), which names neither.
const older = new URLSearchParams(location.search).has('older');
const stream = (settings: Partial<SituationStreamSettings>): SituationStreamStatus => {
  const all: SituationStreamSettings = { enabled: false, time: '07:30', day: 'today', weekday: 1, agenda: true, coming_up: true, look_ahead_days: 7,
    suggestions: false, due_today: false, include_private: false, reminders: false, channels: null, ...settings };
  if (older) { const { reminders: _reminders, include_private: _private, ...before } = all; return { settings: before as SituationStreamSettings,
    last_run: null, last_sent: null, pending: 0, uncertain: 0 }; }
  return { settings: all, last_run: null, last_sent: null, pending: 0, uncertain: 0 };
};
// A server whose streams took over: a daily Agenda at 07:00, and Coming up each Monday.
let current: SituationAgendaStatus = { settings: { enabled: true, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 },
  last_run: null, last_sent: null, pending: 0, uncertain: 0,
  close_day: { settings: { enabled: false, time: '21:00' }, last_run: null, last_sent: null, pending: 0, uncertain: 0 },
  streams: { daily: { ...stream({ enabled: true, time: '07:00', coming_up: false }), next_at: Date.parse('2026-11-09T07:00:00Z'), time_zone: 'UTC' },
    weekly: stream({ enabled: true, time: '08:00', agenda: false }) } };
const saves: Array<{ stream: SituationStreamKind; settings: Partial<SituationStreamSettings> }> = [];
const sends: SituationStreamKind[] = [];
const fail = { save: '' };
const controls = {
  saves, sends, fail,
  closed: 0,
  open() {
    return openStreamDialog(document, {
      read: async () => structuredClone(current),
      save: async (kind, settings) => {
        if (fail.save) { const message = fail.save; fail.save = ''; throw new Error(message); }
        saves.push({ stream: kind, settings: structuredClone(settings) });
        current = { ...current, streams: { ...current.streams!, [kind]: { ...current.streams![kind], settings: { ...current.streams![kind].settings, ...settings } } } };
        return { message: 'saved' };
      },
      sendNow: async kind => { sends.push(kind); return { message: 'checked' }; },
      preview: async (kind): Promise<SituationStreamPreview> => kind === 'daily'
        ? { title: 'Your day · Mon 9 Nov', counts: { states: 1, agenda: 2, due_today: 0, coming_up: 1 }, next_at: Date.parse('2026-11-09T07:00:00Z'), time_zone: 'UTC',
          text: 'Short night · Oura ring\n\nAgenda\n07:00 Run 5 km\n13:00 Lunch with Sam\n\nComing up\nDentist · 2026-11-10' }
        : { title: 'Your week · Mon 9 Nov to Sun 15 Nov', counts: { states: 0, agenda: 0, due_today: 0, coming_up: 0 }, text: '' },
      channels: async () => [{ channel: 'in_app', label: 'The app' }, { channel: 'telegram', label: 'Telegram' }],
      closeDay: { save: async () => ({}), sendNow: async () => ({}) },
    }, () => { controls.closed += 1; });
  },
};
document.querySelector('#open')!.addEventListener('click', () => { controls.open(); });
declare global { interface Window { __stream: typeof controls } }
window.__stream = controls;
