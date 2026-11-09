/** D-335 slice AP (2026-11-07) — a file a page links to, fetched as the page fetches it.
 *
 *  The owner: "#4 and #5 ... should be generic so a downlod file & table->csv file can be into the game
 *  later". `download_file` reads the address of the link a ref or a selector names (an `<a>`'s or
 *  `<area>`'s `href`, a link inside the element, or its `src`), or takes the address given, and fetches
 *  it from the page, so a statement on a site the owner is signed in to comes with their cookies, as it
 *  would to them. A file on another site the page may not fetch from (no CORS) is fetched by the
 *  Bridge itself instead. At most `maxBytes`: a larger file is refused before more than that is read.
 *  Answered in base64; the server keeps it among the owner's files and answers its ref.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED: neither function imports anything, and `fetchFile` touches no page,
 *  so the Bridge runs it in its own worker as well. */

/** What `pageFileAddress` finds: the file's address, and the page it is on. */
export type PageFileAddress =
  | { blocked: true } | { missing: true } | { stale: true } | { no_address: true }
  | { address: string; cross_origin: boolean; url: string; title: string };

/** What `fetchFile` answers. */
export type FetchedFile =
  | { failed: string }
  | { too_large: number; at_least?: true }
  | { address: string; filename: string; mime_type: string; size: number; data: string };

/** The address of the file the element `ref` or `selector` names links to, or `address`, made whole
 *  against the page; refused on the owner's own Recued page. */
export const pageFileAddress = (selector: string | null, ref: string | null, address: string | null): PageFileAddress => {
  if (document.documentElement.hasAttribute('data-recued-owner-surface')) return { blocked: true };
  let href = address;
  if (href === null) {
    const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
    const found = ref === null ? (selector === null ? null : document.querySelector(selector)) : marked?.byRef.get(ref) ?? null;
    if (ref !== null && !found?.isConnected) return { stale: true };
    if (!found) return { missing: true };
    // The link it is or is in, else one inside it, else what it shows from (a picture's or a frame's src).
    const link = found.closest('a[href], area[href]') ?? found.querySelector('a[href], area[href]');
    href = (link as HTMLAnchorElement | null)?.href
      ?? ((found as HTMLElement & { src?: unknown }).src !== undefined ? String((found as HTMLElement & { src?: unknown }).src) : null);
    if (href === null || href === '') return { no_address: true };
  }
  let url: URL;
  try {
    url = new URL(href, location.href);
  } catch {
    return { no_address: true };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { no_address: true };
  return { address: url.href, cross_origin: url.origin !== location.origin, url: location.href, title: document.title };
};

/** The file at `address`, at most `maxBytes`, in base64, with the name and type its site gives it. */
export const fetchFile = async (address: string, maxBytes: number): Promise<FetchedFile> => {
  let response: Response;
  try {
    response = await fetch(address, { credentials: 'include', redirect: 'follow' });
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) return { failed: `the site answered ${String(response.status)}${response.statusText ? ` ${response.statusText}` : ''}` };
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    return { too_large: declared };
  }
  // Read in parts, stopping once past `maxBytes`: a site that does not say the size is not read whole.
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { too_large: size, at_least: true };
      }
      parts.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  const decoded = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  // Its name: what the site sends it as, else the last part of its address.
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*\s*=\s*[\w-]+''([^;]+)/i.exec(disposition)?.[1];
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? /filename\s*=\s*([^;"]+)/i.exec(disposition)?.[1];
  let last = '';
  try {
    last = new URL(response.url || address).pathname.split('/').filter((part) => part !== '').pop() ?? '';
  } catch {
    last = '';
  }
  const filename = (encoded !== undefined ? decoded(encoded.trim()) : quoted !== undefined ? quoted.trim() : decoded(last))
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return { address: response.url || address, filename: filename === '' ? 'download' : filename,
    mime_type: type === '' ? 'application/octet-stream' : type, size, data: btoa(binary) };
};

/** What a file too large to hand over is told. */
export const fileTooLarge = (size: number, atLeast: boolean, most: number): string => {
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `The file is ${atLeast ? `more than ${mb(most)}` : mb(size)}, and the Browser Bridge hands over files of at most `
    + `${mb(most)}.`;
};

/** What an element that links to no file is told. */
export const NO_FILE_ADDRESS = 'That element links to no file: name the link to the file, or give the file\'s address.';

/** D-335 slice AQ — what `attachPageFile` answers. */
export type AttachedFile =
  | { blocked: true } | { missing: true } | { stale: true } | { not_file_field: string }
  | { attached: string; url: string; title: string };

/** D-335 slice AQ (2026-11-07) — puts a file into the file field the element `ref` or `selector` names, as
 *  choosing it in the field's dialog would: the field itself, the one a label names, or the one inside
 *  what was named (a button or a drop zone wrapping it). Then the field's `input` and `change`, which a
 *  page's own uploader listens for. Refused on the owner's own Recued page. */
export const attachPageFile = (selector: string | null, ref: string | null, filename: string, mimeType: string,
  data: string): AttachedFile => {
  if (document.documentElement.hasAttribute('data-recued-owner-surface')) return { blocked: true };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
  const found = ref === null ? (selector === null ? null : document.querySelector(selector)) : marked?.byRef.get(ref) ?? null;
  if (ref !== null && !found?.isConnected) return { stale: true };
  if (!found) return { missing: true };
  const field = found instanceof HTMLInputElement ? found
    : found instanceof HTMLLabelElement ? found.control
      : found.querySelector('input[type="file"]');
  if (!(field instanceof HTMLInputElement) || field.type !== 'file' || field.disabled) {
    return { not_file_field: found.tagName.toLowerCase() };
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  const chosen = new DataTransfer();
  chosen.items.add(new File([bytes], filename, { type: mimeType }));
  field.files = chosen.files;
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return { attached: field.files?.[0]?.name ?? filename, url: location.href, title: document.title };
};

/** What a field that takes no file is told. */
export const NOT_FILE_FIELD = 'That element is not a file field: name the field that chooses a file (an "input" of type '
  + 'file, its label, or the button around it).';
