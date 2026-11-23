import { canonicalizeEmail } from './contact.js';

/** URLs as displayed by the saved Task/Note plain-text readers. Keep offsets in
 * the original text so incoming links can show context and reveal the link. */
export interface SavedTextUrl { href: string; start: number; end: number }
const recordAddress = /#data\/(?:(?:mail|calendar)\/record|contact|task|note)\//u;
export const savedTextUrls = (body: string): SavedTextUrl[] => {
  const urls = /https?:\/\/[^\s<>"`\u2018\u2019\u201c\u201d]+|#data\/(?:(?:mail|calendar)\/record|contact|task|note)\/[^\s<>"`\u2018\u2019\u201c\u201d]+/giu;
  const result: SavedTextUrl[] = [];
  for (const match of body.matchAll(urls)) {
    let href = match[0];
    if (body[match.index - 1] === "'") href = href.replace(/'[.,!?;:]*$/u, '');
    if (recordAddress.test(href)) {
      // A record id can contain punctuation. Only strip an explicit wrapper.
      if (body[match.index - 1] === '(') href = href.replace(/\)[.,!?;:]*$/u, '');
    } else {
      href = href.replace(/[.,!?;:\u3002\uff01\uff1f\u3001]+$/u, '');
      const closing: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
      const opening: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
      for (const character of href) {
        const pair = opening[character];
        if (pair) closing[pair] = (closing[pair] ?? 0) - 1;
        else if (Object.hasOwn(closing, character)) closing[character] = (closing[character] ?? 0) + 1;
      }
      let end = href.length;
      while (end > 0) {
        const character = href[end - 1]!;
        if ((closing[character] ?? 0) <= 0) break;
        closing[character] = (closing[character] ?? 0) - 1; end--;
        while (end > 0 && /[.,!?;:]/u.test(href[end - 1]!)) end--;
      }
      href = href.slice(0, end);
    }
    result.push({ href, start: match.index, end: match.index + href.length });
  }
  return result;
};

export interface SavedWorkAddress {
  kind: 'task' | 'note' | 'contact' | 'mail' | 'calendar'; id: string;
  /** Exact connected account; present only for Mail and Calendar records. */
  collection_slug?: string;
  /** Empty for a hash-relative link; otherwise exact origin + deployment path. */
  client: string;
}
export interface SavedWorkLink extends SavedTextUrl, SavedWorkAddress {}

/** The same deployment and exact record identity boundary as reader navigation.
 * No editor routes, query-bearing absolute URLs, credentials or guessed ids. */
export const savedWorkAddress = (href: string): SavedWorkAddress | null => {
  if (/[\u0000-\u0020\u007f]/u.test(href)) return null;
  try {
    const relative = href.startsWith('#');
    const url = new URL(href, relative ? 'https://recued.invalid/' : undefined);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.username || url.password) return null;
    decodeURIComponent(url.hash);
    const source = /^#data\/(mail|calendar)\/record\/([^/]+)\/([^/]+)$/u.exec(url.hash);
    if (source) {
      const collection_slug = decodeURIComponent(source[2]!), id = decodeURIComponent(source[3]!);
      if (![collection_slug, id].every(value => value.trim() && !/[\u0000-\u001f\u007f]/u.test(value))) return null;
      return { kind: source[1] as 'mail' | 'calendar', collection_slug, id, client: relative ? '' : url.origin + url.pathname };
    }
    const match = /^#data\/(task|note|contact)\/([^/]+)$/u.exec(url.hash);
    if (!match) return null;
    const id = decodeURIComponent(match[2]!);
    if (!id.trim() || /[\u0000-\u001f\u007f]/u.test(id)) return null;
    return { kind: match[1] as SavedWorkAddress['kind'], id: match[1] === 'contact' ? canonicalizeEmail(id) || id : id, client: relative ? '' : url.origin + url.pathname };
  } catch { return null; }
};
export const savedWorkLinks = (body: string): SavedWorkLink[] => savedTextUrls(body).flatMap(link => {
  const address = savedWorkAddress(link.href);
  return address ? [{ ...link, ...address }] : [];
});
export const savedWorkLinkMatches = (link: SavedWorkAddress, target: SavedWorkAddress): boolean =>
  link.kind === target.kind && link.id === target.id && link.collection_slug === target.collection_slug
  && (link.client === '' || link.client === target.client);

/** An unambiguous derived-index key; provider ids can repeat across accounts. */
export const savedWorkLinkIndexId = (address: SavedWorkAddress): string =>
  address.kind === 'mail' || address.kind === 'calendar' ? JSON.stringify([address.collection_slug, address.id]) : address.id;
