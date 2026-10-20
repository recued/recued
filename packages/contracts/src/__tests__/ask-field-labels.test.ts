/** How an approval names a field: in words, with the letters people write as
 *  letters. The card's rows, its "Not set" and "Empty" lists and the terms of
 *  "Allow this session" all name fields this one way. */

import { describe, expect, it } from 'vitest';

import { approvalFieldLabel, askDetailLabel, humanizeAskField } from '../ask-detail-label.js';

describe('a field name, as words', () => {
  it('writes an abbreviation as people write it', () => {
    expect(humanizeAskField('reconciliation_id')).toBe('Reconciliation ID');
    expect(humanizeAskField('bcc')).toBe('BCC');
    expect(humanizeAskField('cc')).toBe('CC');
    expect(humanizeAskField('url')).toBe('URL');
    expect(humanizeAskField('contact_ids')).toBe('Contact IDs');
    expect(humanizeAskField('oauth_client_id')).toBe('OAuth client ID');
    expect(humanizeAskField('event.calendar_id')).toBe('Event calendar ID');
  });

  it('leaves every other word as written, a plain word too', () => {
    expect(humanizeAskField('in_reply_to')).toBe('In reply to');
    expect(humanizeAskField('tax_rate')).toBe('Tax rate');
    expect(humanizeAskField('zip')).toBe('Zip');
    // Only a whole word: "idea" and "accent" are not abbreviations.
    expect(humanizeAskField('idea_notes')).toBe('Idea notes');
    expect(humanizeAskField('accent_color')).toBe('Accent color');
  });

  it('drops the metadata prefix, as before', () => {
    expect(humanizeAskField('metadata.source_url')).toBe('Source URL');
  });

  it('an approval names a known input by the owner\'s name for it', () => {
    expect(approvalFieldLabel('sender_mail_instance')).toBe('From');
    expect(approvalFieldLabel('bcc')).toBe('BCC');
    // A declared label stands as written.
    expect(askDetailLabel('E-mail address')).toBe('E-mail address');
  });
});
