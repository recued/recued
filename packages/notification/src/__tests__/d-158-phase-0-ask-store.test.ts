import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  createAskStore,
  type NewPendingAsk,
  type PendingAsk,
} from '../index.js';

const makeAsk = (
  ask_id: string,
  created_at = 1000,
): NewPendingAsk => ({
  ask_id,
  message: { text: `Question ${ask_id}` },
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: ask_id },
  fanout_channels: ['ui'],
  created_at,
});

describe('D-158 P0 AskStore', () => {
  it('create stores a new ask as open and rejects a duplicate ask_id', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const ask = makeAsk('ask-duplicate');

    await store.create(ask);

    expect(await store.get('ask-duplicate')).toEqual({
      ...ask,
      status: 'open',
    });
    await expect(store.create(ask)).rejects.toThrow(/already stored/);
  });

  it('recordAnswer transitions open to answered with answer and answered_via', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-record'));

    await store.recordAnswer(
      'ask-record',
      { option: 'yes', answered_at: 2000 },
      'ui',
    );

    expect(await store.get('ask-record')).toMatchObject({
      ask_id: 'ask-record',
      status: 'answered',
      answer: { option: 'yes', answered_at: 2000 },
      answered_via: 'ui',
    });
  });

  it('recordAnswer throws when the ask is not open', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-not-open'));
    await store.recordAnswer(
      'ask-not-open',
      { option: 'yes', answered_at: 2000 },
      'ui',
    );

    await expect(
      store.recordAnswer(
        'ask-not-open',
        { option: 'no', answered_at: 3000 },
        'ui',
      ),
    ).rejects.toThrow(/not "open"/);
  });

  it('markHandled transitions answered to handled', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-handled'));
    await store.recordAnswer(
      'ask-handled',
      { option: 'yes', answered_at: 2000 },
      'ui',
    );

    await store.markHandled('ask-handled');

    expect(await store.get('ask-handled')).toMatchObject({
      status: 'handled',
      answer: { option: 'yes', answered_at: 2000 },
    });
  });

  it('markHandled throws when the ask is not answered', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-open'));

    await expect(store.markHandled('ask-open')).rejects.toThrow(/not "answered"/);
  });

  it('lists asks by status oldest first and counts only open asks', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-open-late', 300));
    await store.create(makeAsk('ask-open-early', 100));
    await store.create(makeAsk('ask-answered', 200));
    await store.recordAnswer(
      'ask-answered',
      { option: 'yes', answered_at: 400 },
      'ui',
    );
    await store.create(makeAsk('ask-handled', 500));
    await store.recordAnswer(
      'ask-handled',
      { option: 'no', answered_at: 600 },
      'ui',
    );
    await store.markHandled('ask-handled');

    expect((await store.listByStatus('open')).map((ask) => ask.ask_id)).toEqual([
      'ask-open-early',
      'ask-open-late',
    ]);
    expect((await store.listByStatus('answered')).map((ask) => ask.ask_id)).toEqual([
      'ask-answered',
    ]);
    expect((await store.listByStatus('handled')).map((ask) => ask.ask_id)).toEqual([
      'ask-handled',
    ]);
    expect(await store.countOpen()).toBe(2);
  });
});
