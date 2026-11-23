import type { MailRecoveryEntry, MailRecoveryStore } from '../mail/compose-recovery.js';
import type { DraftRecoveryEntry } from './draft-recovery.js';

/** Read the existing paired-tab store. The original copy stays attached for
 * exact-content checks; only current message fields are searched. */
export const mailRecoverySearchStore = (store?: MailRecoveryStore) => {
  if (!store) return undefined;
  const project = (entry: MailRecoveryEntry): DraftRecoveryEntry => ({
    id: entry.id, revision: 1, updatedAt: entry.updatedAt, sourceId: entry.mailbox.id,
    original: entry.saved,
    status: entry.status === 'editing' ? 'editing' : entry.status === 'pending' ? 'pending' : 'unknown',
    values: { title: entry.dialog.values.subject, body: entry.dialog.values.body, description: entry.brief,
      mailbox: entry.mailbox.email, recipients: [...entry.dialog.values.to, ...entry.dialog.values.cc, ...entry.dialog.values.bcc].join(' '),
      mail: entry },
  });
  return {
    list: () => store.list().map(project),
    get: (id: string) => { const entry = store.get(id); return entry ? project(entry) : null; },
    inspect: () => { const read = store.inspect(); return { ...read, entries: read.entries.map(project) }; },
  };
};
