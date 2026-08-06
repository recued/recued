/** Discover — the [Installed | Discover] tab shell.
 *
 *  Wraps an existing route (`#packs` / `#recipes`) WITHOUT touching it: the
 *  route mounts, unchanged, into the "Installed" tab's host; the marketplace
 *  browse panel mounts (lazily, on first activation — no catalog fetch until the
 *  user opens Discover) into the "Discover" tab's host. The router only needs
 *  `{ dispose }`, so this returns that, tearing down both children.
 *
 *  Composition-layer only — it lives beside the routes rather than inside them,
 *  which keeps the innerHTML-repainting recipes route + the node-based packs
 *  route each free to render however they already do.
 */

export type DiscoveryTab = 'installed' | 'discover';

export const DISCOVERY_SURFACE_HOST_ATTR = 'data-recued-discovery-surface';
export const DISCOVERY_SURFACE_TAB_ATTR = 'data-recued-discovery-tab';
export const DISCOVERY_SURFACE_INSTALLED_ATTR = 'data-recued-discovery-installed';
export const DISCOVERY_SURFACE_DISCOVER_ATTR = 'data-recued-discovery-discover';

export interface MountDiscoverySurfaceOptions {
  root: HTMLElement;
  document?: Document;
  /** Stable DOM id prefix for the composite tabs and their owned panels. */
  idPrefix: string;
  /** Accessible name for the tab group in its host route. */
  tabListLabel: string;
  /** Mount the Installed tab (the existing route) into the given host. */
  mountInstalled: (host: HTMLElement) => DiscoverySurfaceChildMount;
  /** Mount the Discover tab (the browse panel) into the given host. Called at
   *  most once, on first Discover activation. */
  mountDiscover: (host: HTMLElement) => DiscoverySurfaceChildMount;
  initialTab?: DiscoveryTab;
  installedLabel?: string;
  discoverLabel?: string;
  /** Fired after a tab switch (host can sync a hash / analytics). */
  onTabChange?: (tab: DiscoveryTab) => void;
  /** Fired when a tab is shown that was ALREADY mounted (i.e. NOT its first
   *  activation). The host uses it to re-check freshness on a return visit —
   *  e.g. re-download the catalog to "parse the version regularly" — without
   *  paying it on the first open (which already loaded). */
  onReactivate?: (tab: DiscoveryTab) => void;
}

export interface DiscoverySurfaceChildMount {
  dispose(): void;
  /** Optional ownership seams forwarded through this composition shell. */
  hasInFlightWork?: () => boolean;
  inFlightWorkPrompt?: () => string | null;
  hasUnsavedChanges?: () => boolean;
  unsavedChangesPrompt?: () => string | null;
}

export interface DiscoverySurfaceMount {
  activeTab(): DiscoveryTab;
  showTab(tab: DiscoveryTab): void;
  hasInFlightWork(): boolean;
  inFlightWorkPrompt(): string | null;
  hasUnsavedChanges(): boolean;
  unsavedChangesPrompt(): string | null;
  dispose(): void;
}

export const mountDiscoverySurface = (
  opts: MountDiscoverySurfaceOptions,
): DiscoverySurfaceMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountDiscoverySurface: no document available — pass opts.document');
  }
  ensureStyles(doc);

  const root = doc.createElement('div');
  root.setAttribute(DISCOVERY_SURFACE_HOST_ATTR, '');

  // ── Tab bar ───────────────────────────────────────────────────────
  const tabBar = doc.createElement('div');
  tabBar.className = 'discovery-tabbar';
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', opts.tabListLabel);
  tabBar.setAttribute('aria-orientation', 'horizontal');

  const makeTab = (tab: DiscoveryTab, label: string): HTMLButtonElement => {
    const btn = doc.createElement('button') as HTMLButtonElement;
    btn.type = 'button';
    btn.className = 'discovery-tab';
    btn.setAttribute(DISCOVERY_SURFACE_TAB_ATTR, tab);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('id', `${opts.idPrefix}-${tab}-tab`);
    btn.setAttribute('aria-controls', `${opts.idPrefix}-${tab}-panel`);
    btn.textContent = label;
    btn.addEventListener('click', () => showTab(tab));
    btn.addEventListener('keydown', (ev) => onTabKeydown(ev, tab));
    return btn;
  };
  const installedTab = makeTab('installed', opts.installedLabel ?? 'Installed');
  const discoverTab = makeTab('discover', opts.discoverLabel ?? 'Discover');
  tabBar.appendChild(installedTab);
  tabBar.appendChild(discoverTab);
  root.appendChild(tabBar);

  // ── Panes ─────────────────────────────────────────────────────────
  const installedHost = doc.createElement('div');
  installedHost.setAttribute(DISCOVERY_SURFACE_INSTALLED_ATTR, '');
  installedHost.setAttribute('id', `${opts.idPrefix}-installed-panel`);
  installedHost.setAttribute('role', 'tabpanel');
  installedHost.setAttribute(
    'aria-labelledby',
    `${opts.idPrefix}-installed-tab`,
  );
  const discoverHost = doc.createElement('div');
  discoverHost.setAttribute(DISCOVERY_SURFACE_DISCOVER_ATTR, '');
  discoverHost.setAttribute('id', `${opts.idPrefix}-discover-panel`);
  discoverHost.setAttribute('role', 'tabpanel');
  discoverHost.setAttribute(
    'aria-labelledby',
    `${opts.idPrefix}-discover-tab`,
  );
  root.appendChild(installedHost);
  root.appendChild(discoverHost);

  opts.root.appendChild(root);

  // Installed mounts immediately (it's the default surface); Discover mounts
  // lazily on first activation.
  const installedMount = opts.mountInstalled(installedHost);
  let discoverMount: DiscoverySurfaceChildMount | null = null;

  let active: DiscoveryTab = opts.initialTab ?? 'installed';

  /** Tabs are one composite keyboard stop. Arrow keys both move and activate
   *  because each pane paints synchronously (Discover may then show its loading
   *  state); Home / End make the two ends explicit and the arrows wrap. */
  function onTabKeydown(ev: KeyboardEvent, current: DiscoveryTab): void {
    let next: DiscoveryTab;
    if (ev.key === 'Home') next = 'installed';
    else if (ev.key === 'End') next = 'discover';
    else if (ev.key === 'ArrowRight') {
      next = current === 'installed' ? 'discover' : 'installed';
    } else if (ev.key === 'ArrowLeft') {
      next = current === 'discover' ? 'installed' : 'discover';
    } else {
      return;
    }
    ev.preventDefault();
    showTab(next);
    const nextButton = next === 'installed' ? installedTab : discoverTab;
    nextButton.focus({ preventScroll: true });
  }

  const paint = (): void => {
    const onInstalled = active === 'installed';
    installedHost.hidden = !onInstalled;
    discoverHost.hidden = onInstalled;
    installedTab.className = onInstalled ? 'discovery-tab discovery-tab--active' : 'discovery-tab';
    discoverTab.className = onInstalled ? 'discovery-tab' : 'discovery-tab discovery-tab--active';
    installedTab.setAttribute('aria-selected', onInstalled ? 'true' : 'false');
    discoverTab.setAttribute('aria-selected', onInstalled ? 'false' : 'true');
    installedTab.tabIndex = onInstalled ? 0 : -1;
    discoverTab.tabIndex = onInstalled ? -1 : 0;
  };

  const showTab = (tab: DiscoveryTab): void => {
    // Was this pane already live BEFORE this call? Installed mounts eagerly;
    // Discover only after its first open. Drives the re-visit refresh below.
    const wasMounted = tab === 'installed' ? true : discoverMount !== null;
    if (tab === 'discover' && discoverMount === null) {
      discoverMount = opts.mountDiscover(discoverHost);
    }
    const changed = active !== tab;
    active = tab;
    paint();
    if (changed) opts.onTabChange?.(tab);
    // A switch BACK to an already-mounted pane → let the host re-check freshness
    // (first opens already loaded, so they're excluded).
    if (changed && wasMounted) opts.onReactivate?.(tab);
  };

  // Initial render — if the initial tab is Discover, mount it now.
  if (active === 'discover') discoverMount = opts.mountDiscover(discoverHost);
  paint();

  let disposed = false;
  return {
    activeTab: () => active,
    showTab,
    hasInFlightWork: () =>
      installedMount.hasInFlightWork?.() === true
      || discoverMount?.hasInFlightWork?.() === true,
    inFlightWorkPrompt: () =>
      installedMount.inFlightWorkPrompt?.()
      ?? discoverMount?.inFlightWorkPrompt?.()
      ?? null,
    hasUnsavedChanges: () =>
      installedMount.hasUnsavedChanges?.() === true
      || discoverMount?.hasUnsavedChanges?.() === true,
    unsavedChangesPrompt: () =>
      installedMount.unsavedChangesPrompt?.()
      ?? discoverMount?.unsavedChangesPrompt?.()
      ?? null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (discoverMount !== null) discoverMount.dispose();
      installedMount.dispose();
      try {
        opts.root.removeChild(root);
      } catch {
        root.remove();
      }
    },
  };
};

const STYLES_MARKER = 'data-recued-discovery-surface-styles';
const ensureStyles = (doc: Document): void => {
  if (doc.head?.querySelector?.(`style[${STYLES_MARKER}]`) != null) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLES_MARKER, '');
  style.textContent = DISCOVERY_SURFACE_STYLES;
  doc.head?.appendChild?.(style);
};

export const DISCOVERY_SURFACE_STYLES = `
[${DISCOVERY_SURFACE_HOST_ATTR}] { color: var(--fg); }
/* Full-width host: the Installed pane holds a route that ALREADY centers +
   pads its own root (max-width + margin:auto + 16px), so wrapping it must add
   no second container — zero width regression on the Installed tab. The tab bar
   + Discover pane get the matching centered treatment themselves. */
[${DISCOVERY_SURFACE_HOST_ATTR}] .discovery-tabbar {
  display: flex; gap: 4px; width: fit-content; margin: 14px auto 8px; padding: 4px;
  max-width: var(--wc-content-max, 1080px);
  border: 1px solid var(--border); border-radius: 12px; background: var(--surface-sunk);
}
[${DISCOVERY_SURFACE_HOST_ATTR}] .discovery-tab {
  min-height: 36px; font: inherit; font-size: 13px; font-weight: 650; color: var(--fg-muted);
  background: transparent; border: none; border-radius: 8px;
  padding: 8px 16px; cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
[${DISCOVERY_SURFACE_HOST_ATTR}] .discovery-tab:hover { color: var(--fg); background: var(--surface); }
[${DISCOVERY_SURFACE_HOST_ATTR}] .discovery-tab--active {
  color: var(--fg); background: var(--surface); box-shadow: 0 1px 3px rgba(24,24,27,.1);
}
[${DISCOVERY_SURFACE_HOST_ATTR}] .discovery-tab:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
[${DISCOVERY_SURFACE_DISCOVER_ATTR}] {
  max-width: var(--wc-content-max, 1080px); margin: 0 auto; padding: 14px 16px 24px;
}
[${DISCOVERY_SURFACE_INSTALLED_ATTR}][hidden],
[${DISCOVERY_SURFACE_DISCOVER_ATTR}][hidden] { display: none; }
@media (max-width: 560px) {
  [${DISCOVERY_SURFACE_HOST_ATTR}] .discovery-tabbar { width: calc(100% - 28px); }
  [${DISCOVERY_SURFACE_HOST_ATTR}] .discovery-tab { flex: 1; }
}
`;
