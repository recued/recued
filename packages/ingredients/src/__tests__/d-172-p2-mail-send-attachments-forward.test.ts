/** D-172 P2 (Attachments-v2) — kernel mail-send forwards attachment refs.
 *
 *  Before D-172 the kernel `mail-send` slot HARD-THREW
 *  `MAIL_SEND_ATTACHMENTS_NOT_YET_IMPLEMENTED` on any non-null
 *  `input.attachments`. P2 removes that block: the kernel now coerces
 *  the `data.file` record-id refs to a string[] and FORWARDS them into
 *  the `mailSend` dispatcher input (resolution to bytes happens at the
 *  backend `MailCollection.send` layer, which has the file-read deps).
 *
 *  These tests pin the forwarding contract at the kernel boundary:
 *    - attachments present → forwarded verbatim (no throw).
 *    - attachments absent / null → field omitted (legacy shape unchanged).
 *    - empty array → field omitted.
 *    - non-string entries → BAD_INPUT (coerceStringArray guard).
 */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError, type ResolvedCall } from '../types.js';

type MailSendInput = Parameters<NonNullable<Parameters<typeof createKernelAdapter>[0]['mailSend']>>[0];

const okMeta = {
  source_id: 'sid',
  message_id: '<mid@example.com>',
  sent_at: 1_700_000_000_000,
  _id: null as string | null,
  _collection: 'data.mail' as const,
};

const mkCall = (input: Record<string, unknown>): ResolvedCall => ({
  slug: 'mail-send',
  risk_tier: 'write',
  input: { sender_mail_instance: 'work', to: ['ada@example.com'], subject: 'Hi', body: 'Body', ...input },
  output: {},
  manifest_version: 1,
} as ResolvedCall & { manifest_version: number });

const captureAdapter = () => {
  const calls: MailSendInput[] = [];
  const adapter = createKernelAdapter({
    mailSend: async (input) => { calls.push(input); return okMeta; },
  });
  return { adapter, calls };
};

describe('D-172 P2 — kernel mail-send forwards attachments (was: throw)', () => {
  it('forwards data.file refs into the dispatcher input verbatim (no throw)', async () => {
    const { adapter, calls } = captureAdapter();
    const refs = ['file:aaaa', 'file:bbbb'];
    await adapter(mkCall({ attachments: refs }));
    expect(calls).toHaveLength(1);
    expect(calls[0].attachments).toEqual(refs);
  });

  it('no longer throws MAIL_SEND_ATTACHMENTS_NOT_YET_IMPLEMENTED for non-null attachments', async () => {
    const { adapter } = captureAdapter();
    // Previously this rejected; now it resolves.
    await expect(adapter(mkCall({ attachments: ['file:cccc'] }))).resolves.toMatchObject({
      _collection: 'data.mail',
    });
  });

  it('omits attachments when absent (legacy shape unchanged)', async () => {
    const { adapter, calls } = captureAdapter();
    await adapter(mkCall({}));
    expect('attachments' in calls[0]).toBe(false);
  });

  it('omits attachments when null', async () => {
    const { adapter, calls } = captureAdapter();
    await adapter(mkCall({ attachments: null }));
    expect(calls[0].attachments).toBeUndefined();
  });

  it('omits attachments when an empty array is supplied', async () => {
    const { adapter, calls } = captureAdapter();
    await adapter(mkCall({ attachments: [] }));
    expect(calls[0].attachments).toBeUndefined();
  });

  it('rejects non-string attachment entries with BAD_INPUT', async () => {
    const { adapter } = captureAdapter();
    try {
      await adapter(mkCall({ attachments: [123, {}] }));
      expect.fail('expected BAD_INPUT');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('BAD_INPUT');
    }
  });

  it('forwards a bounded reconciliation identity and rejects header injection', async () => {
    const { adapter, calls } = captureAdapter();
    const reconciliationId = `d200-${'a'.repeat(64)}`;
    await adapter(mkCall({ reconciliation_id: reconciliationId }));
    expect(calls[0].reconciliation_id).toBe(reconciliationId);

    await expect(adapter(mkCall({
      reconciliation_id: 'safe\r\nBcc: attacker@example.test',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(calls).toHaveLength(1);
  });
});
