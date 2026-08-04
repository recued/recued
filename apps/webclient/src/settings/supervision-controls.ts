/** Supervision feature — pack-detail "supervised daemon" controls (Slice 4).
 *
 *  A self-contained controller that owns the `supervision.list` state and the
 *  optimistic-set → re-list reconcile flow, and renders a per-pack control group
 *  inside the packs panel's row. Kept out of the 132 KB `packs-panel.ts`: the
 *  panel just instantiates one controller, calls `refresh()` alongside its own
 *  `packs.list` load, appends `renderForPack(pack)` per row, and `dispose()`s.
 *
 *  Discovery: `supervision.list` returns EVERY supervisable daemon op (keyed
 *  `(ingredient_slug, op)`), un-enrolled ones as `mode:'off'`. A row is shown
 *  under a pack when the daemon's `ingredient_slug` matches one of the pack
 *  manifest's ingredient content refs (`slug` / `ingredient_id`). The single
 *  daemon (one per ingredient-op) thus appears under the pack that ships it.
 *
 *  The control is the off/manual/auto mode flip (an active-mode `rx-btn-primary`
 *  among `rx-btn-secondary`s — no custom segmented-control CSS) + Start/Stop
 *  (when enrolled) + a state pill (running neutral, crashed = the lone danger
 *  tone). Enrol requires the op's `required_args` (e.g. cloudflared
 *  `tunnel_name`) — collected inline; the server rejects a missing one.
 *
 *  Optimistic flow mirrors `pack-access-controls.ts`: mark the op pending +
 *  invalidate any in-flight list, fire `supervision.set`, then ALWAYS re-list to
 *  reconcile true server state, surfacing the first failure on a per-row error.
 */
import type {
  CliReachabilityUniverseResponse,
  PackListEntry,
  SupervisionDaemonRow,
  SupervisionListResponse,
  SupervisionMode,
  SupervisionSetRequest,
} from '@recued/contracts';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

export type SupervisionListCaller = () => Promise<SupervisionListResponse>;
export type SupervisionSetCaller = (
  req: SupervisionSetRequest,
) => Promise<SupervisionDaemonRow | null>;
/** `cli.reachability.universe` caller — the installed cli-tool universe, reused
 *  from `cli.reachability.universe`. The controller maps each tool's `catalog_slugs`
 *  → `reachable` so a daemon row can show whether its binary is on the server's
 *  PATH (and gate Start/Auto when it definitively is not). */
export type SupervisionReachabilityCaller = () => Promise<CliReachabilityUniverseResponse>;

export interface SupervisionControllerOptions {
  /** DOM document seam (mirrors the packs panel's). */
  document: Document;
  /** `supervision.list` caller (discovery + state). Absent ⇒ no controls. */
  runList?: SupervisionListCaller;
  /** `supervision.set` caller (enrol / flip / start / stop). Absent ⇒ no
   *  controls (read-only host). */
  runSet?: SupervisionSetCaller;
  /** `cli.reachability.universe` caller. When present, a daemon row whose binary
   *  is NOT on the server's PATH shows a "not installed" badge and gates its
   *  enrol/start controls (enrolling an uninstalled daemon to `auto` just
   *  crash-loops to `permanently_crashed`). Absent ⇒ no readiness signal. */
  runReachabilityUniverse?: SupervisionReachabilityCaller;
  /** Re-render the host panel after the controller's state changes (a refresh
   *  landed, an op went pending, a set reconciled). */
  onChange: () => void;
  /** D-121 broadcast subscriber. When provided, the controller subscribes to
   *  the `supervision` kind and re-lists on it — so a daemon that crashed /
   *  auto-restarted / hit the ceiling on the server surfaces live, without a
   *  manual refresh. Dispose unsubscribes. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface SupervisionController {
  /** True when the set caller is wired (controls render). */
  readonly enabled: boolean;
  /** Load `supervision.list` into state. Called on mount + alongside the host's
   *  refresh. Generation-guarded — a stale load is dropped. */
  refresh(): Promise<void>;
  /** The control group for a pack's daemon ops, or null when the pack ships
   *  none (or no set caller). */
  renderForPack(pack: PackListEntry): HTMLElement | null;
  /** Test seam — the current discovered/enrolled rows. */
  rows(): ReadonlyArray<SupervisionDaemonRow>;
  dispose(): void;
}

/** Data attrs (stable test hooks). */
export const SUPERVISION_SECTION_ATTR = 'data-recued-supervision';
export const SUPERVISION_ROW_ATTR = 'data-recued-daemon';
export const SUPERVISION_MODE_BTN_ATTR = 'data-recued-daemon-mode';
export const SUPERVISION_TOGGLE_ATTR = 'data-recued-daemon-toggle';
export const SUPERVISION_STATE_ATTR = 'data-recued-daemon-state';
export const SUPERVISION_ARG_ATTR = 'data-recued-daemon-arg';
export const SUPERVISION_ERROR_ATTR = 'data-recued-daemon-error';
/** Present on the "not installed" badge when the daemon's binary is not on the
 *  server's PATH (`reachable === false`). */
export const SUPERVISION_NOT_INSTALLED_ATTR = 'data-recued-daemon-not-installed';

const MODES: ReadonlyArray<{ mode: SupervisionMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'manual', label: 'Manual' },
  { mode: 'auto', label: 'Auto' },
];

/** D-118 ServiceState → display label + badge tone. `running` is the neutral
 *  `ok` tone (the theme has no green — `crashed` carries the lone danger tone). */
const STATE_DISPLAY: Record<
  SupervisionDaemonRow['state'],
  { label: string; tone: 'ok' | 'idle' | 'off' | 'neutral' }
> = {
  running: { label: 'Running', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'idle' },
  crashed: { label: 'Crashed', tone: 'off' },
  permanently_crashed: { label: 'Failed', tone: 'off' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

/** A separator that can never appear in an ingredient_slug / op. */
const SEP = String.fromCharCode(0x1f);
const opKey = (ingredient_slug: string, op: string): string =>
  [ingredient_slug, op].join(SEP);

/** The catalog ingredient slugs a pack ships — the keys a discovered daemon
 *  row's `ingredient_slug` is matched against. The daemon packs (cloudflared,
 *  ollama) are `type:'composition'` content refs (D-182 §4), whose
 *  `composition.slug` IS the catalog identity the decomposer registers the
 *  manifest under (== the discovered `ingredient_slug`); plain `type:'ingredient'`
 *  refs are also handled for non-composition packs. */
const packIngredientSlugs = (pack: PackListEntry): Set<string> => {
  const slugs = new Set<string>();
  // Supervision applies to an INSTALLED pack's ingredients; no manifest ⇒ none.
  for (const ref of pack.manifest?.contents ?? []) {
    if (ref.type === 'ingredient') {
      if (ref.slug) slugs.add(ref.slug);
      if (ref.ingredient_id) slugs.add(ref.ingredient_id);
    } else if (ref.type === 'composition') {
      const comp = ref.composition;
      if (comp.slug) slugs.add(comp.slug);
      for (const ing of comp.ingredients ?? []) {
        if (ing.slug) slugs.add(ing.slug);
      }
    }
  }
  return slugs;
};

export const createSupervisionController = (
  opts: SupervisionControllerOptions,
): SupervisionController => {
  const doc = opts.document;
  const runList = opts.runList;
  const runSet = opts.runSet;
  const runReachabilityUniverse = opts.runReachabilityUniverse;

  let rows: SupervisionDaemonRow[] = [];
  /** Per cli-ingredient-slug binary readiness, derived from the reachability
   *  universe's `tool.catalog_slugs` → `{ tool, reachable }`. `reachable` is the
   *  PROACTIVE "binary on PATH" hint (false ⇒ not installed); undefined ⇒ unknown
   *  (not probed / no caller) — only a definitive `false` gates the controls. */
  let reachableBySlug = new Map<string, { tool: string; reachable?: boolean }>();
  let generation = 0;
  let disposed = false;
  /** Ops with a `supervision.set` in flight (keyed `opKey`). */
  const pending = new Set<string>();
  /** Per-op last error (keyed `opKey`). */
  const errors = new Map<string, string>();
  /** Per-op enrol-arg drafts (keyed `opKey` → arg key → value). */
  const argDrafts = new Map<string, Record<string, string>>();

  /** Flatten the reachability universe into a per-slug lookup. A cli ingredient
   *  invokes exactly one tool, so a `catalog_slug` appears under one tool entry. */
  const buildReachableMap = (
    universe: CliReachabilityUniverseResponse,
  ): Map<string, { tool: string; reachable?: boolean }> => {
    const m = new Map<string, { tool: string; reachable?: boolean }>();
    for (const t of universe.tools) {
      for (const slug of t.catalog_slugs) {
        m.set(slug, { tool: t.tool, reachable: t.reachable });
      }
    }
    return m;
  };

  const refresh = async (): Promise<void> => {
    if (disposed || !runList) return;
    const captured = ++generation;
    try {
      // Load the daemon list + the reachability universe in parallel. The
      // universe is a best-effort readiness HINT — a probe failure must never
      // drop the daemon list, so it resolves to undefined on its own rejection.
      const [res, universe] = await Promise.all([
        runList(),
        runReachabilityUniverse ? runReachabilityUniverse().catch(() => undefined) : Promise.resolve(undefined),
      ]);
      if (disposed || captured !== generation) return; // stale load — drop
      rows = res.daemons;
      // Replace the readiness map every fresh load. A best-effort probe failure
      // (universe === undefined) CLEARS it → readiness becomes UNKNOWN and the
      // controls re-enable (the undefined-is-permissive rule), rather than
      // freezing a stale `false` that would keep gating on data we no longer have.
      reachableBySlug = universe ? buildReachableMap(universe) : new Map();
    } catch {
      /* keep prior rows on a transient list failure */
    }
  };

  const draftFor = (key: string): Record<string, string> => {
    let d = argDrafts.get(key);
    if (!d) {
      d = {};
      argDrafts.set(key, d);
    }
    return d;
  };

  /** Apply the authoritative `supervision.set` result to the local row BEFORE
   *  the reconcile re-list — so a reconcile that is raced-stale or fails can't
   *  revert the change the server already accepted (and the UI updates at once).
   *  A null result (an `off` un-enrol) resets the row to its `off` state; the
   *  reconcile then restores the declared default policy. */
  const applyOptimistic = (req: SupervisionSetRequest, result: SupervisionDaemonRow | null): void => {
    const idx = rows.findIndex((r) => r.ingredient_slug === req.ingredient_slug && r.op === req.op);
    if (idx < 0) return;
    const next = [...rows];
    next[idx] = result ?? {
      ...rows[idx],
      mode: 'off',
      enabled: false,
      state: 'unknown',
      pid: null,
      started_at: null,
      consecutive_crashes: 0,
      last_crash_at: null,
      last_exit_code: null,
    };
    rows = next;
  };

  /** Fire one `supervision.set`: optimistic pending + list invalidation, apply
   *  the authoritative result, then ALWAYS re-list to reconcile, surfacing the
   *  first failure on the row. */
  const doSet = async (req: SupervisionSetRequest): Promise<void> => {
    if (!runSet) return;
    const key = opKey(req.ingredient_slug, req.op);
    if (pending.has(key)) return; // entry guard — one set per op at a time
    pending.add(key);
    errors.delete(key);
    generation += 1; // a refresh in-flight when the set started is now stale
    opts.onChange();
    try {
      applyOptimistic(req, await runSet(req));
    } catch (err) {
      errors.set(key, err instanceof Error ? err.message : String(err));
    } finally {
      pending.delete(key);
      await refresh(); // reconcile true server state (corrects any drift)
      opts.onChange();
    }
  };

  /** Build the `args` payload for an enrol/flip: the draft when it satisfies
   *  every required arg, else undefined (the server preserves stored args — the
   *  Start/Stop + manual↔auto re-flip path). */
  const argsForSet = (row: SupervisionDaemonRow, key: string): Record<string, unknown> | undefined => {
    if (row.required_args.length === 0) return undefined;
    const draft = argDrafts.get(key) ?? {};
    const complete = row.required_args.every((a) => (draft[a] ?? '').trim() !== '');
    if (!complete) return undefined;
    const out: Record<string, unknown> = {};
    for (const a of row.required_args) out[a] = draft[a];
    return out;
  };

  const button = (
    label: string,
    variant: 'primary' | 'secondary' | 'danger',
    onClick: () => void,
    attrs: Record<string, string> = {},
  ): HTMLElement => {
    const b = doc.createElement('button');
    b.className = `rx-btn rx-btn-${variant} rx-btn-sm`;
    b.textContent = label;
    b.setAttribute('type', 'button');
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    b.addEventListener('click', onClick);
    return b;
  };

  const statePill = (row: SupervisionDaemonRow): HTMLElement => {
    const d = STATE_DISPLAY[row.state] ?? STATE_DISPLAY.unknown;
    const span = doc.createElement('span');
    span.className = `rx-badge rx-badge-${d.tone}`;
    span.setAttribute(SUPERVISION_STATE_ATTR, row.state);
    span.textContent = d.label;
    return span;
  };

  const renderArgInputs = (row: SupervisionDaemonRow, key: string): HTMLElement | null => {
    if (row.required_args.length === 0) return null;
    const draft = draftFor(key);
    const fields = doc.createElement('div');
    fields.className = 'packs-supervision-args';
    for (const arg of row.required_args) {
      const label = doc.createElement('label');
      label.className = 'packs-supervision-arg';
      label.textContent = arg;
      const input = doc.createElement('input');
      input.setAttribute('type', 'text');
      input.setAttribute(SUPERVISION_ARG_ATTR, arg);
      input.setAttribute('placeholder', arg);
      if (draft[arg] !== undefined) input.value = draft[arg];
      input.addEventListener('input', () => { draft[arg] = input.value; });
      label.appendChild(input);
      fields.appendChild(label);
    }
    return fields;
  };

  const renderDaemonRow = (row: SupervisionDaemonRow): HTMLElement => {
    const key = opKey(row.ingredient_slug, row.op);
    const isPending = pending.has(key);
    // Binary readiness — only a DEFINITIVE `reachable === false` gates controls;
    // unknown (undefined) leaves them as-is (don't block on a missing probe).
    const reach = reachableBySlug.get(row.ingredient_slug);
    const notInstalled = reach?.reachable === false;
    const notInstalledMsg =
      (reach?.tool ?? row.ingredient_slug)
      + " is not installed on the server (not on PATH) — install it to run this daemon";
    const wrap = doc.createElement('div');
    wrap.className = 'packs-supervision-row';
    wrap.setAttribute(SUPERVISION_ROW_ATTR, [row.ingredient_slug, row.op].join(':'));

    // Heading: op name + "supervised daemon" badge + (when enrolled) state pill.
    const head = doc.createElement('div');
    head.className = 'packs-supervision-head';
    const name = doc.createElement('span');
    name.className = 'packs-supervision-op';
    name.textContent = row.op;
    head.appendChild(name);
    const tag = doc.createElement('span');
    tag.className = 'rx-badge rx-badge-accent';
    tag.textContent = 'daemon';
    head.appendChild(tag);
    // "not installed" badge — the binary the daemon launches isn't on PATH, so a
    // start would just crash-loop. Surfaced here (the same #packs route the
    // Local-tools grid lives in) so the install state sits with the daemon control.
    if (notInstalled) {
      const ni = doc.createElement('span');
      ni.className = 'rx-badge rx-badge-off';
      ni.setAttribute(SUPERVISION_NOT_INSTALLED_ATTR, '');
      ni.setAttribute('title', notInstalledMsg);
      ni.textContent = 'not installed';
      head.appendChild(ni);
    }
    if (row.mode !== 'off') head.appendChild(statePill(row));
    wrap.appendChild(head);

    // Mode flip: off / manual / auto (active = primary).
    const modeRow = doc.createElement('div');
    modeRow.className = 'packs-supervision-modes';
    for (const { mode, label } of MODES) {
      const active = row.mode === mode;
      const b = button(
        label,
        active ? 'primary' : 'secondary',
        () => {
          if (isPending || active) return;
          if (mode === 'off') {
            void doSet({ ingredient_slug: row.ingredient_slug, op: row.op, mode: 'off' });
            return;
          }
          void doSet({
            ingredient_slug: row.ingredient_slug,
            op: row.op,
            mode,
            enabled: true,
            ...(argsForSet(row, key) ? { args: argsForSet(row, key) } : {}),
          });
        },
        { [SUPERVISION_MODE_BTN_ATTR]: mode, 'aria-pressed': String(active) },
      );
      if (isPending) b.setAttribute('disabled', '');
      // Uninstalled binary: block enrolling to manual|auto (both enrol-and-start,
      // so they'd crash immediately; auto then crash-loops to permanently_crashed).
      // 'off' and the current (active) mode stay clickable — un-enrol is always allowed.
      if (notInstalled && mode !== 'off' && !active) {
        b.setAttribute('disabled', '');
        b.setAttribute('title', notInstalledMsg);
      }
      modeRow.appendChild(b);
    }
    wrap.appendChild(modeRow);

    // Args (enrol inputs) — shown whenever the op declares required args.
    const args = renderArgInputs(row, key);
    if (args) wrap.appendChild(args);

    // Start / Stop — only meaningful once enrolled (manual/auto).
    if (row.mode !== 'off') {
      const toggle = button(
        row.enabled ? 'Stop' : 'Start',
        row.enabled ? 'danger' : 'secondary',
        () => {
          if (isPending) return;
          void doSet({
            ingredient_slug: row.ingredient_slug,
            op: row.op,
            mode: row.mode,
            enabled: !row.enabled,
          });
        },
        { [SUPERVISION_TOGGLE_ATTR]: row.enabled ? 'stop' : 'start' },
      );
      if (isPending) toggle.setAttribute('disabled', '');
      // Block Start when the binary isn't installed; Stop stays enabled (a daemon
      // whose binary was removed while running must still be stoppable).
      if (notInstalled && !row.enabled) {
        toggle.setAttribute('disabled', '');
        toggle.setAttribute('title', notInstalledMsg);
      }
      wrap.appendChild(toggle);
    }

    // Per-row error (a rejected set — e.g. missing required arg).
    const err = errors.get(key);
    if (err) {
      const errEl = doc.createElement('div');
      errEl.className = 'packs-supervision-error';
      errEl.setAttribute(SUPERVISION_ERROR_ATTR, '');
      errEl.textContent = err;
      wrap.appendChild(errEl);
    }

    return wrap;
  };

  const renderForPack = (pack: PackListEntry): HTMLElement | null => {
    if (!runSet) return null; // read-only host — no enrol control
    const slugs = packIngredientSlugs(pack);
    const daemonRows = rows.filter((r) => slugs.has(r.ingredient_slug));
    if (daemonRows.length === 0) return null;
    const section = doc.createElement('div');
    section.className = 'packs-supervision';
    section.setAttribute(SUPERVISION_SECTION_ATTR, '');
    const title = doc.createElement('div');
    title.className = 'packs-supervision-title';
    title.textContent = 'Supervised daemons';
    section.appendChild(title);
    for (const row of daemonRows) section.appendChild(renderDaemonRow(row));
    return section;
  };

  // Live-state push — re-list on a `supervision` broadcast (a daemon crashed /
  // auto-restarted / hit the ceiling / was stopped on the server, or another
  // paired client flipped it). The narrow event carries no blob; we re-list for
  // authoritative state, then re-render. Best-effort; dropped on dispose. Only
  // subscribed when the controls actually render (`runSet` present) — a
  // read-only host renders nothing, so a re-list would be wasted.
  const unsubscribe = runSet
    ? opts.subscribe?.('supervision', () => {
        void refresh().then(() => { if (!disposed) opts.onChange(); });
      })
    : undefined;

  return {
    enabled: runSet !== undefined,
    refresh,
    renderForPack,
    rows: () => rows,
    dispose: () => {
      disposed = true;
      try { unsubscribe?.(); } catch { /* best-effort teardown */ }
    },
  };
};
