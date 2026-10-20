import { describe, expect, it } from 'vitest';
import { createTelegramTransport } from '../telegram.js';
import { createSlackTransport } from '../slack.js';
import { createDiscordTransport } from '../discord.js';

describe('D-325 bundle transport buttons', () => {
  it('acknowledges an already-applied Telegram edit without treating that error as a successful send', async () => {
    const telegram = createTelegramTransport({ fetchImpl: async () => new Response(JSON.stringify({
      ok: false, error_code: 400, description: 'Bad Request: message is not modified',
    }), { status: 400, headers: { 'content-type': 'application/json' } }) });
    const prompt = { token: 'fixture', recipient: '123', correlation_id: 'ask-first', text: 'Reminder',
      options: [{ id: 'done', label: 'Done' }] };
    expect((await telegram.updatePrompt!({ ...prompt, vendor_message_id: '42' })).ok).toBe(true);
    expect((await telegram.closePrompt({ token: 'fixture', recipient: '123', vendor_message_id: '42', text: 'Closed' })).ok).toBe(true);
    expect((await telegram.sendPrompt(prompt)).ok).toBe(false);
    expect((await telegram.send({ token: 'fixture', recipient: '123', text: 'Reminder' })).ok).toBe(false);
  });
  for (const [vendor, create, response] of [
    ['telegram', createTelegramTransport, { ok: true, result: { message_id: 42 } }],
    ['slack', createSlackTransport, { ok: true, ts: '42' }],
    ['discord', createDiscordTransport, { id: '42' }],
  ] as const) {
    it(`${vendor} encodes each question and edits the original message with only the remaining options`, async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const transport = create({ fetchImpl });
      const prompt = { token: 'fixture-token', recipient: '123', text: '1. Passport\n2. Licence', correlation_id: 'bundle',
        options: [{ id: 'done', label: '1 Done', correlation_id: 'ask-first' },
          { id: 'done', label: '2 Done', correlation_id: 'ask-second' }] };
      expect((await transport.sendPrompt(prompt)).ok).toBe(true);
      const sent = String(calls[0]!.init?.body);
      expect(sent).toContain('ask-first|done');
      expect(sent).toContain('ask-second|done');
      expect((await transport.updatePrompt!({ ...prompt, vendor_message_id: '42', options: [prompt.options[1]!] })).ok).toBe(true);
      const edited = String(calls[1]!.init?.body);
      expect(edited).toContain('ask-second|done');
      expect(edited).not.toContain('ask-first|done');
      if (vendor === 'telegram') expect(calls[1]!.url).toContain('editMessageText');
      if (vendor === 'slack') expect(calls[1]!.url).toContain('chat.update');
      if (vendor === 'discord') {
        expect(calls[1]!.init?.method).toBe('PATCH');
        expect(calls[1]!.url).toMatch(/messages\/42$/);
      }
    });
  }
});
