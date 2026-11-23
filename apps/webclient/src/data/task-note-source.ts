import { parseShellRoute, parseSourceRecordAddress, serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';

export type TaskNoteSource = { tab: 'mail' | 'calendar'; collectionSlug: string; recordId: string; hash: string };
export type WorkRecordLink = { tab: 'contact' | 'task' | 'note' | 'commitment' | 'booking' | 'project'; id: string; hash: string };
export type WorkReaderLink = TaskNoteSource | WorkRecordLink;

/** Only an exact record in this paired client can use the task return stack.
 * Other links keep their ordinary browser behavior. */
const sameClientHash = (href: string, clientHref: string): string | null => {
  if (/[\u0000-\u0020\u007f]/u.test(href)) return null;
  try {
    const url = new URL(href, clientHref), client = new URL(clientHref);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== client.origin || url.pathname !== client.pathname
      || (url.search !== '' && !href.startsWith('#')) || url.username || url.password) return null;
    decodeURIComponent(url.hash);
    return url.hash;
  } catch { return null; }
};

const sourceFromHash = (hash: string): TaskNoteSource | null => {
  const address = parseSourceRecordAddress(parseShellRoute(hash));
  if (!address || (address.tab !== 'mail' && address.tab !== 'calendar') || address.returnToChat || address.returnToRun
    || /[\u0000-\u001f\u007f]/u.test(address.collectionSlug + address.recordId)) return null;
  return { tab: address.tab, collectionSlug: address.collectionSlug, recordId: address.recordId,
    hash: serializeSourceRecordAddress(address) };
};

export const taskNoteSource = (href: string, clientHref: string): TaskNoteSource | null => {
  const hash = sameClientHash(href, clientHref);
  return hash === null ? null : sourceFromHash(hash);
};

/** Only saved records in this client join the reader's return stack. Keep
 * editor routes, other deployments, and external links in the browser. */
export const workReaderLink = (href: string, clientHref: string): TaskNoteSource | WorkRecordLink | null => {
  const hash = sameClientHash(href, clientHref);
  if (hash === null) return null;
  const source = sourceFromHash(hash); if (source) return source;
  const match = /^#data\/(contact|task|note|commitment|booking|project)\/([^/]+)$/u.exec(hash);
  if (!match) return null;
  const tab = match[1] as WorkRecordLink['tab'], id = decodeURIComponent(match[2]!);
  if (!id.trim() || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  return { tab, id, hash: serializeShellRoute('data', tab, id) };
};
