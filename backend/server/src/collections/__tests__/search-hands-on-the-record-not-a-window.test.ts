import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createMailCollection } from '../mail/mail-collection.js';
import { createBlobStore } from '../../storage/blob-store.js';

/** ⛔⛔ A SNIPPET IS A RELEVANCE PREVIEW AND IT WAS BEING READ AS CONTENT.
 *
 *  `snippet()` returns N tokens centred on the match terms, so a row can be
 *  retrieved PERFECTLY and still hand on a fragment that stops before the fact
 *  the question needs. Measured on bench 276 — a seven-message negotiation
 *  whose unit price is DERIVED, never stated — the right mail was reached
 *  11/11 and the answer was right 0/11, with SEVEN DISTINCT wrong totals,
 *  because the pivotal snippet cut at `"At that volume I can…"`, one token
 *  before the two discount rates. The control rules out the model: those same
 *  messages rendered whole into one api call answered 9-11/11 correct.
 *
 *  🔑 THE ASSERTION HERE IS THE COMPOSITION, NOT TWO SHAPES. Checking "the body
 *  is present" would pass against a body that merely repeats the snippet, and
 *  checking "the snippet is short" proves nothing on its own. What has to hold
 *  is the JOIN: the window CUTS the fact, and the row still CARRIES it. Assert
 *  them apart and both halves can be green while the model still cannot answer.
 *
 *  ⚠ Search is the only content surface for mail — there is no `mail.read` to
 *  recover a body with — so what search omits is gone for the whole turn. */
describe('collection search hands on the record, not a window over it', () => {
  const world = () => {
    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'body-'));
    const mail = createMailCollection({
      db, blobs: createBlobStore(dir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(), slug: 'inbox',
      provider: { start: async () => {}, stop: async () => {} } as never,
      config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
    });
    return mail;
  };

  // The shape that failed: the query terms sit at the FRONT, the numbers the
  // question needs sit past the 15-token window.
  const SUBJECT = 'Kestrel item A pricing';
  const BODY =
    'A committed 400 works for Kestrel. At that volume I can take 6% off the '
    + 'price you originally asked for, and I can add 3% early settlement if you '
    + 'pay within 10 days of invoice.';

  const seed = (mail: ReturnType<typeof world>): void => {
    mail.upsert({
      record_id: 'm3',
      hot_fields: { subject: SUBJECT, from: 'sales@kestrel.test', to: ['me@e.com'], cc: [], thread_id: 't1' },
      received_at: 1_788_000_000_000, modified_at: 1_788_000_000_000,
      body_inline: BODY, size_bytes: BODY.length, source_id: 'inbox',
    } as never);
  };

  it('hands back the whole record, including the part a window would have cut', () => {
    const mail = world();
    seed(mail);
    const [hit] = mail.search({ platform: 'mail', slug: 'inbox', query: 'Kestrel item A pricing', limit: 5 } as never);
    expect(hit).toBeDefined();

    // ⛔ THE STRONGEST FORM, AND DELIBERATELY NOT `toContain`. Every query term
    // sits in the SUBJECT and the first clause; the rates sit at the far end.
    // A window centred on the match satisfies `toContain('committed 400')` and
    // still fails the user — asserting EQUALITY with the stored text is what
    // rules out "a window that happens to be wide enough today".
    expect(hit.body).toBe(BODY);
    expect(hit.body_truncated).toBeUndefined();

    // Named explicitly because these two are what bench 276 could not reach:
    // reached the right mail 11/11, answered 0/11, seven distinct wrong totals.
    expect(hit.body).toContain('6% off the price you originally asked for');
    expect(hit.body).toContain('3% early settlement');

    // And the retired field is really gone, not merely unread — a consumer that
    // still finds a `snippet` here would keep computing from a preview.
    expect((hit as unknown as Record<string, unknown>).snippet).toBeUndefined();
  });

  it('marks a body it had to cut, so a fragment is never read as the whole record', () => {
    const mail = world();
    const long = `${'filler word '.repeat(400)}THE-TAIL-FACT`;
    mail.upsert({
      record_id: 'long',
      hot_fields: { subject: 'filler', from: 'a@e.com', to: ['me@e.com'], cc: [], thread_id: 't2' },
      received_at: 1_788_000_000_000, modified_at: 1_788_000_000_000,
      body_inline: long, size_bytes: long.length, source_id: 'inbox',
    } as never);
    const [hit] = mail.search({ platform: 'mail', slug: 'inbox', query: 'filler', limit: 5 } as never);
    expect(hit.body_truncated).toBe(true);
    // The cut is real — the tail is genuinely absent, which is exactly why the
    // flag has to be there rather than the row looking complete.
    expect(hit.body).not.toContain('THE-TAIL-FACT');
  });
});
