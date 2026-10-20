/** D-325 §5.1 — a press on a Slack reminder that already closed says so,
 *  through the press's own `response_url`, to the presser alone. */

import { describe, expect, it, vi } from 'vitest';
import { composeSlackPressReply } from '../composition/bin/wire-slack-press-reply.js';

const NOTICE = 'This reminder is already closed.';
const HOOK = 'https://hooks.slack.com/actions/T1/123/abc';
const press = (response_url: unknown): unknown => ({ type: 'block_actions', user: { id: 'U-click' }, response_url,
  actions: [{ type: 'button', value: 'ask-1|done' }], container: { message_ts: '1716141000.000200' } });
const accepting = () => vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));

describe('D-325 §5.1 — composeSlackPressReply', () => {
  it('posts the notice to the press’s response_url as a message only the presser sees', async () => {
    const fetchImpl = accepting();
    await composeSlackPressReply({ fetchImpl })(press(HOOK), 'slack', NOTICE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(HOOK);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ response_type: 'ephemeral', replace_original: false, text: NOTICE });
  });

  it('sends nothing without a notice, without a response_url, or to any host but Slack’s', async () => {
    const fetchImpl = accepting(); const reply = composeSlackPressReply({ fetchImpl });
    await reply(press(HOOK), 'slack');
    await reply(press(undefined), 'slack', NOTICE);
    for (const url of ['https://hooks.slack.com.example.net/actions/T1', 'http://hooks.slack.com/actions/T1', 'https://169.254.169.254/latest', 'not a url']) {
      await reply(press(url), 'slack', NOTICE);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect away from Slack', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { location: 'https://collector.invalid/steal' } }));
    await expect(composeSlackPressReply({ fetchImpl })(press(HOOK), 'slack', NOTICE)).rejects.toThrow(/redirect refused/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
