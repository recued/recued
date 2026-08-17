/** D-238 — the JOIN: a non-interactive channel delivering an ask that carries
 *  BOTH answer paths, and turning a typed reply back into an answer.
 *
 *  ⛔ `d-238-ask-text-answer.test.ts` proves the matcher and this repo's channel
 *  tests prove the channel; both can be green while `parseInboundReply` never
 *  consults the matcher, or while `deliverAsk` ships an ask with no way to
 *  answer it. Those are the two failures this file exists to make impossible. */

import { describe, expect, it } from 'vitest';

import { createRemoteChannel } from '../channels/remote.js';
import type { NotificationMessage } from '../types.js';
import type { Transport, TransportSendResult } from '@recued/transport';

const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'deny', label: 'Deny' },
];

const MESSAGE: NotificationMessage = {
  title: 'Approval pending',
  text: 'Recipe invoice-intake wants to run mail-send',
};

/** A base `Transport` — no `sendPrompt`, which is what makes the channel
 *  non-interactive. `parseInbound` echoes text the way the Teams leaf does
 *  after it strips HTML. */
const baseTransport = () => {
  const sent: string[] = [];
  const transport: Transport = {
    vendor: 'teams',
    send: async (m): Promise<TransportSendResult> => {
      sent.push(m.text);
      return { ok: true, vendor_message_id: 'm-1' };
    },
    parseInbound: (payload) => {
      const p = payload as { text?: unknown; from?: unknown };
      return typeof p.text === 'string'
        ? { from: typeof p.from === 'string' ? p.from : OWNER, text: p.text }
        : null;
    },
    parseConversationId: () => '19:abc@thread.v2',
  };
  return { transport, sent };
};

/** The enrolled principal — the only account allowed to settle an ask by typing
 *  in the bound chat. */
const OWNER = 'owner-entra-id';

const channelWith = (
  answerLink?: (id: string) => string,
  /** `null` models a connection that bound NO approver. ⚠ Not `undefined`: a
   *  default parameter re-applies its default for an explicit `undefined`, so
   *  the unbound case would silently test the bound one. */
  expected_sender: string | null = OWNER,
) => {
  const { transport, sent } = baseTransport();
  const channel = createRemoteChannel({
    transport,
    capability: 'landing-page',
    resolveCredential: async () => ({
      token: 'tok',
      recipient: '19:abc@thread.v2',
      ...(expected_sender !== null ? { expected_sender } : {}),
    }),
    ...(answerLink ? { answerLink } : {}),
  });
  return { channel, sent };
};

describe('a landing-page channel delivers BOTH answer paths', () => {
  it('carries the ask, the typed-reply hint, and the answer link', async () => {
    const { channel, sent } = channelWith((id) => `https://recued.example.com/ask/${id}`);
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);

    expect(sent).toHaveLength(1);
    const body = sent[0]!;
    expect(body).toContain('Recipe invoice-intake wants to run mail-send');
    expect(body).toContain('Reply with: 1 = Approve, 2 = Deny');
    // The options are NUMBERED, and that is what earns positional matching —
    // the matcher accepts `1`/`2` only because the owner can see them here.
    expect(body).toContain('https://recued.example.com/ask/ask-1');
  });

  /** The honest state on an office LAN: the resolver refuses a private hostname
   *  by design, so no link is injected. The ask must still be answerable — which
   *  is the entire reason the typed path exists. */
  it('still ships the typed-reply hint when no link can be built', async () => {
    const { channel, sent } = channelWith();
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);

    expect(sent[0]!).toContain('Reply with: 1 = Approve, 2 = Deny');
    expect(sent[0]!).not.toContain('http');
  });
});

describe('a landing-page channel answers by typing', () => {
  const deliverThen = async (reply: string, answerLink = true) => {
    const { channel } = channelWith(
      answerLink ? (id) => `https://recued.example.com/ask/${id}` : undefined,
    );
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);
    return channel.parseInboundReply({ text: reply });
  };

  it('turns the option label into an answer for the ask it delivered', async () => {
    await expect(deliverThen('Approve')).resolves.toEqual({
      ask_id: 'ask-1', option: 'approve', via: 'teams',
    });
  });

  it('accepts a positional reply', async () => {
    await expect(deliverThen('2')).resolves.toEqual({
      ask_id: 'ask-1', option: 'deny', via: 'teams',
    });
  });

  it('ignores ordinary conversation in the same chat', async () => {
    for (const text of ['yes', 'ok', 'I think we should approve this', 'morning all']) {
      await expect(deliverThen(text)).resolves.toBeNull();
    }
  });

  /** ⛔ THE LOOP, at the wiring layer rather than the matcher's. With a DELEGATED
   *  Graph credential Recued posts AS the owner, so its own ask comes back
   *  through the poll indistinguishable by sender — and that body contains both
   *  option labels and the words "Reply with". If the channel answered it, every
   *  ask would approve itself the moment it was asked. */
  it('does not answer the ask body it just posted', async () => {
    const { channel, sent } = channelWith((id) => `https://recued.example.com/ask/${id}`);
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);
    expect(channel.parseInboundReply({ text: sent[0]! })).toBeNull();
  });

  /** ⛔ A late reply must not answer a settled ask. `closeAsk` returns early for
   *  a prompt with no buttons to strip — exactly this case — so the settled flag
   *  has to be set BEFORE that return or this passes for the wrong reason. */
  it('stops accepting typed answers once the ask is closed', async () => {
    const { channel } = channelWith();
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);
    expect(channel.parseInboundReply({ text: 'approve' })).not.toBeNull();

    await channel.closeAsk('ask-1');
    expect(channel.parseInboundReply({ text: 'approve' })).toBeNull();
  });

  it('refuses to guess when two asks are open at once', async () => {
    const { channel } = channelWith();
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);
    await channel.deliverAsk('ask-2', MESSAGE, OPTIONS);
    expect(channel.parseInboundReply({ text: 'approve' })).toBeNull();
  });

  it('ignores a reply when nothing was ever delivered here', () => {
    const { channel } = channelWith();
    expect(channel.parseInboundReply({ text: 'approve' })).toBeNull();
  });
});

describe('only the enrolled principal may settle an ask by typing', () => {
  /** ⛔⛔ A BOUND CHAT IS NOT AN AUTHORIZATION BOUNDARY. The recipient is a chat
   *  id and a chat can have other people in it, so without this a colleague
   *  typing `Approve` in a group thread authorizes a side effect on the OWNER's
   *  data. The ask is generated BY Recued FOR the owner — contrast a D-149
   *  approval_link, which the owner authors FOR a third party. */
  it('refuses an exact answer from someone else in the chat', async () => {
    const { channel } = channelWith();
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);

    expect(channel.parseInboundReply({ text: 'Approve', from: 'colleague-id' })).toBeNull();
    // …and the owner's identical answer still works, so the refusal is about
    // WHO sent it rather than the message being unparseable.
    expect(channel.parseInboundReply({ text: 'Approve', from: OWNER })).toEqual({
      ask_id: 'ask-1', option: 'approve', via: 'teams',
    });
  });

  /** ⛔ FAIL CLOSED. "We do not know who may approve" must resolve to "nobody
   *  may", never "anyone may" — the latter is the original defect, and it is the
   *  state a connection enrolled before principal binding would be in. */
  it('refuses every typed answer when no approver is bound', async () => {
    const { channel } = channelWith(undefined, null);
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);

    for (const from of [OWNER, 'colleague-id', '']) {
      expect(channel.parseInboundReply({ text: 'Approve', from })).toBeNull();
    }
  });

  /** The link is unaffected: it is capability-gated by an unguessable ask_id and
   *  answered on a page that authenticates separately, so an unbound connection
   *  still has a working answer path. Refusing typed answers is not refusing
   *  approval. */
  it('still ships the answer link when no approver is bound', async () => {
    const { channel, sent } = channelWith((id) => `https://x.example.com/ask/${id}`, null);
    await channel.deliverAsk('ask-1', MESSAGE, OPTIONS);
    expect(sent[0]!).toContain('https://x.example.com/ask/ask-1');
  });
});
