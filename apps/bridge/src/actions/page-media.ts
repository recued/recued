import type { PageFieldAnswer } from './page-fields.js';
import type { PageInteractionWorld } from './page-inspect.js';

/** Runs in the bound page's isolated world. Only the native timeline is changed. */
export const seekPageMedia = async (selector: string, atSeconds: number, expectedUrl: string,
  ref: string | null): Promise<PageFieldAnswer> => {
  const ownerSurface = (doc: Document) => doc.documentElement.hasAttribute('data-recued-owner-surface');
  if (location.href !== expectedUrl || ownerSurface(document)) return { blocked: true };
  const world = globalThis as typeof globalThis & PageInteractionWorld & { recuedPageRefs?: { byRef: Map<string, Element> } };
  const above = (node: Element): Element | null =>
    node.assignedSlot ?? node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
  const visible = (node: Element) => {
    if (!node.checkVisibility({ checkVisibilityCSS: true })) return false;
    for (let at: Element | null = node; at; at = above(at)) {
      if (at.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  const matches = ref === null ? [...document.querySelectorAll(selector)].filter(visible) : [];
  if (matches.length > 1) return { several: matches.length };
  const target = ref === null ? matches[0] : world.recuedPageRefs?.byRef.get(ref);
  if (!target?.isConnected) return ref === null ? { missing: true } : { stale: true };
  const doc = target.ownerDocument;
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  if (!win || !(target instanceof win.HTMLMediaElement)) return { not_applied: 'Seek needs an observed audio or video element.' };
  const media = target;
  const documentUrl = doc.URL;
  const currentDocument = () => location.href === expectedUrl && doc.URL === documentUrl && media.ownerDocument === doc
    && media.isConnected && !ownerSurface(document) && !ownerSurface(doc);
  const available = () => {
    if (!currentDocument() || !visible(media) || world.recuedInertOf?.(media)) return false;
    let enclosingDialog: Element | undefined;
    for (let at: Element | null = media; at; at = above(at)) {
      if (at.matches('[inert], [aria-disabled="true"]')) return false;
      if (at.matches('dialog:modal')) enclosingDialog = at;
    }
    return enclosingDialog !== undefined || doc.querySelector('dialog:modal') === null;
  };
  if (!available()) return { not_applied: 'The media element is unavailable in the current page or dialog.' };
  const initialSource = media.currentSrc;
  const sameSource = () => !initialSource || media.currentSrc === initialSource;
  const seekable = () => {
    const ranges = media.seekable;
    for (let i = 0; i < ranges.length; i++) {
      if (atSeconds >= ranges.start(i) && atSeconds <= ranges.end(i)) return true;
    }
    return false;
  };
  const by = performance.now() + 2_000;
  while (currentDocument() && sameSource() && media.error === null && performance.now() < by
    && (media.readyState < media.HAVE_METADATA || media.seekable.length === 0)) {
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  if (!currentDocument() || !sameSource()) return { stale: true };
  if (!available()) return { not_applied: 'The media element became unavailable before seeking.' };
  if (!seekable()) return { not_applied: 'The requested timestamp is outside the media’s current seekable ranges.' };
  const receipt = (): PageFieldAnswer => ({ outputs: { seeked_to: media.currentTime, paused: media.paused } });
  if (!media.seeking && media.currentTime === atSeconds) return receipt();
  const source = media.currentSrc;
  return new Promise(resolve => {
    const finish = (answer: PageFieldAnswer) => {
      clearTimeout(timer);
      media.removeEventListener('seeked', onSeeked);
      resolve(answer);
    };
    const onSeeked = (event: Event) => {
      if (!event.isTrusted || media.seeking) return;
      // An already-playing clock can advance while the event is dispatched.
      const tolerance = media.paused ? 0.01 : 0.1;
      finish(currentDocument() && source === media.currentSrc && Math.abs(media.currentTime - atSeconds) <= tolerance
        ? receipt() : { uncertain: true });
    };
    const timer = setTimeout(() => finish({ uncertain: true }), 3_000);
    media.addEventListener('seeked', onSeeked);
    try { media.currentTime = atSeconds; }
    catch { finish({ uncertain: true }); }
  });
};
