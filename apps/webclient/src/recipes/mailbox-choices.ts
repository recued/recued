/** The owner's mailboxes and calendars as a setting that names one offers them
 *  (`mailbox-variable.ts`): each by the name it has under Connections, a
 *  mailbox with its address and whether it can send now. */

import type { MailboxChoice, MailboxVariableCallers } from '@recued/ui-shared';

export interface MailboxChoiceDeps {
  /** `collection.mail.list`. */
  readonly listMail: () => Promise<{
    instances: ReadonlyArray<{ slug: string; send_capable: boolean; account_email?: string }>;
  }>;
  /** `collection.calendar.list`. */
  readonly listCalendars: () => Promise<{ instances: ReadonlyArray<{ slug: string }> }>;
}

export const createMailboxVariableCallers = (deps: MailboxChoiceDeps): MailboxVariableCallers => ({
  list: async (collection) => {
    if (collection === 'calendar') {
      const { instances } = await deps.listCalendars();
      return instances.map((row): MailboxChoice => ({ name: row.slug, collection: 'calendar', can_send: false }));
    }
    const { instances } = await deps.listMail();
    return instances.map((row): MailboxChoice => ({
      name: row.slug,
      collection: 'mail',
      can_send: row.send_capable,
      ...(typeof row.account_email === 'string' && row.account_email !== '' ? { detail: row.account_email } : {}),
    }));
  },
});
