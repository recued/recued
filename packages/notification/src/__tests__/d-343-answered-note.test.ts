/** D-343 (the owner's day audit, 2026-11-15) — an approval answered on Telegram lost its buttons and
 *  still ended "Approve?", so the message never said how it was answered; one replaced by a newer
 *  version already said so. Each channel's prompt is now closed with the answer beneath it. */
import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  type AskOption,
  type Channel,
  type NotificationSettings,
  type PendingAsk,
} from '../index.js';

const closed: Array<{ ask_id: string; note: string | undefined }> = [];
const telegram: Channel = {
  name: 'telegram', capability: 'inline', owns_llm_egress: false,
  async deliverNotify() {}, async deliverAsk() {},
  async closeAsk(ask_id, note) { closed.push({ ask_id, note }); },
} as Channel;

const ui: Channel = {
  name: 'ui', capability: 'inline', owns_llm_egress: true,
  async deliverNotify() {}, async deliverAsk() {}, async closeAsk() {},
} as Channel;

const answer = async (option: string, options: readonly AskOption[]): Promise<string | undefined> => {
  closed.length = 0;
  const settings = createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());
  await settings.setChannelMode('telegram', { notification: true, approval: true });
  const block = createNotificationBlock({ askStore: createAskStore(createInMemoryCollection<PendingAsk>()), channels: [ui, telegram],
    settingsStore: settings, now: () => 1000, mintAskId: () => 'ask-1' });
  block.registerAskHandler('gateway.preflight', () => {});
  await block.ask({ title: 'Approve: Change a task', text: 'The AI in your Telegram chat wants to change a task.' }, options,
    { kind: 'gateway.preflight', payload: {} });
  await block.submitAnswer({ ask_id: 'ask-1', option, via: 'telegram' });
  return closed.find((close) => close.ask_id === 'ask-1')?.note;
};

describe('D-343 — an answered prompt says how it was answered', () => {
  const asked: AskOption[] = [{ id: 'approve', label: 'Approve' }, { id: 'kind', label: 'Allow in this chat' }, { id: 'deny', label: 'Deny' }];
  it('says Approved, Denied, or the answer chosen', async () => {
    expect(await answer('approve', asked)).toBe('Approved.');
    expect(await answer('deny', asked)).toBe('Denied.');
    expect(await answer('kind', asked)).toBe('Allowed in this chat.');
    expect(await answer('later', [{ id: 'later', label: 'Remind me tomorrow' }])).toBe('Answered: Remind me tomorrow.');
  });
});
