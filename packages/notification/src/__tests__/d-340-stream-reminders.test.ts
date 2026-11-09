/** D-340 slice 3 — the owner's reminders inside the daily stream: one ask delivery whose messenger and
 *  email copies are the stream's message (`lead`), which lists the reminders by number, with each
 *  reminder's buttons or answers as before. In a messenger the owner chats with Recued on it is a
 *  notice, as the stream is; the text the owner saw stays when an answered item's buttons go. */
import { createInMemoryCollection } from '@recued/storage';
import type { InteractiveTransport, OutboundMessage, OutboundPrompt, TransportSendResult } from '@recued/transport';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskDeliveryStore, createAskStore, createEmailChannel, createNotificationBlock, createNotificationSettingsStore,
  createRemoteChannel, createUiChannel,
  type AskDeliveryDestination, type AskDeliveryInput, type AskDeliveryRecord, type Channel, type NotificationSettings,
  type OutboundEmail, type PendingAsk, type RemoteNoticeHook,
} from '../index.js';

const telegram: AskDeliveryDestination = { id: 'owner-telegram', channel: 'telegram', connection_name: 'private',
  connection_enrolled_at: 100, recipient: 'private-chat', expected_sender: 'owner' };
const email: AskDeliveryDestination = { id: 'owner-email', channel: 'email', connection_name: 'personal-email',
  connection_enrolled_at: 200, recipient: 'owner@example.com', expected_sender: 'owner@example.com', sender_source: 'alerts' };
const options = [{ id: 'later', label: 'Later' }, { id: 'not_needed', label: 'Not needed' }];
const LEAD = { title: 'Your day · Sat 7 Nov', text: 'Agenda\n07:00 Run 5 km\n\nReminders\n1. Passport\nRenew it by 20 Nov.\n2. Car\nService it.' };
const input = (destinations: AskDeliveryDestination[], lead: AskDeliveryInput['lead'] | null = LEAD): AskDeliveryInput => ({
  group_id: 'stream-1', destinations, ...(lead ? { lead } : {}),
  asks: ['Passport', 'Car'].map((title, index) => ({ ask_id: `ask-stream-${index + 1}`, message: { title, text: `${title} needs attention.` },
    options, handler: { kind: 'reminder.occurrence', payload: { occurrence: `o-${index + 1}` } } })),
});

const fixture = (channel: Channel) => {
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const deliveryStore = createAskDeliveryStore(createInMemoryCollection<AskDeliveryRecord>());
  let sequence = 0;
  const block = createNotificationBlock({ askStore, deliveryStore,
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
    channels: [createUiChannel({ busSink: () => {} }), channel], now: () => 1_000_000,
    mintAskId: () => `ask-attempt-${++sequence}`, isVaultUnlocked: () => true });
  block.registerAskHandler('reminder.occurrence', vi.fn());
  return { block, deliveryStore };
};

const messenger = (notices?: RemoteNoticeHook, interactive = true) => {
  const prompts: OutboundPrompt[] = []; const messages: OutboundMessage[] = [];
  const edits: Array<OutboundPrompt & { vendor_message_id: string }> = []; const closes: Array<{ text: string; vendor_message_id: string }> = [];
  const transport = {
    vendor: 'telegram', parseInbound: () => null, parseConversationId: () => null,
    send: vi.fn(async (message: OutboundMessage): Promise<TransportSendResult> => { messages.push(structuredClone(message)); return { ok: true, vendor_message_id: 'text-1' }; }),
    ...(interactive ? {
      async sendPrompt(prompt: OutboundPrompt) { prompts.push(structuredClone(prompt)); return { ok: true, vendor_message_id: `message-${prompts.length}` }; },
      async updatePrompt(prompt: OutboundPrompt & { vendor_message_id: string }) { edits.push(structuredClone(prompt)); return { ok: true }; },
      async closePrompt(prompt: { text: string; vendor_message_id: string }) { closes.push({ text: prompt.text, vendor_message_id: prompt.vendor_message_id }); return { ok: true }; },
      parseInboundChoice: () => null, parseCallbackConversationId: () => null,
    } : {}),
  } as unknown as InteractiveTransport;
  const channel = createRemoteChannel({ transport, ...(notices ? { notices } : {}), ...(interactive ? {} : { capability: 'landing-page' as const }),
    resolveCredential: async destination => ({
    token: 'bot-token', recipient: 'private-chat', expected_sender: 'owner',
    connection_name: destination?.connection_name ?? 'private', connection_enrolled_at: 100 }) });
  return { channel, prompts, messages, edits, closes };
};

describe('D-340 slice 3 — reminders inside the stream, in a messenger', () => {
  it('sends the stream\'s message as the notice the owner\'s chat makes of it, each reminder\'s buttons by its number', async () => {
    const sent = vi.fn(async () => {});
    const prepare = vi.fn<RemoteNoticeHook['prepare']>(async ({ message }) => ({
      title: `Notice · ${message.title!}`, text: `${message.text}\n\nRule line.`, sent }));
    const r = messenger({ prepare });
    const f = fixture(r.channel);
    await f.block.askBundle(input([telegram, { id: 'ui', channel: 'ui' }]));
    expect(prepare).toHaveBeenCalledWith({ vendor: 'telegram', recipient: 'private-chat', token: 'bot-token', message: LEAD });
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toMatchObject({ title: 'Notice · Your day · Sat 7 Nov', text: `${LEAD.text}\n\nRule line.` });
    expect(r.prompts[0]!.options.map(option => option.label)).toEqual(['1 Later', '1 Not needed', '2 Later', '2 Not needed']);
    // Recorded once the messenger took it, so a reply quoting it reaches the conversation.
    expect(sent).toHaveBeenCalledWith('message-1');
    const attempt = (await f.deliveryStore.get('stream-1'))!.attempts.find(row => row.destination_id === 'owner-telegram')!;
    expect(attempt.result).toMatchObject({ outcome: 'delivered', presentation: 'buttons',
      sent: { title: 'Notice · Your day · Sat 7 Nov', text: `${LEAD.text}\n\nRule line.` } });
  });

  it('keeps the text the owner saw when an answered reminder\'s buttons go, and its heading once the last go', async () => {
    const r = messenger({ prepare: async ({ message }) => ({ title: `Notice · ${message.title!}`, text: `${message.text}\n\nRule line.`, sent: async () => {} }) });
    const f = fixture(r.channel);
    await f.block.askBundle(input([telegram]));
    await f.block.cancelAsk('ask-stream-1');
    expect(r.edits.at(-1)).toMatchObject({ vendor_message_id: 'message-1', title: 'Notice · Your day · Sat 7 Nov', text: `${LEAD.text}\n\nRule line.` });
    expect(r.edits.at(-1)!.options.map(option => option.label)).toEqual(['2 Later', '2 Not needed']);
    await f.block.cancelAsk('ask-stream-2');
    expect(r.closes.at(-1)).toEqual({ vendor_message_id: 'message-1', text: `Notice · Your day · Sat 7 Nov\n\n${LEAD.text}\n\nRule line.` });
  });

  it('goes as the stream\'s own message when the owner\'s chat makes no notice of it, or the hook fails', async () => {
    for (const notices of [undefined, { prepare: async () => undefined }, { prepare: async () => { throw new Error('vault sealed'); } }] as Array<RemoteNoticeHook | undefined>) {
      const r = messenger(notices);
      await fixture(r.channel).block.askBundle(input([telegram]));
      expect(r.prompts[0]).toMatchObject({ title: LEAD.title, text: LEAD.text });
    }
  });

  it('on a messenger with no buttons, says how to answer above the stream\'s message', async () => {
    const r = messenger(undefined, false);
    await fixture(r.channel).block.askBundle(input([telegram]));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ title: LEAD.title,
      text: `Reply with the item number and answer, for example: 2 later.\n1: Later, Not needed\n2: Later, Not needed\n\n${LEAD.text}` });
  });

  it('leaves a reminder bundle with no stream as it was: each item\'s title and text', async () => {
    const r = messenger();
    await fixture(r.channel).block.askBundle(input([telegram], null));
    expect(r.prompts[0]!.title).toBeUndefined();
    expect(r.prompts[0]!.text).toBe('1. Passport\nPassport needs attention.\n\n2. Car\nCar needs attention.');
  });

  it('refuses a lead with no title or no text', async () => {
    const r = messenger();
    for (const lead of [{ title: ' ', text: 'x' }, { title: 'Your day · Sat 7 Nov', text: '' }]) {
      await expect(fixture(r.channel).block.askBundle(input([telegram], lead))).rejects.toThrow('Invalid reminder delivery envelope');
    }
  });
});

describe('D-340 slice 3 — reminders inside the stream, by email', () => {
  it('sends the stream\'s message, its subject the stream\'s title with the tag a reply is matched by, then each reminder\'s answers', async () => {
    const emails: OutboundEmail[] = [];
    const channel = createEmailChannel({ sendEmail: async () => {}, sendEmailDelivery: async message => { emails.push(message); return { outcome: 'delivered' }; } });
    await fixture(channel).block.askBundle(input([email]));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe('Your day · Sat 7 Nov [#ask-stream-1]');
    expect(emails[0]!.body_text).toBe(`${LEAD.text}\n\n1: Later, Not needed\n2: Later, Not needed\n\n`
      + 'Reply with the item number and answer, for example: 2 later. A reply without an item changes nothing.');
  });
});
