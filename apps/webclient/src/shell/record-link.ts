/** A reader link retains the deployed app path, never login/pairing parameters
 * or the route/view context the owner happened to arrive through. */
export const recordLink = (href: string, hash: string): string | null => {
  if (!hash.startsWith('#') || hash.length < 2) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = hash;
    return url.href;
  } catch { return null; }
};
