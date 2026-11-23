/** D-343 (the owner, 2026-11-14) — Telegram, Slack and email show an approval's plain words when it
 *  has them (`NotificationMessage.plain`), its own text otherwise. */
import { describe, expect, it, vi } from 'vitest';
import { createRemoteChannel, type NotificationMessage } from '@recued/notification';
import type { InteractiveTransport } from '@recued/transport';

const message: NotificationMessage = {
  title: 'Approve: Tick a task off, 2 actions', text: 'Your chat wants to tick a task off 2 times…\nTechnical: tool work.update.',
  plain: { title: 'Approve: Tick off 2 tasks', text: 'Your chat wants to tick off 2 tasks:\n  1. Call the plumber' },
};
const channel = () => {
  const sendPrompt = vi.fn<InteractiveTransport['sendPrompt']>(async () => ({ ok: true, vendor_message_id: 'p1' }));
  const closePrompt = vi.fn(async (_prompt: { text?: string }) => ({ ok: true }));
  const transport = { vendor: 'telegram', send: vi.fn(async () => ({ ok: true })), parseInbound: () => null, sendPrompt,
    parseInboundChoice: () => null, parseCallbackConversationId: () => null, closePrompt } as unknown as InteractiveTransport;
  return { sendPrompt, closePrompt, channel: createRemoteChannel({ transport, resolveCredential: async () => ({ recipient: 'C1', token: 't' }) }) };
};

describe('D-343 — a text channel shows an approval\'s plain words', () => {
  it('sends the plain title and text with the buttons', async () => {
    const { channel: remote, sendPrompt } = channel();
    await remote.deliverAsk('ask-1', message, [{ id: 'approve', label: 'Approve' }]);
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Approve: Tick off 2 tasks',
      text: 'Your chat wants to tick off 2 tasks:\n  1. Call the plumber' }));
  });

  it('sends a message without plain words as it is', async () => {
    const { channel: remote, sendPrompt } = channel();
    await remote.deliverAsk('ask-2', { title: 'Decide', text: 'Approve the plan?' }, [{ id: 'approve', label: 'Approve' }]);
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Decide', text: 'Approve the plan?' }));
  });
});

describe('D-343 — an approval withdrawn with no answer says why, beneath what it asked', () => {
  it('closes its message with the note, and without one as before', async () => {
    const { channel: remote, closePrompt } = channel();
    await remote.deliverAsk('ask-3', message, [{ id: 'approve', label: 'Approve' }]);
    await remote.closeAsk('ask-3', 'Replaced by a newer version.');
    expect(closePrompt.mock.calls[0]![0].text).toBe('Approve: Tick off 2 tasks\n\nYour chat wants to tick off 2 tasks:\n  1. Call the plumber\n\nReplaced by a newer version.');
    const plain = channel();
    await plain.channel.deliverAsk('ask-4', message, [{ id: 'approve', label: 'Approve' }]);
    await plain.channel.closeAsk('ask-4');
    expect(plain.closePrompt.mock.calls[0]![0].text).toBe('Approve: Tick off 2 tasks\n\nYour chat wants to tick off 2 tasks:\n  1. Call the plumber');
  });
});
