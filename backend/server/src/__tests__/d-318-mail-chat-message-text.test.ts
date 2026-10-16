/** D-318 step 4, part 2 — the owner's own lines of an email request (§4.4):
 *  quoted history, signatures and mail-app footers left out, and mail that is
 *  not the owner's words reported, so it reaches the model as mail. The shapes
 *  are the ones mail apps write. */

import { describe, expect, it } from 'vitest';

import { mailChatOwnLines } from '../mail-chat-door/message-text.js';

const continuing = { continuing: true } as const;
const starting = { continuing: false } as const;

describe('quoted history', () => {
  const gmailReply = [
    'Sounds good, book it.',
    '',
    'On Tue, Oct 14, 2026 at 9:00 AM Recued <recued@chat.example> wrote:',
    '> The table is free at 7.',
    '> Shall I book it?',
  ].join('\n');

  it('drops a Gmail or Apple Mail quote in a conversation that continues — chat has it', () => {
    expect(mailChatOwnLines(gmailReply, continuing)).toEqual({ text: 'Sounds good, book it.', mail_cut: false });
    expect(mailChatOwnLines([
      'Yes please.',
      '',
      'On Oct 14, 2026, at 09:00, Recued <recued@chat.example> wrote:',
      '',
      '> Shall I book it?',
    ].join('\n'), continuing)).toEqual({ text: 'Yes please.', mail_cut: false });
  });

  it('reports the quote as mail when the email starts a conversation — it is someone’s email', () => {
    expect(mailChatOwnLines(gmailReply, starting)).toEqual({ text: 'Sounds good, book it.', mail_cut: true });
  });

  it('reads an attribution line a mail app wrapped in two', () => {
    expect(mailChatOwnLines([
      'Fine.',
      'On Tue, Oct 14, 2026 at 9:00 AM Ann Smith <',
      'ann@example.com> wrote:',
      '> hello',
    ].join('\n'), continuing).text).toBe('Fine.');
  });

  it('keeps the owner’s lines between quoted ones', () => {
    expect(mailChatOwnLines([
      'On Tue, Oct 14, 2026 at 9:00 AM Recued <recued@chat.example> wrote:',
      '> Which day?',
      'Thursday.',
      '> What time?',
      'Noon.',
    ].join('\n'), continuing).text).toBe('Thursday.\nNoon.');
  });

  it('cuts at an Outlook header block, and at Outlook on the web’s rule', () => {
    expect(mailChatOwnLines([
      'Please move it to Friday.',
      '',
      'From: Client <client@example.test>',
      'Sent: Tuesday, October 14, 2026 9:00 AM',
      'To: Me <me@owner.example>',
      'Subject: Meeting',
      '',
      'Can we move the meeting? Call me on +1 555 0100.',
    ].join('\n'), starting)).toEqual({ text: 'Please move it to Friday.', mail_cut: true });
    expect(mailChatOwnLines([
      'ok',
      '',
      '________________________________',
      'From: Recued <recued@chat.example>',
      'Sent: Tuesday, October 14, 2026 9:00 AM',
      'Subject: Re: ask: lunch',
      '',
      'Booked.',
    ].join('\n'), continuing)).toEqual({ text: 'ok', mail_cut: false });
  });

  it('keeps an own line that only looks like a quote', () => {
    expect(mailChatOwnLines('On reflection, I wrote:\nlet us keep Friday.', starting).text)
      .toBe('On reflection, I wrote:\nlet us keep Friday.');
    expect(mailChatOwnLines('From: my manager, a request.\nPlease file the report.', starting).text)
      .toBe('From: my manager, a request.\nPlease file the report.');
  });
});

describe('forwarded mail', () => {
  it('is mail even in a conversation that continues — Gmail, Apple Mail, Thunderbird', () => {
    for (const marker of [
      '---------- Forwarded message ---------',
      'Begin forwarded message:',
      '-------- Forwarded Message --------',
    ]) {
      expect(mailChatOwnLines([
        'What do you make of this?',
        '',
        marker,
        'From: Supplier <billing@supplier.example>',
        'Date: Tue, Oct 14, 2026',
        '',
        'Invoice 1042 is due. Our bank: IBAN DE00 1234.',
      ].join('\n'), continuing)).toEqual({ text: 'What do you make of this?', mail_cut: true });
    }
  });

  it('leaves no words of the owner when they wrote none', () => {
    expect(mailChatOwnLines('---------- Forwarded message ---------\nFrom: x <x@example.test>\n\nHi', starting))
      .toEqual({ text: '', mail_cut: true });
  });
});

describe('signatures and footers', () => {
  it('cuts from the signature separator, with or without its space', () => {
    expect(mailChatOwnLines('Book it.\n\n-- \nAnn Smith\n+1 555 0100\n12 Main St', starting).text).toBe('Book it.');
    expect(mailChatOwnLines('Book it.\n--\nAnn Smith\n+1 555 0100', starting).text).toBe('Book it.');
  });

  it('drops a mail app’s footer and the blank lines around it', () => {
    for (const footer of ['Sent from my iPhone', 'Get Outlook for iOS', 'Sent from Mail for Windows',
      'Von meinem iPhone gesendet', 'Envoyé de mon iPhone', 'Sent with Proton Mail secure email.']) {
      expect(mailChatOwnLines(`Book it.\n\n${footer}\n`, starting)).toEqual({ text: 'Book it.', mail_cut: false });
    }
  });

  it('a signature above a quote: both go', () => {
    expect(mailChatOwnLines([
      'ok',
      '-- ',
      'Ann',
      '',
      'On Tue, Oct 14, 2026 at 9:00 AM Recued <recued@chat.example> wrote:',
      '> Booked.',
    ].join('\n'), continuing)).toEqual({ text: 'ok', mail_cut: false });
  });

  it('an empty body is empty', () => {
    expect(mailChatOwnLines('', starting)).toEqual({ text: '', mail_cut: false });
    expect(mailChatOwnLines('\r\n\r\n', starting)).toEqual({ text: '', mail_cut: false });
  });
});

describe('the D-318 audit', () => {
  it('a From: line and a To: line are the owner’s own words — a header block has a dated Sent line', () => {
    const transfer = 'Move 500 between my accounts.\nFrom: savings\nTo: checking\nThanks.';
    expect(mailChatOwnLines(transfer, starting)).toEqual({ text: transfer, mail_cut: false });
    // A Sent line without a date is not one either.
    expect(mailChatOwnLines('From: Ann\nSent: the report\nPlease check it.', starting).text)
      .toBe('From: Ann\nSent: the report\nPlease check it.');
    // A German Outlook's block is one.
    expect(mailChatOwnLines([
      'Bitte verschieben.',
      'Von: Kunde <kunde@example.test>',
      'Gesendet: Dienstag, 14. Oktober 2026 09:00',
      'An: Ich <me@owner.example>',
      '',
      'Altes.',
    ].join('\n'), starting)).toEqual({ text: 'Bitte verschieben.', mail_cut: true });
  });

  it('reads an attribution that names the sender after the verb, as German, Dutch and Swedish write it', () => {
    for (const attribution of [
      'Am Di., 14. Okt. 2026 um 09:00 Uhr schrieb Max Muster <max@example.test>:',
      'Op di 14 okt. 2026 om 09:00 schreef Max Muster <max@example.test>:',
      'Den tis 14 okt. 2026 kl 09:00 skrev Max Muster <max@example.test>:',
    ]) {
      expect(mailChatOwnLines(`Ja, bitte.\n\n${attribution}\n> Soll ich buchen?`, continuing), attribution)
        .toEqual({ text: 'Ja, bitte.', mail_cut: false });
    }
  });

  it('what a forward carries below a header block is mail, even in a conversation (Outlook forwards with one)', () => {
    const forward = [
      'Can you handle this?',
      '',
      'From: Supplier <billing@supplier.example>',
      'Sent: Tuesday, October 14, 2026 9:00 AM',
      'Subject: Invoice 1042',
      '',
      'Our bank: IBAN DE00 1234.',
    ].join('\n');
    expect(mailChatOwnLines(forward, { continuing: true, forwarded: true }))
      .toEqual({ text: 'Can you handle this?', mail_cut: true });
    // Without the forward, quoted in a conversation, it is the conversation.
    expect(mailChatOwnLines(forward, continuing)).toEqual({ text: 'Can you handle this?', mail_cut: false });
  });
});

describe('§8.12 — a forward’s quoted lines, and a forward whose mail is not found', () => {
  it('a forward’s `>`-quoted lines are mail even in a conversation: they are what it forwards', () => {
    const quotedForward = ['FYI', '', '> Invoice 1042 is due.', '> Our bank: IBAN DE00 1234.'].join('\n');
    expect(mailChatOwnLines(quotedForward, { continuing: true, forwarded: true })).toEqual({ text: 'FYI', mail_cut: true });
    expect(mailChatOwnLines(quotedForward, continuing)).toEqual({ text: 'FYI', mail_cut: false });
  });

  it('in a forward, `mail_cut` says whether the forwarded mail was found at all', () => {
    // A mail app that marks its forward no way the door reads: nothing is found,
    // and the turn gives none of it as the owner's (`turns.ts`).
    expect(mailChatOwnLines('FYI\n\nInvoice 1042 is due. Our bank: IBAN DE00 1234.', { continuing: false, forwarded: true }))
      .toEqual({ text: 'FYI\n\nInvoice 1042 is due. Our bank: IBAN DE00 1234.', mail_cut: false });
  });
});
