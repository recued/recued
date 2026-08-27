/** Shell-owned entry point for the installed-recipe Run palette.
 *
 * The palette used to be mounted by Chat. This controller gives the existing
 * palette one app-lifetime owner, one persistent top-bar trigger, and one
 * keyboard shortcut, while continuing to reuse its recipe classification and
 * Run | Schedule modal unchanged.
 */

import type { RunPaletteOptions } from '../chat/run-palette.js';
import {
  wireRunPalette,
  type RunPaletteHandle,
} from '../chat/run-palette.js';

export const GLOBAL_RUN_PALETTE_TRIGGER_ATTR =
  'data-recued-global-run-palette-trigger';
export const GLOBAL_RUN_PALETTE_SHORTCUT = 'Control+K Meta+K';

export type GlobalRunPaletteShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'
>;

/** Exact global chord. Ctrl/Cmd+Shift+K and IME composition remain owned by
 * the focused control; holding the accepted chord is suppressed by the
 * controller without minting additional palettes. */
export const isGlobalRunPaletteShortcut = (
  event: GlobalRunPaletteShortcutEvent,
): boolean =>
  !event.isComposing
  && !event.altKey
  && !event.shiftKey
  && (event.ctrlKey || event.metaKey)
  && event.key.toLowerCase() === 'k';

export interface GlobalRunPaletteOptions {
  readonly document: Document;
  /** Persistent shell slot that owns the visible launcher. */
  readonly triggerHost: HTMLElement;
  /** Route-independent portal, normally document.body. */
  readonly portal: HTMLElement;
  readonly palette: Omit<RunPaletteOptions, 'document' | 'onClose'>;
  /** Close transient shell chrome (such as the navigation drawer) before the
   * modal captures its opener. */
  readonly prepareOpen?: () => void;
}

export interface GlobalRunPaletteHandle {
  readonly trigger: HTMLButtonElement;
  /** Open or re-focus the one palette. False means another modal owns the UI. */
  open(): boolean;
  /** Force-close during an accepted route leave or app teardown. */
  close(): void;
  isOpen(): boolean;
  hasInFlightWork(): boolean;
  dispose(): void;
}

const shortcutDisplay = (doc: Document): string => {
  const platform = doc.defaultView?.navigator?.platform
    ?? (globalThis as { navigator?: Navigator }).navigator?.platform
    ?? '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl K';
};

const blockingModal = (doc: Document): Element | null => {
  const queryAll = (doc as Document & {
    querySelectorAll?: (selector: string) => Iterable<Element>;
  }).querySelectorAll;
  if (typeof queryAll !== 'function') return null;
  for (const candidate of queryAll.call(doc, '[aria-modal="true"]')) {
    if (
      candidate.hasAttribute('hidden')
      || candidate.getAttribute('aria-hidden') === 'true'
    ) continue;
    const getClientRects = (candidate as Element & {
      getClientRects?: () => { readonly length: number };
    }).getClientRects;
    // Real DOM: exclude route-owned dialog shells that remain mounted under
    // display:none. Minimal test DOMs without layout treat a present modal as
    // active, which is the conservative fallback.
    if (
      typeof getClientRects !== 'function'
      || getClientRects.call(candidate).length > 0
    ) return candidate;
  }
  return null;
};

export const mountGlobalRunPalette = (
  opts: GlobalRunPaletteOptions,
): GlobalRunPaletteHandle => {
  const doc = opts.document;
  let palette: RunPaletteHandle | null = null;
  let disposed = false;

  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.setAttribute(GLOBAL_RUN_PALETTE_TRIGGER_ATTR, '');
  trigger.setAttribute('aria-label', 'Run a recipe');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-keyshortcuts', GLOBAL_RUN_PALETTE_SHORTCUT);
  const shortcut = shortcutDisplay(doc);
  trigger.setAttribute('title', `Run a recipe (${shortcut})`);

  const glyph = doc.createElement('span');
  glyph.className = 'webclient-global-run-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '▶';
  const label = doc.createElement('span');
  label.className = 'webclient-global-run-label';
  label.textContent = 'Run';
  const key = doc.createElement('kbd');
  key.className = 'webclient-global-run-key';
  key.setAttribute('aria-hidden', 'true');
  key.textContent = shortcut;
  trigger.appendChild(glyph);
  trigger.appendChild(label);
  trigger.appendChild(key);
  opts.triggerHost.appendChild(trigger);

  const close = (): void => {
    if (palette === null) return;
    const open = palette;
    palette = null;
    open.destroy();
  };

  const open = (): boolean => {
    if (disposed) return false;
    if (palette !== null) {
      palette.focus();
      return true;
    }
    // A modal already owns focus and Escape. Non-modal Account/Attention
    // popovers close naturally when the palette takes focus.
    if (blockingModal(doc) !== null) return false;
    opts.prepareOpen?.();
    palette = wireRunPalette({
      document: doc,
      ...opts.palette,
      onClose: () => {
        palette = null;
      },
    });
    opts.portal.appendChild(palette.element);
    return true;
  };

  trigger.addEventListener('click', () => {
    open();
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isGlobalRunPaletteShortcut(event)) return;
    // Claim every accepted chord, including repeats and a chord pressed while
    // another modal is active, so the browser does not pull focus out of the
    // app into its own search UI.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    open();
  };
  doc.addEventListener('keydown', onKeydown, true);

  return {
    trigger,
    open,
    close,
    isOpen: () => palette !== null,
    hasInFlightWork: () => palette?.hasInFlightWork() === true,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener('keydown', onKeydown, true);
      close();
      trigger.remove();
    },
  };
};
