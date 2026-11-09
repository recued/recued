/** A sign-in the server refuses (2026-11-03): the note of which server did it
 *  (`sign-in-refusal-store.ts`), the worker's pairing status that carries it, and the side panel's
 *  client that passes it on. The worker unpairing itself is in the bootstrap's own test. */

import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_PAIR_MESSAGE_TYPE, createBridgeWorkerPairing } from '../pairing/worker-pairing.js';
import { createRuntimePairingClient } from '../pairing/pairing-client.js';
import {
  BRIDGE_SIGN_IN_REFUSED_SESSION_KEY,
  createInMemorySignInRefusalStore,
  createSessionSignInRefusalStore,
  pairFormServerUrl,
} from '../pairing/sign-in-refusal-store.js';
import type { ChromeStorageSessionArea } from '../pairing/pending-pair-store.js';

const sessionArea = (): ChromeStorageSessionArea & { data: Record<string, unknown> } => {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) { return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])); },
    async set(items) { Object.assign(data, items); },
    async remove(keys) { for (const k of keys) delete data[k]; },
  };
};

describe('the address the pair form takes, from the socket URL a pairing stored', () => {
  it('reverses what pairing did to it', () => {
    expect(pairFormServerUrl('wss://review.recued.com/ws')).toBe('https://review.recued.com');
    expect(pairFormServerUrl('ws://127.0.0.1:7717/ws')).toBe('http://127.0.0.1:7717');
    expect(pairFormServerUrl('wss://alice.recued.cloud:8443/ws')).toBe('https://alice.recued.cloud:8443');
    expect(pairFormServerUrl('wss://host.example/recued/ws')).toBe('https://host.example/recued');
  });

  it('is empty for anything that is not a socket URL', () => {
    expect(pairFormServerUrl('https://review.recued.com')).toBe('');
    expect(pairFormServerUrl('not a url')).toBe('');
  });
});

describe('the note of which server refused this bridge', () => {
  it('session storage keeps it under its one key, and gives back only a usable one', async () => {
    const area = sessionArea();
    const store = createSessionSignInRefusalStore(area);
    expect(await store.load()).toBeNull();
    await store.save({ serverUrl: 'https://review.example', at: 5 });
    expect(area.data).toEqual({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: { serverUrl: 'https://review.example', at: 5 } });
    expect(await store.load()).toEqual({ serverUrl: 'https://review.example', at: 5 });
    area.data[BRIDGE_SIGN_IN_REFUSED_SESSION_KEY] = { serverUrl: '', at: 5 };
    expect(await store.load()).toBeNull();
    await store.clear();
    expect(area.data).toEqual({});
  });
});

describe('the worker says why it is unpaired, until the next pairing', () => {
  const build = () => {
    const refusals = createInMemorySignInRefusalStore();
    let paired = false;
    const onPaired = vi.fn(async () => undefined);
    const pairing = createBridgeWorkerPairing({
      submit: async () => ({ ok: true as const, token: 'bearer-1', token_id: 'tok-1', passport: {} }),
      finalize: async () => { paired = true; return { ok: true, server_url: 'wss://review.example/ws', token_id: 'tok-1' }; },
      readPaired: async () => (paired ? { serverUrl: 'wss://review.example/ws' } : null),
      onPaired,
      mintInstanceId: () => 'inst-1',
      refusals,
    });
    return { pairing, refusals, onPaired };
  };

  it('an unpaired status names the server that refused it', async () => {
    const t = build();
    expect(await t.pairing.status()).toEqual({ state: 'unpaired' });
    await t.refusals.save({ serverUrl: 'https://review.example', at: 1 });
    expect(await t.pairing.status()).toEqual({ state: 'unpaired', refused: { serverUrl: 'https://review.example' } });
  });

  it('a pairing that finishes forgets the refusal, before the runtime starts', async () => {
    const t = build();
    await t.refusals.save({ serverUrl: 'https://review.example', at: 1 });
    let noteWhenStarted: unknown = 'unset';
    t.onPaired.mockImplementation(async () => { noteWhenStarted = await t.refusals.load(); });
    expect(await t.pairing.start({ serverUrl: 'https://review.example', code: 'ABC12345' })).toMatchObject({ ok: true });
    expect(noteWhenStarted).toBeNull();
    expect(await t.refusals.load()).toBeNull();
  });
});

describe("the side panel's client passes the refusal on, if it is usable", () => {
  const client = (answer: unknown) => createRuntimePairingClient({ sendMessage: async () => answer });

  it('passes a server address through', async () => {
    expect(await client({ state: 'unpaired', refused: { serverUrl: 'https://review.example' } }).status())
      .toEqual({ state: 'unpaired', refused: { serverUrl: 'https://review.example' } });
  });

  it('drops one it could not show or type in', async () => {
    expect(await client({ state: 'unpaired', refused: { serverUrl: 42 } }).status()).toEqual({ state: 'unpaired' });
    expect(await client({ state: 'unpaired', refused: 'yes' }).status()).toEqual({ state: 'unpaired' });
  });

  it('asks the worker with the pairing message', async () => {
    const sent: unknown[] = [];
    await createRuntimePairingClient({ sendMessage: async (m) => { sent.push(m); return { state: 'unpaired' }; } }).status();
    expect(sent).toEqual([{ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'status' }]);
  });
});

describe('2026-11-04 - a Disconnect the server could not be told of', () => {
  it('the note keeps that it was a disconnect, and the worker says so instead of a refusal', async () => {
    const area = sessionArea();
    const store = createSessionSignInRefusalStore(area);
    await store.save({ serverUrl: 'https://review.example', at: 7, kind: 'disconnected' });
    expect(await store.load()).toEqual({ serverUrl: 'https://review.example', at: 7, kind: 'disconnected' });
    const pairing = createBridgeWorkerPairing({
      submit: async () => ({ ok: true as const, token: 'bearer-1', token_id: 'tok-1', passport: {} }),
      finalize: async () => ({ ok: true, server_url: 'wss://review.example/ws', token_id: 'tok-1' }),
      readPaired: async () => null,
      onPaired: async () => undefined,
      mintInstanceId: () => 'inst-1',
      refusals: store,
    });
    expect(await pairing.status()).toEqual({ state: 'unpaired', disconnected: { serverUrl: 'https://review.example' } });
  });

  it('an unknown kind reads as a refusal, as notes before it did', async () => {
    const area = sessionArea();
    area.data[BRIDGE_SIGN_IN_REFUSED_SESSION_KEY] = { serverUrl: 'https://review.example', at: 7, kind: 'other' };
    expect(await createSessionSignInRefusalStore(area).load()).toEqual({ serverUrl: 'https://review.example', at: 7 });
  });

  it('the side panel\'s client passes it on, if it is usable', async () => {
    const client = (answer: unknown) => createRuntimePairingClient({ sendMessage: async () => answer });
    expect(await client({ state: 'unpaired', disconnected: { serverUrl: 'https://review.example' } }).status())
      .toEqual({ state: 'unpaired', disconnected: { serverUrl: 'https://review.example' } });
    expect(await client({ state: 'unpaired', disconnected: { serverUrl: '' } }).status()).toEqual({ state: 'unpaired' });
  });
});
