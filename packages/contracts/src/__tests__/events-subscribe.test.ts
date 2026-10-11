/** A client keeps its live updates against a server at another version.
 *
 *  ⛔ From 2026-05-07 `events.subscribe` refused the whole call for one kind
 *  the server does not send, so a client newer or older than its server got
 *  no live updates at all. Found live on 2026-10-10: after `service` was
 *  retired, a Chat turn sat at "Preparing your answer…" for five minutes. */

import { describe, expect, it } from 'vitest';

import {
  eventsSubscribeRefusedKind,
  eventsSubscribeUnknownKindMessage,
  subscribeToKnownKinds,
} from '../events-subscribe.js';
import type { BroadcastEventKind, SubscribeAck, SubscribeRequest } from '../events.js';
import { RpcError } from '../rpc/types.js';

/** The error frame a server sent that day, as captured on the wire. Servers
 *  from 2026-05-07 on send it and never change, so it is pinned as text. */
const CAPTURED = { code: 'bad_request', message: "events.subscribe: unknown kind 'service' (not in BROADCAST_EVENT_KIND_SET)" };

/** The rpc error a client builds from an error frame (both clients' rpc-conn). */
const fromFrame = (e: { code: string; message: string }): RpcError =>
  new RpcError(e.code, e.message, undefined, 'events.subscribe');

const ACK: SubscribeAck = { cursor: 7, replay_count: 0, fell_off_ring: false };

/** A server from before 2026-10-10: refuses the call for the FIRST kind it
 *  does not know, as its `.find` did, and installs nothing. */
const olderServer = (knows: ReadonlySet<string>) => {
  const calls: string[][] = [];
  const call = async (req: SubscribeRequest): Promise<SubscribeAck> => {
    calls.push([...req.kinds]);
    const unknown = req.kinds.find((k) => !knows.has(k));
    if (unknown !== undefined) {
      throw fromFrame({ code: 'bad_request', message: `events.subscribe: unknown kind '${unknown}' (not in BROADCAST_EVENT_KIND_SET)` });
    }
    return ACK;
  };
  return { call, calls };
};

const KINDS = ['approval', 'execution', 'records', 'mail_fact'] as BroadcastEventKind[];

describe('subscribeToKnownKinds', () => {
  it('against an older server: asks again without each kind it refuses, and keeps the rest', async () => {
    const server = olderServer(new Set(['approval', 'execution']));
    const { ack, left_out } = await subscribeToKnownKinds(server.call, { kinds: KINDS });
    expect(ack).toEqual(ACK);
    expect(left_out).toEqual(['records', 'mail_fact']);
    expect(server.calls).toEqual([
      ['approval', 'execution', 'records', 'mail_fact'],
      ['approval', 'execution', 'mail_fact'],
      ['approval', 'execution'],
    ]);
  });

  it('against a current server: one call, and what it left out comes from the ack', async () => {
    const calls: SubscribeRequest[] = [];
    const { left_out } = await subscribeToKnownKinds(async (req) => {
      calls.push(req);
      return { ...ACK, unknown_kinds: ['mail_fact'] };
    }, { kinds: KINDS, cursor_since: 3 });
    expect(left_out).toEqual(['mail_fact']);
    expect(calls).toEqual([{ kinds: KINDS, cursor_since: 3 }]);
  });

  it('any other failure is thrown, never retried', async () => {
    for (const err of [
      fromFrame({ code: 'unavailable', message: 'subscribe temporarily unavailable' }),
      fromFrame({ code: 'bad_request', message: 'events.subscribe: kinds must be a non-empty array' }),
      new Error(CAPTURED.message), // the text without the rpc error's code
    ]) {
      let calls = 0;
      await expect(subscribeToKnownKinds(async () => { calls += 1; throw err; }, { kinds: KINDS }))
        .rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it('the refusal of the last kind left is thrown: a server that knows none of them ends the loop', async () => {
    const server = olderServer(new Set());
    await expect(subscribeToKnownKinds(server.call, { kinds: KINDS }))
      .rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining("'mail_fact'") });
    expect(server.calls).toHaveLength(KINDS.length);
  });

  it('a refusal naming a kind it was not asked for is thrown', async () => {
    let calls = 0;
    const refusal = fromFrame({ ...CAPTURED });
    await expect(subscribeToKnownKinds(async () => { calls += 1; throw refusal; }, { kinds: KINDS }))
      .rejects.toBe(refusal);
    expect(calls).toBe(1);
  });
});

describe('the refusal text', () => {
  it('reads the kind out of the frame a server sent', () => {
    expect(eventsSubscribeRefusedKind(fromFrame(CAPTURED))).toBe('service');
  });

  it("is what a current server still sends for a call it cannot serve at all", () => {
    expect(eventsSubscribeUnknownKindMessage('service')).toBe(CAPTURED.message);
  });

  it('is not any other error', () => {
    expect(eventsSubscribeRefusedKind(fromFrame({ code: 'bad_request', message: 'events.subscribe: kinds must be strings' }))).toBeNull();
    expect(eventsSubscribeRefusedKind(null)).toBeNull();
    expect(eventsSubscribeRefusedKind('nope')).toBeNull();
  });
});
