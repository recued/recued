/** D-239 — kernel-adapter validation for the mail write-back four.
 *
 *  The dispatcher tests cover what happens once a well-formed call arrives.
 *  These cover the step BEFORE that, which is where a recipe-authoring slip
 *  turns into a silent wrong action rather than an error:
 *
 *   - a `read` / `flagged` that is not a boolean must be REFUSED, never
 *     coerced. `"{{step.x.unread}}"` resolving to the STRING `"false"` is
 *     truthy, so a coercing kernel would mark the message READ on a recipe
 *     that says the opposite. Nothing downstream can detect that: the
 *     dispatcher receives a valid boolean and does exactly as told.
 *   - a `mail-move` with NO destination must be refused, because an empty
 *     modify SUCCEEDS at every provider — the run reports a move that moved
 *     nothing and the recipe carries on believing the message was filed.
 */

import { describe, expect, it, vi } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const call = (slug: string, input: Record<string, unknown>): ResolvedCall => ({
  slug,
  risk_tier: slug === 'mail-delete' ? 'destructive' : 'write',
  input,
  output: {},
  manifest_version: 1,
} as ResolvedCall & { manifest_version: number });

const expectBadInput = async (fn: () => Promise<unknown>, match: RegExp) => {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(IngredientError);
    expect((err as IngredientError).code).toBe('BAD_INPUT');
    expect((err as IngredientError).message).toMatch(match);
    return;
  }
  throw new Error('expected the call to be refused');
};

describe('D-239 kernel — a non-boolean state argument is refused, not coerced', () => {
  it('mail-mark refuses the string "false" instead of marking the message read', async () => {
    const mailMark = vi.fn(async (_i: { slug: string; record_id: string; read: boolean }) => ({
      record_id: 'r', is_read: true, is_flagged: false, folder: 'INBOX',
    }));
    const adapter = createKernelAdapter({ mailMark });

    await expectBadInput(
      () => adapter(call('mail-mark', { slug: 'inbox', record_id: 'r1', read: 'false' })),
      /read must be true or false/,
    );
    // ⛔ The dispatcher must never have been reached. If it had, it would have
    // received a perfectly valid `read: true` and done the opposite of what
    // the recipe asked, with nothing anywhere to notice.
    expect(mailMark).not.toHaveBeenCalled();
  });

  it('mail-flag refuses a non-boolean the same way', async () => {
    const mailFlag = vi.fn(async (_i: { slug: string; record_id: string; flagged: boolean }) => ({
      record_id: 'r', is_read: false, is_flagged: true, folder: 'INBOX',
    }));
    const adapter = createKernelAdapter({ mailFlag });

    await expectBadInput(
      () => adapter(call('mail-flag', { slug: 'inbox', record_id: 'r1', flagged: 1 })),
      /flagged must be true or false/,
    );
    expect(mailFlag).not.toHaveBeenCalled();
  });

  it('passes a real boolean straight through', async () => {
    const mailMark = vi.fn(async (_i: { slug: string; record_id: string; read: boolean }) => ({
      record_id: 'r1', is_read: false, is_flagged: false, folder: 'INBOX',
    }));
    const adapter = createKernelAdapter({ mailMark });

    await adapter(call('mail-mark', { slug: 'inbox', record_id: 'r1', read: false }));

    expect(mailMark).toHaveBeenCalledWith({ slug: 'inbox', record_id: 'r1', read: false });
  });
});

describe('D-239 kernel — a move must name a destination', () => {
  it('refuses a move with neither a folder nor labels', async () => {
    const mailMove = vi.fn();
    const adapter = createKernelAdapter({ mailMove: mailMove as never });

    await expectBadInput(
      () => adapter(call('mail-move', { slug: 'inbox', record_id: 'r1' })),
      /name a destination/,
    );
    // An empty modify request succeeds at every provider — reaching the
    // dispatcher here would report a successful move that moved nothing.
    expect(mailMove).not.toHaveBeenCalled();
  });

  it('refuses empty label arrays, which are the same no-op in a different shape', async () => {
    const mailMove = vi.fn();
    const adapter = createKernelAdapter({ mailMove: mailMove as never });

    await expectBadInput(
      () => adapter(call('mail-move', {
        slug: 'inbox', record_id: 'r1', add_labels: [], remove_labels: [],
      })),
      /name a destination/,
    );
    expect(mailMove).not.toHaveBeenCalled();
  });

  it('forwards a folder destination', async () => {
    const mailMove = vi.fn(async () => ({
      record_id: 'r2', is_read: false, is_flagged: false, folder: 'Archive', rekeyed: true,
    }));
    const adapter = createKernelAdapter({ mailMove: mailMove as never });

    await adapter(call('mail-move', {
      slug: 'inbox', record_id: 'r1', folder: 'Archive',
    }));

    expect(mailMove).toHaveBeenCalledWith({
      slug: 'inbox', record_id: 'r1', folder: 'Archive',
    });
  });

  it('forwards a gmail label destination', async () => {
    const mailMove = vi.fn(async () => ({
      record_id: 'r1', is_read: false, is_flagged: false, folder: 'IMPORTANT', rekeyed: false,
    }));
    const adapter = createKernelAdapter({ mailMove: mailMove as never });

    // The archive gesture on Gmail: drop INBOX, keep everything else.
    await adapter(call('mail-move', {
      slug: 'inbox', record_id: 'r1', remove_labels: ['INBOX'],
    }));

    expect(mailMove).toHaveBeenCalledWith({
      slug: 'inbox', record_id: 'r1', remove_labels: ['INBOX'],
    });
  });
});

describe('D-239 kernel — the shared (slug, record_id) gate', () => {
  for (const slug of ['mail-mark', 'mail-flag', 'mail-move', 'mail-delete']) {
    it(`${slug} refuses an unresolved record_id`, async () => {
      const adapter = createKernelAdapter({
        mailMark: (async () => ({})) as never,
        mailFlag: (async () => ({})) as never,
        mailMove: (async () => ({})) as never,
        mailDelete: (async () => ({})) as never,
      });
      // The empty string is what an unresolved `{{step.x.record_id}}` leaves
      // behind. Passing it on surfaces as MAIL_RECORD_NOT_FOUND, which reads
      // as "the message was deleted" rather than "your template is wrong".
      await expectBadInput(
        () => adapter(call(slug, { slug: 'inbox', record_id: '' })),
        /record_id is required/,
      );
    });
  }

  it('reports an unwired dispatcher as unreachable, not as bad input', async () => {
    const adapter = createKernelAdapter({});
    try {
      await adapter(call('mail-delete', { slug: 'inbox', record_id: 'r1' }));
      throw new Error('expected the call to be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('SERVER_NOT_REACHABLE');
    }
  });
});
