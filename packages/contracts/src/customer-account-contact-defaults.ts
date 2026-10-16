import type { CustomerAccountInput } from './customer-account-statements.js';

/** Owner preferences for new account email forms, never send authority. */
export interface CustomerAccountContactDefaults {
  contact_name?: string;recipient_email?: string;sender_mail_instance?: string;
}
export interface CustomerAccountContactDefaultsRecord extends CustomerAccountInput {
  format: 'recued.customer-account-contact-defaults';version: 1;
  /** Independent of financial account membership and statement revisions. */
  revision: number;updated_at: number | null;contact: CustomerAccountContactDefaults;
}
/** The supplied fields replace the defaults. An empty contact clears them. */
export interface CustomerAccountContactDefaultsSetInput extends CustomerAccountInput {
  expected_revision: number;contact: CustomerAccountContactDefaults;
}
export const parseCustomerAccountContactDefaults = (value: unknown): CustomerAccountContactDefaults => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['contact_name','recipient_email','sender_mail_instance'].includes(key))) {
    throw new TypeError('Choose only a contact name, one email address and a Mail account.');
  }
  const result: CustomerAccountContactDefaults = {};
  if ('contact_name' in value) {
    if (typeof value.contact_name !== 'string' || !value.contact_name.trim() || value.contact_name.trim().length > 200
      || /[\x00-\x1f\x7f]/.test(value.contact_name)) throw new TypeError('Enter a contact name of up to 200 characters on one line.');
    result.contact_name = value.contact_name.trim();
  }
  if ('recipient_email' in value) {
    if (typeof value.recipient_email !== 'string' || value.recipient_email.trim().length > 254
      || /[\x00-\x1f\x7f]/.test(value.recipient_email)
      || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value.recipient_email.trim())) throw new TypeError('Enter one customer email address.');
    result.recipient_email = value.recipient_email.trim();
  }
  if ('sender_mail_instance' in value) {
    if (typeof value.sender_mail_instance !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.sender_mail_instance.trim())) {
      throw new TypeError('Choose a Mail account, or clear its default.');
    }
    result.sender_mail_instance = value.sender_mail_instance.trim();
  }
  return result;
};
