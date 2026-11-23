/** D-406 — the emails picked for a chat message: read back from a stored message (malformed dropped), and
 *  taken from `chat.send` (malformed or too many refused, never dropped). */
import { describe, expect, it } from 'vitest';

import { CHAT_MAIL_REFS_MAX, chatMailRefInputsOf, chatMailRefsOf } from '../chat-mail-refs.js';

describe('the picked emails a stored message holds', () => {
  it('each well-formed one once, in order, with its sender, subject and date', () => {
    expect(chatMailRefsOf([
      { slug: 'gmail', record_id: 'm1', from: '  Anna Keller <anna@example.com> ', subject: 'Lease renewal', received_at: 1_700_000_000_000 },
      { slug: 'gmail', record_id: 'm1', subject: 'again' },
      { slug: 'work', record_id: 'm2' },
    ])).toEqual([
      { slug: 'gmail', record_id: 'm1', from: 'Anna Keller <anna@example.com>', subject: 'Lease renewal', received_at: 1_700_000_000_000 },
      { slug: 'work', record_id: 'm2' },
    ]);
  });

  it('⛔ drops what is not one, and reads at most the cap', () => {
    expect(chatMailRefsOf([{ slug: '', record_id: 'm1' }, { slug: 'gmail' }, 'm1', null, { slug: 'gmail', record_id: 'm1', received_at: -1 }]))
      .toEqual([{ slug: 'gmail', record_id: 'm1' }]);
    const many = Array.from({ length: CHAT_MAIL_REFS_MAX + 2 }, (_, i) => ({ slug: 'gmail', record_id: `m${String(i)}` }));
    expect(chatMailRefsOf(many)).toHaveLength(CHAT_MAIL_REFS_MAX);
    expect(chatMailRefsOf('not a list')).toEqual([]);
    expect(chatMailRefsOf([{ slug: 'gmail', record_id: 'm1', subject: 'x'.repeat(2_000) }])[0]!.subject).toHaveLength(1_024);
  });
});

describe('the picked emails chat.send takes', () => {
  it('none, or each once', () => {
    expect(chatMailRefInputsOf(undefined)).toEqual({ refs: [] });
    expect(chatMailRefInputsOf([{ slug: 'gmail', record_id: 'm1' }, { slug: 'gmail', record_id: 'm1' }, { slug: 'gmail', record_id: 'm2', subject: 'ignored' }]))
      .toEqual({ refs: [{ slug: 'gmail', record_id: 'm1' }, { slug: 'gmail', record_id: 'm2' }] });
  });

  it('⛔ refuses, never drops: a malformed one, a list that is not one, more than the cap', () => {
    expect(chatMailRefInputsOf([{ slug: 'gmail', record_id: 'm1' }, { slug: 'gmail' }])).toEqual({ error: 'A picked email is not one. Pick it again.' });
    expect(chatMailRefInputsOf({ slug: 'gmail', record_id: 'm1' })).toEqual({ error: 'The picked emails must be a list.' });
    const tooMany = Array.from({ length: CHAT_MAIL_REFS_MAX + 1 }, (_, i) => ({ slug: 'gmail', record_id: `m${String(i)}` }));
    expect(chatMailRefInputsOf(tooMany)).toEqual({ error: `Pick at most ${String(CHAT_MAIL_REFS_MAX)} emails for one message.` });
  });
});
