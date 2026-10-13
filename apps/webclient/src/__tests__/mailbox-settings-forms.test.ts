/** A setting that names one of the owner's mailboxes or calendars: the dish
 *  form hands the shared settings form the recipe's mailbox settings and the
 *  owner's lists (`recipes/dish-form.ts`), and the lists come from the server's
 *  mail and calendar reads (`recipes/mailbox-choices.ts`). What the shared form
 *  does with them is `ui-shared`'s `mailbox-variable.test.ts`. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MailboxSetting, ServerRecipeListEntry } from '@recued/contracts';
import type { MailboxVariableCallers } from '@recued/ui-shared';

type OverlayOptions = {
  mailboxes?: { settings: ReadonlyArray<MailboxSetting>; callers: MailboxVariableCallers };
};

const captured: OverlayOptions[] = [];
vi.mock('@recued/ui-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/ui-shared')>();
  return {
    ...actual,
    wireConfigEditorOverlay: (opts: OverlayOptions) => {
      captured.push(opts);
      return { element: {} as HTMLElement, hasInFlightWork: () => false, destroy: () => undefined };
    },
  };
});

const { openDishForm } = await import('../recipes/dish-form.js');
const { createMailboxVariableCallers } = await import('../recipes/mailbox-choices.js');

const settings: MailboxSetting[] = [{ key: 'sender_mail_instance', collection: 'mail', sends: true }];

const entry = (mailbox_settings?: MailboxSetting[]): ServerRecipeListEntry => ({
  recipe_id: 'send-thank-you-email',
  publisher_id: 'recued-core',
  recipe: {
    recipe_id: 'send-thank-you-email',
    metadata: { name: 'Send a thank-you email' },
    variables: { sender_mail_instance: { label: 'Mail account slug', type: 'string', default: '' } },
  },
  ...(mailbox_settings !== undefined ? { mailbox_settings } : {}),
} as unknown as ServerRecipeListEntry);

const callers: MailboxVariableCallers = { list: async () => [] };

const open = (row: ServerRecipeListEntry, mailboxes?: MailboxVariableCallers): OverlayOptions => {
  captured.length = 0;
  openDishForm({
    document: {} as Document,
    mode: 'switch-on',
    entry: row,
    dishes: [],
    start: {},
    callers: { create: async () => ({ dish: {} as never }) },
    ...(mailboxes !== undefined ? { mailboxes } : {}),
    onClose: () => undefined,
  });
  return captured[0]!;
};

describe('the dish form', () => {
  beforeEach(() => { captured.length = 0; });

  it('hands the settings form the recipe’s mailbox settings with the owner’s lists', () => {
    const options = open(entry(settings), callers);
    expect(options.mailboxes?.settings).toEqual(settings);
    expect(options.mailboxes?.callers).toBe(callers);
  });

  it('hands it nothing for a recipe with none, from a server that says none, or with no lists', () => {
    expect(open(entry([]), callers).mailboxes).toBeUndefined();
    expect(open(entry(), callers).mailboxes).toBeUndefined();
    expect(open(entry(settings)).mailboxes).toBeUndefined();
  });
});

describe('the owner’s lists', () => {
  const lists = createMailboxVariableCallers({
    listMail: async () => ({
      instances: [
        { slug: 'work', send_capable: true, account_email: 'me@work.test' },
        { slug: 'archive', send_capable: false, account_email: '' },
      ],
    }),
    listCalendars: async () => ({ instances: [{ slug: 'family' }] }),
  });

  it('a mailbox by its name, whether it can send, and its address', async () => {
    expect(await lists.list('mail')).toEqual([
      { name: 'work', collection: 'mail', can_send: true, detail: 'me@work.test' },
      { name: 'archive', collection: 'mail', can_send: false },
    ]);
  });

  it('a calendar by its name; it never sends', async () => {
    expect(await lists.list('calendar')).toEqual([{ name: 'family', collection: 'calendar', can_send: false }]);
  });

  it('a list that cannot be read fails the read, so the form keeps the text box', async () => {
    const failing = createMailboxVariableCallers({
      listMail: async () => { throw new Error('offline'); },
      listCalendars: async () => ({ instances: [] }),
    });
    await expect(failing.list('mail')).rejects.toThrow('offline');
  });
});
