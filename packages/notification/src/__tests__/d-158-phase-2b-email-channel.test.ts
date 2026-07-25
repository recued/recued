import { describe, expect, it, vi } from 'vitest';
import {
  createEmailChannel,
  extractAskId,
  parseEmailReply,
  type AskOption,
  type EmailSender,
  type NotificationMessage,
  type OutboundEmail,
} from '@recued/notification';

const notifyMessage: NotificationMessage = {
  title: 'Build ready',
  text: 'Deploy finished',
  link_url: 'https://recued.test/runs/1',
};

const notifyMessageWithoutTitle: NotificationMessage = {
  text: 'Background sync completed',
};

const askMessage: NotificationMessage = {
  title: 'Decision ready',
  text: 'Approve the plan?',
};

const askOptions: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
  { id: 'more-info', label: 'Need more info' },
];

const emailSender = (): ReturnType<typeof vi.fn<EmailSender>> =>
  vi.fn<EmailSender>(async () => {});

const sentEmail = (
  sendEmail: ReturnType<typeof vi.fn<EmailSender>>,
  index = 0,
): OutboundEmail => {
  const call = sendEmail.mock.calls[index];
  if (call === undefined) {
    throw new Error(`missing sendEmail call ${index}`);
  }
  return call[0];
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const replySubject = 'Re: Decision ready [#ask-email-reply]';

const parseReply = (body_text: string, subject = replySubject) =>
  parseEmailReply({ subject, body_text }, askOptions);

describe('D-158 P2b-i createEmailChannel identity and notify delivery', () => {
  it('uses the email channel name', () => {
    const channel = createEmailChannel({ sendEmail: emailSender() });

    expect(channel.name).toBe('email');
  });

  it('deliverNotify sends a titled notification with no ask tag and a trailing link line', async () => {
    const sendEmail = emailSender();
    const channel = createEmailChannel({ sendEmail });

    await channel.deliverNotify(notifyMessage);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sentEmail(sendEmail)).toEqual({
      subject: 'Build ready',
      body_text: 'Deploy finished\n\nhttps://recued.test/runs/1',
    });
    expect(extractAskId(sentEmail(sendEmail).subject)).toBeNull();
    expect(sentEmail(sendEmail).subject).not.toMatch(/\[#ask-/);
  });

  it('deliverNotify uses the default subject when the message has no title', async () => {
    const sendEmail = emailSender();
    const channel = createEmailChannel({ sendEmail });

    await channel.deliverNotify(notifyMessageWithoutTitle);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sentEmail(sendEmail)).toEqual({
      subject: 'Recued',
      body_text: 'Background sync completed',
    });
  });
});

describe('D-158 P2b-i createEmailChannel ask delivery', () => {
  it('deliverAsk sends a tagged prompt body with every option label and the reply instruction', async () => {
    const sendEmail = emailSender();
    const channel = createEmailChannel({ sendEmail });

    await channel.deliverAsk('ask-email-1', askMessage, askOptions);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const email = sentEmail(sendEmail);
    expect(extractAskId(email.subject)).toBe('ask-email-1');
    expect(email.subject).toMatch(/\[#ask-email-1\]$/);
    expect(email.body_text).toContain('Approve the plan?');
    for (const option of askOptions) {
      expect(email.body_text).toContain(`- ${option.label}`);
    }
    expect(email.body_text).toContain(
      'To answer, reply to this email with just one of these options:',
    );
    expect(email.body_text).toContain(
      'Reply with only the option text and nothing else',
    );
  });

  it('deliverAsk sends only once for the same ask_id and sends again for a different ask_id', async () => {
    const sendEmail = emailSender();
    const channel = createEmailChannel({ sendEmail });

    await channel.deliverAsk('ask-repeat', askMessage, askOptions);
    await channel.deliverAsk('ask-repeat', { text: 'Changed prompt' }, [
      { id: 'changed', label: 'Changed' },
    ]);
    await channel.deliverAsk('ask-other', askMessage, askOptions);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(extractAskId(sentEmail(sendEmail, 0).subject)).toBe('ask-repeat');
    expect(extractAskId(sentEmail(sendEmail, 1).subject)).toBe('ask-other');
  });

  it('deliverAsk reserves the ask_id before awaiting sendEmail', async () => {
    const gate = deferred<void>();
    const sendEmail = vi.fn<EmailSender>(() => gate.promise);
    const channel = createEmailChannel({ sendEmail });

    const first = channel.deliverAsk('ask-concurrent', askMessage, askOptions);
    const second = channel.deliverAsk('ask-concurrent', askMessage, askOptions);

    expect(sendEmail).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('deliverAsk rejects on send failure and releases the ask_id for retry', async () => {
    const sendEmail = vi.fn<EmailSender>();
    sendEmail
      .mockRejectedValueOnce(new Error('smtp rejected'))
      .mockResolvedValueOnce(undefined);
    const channel = createEmailChannel({ sendEmail });

    await expect(
      channel.deliverAsk('ask-retry', askMessage, askOptions),
    ).rejects.toThrow(/smtp rejected/);
    await channel.deliverAsk('ask-retry', askMessage, askOptions);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(extractAskId(sentEmail(sendEmail, 0).subject)).toBe('ask-retry');
    expect(extractAskId(sentEmail(sendEmail, 1).subject)).toBe('ask-retry');
  });
});

describe('D-158 P2b-i createEmailChannel closeAsk', () => {
  it('resolves without sending email', async () => {
    const sendEmail = emailSender();
    const channel = createEmailChannel({ sendEmail });

    await expect(channel.closeAsk('ask-close')).resolves.toBeUndefined();

    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('D-158 P2b-i extractAskId', () => {
  it('extracts bracket-hash ask tags from original and reply subjects', () => {
    expect(extractAskId('Decision ready [#ask-alpha-123]')).toBe(
      'ask-alpha-123',
    );
    expect(extractAskId('Re: Decision ready [#ask-alpha-123]')).toBe(
      'ask-alpha-123',
    );
  });

  it('returns null when the subject has no ask tag', () => {
    expect(extractAskId('Decision ready')).toBeNull();
  });
});

describe('D-158 P2b-i parseEmailReply', () => {
  it('maps exact option ids and labels to inbound email replies', () => {
    expect(parseReply('approve')).toEqual({
      ask_id: 'ask-email-reply',
      option: 'approve',
      via: 'email',
    });
    expect(parseReply('Need more info')).toEqual({
      ask_id: 'ask-email-reply',
      option: 'more-info',
      via: 'email',
    });
  });

  it('matches different case and trailing sentence punctuation', () => {
    expect(parseReply('Approve.')).toEqual({
      ask_id: 'ask-email-reply',
      option: 'approve',
      via: 'email',
    });
  });

  it('does not treat negated or extra-word replies as an approve option', () => {
    expect(parseReply('do not approve')).toBeNull();
    expect(parseReply('I cannot approve this')).toBeNull();
    expect(parseReply('I approve')).toBeNull();
  });

  it('returns null when the reply matches no option', () => {
    expect(parseReply('maybe later')).toBeNull();
  });

  it('ignores quoted original text below attribution and angle-quoted lines', () => {
    expect(
      parseReply(
        'Approve\n\nOn Thu, May 21, 2026 at 9:00 AM Recued wrote:\n' +
          'To answer, reply with one option:\n' +
          '- Approve\n' +
          '- Reject\n' +
          '- Need more info',
      ),
    ).toEqual({
      ask_id: 'ask-email-reply',
      option: 'approve',
      via: 'email',
    });

    expect(
      parseReply(
        'Reject\n\n> To answer, reply with one option:\n' +
          '> - Approve\n' +
          '> - Reject\n' +
          '> - Need more info',
      ),
    ).toEqual({
      ask_id: 'ask-email-reply',
      option: 'reject',
      via: 'email',
    });
  });

  it('returns null when the subject has no ask tag', () => {
    expect(parseReply('Approve', 'Re: Decision ready')).toBeNull();
  });
});
