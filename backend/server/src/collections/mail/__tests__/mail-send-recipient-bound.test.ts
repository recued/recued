/** Every mail send refuses a recipient no parser should see, before the
 *  provider, the self-send guard or the audit row reads it. Notification
 *  connections, booking notices and the email chat door reach `send` without
 *  `normalizeMailSend`, so the collection checks the bound itself
 *  (`MAIL_RECIPIENT_MAX_LENGTH`). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { MAIL_RECIPIENT_MAX_LENGTH } from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBlobStore } from '../../../storage/blob-store.js';
import { createMailCollection } from '../mail-collection.js';
import type { OutgoingMessage } from '../provider.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const collection = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-recipient-bound-'));
  dirs.push(dir);
  const send = vi.fn(async (_msg: OutgoingMessage) => ({ source_id: 'g1', message_id: 'g1', sent_at: 1, thread_id: 't' }));
  const mail = createMailCollection({
    db: new Database(':memory:'),
    blobs: createBlobStore(dir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'work',
    provider: {
      kind: 'gmail', sendCapable: true, accountEmail: 'me@example.com', send,
      initialScan: async () => {}, poll: async () => {}, stop: async () => {},
    } as never,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }) as never,
  });
  return { mail, send };
};

const message = { to: ['ann@example.com'], subject: 'Hello', body_text: 'Hi.' };

const refusalOf = async (run: Promise<unknown>): Promise<IngredientError> => {
  const outcome = await run.then(() => null, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(IngredientError);
  return outcome as IngredientError;
};

describe('the mail collection’s recipient bound', () => {
  it('refuses an over-long or line-broken recipient in any field, before the provider sees it', async () => {
    const { mail, send } = collection();
    const long = 'x'.repeat(MAIL_RECIPIENT_MAX_LENGTH + 1);
    const cases: Array<[Partial<typeof message> & { cc?: string[]; bcc?: string[]; reply_to?: string }, string]> = [
      [{ to: ['ann@example.com', long] }, 'to[1]'],
      [{ cc: [long] }, 'cc[0]'],
      [{ bcc: ['bob@example.com\r\nBcc: eve@example.com'] }, 'bcc[0]'],
      [{ reply_to: long }, 'reply_to'],
    ];
    for (const [over, where] of cases) {
      const refused = await refusalOf(mail.send({ ...message, ...over }));
      expect(refused.code).toBe('BAD_INPUT');
      expect(refused.message).toContain(`mail-send: ${where} `);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('⛔ answers before the self-send guard parses the recipient', async () => {
    // `extractAddress` takes quadratic time over a run of `<`. The answer is
    // the bound's, so the guard never read the string.
    const { mail, send } = collection();
    const refused = await refusalOf(mail.send({ ...message, to: ['<'.repeat(300_000)] }));
    expect(refused.message).toBe(`mail-send: to[0] is longer than ${MAIL_RECIPIENT_MAX_LENGTH} characters`);
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves the address shape to the input contract: a short list still reaches the provider', async () => {
    // A notification connection's `default_recipient` comes here without
    // `normalizeMailSend`; refusing a list at this layer would break a send
    // that works today.
    const { mail, send } = collection();
    await mail.send({ ...message, to: ['ann@example.com, bob@example.com'] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].to).toEqual(['ann@example.com, bob@example.com']);
  });
});
