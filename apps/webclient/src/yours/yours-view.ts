/** Small presentation primitives. Commands and route/draft state stay with the controller. */
const node = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className: string, text?: string) => {
  const element = parent.ownerDocument.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  parent.append(element); return element;
};

export const yoursActions = (parent: HTMLElement) => node(parent, 'div', 'yours-actions');
export const yoursToolbar = (parent: HTMLElement) => node(parent, 'div', 'yours-toolbar');
export const yoursList = (parent: HTMLElement) => node(parent, 'div', 'yours-list');
export const yoursEmpty = (parent: HTMLElement, text: string) => node(parent, 'p', 'yours-empty', text);
export const yoursNode = node;

/** Keep every destination in the existing rail and expose a real scroll action
 * when some destinations are outside the viewport. */
export const yoursNavigation = (parent: HTMLElement, title: string) => {
  const host = node(parent, 'div', 'yours-navigation');
  const nav = node(host, 'nav', 'yours-nav'); nav.setAttribute('aria-label', title); nav.setAttribute('data-recued-scroll-rail', '');
  const more = node(host, 'button', 'yours-nav-more', '›'); more.type = 'button'; more.hidden = true;
  const update = () => {
    more.hidden = nav.scrollWidth <= nav.clientWidth + 1;
    const atEnd = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 2;
    more.textContent = atEnd ? '‹' : '›'; more.setAttribute('aria-label', atEnd ? `Show earlier ${title} sections` : `Show more ${title} sections`);
  };
  more.addEventListener('click', () => {
    const atEnd = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 2;
    nav.scrollBy({ left: (atEnd ? -1 : 1) * nav.clientWidth * .8,
      behavior: parent.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  nav.addEventListener('scroll', update);
  const Observer = parent.ownerDocument.defaultView?.ResizeObserver;
  const observer = Observer ? new Observer(update) : undefined; observer?.observe(nav);
  const frame = parent.ownerDocument.defaultView?.requestAnimationFrame(update);
  return { nav, dispose: () => { observer?.disconnect(); if (frame !== undefined) parent.ownerDocument.defaultView?.cancelAnimationFrame(frame); } };
};
export const yoursInput = (parent: HTMLElement, title: string, name: string, value: string, changed: () => void, type = 'text') => {
  const label = node(parent, 'label', '', title); const input = node(label, 'input', ''); input.type = type; input.name = name; input.value = value;
  input.setAttribute('aria-label', title); input.dataset.yoursFocus = name; input.addEventListener('input', changed); return input;
};
export const yoursChoice = (parent: HTMLElement, title: string, name: string, choices: Array<[string, string]>, value: string, changed: () => void) => {
  const label = node(parent, 'label', '', title); const select = node(label, 'select', ''); select.name = name; select.setAttribute('aria-label', title); select.dataset.yoursFocus = name;
  for (const [id, text] of choices) { const option = node(select, 'option', '', text); option.value = id; }
  select.value = value; select.addEventListener('change', changed); return select;
};

export const yoursPageHeader = (parent: HTMLElement, title: string, description?: string) => {
  const header = node(parent, 'header', 'yours-page-header'); const text = node(header, 'div', 'yours-page-title');
  node(text, 'h2', '', title);
  if (description) node(text, 'p', '', description);
  return { header, text, actions: yoursActions(header) };
};

/** Native disclosure keyboard behavior; its children remain ordinary buttons,
 * not an ARIA menu without the corresponding arrow-key interaction. */
export const yoursMenu = (parent: HTMLElement, label: string, identity: readonly string[]) => {
  const details = node(parent, 'details', 'yours-menu'); details.dataset.yoursMenu = JSON.stringify(identity);
  const summary = node(details, 'summary', '', 'More'); summary.setAttribute('aria-label', `More actions for ${label}`);
  const actions = node(details, 'div', 'yours-menu-body'); actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `Actions for ${label}`);
  details.addEventListener('toggle', () => {
    if (details.open) details.dataset.align = summary.getBoundingClientRect().left + actions.offsetWidth > (parent.ownerDocument.defaultView?.innerWidth ?? 0) - 16 ? 'end' : 'start';
  });
  details.addEventListener('keydown', event => {
    if (event.key === 'Escape' && details.open) { event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus(); }
  });
  return actions;
};

export const yoursDisclosure = (parent: HTMLElement, title: string) => {
  const details = node(parent, 'details', 'yours-disclosure'); details.dataset.yoursDisclosure = title; node(details, 'summary', '', title); return details;
};
