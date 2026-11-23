import { canonicalizeEmail, isContactAnnualDate, isMailboxAddress, isMentionOnlyEmail,
  type ContactAdditionalIdentifiers, type ContactRecord, type MailingAddress } from '@recued/contracts';
import { e } from '@recued/ui-shared';

export interface ContactQuickValue { key: string; kind: 'email' | 'phone' | 'address'; value: string }
export interface ContactQuickActionState {
  copy_blocked?: boolean;
  copy?: { key: string; busy: boolean; error?: boolean; text?: string };
  download?: { error: boolean; text: string };
}

export const formatContactMailingAddress = (address: MailingAddress): string =>
  [address.address1, address.address2, address.city, address.state, address.zip, address.country]
    .map(part => (part ?? '').trim()).filter(Boolean).join(', ');

/** Resolve actions from the displayed projection, never from a losing source's
 * contribution or a value supplied in a DOM attribute. */
export const contactQuickValues = (
  contact: ContactRecord | null, identifiers?: ContactAdditionalIdentifiers, displayedEmail = contact?.email,
): ContactQuickValue[] => {
  if (!contact || contact.merged_into !== undefined) return [];
  const values: ContactQuickValue[] = [];
  const add = (key: string, kind: ContactQuickValue['kind'], raw?: string) => {
    const value = raw?.trim();
    if (value && !(kind === 'email' && isMentionOnlyEmail(value))) values.push({ key, kind, value });
  };
  add('email', 'email', displayedEmail);
  add('phone', 'phone', contact.phone);
  if (contact.mailing_address) add('address', 'address', formatContactMailingAddress(contact.mailing_address));
  identifiers?.emails.forEach((value, index) => add(`extra-email-${index}`, 'email', value));
  identifiers?.phones.forEach((value, index) => add(`extra-phone-${index}`, 'phone', value));
  return values;
};

/** Keep the saved number and explicit extension. Do not guess a country or
 * turn arbitrary URI parameters / dial codes into calls. */
export const contactPhoneHref = (value: string): string | null => {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = value.trim();
  const extension = /(?:ext\.?|x) *(\d{1,10})$/iu.exec(text);
  const base = extension ? text.slice(0, extension.index).trim() : text;
  if (!/^\+?[0-9][0-9 ().-]*$/u.test(base)) return null;
  const number = base.replace(/[ ().-]/g, '');
  const digits = number.replace(/^\+/, '');
  if (digits.length < 3 || digits.length > 15) return null;
  return `tel:${number}${extension ? `;ext=${extension[1]}` : ''}`;
};

export const renderContactValueActions = (
  value: ContactQuickValue | undefined, state: ContactQuickActionState | undefined, actionAttribute: string,
): string => {
  if (!value) return '';
  const label = value.kind === 'email' ? 'email address' : value.kind === 'phone' ? 'phone number' : 'mailing address';
  const copying = state?.copy?.busy && state.copy.key === value.key;
  const href = value.kind === 'phone' ? contactPhoneHref(value.value) : null;
  const feedback = state?.copy?.key === value.key && state.copy.text ? state.copy : null;
  return `<span class="data-contact-quick-actions">
    <button type="button" class="data-button" ${actionAttribute}="copy-contact-value" data-contact-quick-key="${e(value.key)}"
      data-contact-quick-focus="copy-${e(value.key)}" aria-label="${e(`Copy ${label}: ${value.value}`)}"${state?.copy?.busy || state?.copy_blocked ? ' aria-disabled="true"' : ''}${copying ? ' aria-busy="true"' : ''}>${copying ? 'Copying…' : 'Copy'}</button>
    ${href ? `<a class="data-button" href="${e(href)}" data-contact-quick-focus="call-${e(value.key)}" aria-label="${e(`Call ${value.value}`)}">Call</a>` : ''}
    ${feedback ? `<span class="data-contact-quick-feedback" role="${feedback.error ? 'alert' : 'status'}">${e(feedback.text!)}</span>` : ''}
  </span>`;
};

export const renderContactAdditionalIdentifiers = (
  identifiers: ContactAdditionalIdentifiers | undefined, values: readonly ContactQuickValue[],
  state: ContactQuickActionState | undefined, actionAttribute: string,
): string => {
  if (!identifiers) return '';
  const group = (kind: 'email' | 'phone', label: string, rawValues: readonly string[]) => {
    const rows = rawValues.map((raw, index) => {
      const value = raw.trim();
      if (!value || kind === 'email' && isMentionOnlyEmail(value)) return '';
      const quickValue = values.find(item => item.key === `extra-${kind}-${index}`);
      return `<div class="data-contact-identifier"><span>${e(value)}</span>${renderContactValueActions(quickValue, state, actionAttribute)}</div>`;
    }).join('');
    return rows ? `<div class="data-contact-field"><dt class="data-label">${label}</dt><dd class="data-contact-value data-contact-identifiers">${rows}</dd></div>` : '';
  };
  const groups = group('email', 'Other email addresses', identifiers.emails) + group('phone', 'Other phone numbers', identifiers.phones);
  return groups ? `<section aria-label="Additional contact details"><dl class="data-contact-fields">${groups}</dl></section>` : '';
};

const escapeVCardText = (value: string): string => value
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  .replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&');

/** RFC 6350 sections 3.2/3.4: fold at 75 UTF-8 octets, between code points,
 * after escaping. A continuation space counts toward the next line's limit.
 * https://www.rfc-editor.org/rfc/rfc6350.html */
const foldVCardLine = (value: string): string => {
  const lines: string[] = [];
  let line = '', bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > 75) { lines.push(line); line = ' '; bytes = 1; }
    line += char; bytes += size;
  }
  lines.push(line);
  return lines.join('\r\n');
};

export const createContactVCard = (contact: ContactRecord, identifiers?: ContactAdditionalIdentifiers): {
  content: string; filename: string; mime_type: string;
} => {
  if (contact.merged_into !== undefined) throw new Error('Open the contact this record was merged into to download it.');
  const values = contactQuickValues(contact, identifiers);
  const distinct = (kind: ContactQuickValue['kind'], key: (value: string) => string) => {
    const seen = new Set<string>();
    return values.filter(value => value.kind === kind).map(value => value.value).filter(value => {
      const normalized = key(value);
      if (seen.has(normalized)) return false;
      seen.add(normalized); return true;
    });
  };
  const emails = distinct('email', canonicalizeEmail).filter(value => isMailboxAddress(canonicalizeEmail(value)));
  const phones = distinct('phone', value => contactPhoneHref(value) ?? value);
  const name = contact.name?.trim() || emails[0] || phones[0] || 'Contact';
  // One display name is preserved as FN without guessing at family/given names.
  // vCard 4 also preserves annual dates whose year is unknown.
  const lines = ['BEGIN:VCARD', 'VERSION:4.0', `FN:${escapeVCardText(name)}`];
  emails.forEach((value, index) => lines.push(`EMAIL${index === 0 ? ';PREF=1' : ''}:${escapeVCardText(value)}`));
  phones.forEach((value, index) => lines.push(`TEL;VALUE=text${index === 0 ? ';PREF=1' : ''}:${escapeVCardText(value)}`));
  if (contact.mailing_address && values.some(value => value.kind === 'address')) {
    const address = contact.mailing_address;
    lines.push('ADR:' + ['', address.address2, address.address1, address.city, address.state, address.zip, address.country]
      .map(part => escapeVCardText((part ?? '').trim())).join(';'));
  }
  if (contact.company?.trim()) lines.push(`ORG:${escapeVCardText(contact.company.trim())}`);
  if (contact.title?.trim()) lines.push(`TITLE:${escapeVCardText(contact.title.trim())}`);
  for (const [key, raw] of [['BDAY', contact.birthday], ['ANNIVERSARY', contact.anniversary]] as const) {
    const value = raw?.trim();
    if (!value) continue;
    const date = isContactAnnualDate(value) ? value.startsWith('--') ? '--' + value.slice(2).replace(/-/g, '') : value.replace(/-/g, '') : null;
    lines.push(date ? `${key}:${date}` : `${key};VALUE=text:${escapeVCardText(value)}`);
  }
  lines.push('END:VCARD');
  const safeName = Array.from(name.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .slice(0, 60).join('').replace(/[. ]+$/u, '');
  return { content: lines.map(foldVCardLine).join('\r\n') + '\r\n',
    filename: safeName ? `contact-${safeName}.vcf` : 'contact.vcf', mime_type: 'text/vcard;charset=utf-8' };
};

export { copyText as copyContactText } from '../shell/copy-text.js';

export const downloadContactVCard = (doc: Document, file: ReturnType<typeof createContactVCard>): void => {
  const view = doc.defaultView;
  if (!view || typeof view.URL?.createObjectURL !== 'function') throw new Error('Downloads are unavailable.');
  const url = view.URL.createObjectURL(new view.Blob([file.content], { type: file.mime_type }));
  const link = doc.createElement('a');
  try {
    link.href = url; link.download = file.filename; link.hidden = true;
    doc.body.append(link); link.click();
  } finally {
    link.remove();
    view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
  }
};

export const CONTACT_QUICK_ACTION_STYLES = `
.data-contact-quick-actions { display:inline-flex; flex-wrap:wrap; align-items:center; gap:6px; vertical-align:middle; }
.data-contact-quick-actions .data-button { min-height:44px; padding:6px 10px; font-size:12px; text-decoration:none; }
.data-contact-quick-actions [aria-disabled="true"] { opacity:.65; cursor:default; }
.data-contact-quick-feedback { font-size:12px; color:var(--fg-muted); }
.data-contact-quick-feedback[role="alert"] { color:var(--danger,var(--fg)); }
.data-contact-identifier { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; font-size:14px; overflow-wrap:anywhere; }
.data-contact-value.data-contact-identifiers { display:grid; gap:8px; margin:0; }
.data-contact-primary-email { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; }
.data-contact-more summary { cursor:pointer; }
.data-contact-more[open] { display:grid; gap:8px; }
`;
