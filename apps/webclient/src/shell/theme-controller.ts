/** Webclient light / dark / system theme toggle.
 *
 *  The colour system (`@recued/ui-shared` tokens.css) defines a light
 *  palette on `:root` and a dark palette via BOTH
 *  `:root[data-theme="dark"]` (pinned) and
 *  `@media (prefers-color-scheme: dark) :root:not([data-theme])` (OS,
 *  unpinned). This controller is the in-app override: it writes
 *  `data-theme` on `<html>` and persists the choice.
 *
 *    - `system` → NO `data-theme` attribute → the media query governs
 *      (follows the OS). The default.
 *    - `light`  → `data-theme="light"` → stays light even if the OS is
 *      dark (the media query's `:not([data-theme])` excludes it).
 *    - `dark`   → `data-theme="dark"` → dark regardless of the OS.
 *
 *  The persisted choice is ALSO applied by a tiny inline script in
 *  `index.html` before first paint (FOUC-free); this controller re-applies
 *  on mount (idempotent) and owns the toggle interaction. Persistence +
 *  the DOM root are injectable so the unit tests can drive it against a
 *  fake document + storage. */

export type ThemePreference = 'system' | 'light' | 'dark';

/** localStorage key — MUST match the inline boot script in index.html. */
export const THEME_STORAGE_KEY = 'recued.theme';
/** Marker on the toggle button (tests + the review rig locate it by this). */
export const THEME_TOGGLE_ATTR = 'data-recued-theme-toggle';

const CYCLE: readonly ThemePreference[] = ['system', 'light', 'dark'];
const LABEL: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
// Glyph carries the meaning at a glance; colour stays sparse (D-174).
const GLYPH: Readonly<Record<ThemePreference, string>> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};
// Mobile browser-chrome colour per resolved theme (the `<meta theme-color>`).
const THEME_COLOR: Readonly<Record<'light' | 'dark', string>> = {
  light: '#f8fafc',
  dark: '#09090b',
};

type StorageSeam = Pick<Storage, 'getItem' | 'setItem'>;

const safeStorage = (doc: Document): StorageSeam | null => {
  try {
    return doc.defaultView?.localStorage ?? null;
  } catch {
    // Accessing localStorage can throw in sandboxed / blocked contexts.
    return null;
  }
};

const readStored = (storage: StorageSeam | null): ThemePreference => {
  if (storage === null) return 'system';
  try {
    const v = storage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
};

export interface MountThemeToggleOptions {
  /** Element the toggle button mounts into (the shell topbar). */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Element that carries `data-theme`. Defaults to `document.documentElement`. */
  root?: HTMLElement;
  /** Persistence seam. Defaults to this document's `localStorage` (null when unavailable). */
  storage?: StorageSeam | null;
  /** Fired after each change with the new preference. */
  onChange?: (pref: ThemePreference) => void;
}

export interface ThemeToggleMount {
  /** Current preference. */
  get(): ThemePreference;
  /** Set + persist + apply a preference (also re-renders the button). */
  set(pref: ThemePreference): void;
  /** Advance system → light → dark → system and apply. Returns the new value. */
  cycle(): ThemePreference;
  /** Detach the listener + remove the button. Idempotent. */
  dispose(): void;
}

const updateThemeColorMeta = (doc: Document, pref: ThemePreference): void => {
  const meta = doc.querySelector?.('meta[name="theme-color"]');
  if (!meta) return;
  let resolved: 'light' | 'dark' = pref === 'dark' ? 'dark' : 'light';
  if (pref === 'system') {
    const mm = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    resolved = mm?.matches ? 'dark' : 'light';
  }
  meta.setAttribute('content', THEME_COLOR[resolved]);
};

/** Mount the theme toggle. Reads the persisted preference, applies it to
 *  the root (idempotent with the inline boot script), renders a cycling
 *  button, and returns a handle. */
export const mountThemeToggle = (
  opts: MountThemeToggleOptions,
): ThemeToggleMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountThemeToggle: no document available — pass `opts.document` for non-browser environments',
    );
  }
  // `documentElement` is always present in a real DOM; a minimal fake (some
  // unit-test shells) may omit it — tolerate that so the toggle still mounts.
  const root: HTMLElement | undefined =
    opts.root ?? doc.documentElement ?? undefined;
  const storage = opts.storage !== undefined ? opts.storage : safeStorage(doc);

  let pref = readStored(storage);
  let disposed = false;

  const apply = (p: ThemePreference): void => {
    if (root !== undefined) {
      if (p === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', p);
    }
    updateThemeColorMeta(doc, p);
  };

  const button = doc.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute(THEME_TOGGLE_ATTR, '');
  button.className = 'webclient-theme-toggle';

  const render = (): void => {
    button.textContent = `${GLYPH[pref]} ${LABEL[pref]}`;
    button.setAttribute('aria-label', `Theme: ${LABEL[pref]}. Click to change.`);
    button.setAttribute('title', `Theme: ${LABEL[pref]}`);
    button.setAttribute('data-theme-pref', pref);
  };

  const set = (p: ThemePreference): void => {
    if (disposed) return;
    pref = p;
    if (storage !== null) {
      try {
        storage.setItem(THEME_STORAGE_KEY, p);
      } catch {
        /* persistence is best-effort — the in-session choice still applies */
      }
    }
    apply(p);
    render();
    opts.onChange?.(p);
  };

  const cycle = (): ThemePreference => {
    const next = CYCLE[(CYCLE.indexOf(pref) + 1) % CYCLE.length]!;
    set(next);
    return next;
  };

  const onClick = (): void => {
    cycle();
  };
  button.addEventListener('click', onClick);
  opts.host.appendChild(button);

  // Sync the attribute with the stored value (matches the inline boot) +
  // paint the initial label.
  apply(pref);
  render();

  return {
    get: () => pref,
    set,
    cycle,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      button.removeEventListener('click', onClick);
      button.remove();
    },
  };
};

/** Self-scoped CSS for the toggle button — a quiet neutral outlined control
 *  matching the topbar metrics. Injected with the shell styles. */
export const THEME_TOGGLE_STYLES = `
[${THEME_TOGGLE_ATTR}] {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 10px;
  font: inherit;
  font-size: 12px;
  color: var(--fg-muted);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 6px);
  cursor: pointer;
  white-space: nowrap;
}
[${THEME_TOGGLE_ATTR}]:hover {
  background: var(--surface-sunk);
  color: var(--fg);
}
[${THEME_TOGGLE_ATTR}]:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--wc-ring, 0 0 0 3px var(--accent-weak));
}
`;
