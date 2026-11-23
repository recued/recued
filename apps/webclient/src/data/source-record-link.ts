import { formatClientDateTime } from '@recued/ui-shared';

/** Plain display metadata, never saved content or a provider relationship. */
export const sourceRecordLinkDetails = (tab: 'mail' | 'calendar', slug: string, fields: Record<string, unknown>, receivedAt: number) => {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const fullTitle = text(tab === 'mail' ? fields.subject : fields.summary) || (tab === 'mail' ? 'Email' : 'Calendar event');
  const titleChars = Array.from(fullTitle), title = titleChars.slice(0, 240).join('') + (titleChars.length > 240 ? '…' : '');
  const rawDate = tab === 'calendar' ? fields.start_at : receivedAt;
  const date = typeof rawDate === 'number' ? rawDate : typeof rawDate === 'string' ? Date.parse(rawDate) : NaN;
  const details = ['Account: ' + slug,
    ...(tab === 'mail' && text(fields.from) ? [text(fields.from)] : []),
    ...(Number.isFinite(date) && Number.isFinite(new Date(date).getTime()) ? [formatClientDateTime(date, { includeSeconds: false })] : [])];
  return { title, details };
};
