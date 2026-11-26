import { canonicalizeEmail, parseAddress } from './contact.js';
import { mailRecipientInvalidReason } from './mail.js';

/** One chosen responder and the reviewed To/Cc participant set, excluding self. */
export interface MailFollowUpWaitingFor { address: string; recipients: string[] }
const email = (value: unknown): string => typeof value === 'string' && mailRecipientInvalidReason(value) === null
  ? canonicalizeEmail(parseAddress(value)?.email ?? '') : '';
export const mailFollowUpRecipients = (to: readonly string[], cc: readonly string[], account: string): string[] =>
  [...new Set([...to, ...cc].map(email).filter(value => value && value !== email(account)))].sort();
export const readMailFollowUpWaitingFor = (raw: unknown): MailFollowUpWaitingFor | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>, address = email(value.address);
  if (Object.keys(value).some(key => !['address', 'recipients'].includes(key)) || !address
    || !Array.isArray(value.recipients) || !value.recipients.length || value.recipients.length > 20
    || value.recipients.some(item => !email(item))) return null;
  const recipients = [...new Set(value.recipients.map(email))].sort();
  return recipients.includes(address) ? { address, recipients } : null;
};
export const mailFollowUpWaitingForMatches = (choice: MailFollowUpWaitingFor, recipients: readonly string[]): boolean =>
  recipients.includes(choice.address) && JSON.stringify(choice.recipients) === JSON.stringify([...new Set(recipients)].sort());
