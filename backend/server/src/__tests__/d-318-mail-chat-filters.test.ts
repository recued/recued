/** D-318 step 4 — which emails in the chat mailbox are requests at all: the
 *  automatic-mail signs (§4.7) and the `ask:` prefix (§4.3). */

import { describe, expect, it } from 'vitest';

import {
  automaticMailSign,
  subjectAsks,
  subjectForwards,
  subjectIsForward,
  subjectReplies,
  subjectWithoutAsk,
  withoutReplyPrefixes,
} from '../mail-chat-door/filters.js';

describe('automaticMailSign', () => {
  it.each([
    [{ 'auto-submitted': 'auto-replied' }, 'auto-submitted'],
    [{ 'auto-submitted': 'auto-generated; owner-email="x@example.test"' }, 'auto-submitted'],
    [{ 'x-autoreply': 'yes' }, 'x-autoreply'],
    [{ 'x-autorespond': '' }, 'x-autoreply'],
    [{ precedence: 'bulk' }, 'precedence'],
    [{ precedence: 'Auto_Reply' }, 'precedence'],
    [{ precedence: 'list' }, 'precedence'],
    [{ precedence: 'junk' }, 'precedence'],
    [{ 'list-id': '<team.lists.example.test>' }, 'list-id'],
    [{ 'content-type': 'multipart/report; report-type=delivery-status; boundary="b"' }, 'report'],
    [{ 'return-path': '<>' }, 'empty-return-path'],
    [{ 'return-path': '< >' }, 'empty-return-path'],
  ] as const)('declines %j as automatic (%s)', (headers, sign) => {
    expect(automaticMailSign(headers)).toBe(sign);
  });

  it('lets a person’s email through', () => {
    expect(automaticMailSign(undefined)).toBeNull();
    expect(automaticMailSign({})).toBeNull();
    expect(automaticMailSign({
      'auto-submitted': 'no',
      precedence: 'first-class',
      'content-type': 'multipart/alternative; boundary="b"',
      'return-path': '<me@owner.example>',
      // A request to suppress auto-replies is not one.
      'x-auto-response-suppress': 'All',
    })).toBeNull();
  });
});

describe('the ask: prefix', () => {
  it('reads past any reply prefix, case aside, but not past a forward’s', () => {
    expect(withoutReplyPrefixes('Re: RE: AW: Sv: ask: lunch')).toBe('ask: lunch');
    expect(withoutReplyPrefixes('Re[2]: ask: lunch')).toBe('ask: lunch');
    expect(subjectAsks('ask: lunch', 'ask:')).toBe(true);
    expect(subjectAsks('Re: ASK: lunch', 'ask:')).toBe(true);
    expect(subjectAsks('  ask:lunch', 'ask:')).toBe(true);
    expect(subjectAsks('Fwd: ask: lunch', 'ask:')).toBe(false);
    expect(subjectAsks('FW: invoice 1042', 'ask:')).toBe(false);
    expect(subjectAsks('lunch? ask: me', 'ask:')).toBe(false);
    expect(subjectAsks('chat: lunch', 'chat:')).toBe(true);
  });

  it('takes it off what was asked, and leaves a subject without it as it is', () => {
    expect(subjectWithoutAsk('Re: ask:  what is on today?', 'ask:')).toBe('what is on today?');
    expect(subjectWithoutAsk('weekly report', 'ask:')).toBe('weekly report');
    expect(subjectWithoutAsk('ask: lunch', null)).toBe('ask: lunch');
  });
});

describe('the D-318 audit — reply and forward prefixes', () => {
  it('VS: is a forward (Danish, Norwegian), never a reply that asks', () => {
    expect(withoutReplyPrefixes('VS: ask: lunch')).toBe('VS: ask: lunch');
    expect(subjectAsks('VS: ask: lunch', 'ask:')).toBe(false);
    expect(subjectForwards('VS: ask: lunch')).toBe(true);
    expect(subjectReplies('VS: lunch')).toBe(false);
  });

  it('knows a forward in the common languages, past any reply prefix — and a word that only begins so is none', () => {
    for (const prefix of ['Fwd', 'FW', 'WG', 'TR', 'RV', 'Enc', 'VS', 'Doorst', 'VB', 'Fwd[2]']) {
      expect(subjectForwards(`${prefix}: invoice`), prefix).toBe(true);
    }
    expect(subjectForwards('Re: Fwd: invoice')).toBe(true);
    for (const subject of ['invoice FW: x', 'Trip: Lisbon', 'Encore: x', 'Re: lunch', 'ask: lunch']) {
      expect(subjectForwards(subject), subject).toBe(false);
    }
  });

  it('§8.12 — the email itself is a forward: its subject begins with the prefix, or with `ask:` and then it', () => {
    for (const subject of ['Fwd: invoice', 'FW: RE: invoice', ' WG: Rechnung', 'Fwd[2]: invoice', 'Fwd: ask: lunch']) {
      expect(subjectIsForward(subject, 'ask:'), subject).toBe(true);
    }
    expect(subjectIsForward('ask: Fwd: invoice 1042', 'ask:')).toBe(true);
    expect(subjectIsForward('Ask:FW: invoice 1042', 'ask:')).toBe(true);
    // A reply answers a forward: its quoted history is the conversation's.
    for (const subject of ['Re: Fwd: invoice', 'Re: ask: Fwd: invoice', 'ask: Re: Fwd: invoice', 'ask: invoice', 'invoice FW: x']) {
      expect(subjectIsForward(subject, 'ask:'), subject).toBe(false);
    }
    // Without a prefix, only the subject's own beginning counts.
    expect(subjectIsForward('ask: Fwd: invoice', null)).toBe(false);
  });

  it('a reply prefix is a reply', () => {
    for (const subject of ['Re: lunch', 'RE[3]: lunch', 'AW: lunch', 'SV: lunch', 'Antw: lunch', 'RES: lunch']) {
      expect(subjectReplies(subject), subject).toBe(true);
    }
    expect(subjectReplies('lunch')).toBe(false);
  });
});
