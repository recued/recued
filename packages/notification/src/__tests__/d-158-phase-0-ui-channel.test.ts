import { describe, expect, it } from 'vitest';
import {
  createUiChannel,
  type AskOption,
  type NotificationMessage,
  type UiNotificationEvent,
} from '../index.js';

const message: NotificationMessage = {
  title: 'Decision ready',
  text: 'Choose how Recued should proceed.',
};

const options: readonly AskOption[] = [
  { id: 'continue', label: 'Continue' },
  { id: 'stop', label: 'Stop' },
];

describe('D-158 P0 / D-163 P0 ui channel event shapes', () => {
  it('declares capability inline (D-163 N.7)', () => {
    const channel = createUiChannel({ busSink: () => {} });
    expect(channel.name).toBe('ui');
    expect(channel.capability).toBe('inline');
  });

  it('deliverNotify emits notification.notify', async () => {
    const events: UiNotificationEvent[] = [];
    const channel = createUiChannel({
      busSink: (event) => events.push(event),
    });

    await channel.deliverNotify(message);

    expect(events).toEqual([{ kind: 'notification.notify', message }]);
  });

  it('deliverAsk emits notification.ask with ask_id, message, options', async () => {
    const events: UiNotificationEvent[] = [];
    const channel = createUiChannel({
      busSink: (event) => events.push(event),
    });

    await channel.deliverAsk('ask-ui', message, options);

    expect(events).toEqual([
      {
        kind: 'notification.ask',
        ask_id: 'ask-ui',
        message,
        options,
      },
    ]);
  });

  it('closeAsk emits notification.ask_closed', async () => {
    const events: UiNotificationEvent[] = [];
    const channel = createUiChannel({
      busSink: (event) => events.push(event),
    });

    await channel.closeAsk('ask-ui');

    expect(events).toEqual([
      { kind: 'notification.ask_closed', ask_id: 'ask-ui' },
    ]);
  });

  it('handles every ui event shape over a single channel instance', async () => {
    const events: UiNotificationEvent[] = [];
    const channel = createUiChannel({ busSink: (event) => events.push(event) });

    await channel.deliverNotify(message);
    await channel.deliverAsk('ask-life', message, options);
    await channel.closeAsk('ask-life');

    expect(events).toEqual([
      { kind: 'notification.notify', message },
      {
        kind: 'notification.ask',
        ask_id: 'ask-life',
        message,
        options,
      },
      { kind: 'notification.ask_closed', ask_id: 'ask-life' },
    ]);
  });
});
