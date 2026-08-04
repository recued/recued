/** D-210 §4c — the `#reception/records` section: two lenses over the IMMUTABLE reception layers.
 *
 *  Owner's rule (2026-07-18): **`#reception/records` is IMMUTABLE, `#data/*` is MUTABLE.** This
 *  section is the immutable side, and §4's table says it has exactly two layers to show:
 *
 *  | lens | layer | what it is |
 *  |---|---|---|
 *  | **Requests** (default) | 1 — the sealed visitor entry | `reception_form_submission` (both flows since D-210 A.8 slice 4c), REDACTED by construction |
 *  | **Responses** | 2 — the accepted addition | `form_response`, append-only, PLAINTEXT by design |
 *
 *  ⛔ **Two lenses, not one merged list** — see `form-response-lens.ts`: layer 1 carries neither
 *  the visitor's values nor the ciphertext to recover them, layer 2 carries the answers in full.
 *  Merging them would put redacted and unredacted rows in one list and teach the owner the wrong
 *  thing about both.
 *
 *  Requests is the default because it is the one that can be WAITING on the owner; Responses is
 *  a record of things already decided.
 *
 *  ## ⛔ The rule is SCOPED to the reception lineage — do not generalize it
 *
 *  Owner-ruled 2026-07-18, in the same breath as the rule itself. `#data` still holds immutable
 *  things (`webhook`, `annotation`, `link`, and the `mail` / `crm` mirrors) and they STAY there.
 *  Mutability only orders things once a prior question is settled — **who is on the other end:**
 *
 *    - **reception** = a **HUMAN VISITOR**, through a door you published  → `#reception/*`
 *    - **`webhook`** = a **VENDOR SOURCE**, a machine POSTing             → `#data`
 *
 *  Owner: *"webhook is its own door in code, it just doesn't earn its place yet, so we
 *  temporarily put it in data where it is more relevant."* ⇒ that placement is deliberate and
 *  reasoned; a future reader finding an immutable tab in `#data` has NOT found a bug. */

import {
  mountReceptionFormResponseLens,
  type ReceptionFormResponseConn,
  type ReceptionFormResponseLensMount,
} from './form-response-lens.js';
import {
  mountReceptionRecordsPanel,
  type ReceptionRecordsConn,
  type ReceptionRecordsPanelMount,
} from './records-panel.js';

export type ReceptionRecordsLens = 'requests' | 'responses';

export const RECEPTION_RECORDS_LENSES: ReadonlyArray<{
  id: ReceptionRecordsLens;
  label: string;
}> = [
  { id: 'requests', label: 'Requests' },
  { id: 'responses', label: 'Responses' },
];

export const RECEPTION_RECORDS_LENS_ATTR = 'data-recued-reception-records-lens';
export const RECEPTION_RECORDS_SECTION_ATTR = 'data-recued-reception-records-section';

export type ReceptionRecordsSectionConn = ReceptionRecordsConn & ReceptionFormResponseConn;

export interface ReceptionRecordsSectionOptions {
  host: HTMLElement;
  conn: ReceptionRecordsSectionConn;
  document?: Document;
  now?: () => number;
  /** Which lens to open on mount. Absent ⇒ Requests. */
  initialLens?: ReceptionRecordsLens;
}

export interface ReceptionRecordsSectionMount {
  activeLens(): ReceptionRecordsLens;
  setLens(lens: ReceptionRecordsLens): void;
  /** The live child mount, for tests + callers that need to drive the lens directly. */
  current(): ReceptionRecordsPanelMount | ReceptionFormResponseLensMount;
  dispose(): void;
}

const LENS_NAV_STYLES = `
[${RECEPTION_RECORDS_SECTION_ATTR}] { display: grid; gap: 16px; }
[${RECEPTION_RECORDS_SECTION_ATTR}] .reception-records-lenses {
  display: inline-flex; gap: 4px; width: fit-content; padding: 4px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface-sunk);
}
[${RECEPTION_RECORDS_SECTION_ATTR}] .reception-records-lens {
  appearance: none; min-height: 32px; padding: 6px 14px; border: 0; border-radius: 7px;
  background: transparent; color: var(--fg-muted); font-size: 13px; font-weight: 650; cursor: pointer;
}
[${RECEPTION_RECORDS_SECTION_ATTR}] .reception-records-lens:hover { color: var(--fg); }
[${RECEPTION_RECORDS_SECTION_ATTR}] .reception-records-lens--active {
  background: var(--surface); color: var(--fg); box-shadow: 0 1px 3px rgba(24, 24, 27, 0.10);
}
[${RECEPTION_RECORDS_SECTION_ATTR}] .reception-records-lens:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
`;

export const mountReceptionRecordsSection = (
  opts: ReceptionRecordsSectionOptions,
): ReceptionRecordsSectionMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountReceptionRecordsSection: no document available - pass opts.document for non-browser environments',
    );
  }

  const root = doc.createElement('div');
  root.setAttribute(RECEPTION_RECORDS_SECTION_ATTR, '');
  opts.host.appendChild(root);

  const style = doc.createElement('style');
  style.textContent = LENS_NAV_STYLES;
  root.appendChild(style);

  const nav = doc.createElement('div');
  nav.className = 'reception-records-lenses';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Reception record lenses');
  nav.setAttribute('aria-orientation', 'horizontal');
  root.appendChild(nav);

  const content = doc.createElement('div');
  content.setAttribute('id', 'recued-reception-records-panel');
  content.setAttribute('role', 'tabpanel');
  root.appendChild(content);

  let lens: ReceptionRecordsLens = opts.initialLens ?? 'requests';
  let child: ReceptionRecordsPanelMount | ReceptionFormResponseLensMount;
  let disposed = false;
  const lensButtons = new Map<ReceptionRecordsLens, HTMLButtonElement>();

  const paintNav = (): void => {
    for (const entry of RECEPTION_RECORDS_LENSES) {
      const button = doc.createElement('button');
      button.setAttribute('type', 'button');
      button.setAttribute(RECEPTION_RECORDS_LENS_ATTR, entry.id);
      button.setAttribute('id', `recued-reception-records-${entry.id}-tab`);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'recued-reception-records-panel');
      button.textContent = entry.label;
      nav.appendChild(button);
      lensButtons.set(entry.id, button);
    }
  };

  const activateNav = (focus: boolean): void => {
    for (const entry of RECEPTION_RECORDS_LENSES) {
      const button = lensButtons.get(entry.id);
      if (button === undefined) continue;
      const active = entry.id === lens;
      button.className = active
        ? 'reception-records-lens reception-records-lens--active'
        : 'reception-records-lens';
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.setAttribute('tabindex', active ? '0' : '-1');
    }
    content.setAttribute(
      'aria-labelledby',
      `recued-reception-records-${lens}-tab`,
    );
    if (focus) lensButtons.get(lens)?.focus?.({ preventScroll: true });
  };

  const mountChild = (): ReceptionRecordsPanelMount | ReceptionFormResponseLensMount =>
    lens === 'responses'
      ? mountReceptionFormResponseLens({
          host: content,
          conn: opts.conn,
          ...(opts.document !== undefined ? { document: opts.document } : {}),
        })
      : mountReceptionRecordsPanel({
          host: content,
          conn: opts.conn,
          ...(opts.document !== undefined ? { document: opts.document } : {}),
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        });

  const switchLens = (next: ReceptionRecordsLens, focus: boolean): void => {
    if (disposed || next === lens) return;
    lens = next;
    // ⛔ Dispose BEFORE re-mounting — each lens appends its own root to `content` and registers a
    // click listener on it. Skipping this leaves the old lens's listener live under the new one,
    // so a click lands in both.
    child.dispose();
    content.innerHTML = '';
    child = mountChild();
    activateNav(focus);
  };

  const setLens = (next: ReceptionRecordsLens): void => {
    switchLens(next, false);
  };

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    if (target === null || typeof target.getAttribute !== 'function') return;
    const next = target.getAttribute(RECEPTION_RECORDS_LENS_ATTR);
    if (next === 'requests' || next === 'responses') switchLens(next, true);
  };

  const onKeydown = (ev: KeyboardEvent): void => {
    const target = ev.target as HTMLElement | null;
    const current = target?.getAttribute?.(RECEPTION_RECORDS_LENS_ATTR);
    if (current !== 'requests' && current !== 'responses') return;
    const currentIndex = RECEPTION_RECORDS_LENSES.findIndex(
      (entry) => entry.id === current,
    );
    let nextIndex: number | null = null;
    if (ev.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % RECEPTION_RECORDS_LENSES.length;
    } else if (ev.key === 'ArrowLeft') {
      nextIndex = (
        currentIndex - 1 + RECEPTION_RECORDS_LENSES.length
      ) % RECEPTION_RECORDS_LENSES.length;
    } else if (ev.key === 'Home') {
      nextIndex = 0;
    } else if (ev.key === 'End') {
      nextIndex = RECEPTION_RECORDS_LENSES.length - 1;
    }
    if (nextIndex === null) return;
    ev.preventDefault();
    switchLens(RECEPTION_RECORDS_LENSES[nextIndex]!.id, true);
  };

  paintNav();
  activateNav(false);
  child = mountChild();
  nav.addEventListener('click', onClick);
  nav.addEventListener('keydown', onKeydown);

  return {
    activeLens: () => lens,
    setLens,
    current: () => child,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      nav.removeEventListener('click', onClick);
      nav.removeEventListener('keydown', onKeydown);
      child.dispose();
      root.remove();
    },
  };
};
