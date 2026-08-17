/** D-238 — the Teams transport.
 *
 *  The assertions worth having here are about what this transport DOESN'T do.
 *  It is the first base-`Transport` vendor: it must not grow a `sendPrompt`
 *  (Graph cannot deliver a card action to a poller), and it must not hand markup
 *  control to a payload it did not author. Both are properties a green send test
 *  would happily pass while broken. */

import { describe, expect, it } from 'vitest';

import { createTeamsTransport, normalizeTeamsChatId } from '../teams.js';

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

const captureFetch = () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return okResponse({ id: '1616964509832' });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const body = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body)) as Record<string, unknown>;

describe('createTeamsTransport', () => {
  it('posts to the chat messages endpoint with the bearer credential', async () => {
    const { calls, fetchImpl } = captureFetch();
    const t = createTeamsTransport({ fetchImpl });

    const result = await t.send({
      recipient: '19:abc@thread.v2',
      token: 'at-live',
      text: 'Mail from Dana needs a decision.',
    });

    expect(result).toEqual({ ok: true, vendor_message_id: '1616964509832' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.v2/messages',
    );
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe('Bearer at-live');
  });

  /** ⛔ The escaping class this vendor is designed to never enter. Slack needed a
   *  dedicated escaper because it INTERPRETS the body — `<url|label>` disguise,
   *  `<!channel>` pings, an ordinary `Dana <dana@x.com>` header being eaten. An
   *  ask body is agent-authored, so the safe posture is a contentType that
   *  interprets nothing. If this ever flips to 'html', every one of those
   *  becomes live and nothing else in the suite would notice. */
  it('sends contentType text — never html — so a payload cannot author markup', async () => {
    const { calls, fetchImpl } = captureFetch();
    const t = createTeamsTransport({ fetchImpl });

    await t.send({
      recipient: '19:abc@thread.v2',
      token: 'tok',
      text: 'Reply to Dana <dana@example.com> — <!channel> <https://evil|Approve>',
    });

    const sent = body(calls[0]!.init).body as { contentType: string; content: string };
    expect(sent.contentType).toBe('text');
    // Verbatim: nothing stripped, nothing interpreted, nothing escaped-then-
    // double-escaped. The content type is what makes that safe.
    expect(sent.content).toContain('Dana <dana@example.com>');
    expect(sent.content).toContain('<!channel>');
    expect(sent.content).toContain('<https://evil|Approve>');
  });

  it('puts the title and the deep link on their own lines', async () => {
    const { calls, fetchImpl } = captureFetch();
    const t = createTeamsTransport({ fetchImpl });
    await t.send({
      recipient: '19:abc@thread.v2',
      token: 'tok',
      text: 'body',
      title: 'Approval pending',
      link_url: 'https://recued.example.com/ask/abc',
    });
    const sent = body(calls[0]!.init).body as { content: string };
    expect(sent.content).toBe(
      'Approval pending\n\nbody\n\nhttps://recued.example.com/ask/abc',
    );
  });

  it('classifies an expired credential as an auth failure, not a network one', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const result = await createTeamsTransport({ fetchImpl }).send({
      recipient: '19:abc@thread.v2',
      token: 'expired',
      text: 'x',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('auth');
    // Both halves: the code is what a search finds, the message is what a human
    // reads. Dropping either makes an unattended failure harder to diagnose.
    expect(result.error.detail).toContain('InvalidAuthenticationToken');
    expect(result.error.detail).toContain('Access token has expired.');
  });

  /** ⛔ Not a style assertion. `createRemoteChannel` narrows on `sendPrompt` to
   *  decide whether a channel can carry an ask; if this transport ever grew one,
   *  an `inline` Teams channel would construct cleanly and then fail on the first
   *  ask — on the block's best-effort fan-out, which catches. Graph cannot
   *  deliver a card action to a poller, so the absence is the design. */
  it('is NOT interactive — no sendPrompt, closePrompt, or choice decoding', () => {
    const t = createTeamsTransport() as unknown as Record<string, unknown>;
    expect(t.sendPrompt).toBeUndefined();
    expect(t.closePrompt).toBeUndefined();
    expect(t.parseInboundChoice).toBeUndefined();
  });

  /** ⛔ The one that would make typed answers silently impossible.
   *  `body.content` comes back as HTML even though we POST `contentType: 'text'`
   *  — Teams stores what the CLIENT sent, and a person typing in Teams sends
   *  HTML. So a reply reading `approve` arrives as `<p>approve</p>`, and an
   *  answer matcher comparing that to the option label `Approve` would never
   *  match. Nothing else in the stack would explain why. */
  it('strips the HTML Teams wraps a typed reply in', () => {
    const t = createTeamsTransport();
    expect(t.parseInbound({ id: '9', body: { content: '<p>approve</p>' } })?.text)
      .toBe('approve');
  });

  it('treats a block boundary as a line break, never a word join', () => {
    const t = createTeamsTransport();
    expect(t.parseInbound({ id: '9', body: { content: '<p>a</p><p>b</p>' } })?.text)
      .toBe('a\nb');
    expect(t.parseInbound({ id: '9', body: { content: 'a<br>b' } })?.text).toBe('a\nb');
  });

  /** Ampersand decodes LAST. Decoding it first would turn `&amp;lt;` into `<`,
   *  manufacturing markup out of text the sender escaped on purpose. */
  it('decodes the five XML entities without double-decoding', () => {
    const t = createTeamsTransport();
    expect(t.parseInbound({ id: '9', body: { content: 'a &amp;lt; b' } })?.text)
      .toBe('a &lt; b');
    expect(t.parseInbound({ id: '9', body: { content: '&quot;deny&quot;' } })?.text)
      .toBe('"deny"');
  });

  it('carries the sender id and vendor message id through', () => {
    const t = createTeamsTransport();
    expect(t.parseInbound({
      id: '1727366299993',
      body: { content: 'deny' },
      from: { user: { id: 'u-1' } },
    })).toEqual({ from: 'u-1', text: 'deny', vendor_message_id: '1727366299993' });
  });

  it('returns null for a payload carrying no body content', () => {
    const t = createTeamsTransport();
    expect(t.parseInbound({ id: '1' })).toBeNull();
    expect(t.parseInbound(null)).toBeNull();
  });

  it('reads the bound conversation off the message chatId', () => {
    const t = createTeamsTransport();
    expect(t.parseConversationId({ chatId: '19:abc@thread.v2' })).toBe('19:abc@thread.v2');
    // Fail-closed: the binding gate refuses a payload it cannot place.
    expect(t.parseConversationId({})).toBeNull();
  });
});

describe('normalizeTeamsChatId', () => {
  const ID = '19:abc123@thread.v2';

  it('passes a raw id through untouched, so existing configs keep working', () => {
    expect(normalizeTeamsChatId(ID)).toBe(ID);
    expect(normalizeTeamsChatId(`  ${ID}  `)).toBe(ID);
  });

  /** ⛔ THE ONE THAT MATTERS. Teams stopped exposing the thread id in the
   *  address bar, so the card's old instruction — "take it from the web URL" —
   *  became impossible to follow. Copy link is what a client still offers, and
   *  the id rides in it percent-encoded, exactly as Graph's own `chat.webUrl`
   *  does. */
  it('extracts the id from a pasted Copy link', () => {
    expect(normalizeTeamsChatId(
      'https://teams.microsoft.com/l/chat/19%3Aabc123%40thread.v2/0?tenantId=t-1',
    )).toBe(ID);
  });

  it('handles a 1:1 chat id, whose suffix differs', () => {
    const one = '19:aaa_bbb@unq.gbl.spaces';
    expect(normalizeTeamsChatId(
      `https://teams.microsoft.com/l/chat/19%3Aaaa_bbb%40unq.gbl.spaces/0?tenantId=t`,
    )).toBe(one);
  });

  /** ⛔ A link to something ELSE must yield null, never a plausible-looking
   *  wrong id — sending an owner's approval to the wrong conversation is the
   *  failure this shape guards against. The consumer-Teams link below is the
   *  real one that surfaced during drive prep. */
  it('refuses anything that is not a chat thread id', () => {
    for (const text of [
      'https://teams.live.com/l/message/48:notes/1786838670222?context=%7B%22contextType%22%3A%22chat%22%7D',
      'https://teams.microsoft.com/l/team/19%3Asomething%40thread.tacv2/conversations',
      'https://example.com/19:not-a-chat',
      'just some words',
      '',
      '   ',
    ]) {
      expect(normalizeTeamsChatId(text)).toBeNull();
    }
  });

  it('survives a malformed percent-escape rather than throwing', () => {
    expect(normalizeTeamsChatId(`%E0%A4%A ${ID}`)).toBe(ID);
  });
});
