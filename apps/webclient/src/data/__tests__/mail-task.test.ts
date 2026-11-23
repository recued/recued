import { describe, expect, it } from 'vitest';
import { TASK_TITLE_MAX, type MailMessageSnapshot } from '@recued/contracts';
import { mailTaskValues } from '../mail-task.js';
import { parseShellRoute, parseSourceRecordAddress } from '../../shell/route.js';

const message: MailMessageSnapshot = { slug: 'work/one', record_id: 'mail?#二', from: 'Alex <alex@example.test>', to: ['owner@example.test'], cc: [],
  subject: ' Review the quote ', received_at: 1, body: '  Please check the revised quote.\nKeep the delivery date. ', body_truncated: false, read: 'stored', reply: null };

describe('mail follow-up task draft', () => {
  it('quotes the selected email and links its exact mailbox record without retaining URL queries or inferring relationships', () => {
    const values = mailTaskValues(message, 'https://recued.example/client/?token=private#data/mail/other');
    expect(values).toEqual({ title: 'Review the quote', done: false, due_at: null,
      body: 'From: Alex <alex@example.test>\nEmail: https://recued.example/client/#data/mail/record/work%2Fone/mail%3F%23%E4%BA%8C\n\nEmail excerpt:\nPlease check the revised quote.\nKeep the delivery date.' });
    const url = new URL(String(values.body).split('\n')[1]!.slice('Email: '.length));
    expect(parseSourceRecordAddress(parseShellRoute(url.hash))).toEqual({ tab: 'mail', collectionSlug: message.slug, recordId: message.record_id });
    expect(message.body).toBe('  Please check the revised quote.\nKeep the delivery date. ');
  });

  it('bounds long subjects and excerpts without splitting Unicode, and identifies partial text', () => {
    const values = mailTaskValues({ ...message, subject: 'a'.repeat(TASK_TITLE_MAX - 1) + '🧾next', body: 'b'.repeat(599) + '🧾last' }, 'https://recued.example/');
    expect(values.title).toBe('a'.repeat(TASK_TITLE_MAX - 1));
    expect(values.body).toContain('Email excerpt (partial):\n' + 'b'.repeat(599));
    expect(values.body).not.toContain('last');
    expect(mailTaskValues({ ...message, body_truncated: true }, 'https://recued.example/').body).toContain('Email excerpt (partial):');
  });

  it('provides an editable fallback for missing subjects and bodies', () => {
    expect(mailTaskValues({ ...message, subject: ' ', body: null }, 'https://recued.example/')).toMatchObject({ title: 'Follow up on email',
      body: expect.stringContaining('The email text was unavailable. Open the email for context.') });
  });
});
