/** D-335 slice M (2026-11-04) — a ref whose element the page rebuilt, found again.
 *
 *  Many pages render a control anew when something changes: Wikipedia replaces its whole search
 *  form once the box has focus, and an app's Save button is drawn again once the form is valid. A
 *  ref read before then names an element that has left the page, and a click by it failed "The
 *  page changed since it was inspected: inspect it again" (measured 2026-11-04: in the search task
 *  a sequence's click on Search after its typing stopped there, and the model inspected and asked
 *  again). The control a person sees is the same one.
 *
 *  So before a step by ref, {@link rebindPageRef} looks at the element the ref names. Still on the
 *  page: nothing changes. Gone: the page's one shown element that is the same control takes the
 *  ref, as a person would find the Search button again. The same control: the same tag, type,
 *  name, role, label (`aria-label`, placeholder, title), text (a field's is its value, so none),
 *  a button input's value and a link's address; an id, when both have one; and, when the gone
 *  element's own surroundings left the page with it (as a rebuilt form does), the same form (its
 *  id, address and method) and the same row (a list item or table row, by its text), so a Delete
 *  in another row is never taken for one whose row was removed. None, or more than one, and the
 *  ref stays gone, refusing as before.
 *
 *  Only the ordinary executor does this: a run reviewed before it starts (D-261) acts on the
 *  elements its reviewer saw, or not at all. Since slice R it looks in web components and frames
 *  from the same site too, when the page itself has none.
 *
 *  D-347 follow-up 17 (2026-11-08) — and before a step that acts (`act`), a ref whose element is still on
 *  the page is held to what the page's last read showed of it (`page-inspect.ts` keeps that beside the
 *  ref): a page can draw other content into the same elements, on its own (a timer, a push) or after a
 *  step, and a list drawn anew so would have the step act on another row. The same, it acts. Else the
 *  one shown element that now shows exactly that takes the ref (the content moved); none, or more than
 *  one, and the step is refused saying what the element shows now and showed then. Its own words and
 *  attributes and its row's words and links count; a number with a point, a comma or a colon (a price,
 *  an amount, a time) may have moved on, but a whole number names the row as its words do.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED. */
export const rebindPageRef = (ref: string, act?: boolean | null)
  : { kept: true } | { rebound: true } | { stale: true } | { missing: true } | { changed: { now: string; was: string } } => {
  type Print = Record<string, string>;
  type RefMap = { next: number; byRef: Map<string, Element>; byElement: WeakMap<Element, string>;
    seen?: WeakMap<Element, Print>; print?: (element: Element) => Print };
  const refs = (globalThis as typeof globalThis & { recuedPageRefs?: RefMap }).recuedPageRefs;
  const old = refs?.byRef.get(ref);
  if (refs === undefined || old === undefined) return { missing: true };
  const shown = (element: Element) => element.getAttribute('aria-hidden') !== 'true'
    && element.checkVisibility({ checkVisibilityCSS: true });
  /** The shown elements of `tag` that pass `test`: in the page itself, else (D-335 slice R) the ones a web
   *  component draws or a frame from this site holds, as the outline reads them. */
  const findShown = (tag: string, test: (element: Element) => boolean): Element[] => {
    const matching = (root: Document | ShadowRoot) => [...root.querySelectorAll(tag)].filter((element) => shown(element) && test(element));
    const found = matching(document);
    if (found.length > 0) return found;
    // Components' shadow roots, open or closed, and frames' documents.
    const shadowOf = (element: Element): ShadowRoot | null => {
      try {
        const dom = (globalThis as typeof globalThis & {
          chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot | null | undefined } } }).chrome?.dom;
        return dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot;
      } catch {
        return element.shadowRoot;
      }
    };
    const roots: Array<Document | ShadowRoot> = [document];
    for (let at = 0; at < roots.length && at < 1_000; at += 1) {
      for (const element of roots[at]!.querySelectorAll('*')) {
        const shadow = shadowOf(element);
        if (shadow !== null) roots.push(shadow);
        if (element.localName === 'iframe' || element.localName === 'frame') {
          try {
            const inner = (element as HTMLIFrameElement).contentDocument;
            if (inner !== null && !inner.documentElement.hasAttribute('data-recued-owner-surface')) roots.push(inner);
          } catch {
            // Another site's frame: not this document's to read.
          }
        }
      }
    }
    return roots.slice(1).flatMap(matching);
  };
  const take = (element: Element) => {
    refs.byRef.set(ref, element);
    if (!refs.byElement.has(element)) refs.byElement.set(element, ref);
  };
  if (old.isConnected) {
    const seen = act === true ? refs.seen?.get(old) : undefined;
    const printOf = refs.print;
    if (seen === undefined || printOf === undefined) return { kept: true };
    const KEYS = ['tag', 'type', 'name', 'role', 'label', 'placeholder', 'title', 'text', 'value', 'href', 'form', 'row', 'links'];
    const LOOSE = new Set(['label', 'title', 'text', 'value', 'row']);
    const loose = (text: string) => text.replace(/\d+(?:[.,:]\d+)+/g, '#');
    const alike = (a: Print, b: Print, exact: boolean) => KEYS.every((key) => (exact || !LOOSE.has(key)
      ? a[key] === b[key] : loose(a[key] ?? '') === loose(b[key] ?? '')));
    const now = printOf(old);
    if (alike(now, seen, false)) return { kept: true };
    const moved = findShown(seen.tag ?? old.localName, (element) => alike(printOf(element), seen, true));
    if (moved.length === 1) {
      take(moved[0]!);
      return { rebound: true };
    }
    const say = (print: Print) => `“${print.shows ?? ''}”${print.in ? ` in “${print.in}”` : ''}`;
    return { changed: { now: say(now), was: say(seen) } };
  }
  const norm = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const ROWS = 'li, tr, [role="row"], [role="listitem"], [role="option"], [role="article"], article';
  const print = (element: Element) => {
    const form = (element as HTMLInputElement).form ?? element.closest('form');
    const row = element.closest(ROWS);
    return {
      tag: element.localName,
      type: norm(element.getAttribute('type')),
      name: element.getAttribute('name') ?? '',
      role: norm(element.getAttribute('role')),
      label: norm(element.getAttribute('aria-label')),
      placeholder: norm(element.getAttribute('placeholder')),
      title: norm(element.getAttribute('title')),
      // A field's text is what it holds, which typing changes.
      text: element.matches('input, textarea, select') ? '' : norm(element.textContent).slice(0, 200),
      value: element.matches('input[type="submit" i], input[type="button" i], input[type="reset" i]')
        ? norm((element as HTMLInputElement).value) : '',
      href: element.getAttribute('href') ?? '',
      form: form === null ? null : `${form.id}|${form.getAttribute('action') ?? ''}|${norm(form.getAttribute('method'))}`,
      row: row === null || row === element ? null : norm(row.textContent).slice(0, 300),
    };
  };
  const was = print(old);
  const same = (element: Element) => {
    if (element.id !== '' && old.id !== '' && element.id !== old.id) return false;
    const now = print(element);
    for (const key of ['tag', 'type', 'name', 'role', 'label', 'placeholder', 'title', 'text', 'value', 'href'] as const) {
      if (now[key] !== was[key]) return false;
    }
    // Surroundings that left with it say where it was; ones that did not are not known.
    if (was.form !== null && now.form !== was.form) return false;
    if (was.row !== null && now.row !== was.row) return false;
    return true;
  };
  const found = findShown(was.tag, same);
  if (found.length !== 1) return { stale: true };
  take(found[0]!);
  return { rebound: true };
};
