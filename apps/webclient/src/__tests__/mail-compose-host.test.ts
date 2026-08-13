/** D-145 PA7 / D-172 P2 — the pure halves of the mail compose host.
 *
 *  The DOM half is verified in a real browser (see the verify drive) because
 *  this repo has no jsdom/happy-dom and the webclient's fake-document double
 *  cannot exercise `closest` / `innerHTML` / delegated listeners — the exact
 *  machinery this host is made of. What IS testable without a DOM is pinned
 *  here: the two mappings where a wrong field is silent rather than loud.
 */

import { describe, expect, it } from 'vitest';
import {
  SEND_COMPOSED_MAIL_RECIPE_ID,
  composePayloadToSendRecipeConfig,
  type ComposeMailSendPayload,
} from '@recued/contracts';

import { senderOptionFromInstance } from '../mail/mail-compose-host.js';

describe('D-127 — mail instance row → sender option', () => {
  it('carries the row slug as mail_instance_slug', () => {
    const opt = senderOptionFromInstance({
      slug: 'work',
      adapter_type: 'imap',
      send_capable: true,
      account_email: 'alice@example.com',
    });
    // ⛔ The slug is the ROW's, never derived from the id/label. The contract
    // note on MailSenderSourceOption records why: a trailing-segment heuristic
    // collapsed `recued.mail_message` and `hubspot.<conn>.mail_message`.
    expect(opt.mail_instance_slug).toBe('work');
    expect(opt.id).toBe('work');
    expect(opt.account_email).toBe('alice@example.com');
    expect(opt.send_capable).toBe(true);
  });

  it('labels the known adapter kinds and passes an unknown one through', () => {
    const label = (adapter_type: string): string =>
      senderOptionFromInstance({
        slug: 's', adapter_type, send_capable: true, account_email: 'a@b.test',
      }).label;
    expect(label('gmail')).toBe('a@b.test (Gmail)');
    expect(label('graph')).toBe('a@b.test (Outlook)');
    expect(label('imap')).toBe('a@b.test (IMAP)');
    // An adapter we have no copy for must still produce a usable label rather
    // than "undefined" — the picker is how the owner tells accounts apart.
    expect(label('exchange-2003')).toBe('a@b.test (exchange-2003)');
  });

  it('falls back to the slug when the account email is blank', () => {
    const opt = senderOptionFromInstance({
      slug: 'work', adapter_type: 'imap', send_capable: true, account_email: '',
    });
    expect(opt.label).toBe('work (IMAP)');
    // ⚠ account_email stays empty — the LABEL degrades, the DATA does not get
    // a fabricated address. The self-loop guard compares against this field.
    expect(opt.account_email).toBe('');
  });

  it('preserves send_capable: false so the dialog can filter it out', () => {
    expect(senderOptionFromInstance({
      slug: 'ro', adapter_type: 'imap', send_capable: false, account_email: 'a@b.test',
    }).send_capable).toBe(false);
  });
});

describe('D-177 N.12 — send payload → execute config', () => {
  const base: ComposeMailSendPayload = {
    instance: 'work',
    to: ['bob@elsewhere.test'],
    subject: 'hello',
    body_text: 'body',
  };

  it('renames the two fields that differ between the rpc and ingredient shapes', () => {
    const config = composePayloadToSendRecipeConfig(base);
    // `instance` → `sender_mail_instance` and `body_text` → `body` +
    // `body_format`. Hand-mapping this per call site is how a field goes
    // missing on one surface and not another.
    expect(config).toEqual({
      sender_mail_instance: 'work',
      to: ['bob@elsewhere.test'],
      subject: 'hello',
      body: 'body',
      body_format: 'text',
    });
  });

  it('omits empty optionals rather than sending them empty', () => {
    const config = composePayloadToSendRecipeConfig({
      ...base, cc: [], bcc: [], attachments: [], references: [],
    });
    for (const key of ['cc', 'bcc', 'attachments', 'references']) {
      expect(Object.hasOwn(config, key), key).toBe(false);
    }
  });

  it('carries attachments through as ids', () => {
    const config = composePayloadToSendRecipeConfig({
      ...base, attachments: ['file:a', 'file:b'],
    });
    expect(config.attachments).toEqual(['file:a', 'file:b']);
  });

  it('carries threading fields when present', () => {
    const config = composePayloadToSendRecipeConfig({
      ...base, in_reply_to: '<mid@x>', references: ['<mid@x>'], cc: ['c@x.test'],
    });
    expect(config.in_reply_to).toBe('<mid@x>');
    expect(config.references).toEqual(['<mid@x>']);
    expect(config.cc).toEqual(['c@x.test']);
  });

  it('copies arrays instead of aliasing the payload', () => {
    const attachments = ['file:a'];
    const config = composePayloadToSendRecipeConfig({ ...base, attachments });
    attachments.push('file:mutated');
    // The config is durable input to a gated run — it must not change under a
    // caller that reuses its array afterwards.
    expect(config.attachments).toEqual(['file:a']);
  });

  it('names the recipe the route dispatches', () => {
    expect(SEND_COMPOSED_MAIL_RECIPE_ID).toBe('send-composed-mail');
  });
});
