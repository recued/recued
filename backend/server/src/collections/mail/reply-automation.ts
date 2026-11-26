/** A header observation, not a claim that an unmarked message was written by a
 * human. Missing, ambiguous and malformed evidence requires owner review.
 * Auto-Submitted semantics: https://www.rfc-editor.org/rfc/rfc3834#section-5 */
export type MailReplyAutomation = 'automatic' | 'unmarked' | 'unknown';
const relevant = new Set(['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'list-id', 'content-type', 'return-path']);
export const classifyReplyAutomation = (entries: Iterable<readonly [string, string]> | undefined): MailReplyAutomation => {
  if (!entries) return 'unknown';
  const values = new Map<string, string>(); let count = 0;
  for (const [name, raw] of entries) {
    if (++count > 4096) return 'unknown';
    const key = name.trim().toLowerCase(); if (!relevant.has(key)) continue;
    const value = raw.replace(/\r?\n[ \t]+/g, ' ').trim();
    if (values.has(key) || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return 'unknown';
    values.set(key, value);
  }
  // Delivery reports, list traffic and null-return-path messages need review;
  // they must not quietly look like either a personal reply or a vacation notice.
  if (values.get('content-type')?.toLowerCase().startsWith('multipart/report')
    || values.has('list-id') || /^<\s*>$/.test(values.get('return-path') ?? '')
    || /^(bulk|list|junk)$/i.test(values.get('precedence') ?? '')) return 'unknown';
  const submitted = values.get('auto-submitted')?.split(';')[0]?.trim().toLowerCase();
  if (submitted !== undefined) {
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(submitted)) return 'unknown';
    if (submitted !== 'no') return 'automatic';
  }
  for (const key of ['x-autoreply', 'x-autorespond']) if (values.has(key)) {
    const value = values.get(key)!;
    return value && !/^(no|false|0)$/i.test(value) ? 'automatic' : 'unknown';
  }
  return /^auto_reply$/i.test(values.get('precedence') ?? '') ? 'automatic' : 'unmarked';
};
export const parsedReplyAutomation = (parsed: { readonly headerLines: readonly { readonly key: string; readonly line: string }[] }): MailReplyAutomation =>
  classifyReplyAutomation(parsed.headerLines.map(({ key, line }) => [key, line.slice(line.indexOf(':') + 1)] as const));
/** Versioned evidence retained by sync. Legacy rows deliberately read unknown. */
export const storedReplyAutomation = (value: unknown): MailReplyAutomation => value === 'v1:automatic' ? 'automatic'
  : value === 'v1:unmarked' ? 'unmarked' : 'unknown';
