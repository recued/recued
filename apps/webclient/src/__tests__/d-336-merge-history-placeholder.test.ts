/** D-336 slice P — a contact with no address can now be merged by the owner
 *  (`contact.merge.pair`), so the merge history and its separation review meet one. Its
 *  placeholder is never shown (slice H): it reads as having no email address. */

import { describe, expect, it } from 'vitest';
import type { ContactMergeCandidate, ContactRecord } from '@recued/contracts';

import { createContactMergeRecovery, MERGE_RECOVERY_PREFIX } from '../data/contact-merge-recovery.js';

const PLACEHOLDER = 'mention-only-ct-mia@_recued.invalid';
const merged: ContactMergeCandidate = {
  id: 'cand-owner', email_a: PLACEHOLDER, email_b: 'mia@example.test', pair_key: `${PLACEHOLDER}|mia@example.test`,
  matched_fields: [], detected_at: 1, detected_by: 'owner', status: 'merged', resolved_at: 2,
};
const contact = (email: string, name?: string): ContactRecord => ({
  email, ...(name !== undefined ? { name } : {}), first_seen: 1, last_interaction: 1, interaction_count: 1, source: 'manual',
} as ContactRecord);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('D-336 slice P — the merge history never shows a placeholder', () => {
  it('lists the merge with "No email address" in its place', async () => {
    const recovery = createContactMergeRecovery({
      list: async () => ({ candidates: [merged] }),
      preview: async () => { throw new Error('not used'); },
      split: async () => { throw new Error('not used'); },
    }, () => {});
    recovery.handle(`${MERGE_RECOVERY_PREFIX}open`);
    await settle();
    const html = recovery.render();
    expect(html).toContain('<p>No email address<br>mia@example.test</p>');
    expect(html).not.toContain('_recued.invalid');
  });

  it('names a contact with no address, and gives it no address, when separating', async () => {
    const recovery = createContactMergeRecovery({
      list: async () => ({ candidates: [merged] }),
      preview: async () => ({ status: 'separate', canonicals: [contact(PLACEHOLDER, 'Mia'), contact('mia@example.test', 'Mia Whitfield')] }) as never,
      split: async () => { throw new Error('not used'); },
    }, () => {});
    recovery.handle(`${MERGE_RECOVERY_PREFIX}open`);
    await settle();
    recovery.handle(`${MERGE_RECOVERY_PREFIX}review`, 'cand-owner');
    await settle();
    const html = recovery.render();
    expect(html).toContain('>Mia</a> · No email address</li>');
    expect(html).toContain('>Mia Whitfield</a> · mia@example.test</li>');
    expect(html).not.toContain('_recued.invalid</');
  });
});
