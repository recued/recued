/** D-335 slice L (2026-11-04) — a field that suggests as you type, and the suggestion to pick. The
 *  owner: "typically human type on the input, the dropdown display matching list, then the tricky
 *  part is in some case the item has to be selected for submit (internally the website record the
 *  object with id), if none is selected, the display text is just a text string, and most likely
 *  the backend will discard it".
 *
 *  The executor's `pick` (`executor.ts`) runs these in the page, in order:
 *  1. {@link notePickLists}, before typing: the lists shown near the field and the hidden values
 *     around it, so a list that showed for the typing is told from one that was always there, and a
 *     field that recorded its pick from one that only holds text.
 *  2. The typing, as `fill` does (`fillPageField`).
 *  3. {@link findPickOption}, again until the suggestion shows: the field's own list (the one its
 *     `aria-controls` or `aria-owns` names, or the one its `aria-activedescendant` is in), else a list
 *     that showed just below or above the field since the note; then the option whose text is the
 *     one wanted. The noted field has a ref even when named by selector; guarded retries rebind
 *     only a unique matching replacement. Focus alone never selects another field. When no list
 *     shows within a second, {@link typeWithKeys} types the text again a key at a time, for a picker
 *     that reads keys rather than the value.
 *  4. The click on that option, as a person's (`clickPageElement`, by the ref this gives it): on its
 *     link when it holds one, since the middle of its row may miss a link that is only its text.
 *  5. {@link pickTook}: a hidden value changed, or the field or what sits beside it (a chip) shows
 *     the option, with the list closed or the typed text gone.
 *
 *  Not the first suggestion: the first is often not the one meant, since a picker ranks what is
 *  recent or popular, and a wrong record looks right. The whole text matching wins, then the first
 *  line of an option (a name over its details), then the one option containing it; none or several
 *  answer the suggestions instead.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED: each function declares everything it uses, and reads what they
 *  share from {@link PICK_RULES}, passed as an argument. */

/** What counts as a suggestion list and an option, passed into each function. */
export const PICK_RULES = {
  /** A list near the field that is no field's own by ARIA: the lists pickers render. */
  lists: '[role="listbox"], [role="menu"], [role="grid"], [role="tree"], ul, ol, [class*="suggest" i], '
    + '[class*="autocomplete" i], [class*="typeahead" i], [class*="combobox" i], [class*="dropdown" i], '
    + '[class*="results" i], [class*="options" i], [class*="pac-container" i]',
  /** How far below or above the field such a list may start, in pixels. */
  nearPx: 320,
  /** The most suggestions an answer lists, and the most of each it quotes. */
  listed: 10,
  quote: 80,
  /** The most of the field's surroundings read for its chips. */
  aroundChars: 400,
} as const;

export type PickRules = typeof PICK_RULES;

type PickNote = { field: Element; lists: Map<Element, string>; hidden: Map<Element, string>; scope: Element;
  chosen?: { option: Element; label: string } };

/** Before typing: what is shown near the field now, and the hidden values around it. `ref`, when
 *  given, names the field instead of `selector`. */
export const notePickLists = (selector: string, ref: string | null | undefined, rules: PickRules):
  { noted: true; ref: string } | { missing: true } | { stale: true } | { blocked: true } | { several: number } => {
  if (document.documentElement.hasAttribute('data-recued-owner-surface')) return { blocked: true };
  type RefMap = { next: number; byRef: Map<string, Element>; byElement: WeakMap<Element, string> };
  const world = globalThis as typeof globalThis & { recuedPageRefs?: RefMap; recuedPickNote?: PickNote };
  let bySelector: Element | null = null;
  if (ref == null) {
    // Keep the ordinary fill's ambiguity check when pinning a selector to a ref.
    const all = [...document.querySelectorAll(selector)];
    const visible = all.filter(one => one.closest('[aria-hidden="true"]') === null && one.checkVisibility({ checkVisibilityCSS: true }));
    if (visible.length > 1 || (visible.length === 0 && all.length > 1)) return { several: visible.length || all.length };
    bySelector = visible[0] ?? all[0] ?? null;
  }
  const field = ref == null ? bySelector : world.recuedPageRefs?.byRef.get(ref) ?? null;
  if (ref != null && !field?.isConnected) return { stale: true };
  if (!field) return { missing: true };
  const shown = (element: Element) => element.getAttribute('aria-hidden') !== 'true'
    && element.checkVisibility({ checkVisibilityCSS: true });
  // D-335 slice R — a field in a web component, or in a frame from this site, keeps its list there,
  // or in the page around it.
  const root = field.getRootNode() as Document | ShadowRoot;
  const scopes = [...new Set<Document | ShadowRoot>([root, field.ownerDocument, document])];
  const lists = new Map<Element, string>();
  for (const element of scopes.flatMap((scope) => [...scope.querySelectorAll(rules.lists)])) {
    if (shown(element)) lists.set(element, (element as HTMLElement).innerText ?? '');
  }
  // Where its record would be kept: its form, else what holds the field a few levels up.
  const form = (field as HTMLInputElement).form ?? field.closest('form');
  const scope = form ?? field.parentElement?.parentElement?.parentElement ?? document.body;
  const hidden = new Map<Element, string>();
  for (const input of scope.querySelectorAll('input[type="hidden"]')) hidden.set(input, (input as HTMLInputElement).value);
  // Pin selectors too: later injections must not follow a selector or focus to
  // a different field. The executor uses the ordinary guarded ref retry.
  const refs = world.recuedPageRefs ??= { next: 1, byRef: new Map(), byElement: new WeakMap() };
  let fieldRef = ref ?? refs.byElement.get(field);
  if (fieldRef === undefined || refs.byRef.get(fieldRef) !== field) {
    fieldRef = `e${refs.next++}`;
    refs.byRef.set(fieldRef, field);
    refs.byElement.set(field, fieldRef);
  }
  world.recuedPickNote = { field, lists, hidden, scope };
  return { noted: true, ref: fieldRef };
};

/** The option to pick, once it shows: `found` is the ref it now has, `label` its text and `url`
 *  the page's address to click it at. Else why not yet: no list, or the suggestions shown, none or
 *  several of which match. */
export const findPickOption = (selector: string, ref: string | null | undefined, want: string, rules: PickRules):
  { found: string; label: string; url: string } | { none: string[] } | { several: string[] } | { no_list: true }
  | { gone: true } | { stale: true } | { blocked: true } => {
  if (document.documentElement.hasAttribute('data-recued-owner-surface')) return { blocked: true };
  type RefMap = { next: number; byRef: Map<string, Element>; byElement: WeakMap<Element, string> };
  const world = globalThis as typeof globalThis & { recuedPageRefs?: RefMap; recuedPickNote?: PickNote };
  const note = world.recuedPickNote;
  const isField = (element: Element | null) => element !== null && element.isConnected
    && element.matches('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="combobox"]');
  // Rebuilt fields are recovered by the executor's guarded ref retry. An
  // unrelated live field, including the one with focus, is never a substitute.
  const named = ref == null ? document.querySelector(selector) : world.recuedPageRefs?.byRef.get(ref) ?? null;
  if (ref != null && !named?.isConnected) return { stale: true };
  const field = isField(named) ? named : null;
  if (field === null) return { gone: true };
  // Slice R — where its list may be: its web component or frame, and the page around it.
  const root = field.getRootNode() as Document | ShadowRoot;
  const scopes = [...new Set<Document | ShadowRoot>([root, field.ownerDocument, document])];
  const byId = (id: string) => scopes.map((scope) => scope.getElementById(id)).find((element) => element !== null) ?? null;
  const shown = (element: Element) => element.getAttribute('aria-hidden') !== 'true'
    && element.checkVisibility({ checkVisibilityCSS: true });
  const textOf = (element: Element) => ((element as HTMLElement).innerText ?? element.textContent ?? '').trim();
  const norm = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const firstLine = (text: string) => text.split('\n').find((line) => line.trim() !== '') ?? '';
  const said = (element: Element) => {
    const text = textOf(element).replace(/\s+/g, ' ');
    return text.length > rules.quote ? `${text.slice(0, rules.quote - 1)}…` : text;
  };

  // 1. The field's own list, by ARIA: its controls or owns, its combobox's, its active option's list.
  const ids = new Set<string>();
  for (const owner of [field, field.closest('[role="combobox"]')]) {
    for (const attribute of ['aria-controls', 'aria-owns']) {
      for (const id of (owner?.getAttribute(attribute) ?? '').split(/\s+/)) if (id !== '') ids.add(id);
    }
  }
  const linked = [...ids].map((id) => byId(id)).filter((element): element is HTMLElement => element !== null);
  const active = field.getAttribute('aria-activedescendant');
  const activeList = active ? byId(active)?.closest('[role="listbox"], [role="menu"], [role="grid"], [role="tree"]') : null;
  if (activeList) linked.push(activeList as HTMLElement);
  let lists: Element[] = linked.filter(shown);
  // 2. Else a list that showed just below or above the field since the note, beside it.
  if (lists.length === 0) {
    const box = field.getBoundingClientRect();
    lists = [...new Set(scopes.flatMap((scope) => [...scope.querySelectorAll(rules.lists)]))].filter((element) => {
      if (!shown(element) || element.contains(field)) return false;
      const was = note?.lists.get(element);
      if (was !== undefined && was === ((element as HTMLElement).innerText ?? '')) return false;
      const at = element.getBoundingClientRect();
      if (at.width <= 0 || at.height <= 0 || at.left >= box.right || at.right <= box.left) return false;
      return (at.top >= box.top && at.top <= box.bottom + rules.nearPx)
        || (at.bottom <= box.bottom && at.bottom >= box.top - rules.nearPx);
    });
    // The innermost: a box holding another list says less precisely where its options are.
    lists = lists.filter((list) => !lists.some((other) => other !== list && list.contains(other)));
  }
  // Its options: ARIA options, else menu items, else list items, else its rows, in the page's order.
  const options: Element[] = [];
  for (const list of lists) {
    let rows = [...list.querySelectorAll('[role="option"]')];
    if (rows.length === 0) rows = [...list.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')];
    if (rows.length === 0) rows = [...list.querySelectorAll('li')];
    // A listbox's rows are its options: anything else in it ("Loading…", "No results") is not one.
    if (rows.length === 0 && !list.matches('[role="listbox"]')) rows = [...list.children];
    for (const row of rows) {
      if (shown(row) && row.getAttribute('aria-disabled') !== 'true' && textOf(row) !== '' && !options.includes(row)) options.push(row);
    }
  }
  const rows = options.filter((option) => !options.some((other) => other !== option && option.contains(other)));
  if (rows.length === 0) return { no_list: true };

  // The whole text, then the first line (a name over its details), then the one that contains it
  // in whole words ("London" is in "London, UK", not in "Londonderry").
  const wanted = norm(want);
  const whole = rows.filter((option) => norm(textOf(option)) === wanted);
  const head = whole.length > 0 ? whole : rows.filter((option) => norm(firstLine(textOf(option))) === wanted);
  const matches = head.length > 0 ? head : rows.filter((option) => ` ${norm(textOf(option))} `.includes(` ${wanted} `));
  if (matches.length === 0) return { none: rows.slice(0, rules.listed).map(said) };
  if (matches.length > 1) return { several: matches.slice(0, rules.listed).map(said) };
  const option = matches[0]!;
  // What is clicked: an option holding one link is that link, where its row's middle may miss it.
  const links = option.querySelectorAll('a[href]');
  const target = links.length === 1 && shown(links[0]!) ? links[0]! : option;
  // A ref for it, as the inspection gives one, so it is clicked as any element by ref is.
  const refMap = world.recuedPageRefs ??= { next: 1, byRef: new Map(), byElement: new WeakMap() };
  let optionRef = refMap.byElement.get(target);
  if (optionRef === undefined || refMap.byRef.get(optionRef) !== target) {
    optionRef = `e${refMap.next++}`;
    refMap.byElement.set(target, optionRef);
    refMap.byRef.set(optionRef, target);
  }
  if (note !== undefined) note.chosen = { option, label: textOf(option) };
  return { found: optionRef, label: said(option), url: location.href };
};

/** Types `typed` into the field again, a key at a time, as a person's keys reach the page:
 *  `keydown`, `keypress`, `beforeinput`, the character, `input`, `keyup`. For a picker that searches
 *  on keys rather than on the value. A key the page cancels is not typed, as a browser would not
 *  type it. The events are the page's own (`isTrusted: false`). Recovery keeps
 *  the ordinary fill's page, disabled-field and modal checks before touching the field. */
export const typeWithKeys = (selector: string, ref: string | null | undefined, typed: string, expectedUrl?: string | null):
  { typed: true } | { not_applied: string } | { gone: true } | { stale: true } | { blocked: true } => {
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  const world = globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } };
  const isField = (element: Element | null) => element !== null && element.isConnected && element.matches('input, textarea');
  const named = ref == null ? document.querySelector(selector) : world.recuedPageRefs?.byRef.get(ref) ?? null;
  if (ref != null && !named?.isConnected) return { stale: true };
  if (!isField(named)) return { gone: true };
  const field = named as HTMLInputElement | HTMLTextAreaElement;
  if (field.matches(':disabled') || field.getAttribute('aria-disabled') === 'true') {
    return { not_applied: 'This field is disabled.' };
  }
  // Injected and self-contained, as fillPageField is. Composed ancestry also
  // allows a field inside an active dialog's shadow tree.
  const within = (parent: Element, child: Element): boolean => {
    for (let at: Element | null = child; at;) {
      if (at === parent) return true;
      const root = at.getRootNode();
      at = at.parentElement ?? (root as ShadowRoot).host ?? null;
    }
    return false;
  };
  for (const modal of document.querySelectorAll('dialog:modal, [aria-modal="true"]')) {
    if (modal.checkVisibility({ checkVisibilityCSS: true }) && !within(modal, field)) {
      return { not_applied: 'An open dialog blocks this field. Use the control inside the active dialog.' };
    }
  }
  const own = Object.getOwnPropertyDescriptor(
    field.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
  const set = (value: string) => (own ? own.call(field, value) : (field.value = value));
  field.focus();
  set('');
  field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
  for (const char of typed) {
    const upper = char.toUpperCase();
    const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(char) ? `Digit${char}` : char === ' ' ? 'Space' : '';
    const key = { key: char, code, keyCode: upper.charCodeAt(0), which: upper.charCodeAt(0),
      bubbles: true, cancelable: true, composed: true };
    const down = field.dispatchEvent(new KeyboardEvent('keydown', key));
    const press = down && field.dispatchEvent(new KeyboardEvent('keypress', { ...key, charCode: char.codePointAt(0) }));
    const before = press && field.dispatchEvent(new InputEvent('beforeinput',
      { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: char }));
    if (before) {
      set(field.value + char);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
    }
    field.dispatchEvent(new KeyboardEvent('keyup', key));
  }
  return { typed: true };
};

/** After the click on the option: whether the field took it. A hidden value around it changed or
 *  appeared (the record a form keeps for its pick), or the field or what sits beside it (a chip)
 *  shows the option, with its list closed or the typed text gone from the field. */
export const pickTook = (selector: string, ref: string | null | undefined, typed: string, want: string,
  rules: PickRules): { took: 'hidden' | 'shown' } | { open: true } | { not_shown: true } | { unknown: true } => {
  const world = globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> };
    recuedPickNote?: PickNote };
  const note = world.recuedPickNote;
  if (note?.chosen === undefined) return { unknown: true };
  for (const input of note.scope.isConnected ? note.scope.querySelectorAll('input[type="hidden"]') : []) {
    const was = note.hidden.get(input);
    if (was === undefined ? (input as HTMLInputElement).value !== '' : (input as HTMLInputElement).value !== was) {
      return { took: 'hidden' };
    }
  }
  const shown = (element: Element) => element.isConnected && element.getAttribute('aria-hidden') !== 'true'
    && element.checkVisibility({ checkVisibilityCSS: true });
  const norm = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const isField = (element: Element | null) => element !== null && element.isConnected
    && element.matches('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="combobox"]');
  const named = ref == null ? document.querySelector(selector) : world.recuedPageRefs?.byRef.get(ref) ?? null;
  const field = isField(named) ? named : null;
  const option = note.chosen.option;
  const list = option.closest('[role="listbox"], [role="menu"], [role="grid"], [role="tree"], ul, ol') ?? option.parentElement;
  const open = shown(option) || (list !== null && shown(list) && list.contains(option));
  const value = field !== null && 'value' in field ? norm(String((field as HTMLInputElement).value ?? '')) : '';
  // Beside the field: what holds it a few levels up, while that stays short, without the list.
  let around = '';
  if (field !== null) {
    const without = (element: Element) => {
      let text = (element as HTMLElement).innerText ?? '';
      if (list !== null && element.contains(list)) text = text.replace((list as HTMLElement).innerText ?? '', ' ');
      return text;
    };
    let holder = field.parentElement;
    for (let level = 0; level < 3 && holder?.parentElement; level += 1) {
      if (without(holder.parentElement).length > rules.aroundChars) break;
      holder = holder.parentElement;
    }
    around = holder === null ? '' : norm(without(holder));
  }
  const label = note.chosen.label;
  const signs = [norm(label.split('\n').find((line) => line.trim() !== '') ?? ''), norm(want)].filter((sign) => sign !== '');
  const showsIt = signs.some((sign) => value.includes(sign) || around.includes(sign));
  if (showsIt && (!open || value !== norm(typed))) return { took: 'shown' };
  return open ? { open: true } : { not_shown: true };
};
