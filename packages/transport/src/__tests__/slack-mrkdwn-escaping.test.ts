/** Slack renders an argument value as WHAT IT IS, not as markup.
 *
 *  Slack is the only channel that interprets a message body (the section
 *  block declares `mrkdwn`). Every other surface treats the same bytes as
 *  data — the webclient / ask-landing / email escape into HTML, Telegram
 *  sends with no `parse_mode`. Unescaped, an approval ask displayed
 *  something other than the arguments it was asking the owner to approve.
 */
import { describe, expect, it } from 'vitest';
import { createSlackTransport } from '../slack.js';

const capture = () => {
  const seen: { body?: Record<string, unknown> } = {};
  const transport = createSlackTransport({
    fetchImpl: (async (_url: string, init: { body: string }) => {
      seen.body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, ts: '17.1' }), {
        status: 200,
      });
    }) as never,
  });
  return { transport, seen };
};

const sectionOf = (body: Record<string, unknown> | undefined): string => {
  const blocks = body?.blocks as Array<{ text?: { text?: string } }> | undefined;
  return blocks?.[0]?.text?.text ?? '';
};

describe('Slack mrkdwn escaping', () => {
  it('does not let a value disguise a URL behind a friendly label', () => {
    // `<href|label>` renders as a link showing `label` and pointing at
    // `href`. An agent drafting mail from content it read inbound is
    // exactly how a value like this arrives at an approval.
    const { transport, seen } = capture();
    return transport
      .send({
        recipient: 'C1',
        token: 't',
        text: 'body: Review <https://evil.example|https://recued.com/invoice>',
      })
      .then(() => {
        const wire = seen.body?.text as string;
        expect(wire).not.toContain('<https://evil.example|');
        expect(wire).toContain(
          '&lt;https://evil.example|https://recued.com/invoice&gt;',
        );
      });
  });

  it('does not let a value ping the workspace', () => {
    const { transport, seen } = capture();
    return transport
      .send({ recipient: 'C1', token: 't', text: 'subject: <!channel> outage' })
      .then(() => {
        expect(seen.body?.text as string).toContain('&lt;!channel&gt;');
        expect(seen.body?.text as string).not.toContain('<!channel>');
      });
  });

  it('renders an ordinary angle-bracketed address as itself', () => {
    // No adversary needed — this is what a mail header looks like, and
    // Slack was eating the brackets.
    const { transport, seen } = capture();
    return transport
      .send({ recipient: 'C1', token: 't', text: 'to: Dana <dana@north.example>' })
      .then(() => {
        expect(seen.body?.text as string).toContain(
          'to: Dana &lt;dana@north.example&gt;',
        );
      });
  });

  it('escapes & first so its own replacements are not double-escaped', () => {
    const { transport, seen } = capture();
    return transport
      .send({ recipient: 'C1', token: 't', text: 'subject: margins & <b>' })
      .then(() => {
        expect(seen.body?.text as string).toContain('margins &amp; &lt;b&gt;');
        expect(seen.body?.text as string).not.toContain('&amp;lt;');
      });
  });

  it('keeps the bold title WE author while escaping the title text', () => {
    // The `*` around the title is this transport's own markup and must
    // survive — which is why escaping is per-part, not one pass over the
    // composed string.
    const { transport, seen } = capture();
    return transport
      .send({
        recipient: 'C1',
        token: 't',
        title: 'Approve core.mail.send <write>',
        text: 'body',
      })
      .then(() => {
        expect(seen.body?.text as string).toBe(
          '*Approve core.mail.send &lt;write&gt;*\nbody',
        );
      });
  });

  it('escapes the ask body in the section block AND the fallback text', () => {
    const { transport, seen } = capture();
    return transport
      .sendPrompt({
        recipient: 'C1',
        token: 't',
        correlation_id: 'ask_1',
        title: 'Approve core.mail.send (write)',
        text: 'to: Dana <dana@north.example>\n\nApprove?',
        options: [{ id: 'approve', label: 'Approve' }],
      })
      .then(() => {
        expect(sectionOf(seen.body)).toContain('&lt;dana@north.example&gt;');
        expect(seen.body?.text as string).toContain('&lt;dana@north.example&gt;');
      });
  });

  it('escapes the close body too — bypasses the compose path', () => {
    const { transport, seen } = capture();
    return transport
      .closePrompt({
        recipient: 'C1',
        token: 't',
        vendor_message_id: '17.1',
        text: 'to: Dana <dana@north.example>',
      })
      .then(() => {
        expect(sectionOf(seen.body)).toContain('&lt;dana@north.example&gt;');
      });
  });

  it('escapes BEFORE fitting, so escaping cannot regrow past the cap', () => {
    // Escaping expands (`<` → `&lt;`). Fitting first would hand the budget
    // a string that then grew back over Slack's 3000-char section cap —
    // and an over-cap send is the silent drop this all exists to prevent.
    const { transport, seen } = capture();
    return transport
      .sendPrompt({
        recipient: 'C1',
        token: 't',
        correlation_id: 'ask_1',
        text: '<'.repeat(2000) + '\n\nApprove?',
        options: [{ id: 'approve', label: 'Approve' }],
      })
      .then(() => {
        const section = sectionOf(seen.body);
        expect(section.length).toBeLessThanOrEqual(3000);
        expect(section).toContain('trimmed to fit Slack');
        // The cut cannot reintroduce markup: every `<` is gone before it.
        expect(section).not.toContain('<');
      });
  });
});
