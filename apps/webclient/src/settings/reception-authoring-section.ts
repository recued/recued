/** Reception ▸ Endpoints ▸ authoring — the routed full-page per-kind
 *  authoring form (`#reception/endpoints/new|edit/<kind>`, R19 Slice 2).
 *
 *  ── Why this exists (the owner's "can't enable" fix) ──────────────
 *  Pre-R19, every authoring form mounted into the Settings `modalHost`
 *  overlay — a `rgba(0,0,0,0.4)` backdrop with a `.reception-form` that
 *  carried no surface of its own, so the form rendered TRANSPARENT over
 *  the dark backdrop: invisible, unusable, "reception not completed /
 *  can't enable". R19 promotes the authoring form OUT of that modal into
 *  a routed FULL PAGE that flows in the route content host on the normal
 *  page background. This module is that page.
 *
 *  ── What it owns ──────────────────────────────────────────────────
 *    - **Chrome.** A "← Endpoints" back-link (a plain anchor — native
 *      hash nav, no dispatcher) + a child form host. Built with
 *      `doc.createElement` (the inbox-panel / bootstrap DOM-boundary
 *      idiom; the form host is a real element so the string-rendered
 *      `mountAuthoringForm` inside it behaves exactly as in the modal).
 *    - **Seed resolution.** Three sources, in precedence order:
 *        1. a TRANSIENT seed stashed by the templates browser / AI-propose
 *           pick (`stashReceptionAuthoringSeed` → `consumeAuthoringSeed`)
 *           — a `#…/new/<kind>` hash can't carry a full working config, so
 *           the page-host hands the already-resolved seed off out of band;
 *        2. `edit` + `reception_page` → fetch `reception.page.get` FIRST,
 *           seed the form once it resolves (fetch-before-seed closes the
 *           stale-`null` overwrite race the modal path guarded with
 *           `resolvePageConfig` + `gateEditPage` — the section always
 *           re-reads the live singleton, so no gate is needed here);
 *        3. otherwise a fresh `new` create (no seed).
 *    - **Share capture on close.** A successful link-kind create returns a
 *      one-shot `share_url_once` the shell never re-surfaces; the section
 *      registers it via `shell.setEndpointShare` (reusing the page-host's
 *      `buildShareInputForCreate`) — identical to the modal path — so the
 *      endpoint's `openDetail` draws the § A.20.4 Share Cards. It then
 *      navigates to that new endpoint's DETAIL (`onNavigateToDetail`) so the
 *      one-shot cards surface immediately; a cancel / share-less singleton /
 *      an unwired navigator falls back to the endpoints list (`onBack`).
 *
 *  The form body itself is the unchanged `mountAuthoringForm` — this
 *  module only relocates it from a modal satellite to a routed page +
 *  wires the back / create-close navigation.
 *
 *  Design record: `recued-project/handovers/webclient-ia-treemap.md` §9
 *  + Review log R19 / R19.1. */

import { emptyHint, panel } from '@recued/ui-shared/primitives';

import type {
  Conn,
  PacketDeclaration,
  ReceptionEndpointCreateResult,
  ReceptionEndpointKind,
  ServerRpcRegistry,
} from '@recued/contracts';

import { serializeShellRoute } from '../shell/route.js';
import {
  mountAuthoringForm,
  type AuthoringFormMount,
} from './reception-authoring-mount.js';
import {
  buildDefaultPacketDeclaration,
  buildShareInputForCreate,
} from './reception-page-host.js';
import { isReceptionEndpointKindAvailable } from './reception.js';
import type { ReceptionPageShell } from './reception-page-shell.js';

// ════════════════════════════════════════════════════════════════
// Transient seed handoff (templates / AI-propose → routed form)
// ════════════════════════════════════════════════════════════════

/** The one in-flight seed handed off from a templates-browser / AI pick
 *  to the routed authoring page. Module-level because the handoff spans a
 *  route RE-MOUNT (the page-host stashes it, then navigation tears the
 *  whole route down + re-bootstraps; a closure couldn't survive that). It
 *  is strictly single-use — `consumeAuthoringSeed` clears it on the next
 *  section mount whether or not the kind matches, so a stale seed can
 *  never bleed into an unrelated form. Lost on a hard refresh (the URL
 *  carries no config) → the form degrades to a blank create of that kind,
 *  the same graceful fallback the modal path takes for an unloaded
 *  template. */
let pendingAuthoringSeed: {
  readonly kind: ReceptionEndpointKind;
  readonly config: object;
} | null = null;

/** Stash a resolved working config for the routed authoring page to pick
 *  up. Called by the route layer's `onEnterAuthoring` impl immediately
 *  before it navigates to `#reception/endpoints/new/<kind>` (templates /
 *  AI-propose picks — the only authoring entries that carry a seed). */
export const stashReceptionAuthoringSeed = (
  kind: ReceptionEndpointKind,
  config: object,
): void => {
  pendingAuthoringSeed = { kind, config };
};

/** Read + clear the stashed seed. Returns the config only when it was
 *  stashed for THIS kind; clears unconditionally (single-use) so a
 *  mismatched leftover is discarded rather than reused. */
const consumeAuthoringSeed = (kind: ReceptionEndpointKind): object | null => {
  const seed = pendingAuthoringSeed;
  pendingAuthoringSeed = null;
  return seed !== null && seed.kind === kind ? seed.config : null;
};

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export interface ReceptionAuthoringSectionOptions {
  /** Route content host — the section appends its chrome here + clears
   *  it on dispose. */
  host: HTMLElement;
  /** The SHARED reception page shell — the embedded `mountAuthoringForm`
   *  drives `runPreview` / `createEndpoint` / `upsertReceptionPage`
   *  through it, and the section registers the create result's share URL
   *  via `setEndpointShare`. */
  shell: ReceptionPageShell;
  /** Typed rpc — the `edit` + `reception_page` path fetches the live
   *  singleton config. The wider route conn satisfies this narrowed slice
   *  by contravariance. */
  conn: Conn<Pick<ServerRpcRegistry, 'reception.page.get'>>;
  /** Route verb — `new` (fresh create) vs `edit` (re-read + seed). */
  mode: 'new' | 'edit';
  /** Which per-kind authoring form to render. */
  kind: ReceptionEndpointKind;
  /** Navigate back to the endpoints list — fired on cancel close, and on a
   *  create when no detail navigator is wired. The route layer points this
   *  at `#reception/endpoints`. */
  onBack: () => void;
  /** Navigate to the just-created endpoint's detail
   *  (`#reception/endpoints/<id>`) so its one-shot Share Cards surface
   *  immediately — the whole point of a link create. Fired on a successful
   *  link-kind create IN PLACE OF `onBack`. Absent (older non-routed
   *  compositions + tests) ⇒ the create falls back to `onBack` (the list).
   *  The route layer points this at the Slice-4 detail deep link. */
  onNavigateToDetail?: (endpointId: string) => void;
  /** DOM document seam — defaults to `globalThis.document`. Throws if
   *  neither is available (non-browser env without an override). */
  document?: Document;
  /** Override the packet-declaration factory the embedded form uses for
   *  its link-kind preview / create dispatch. Defaults to
   *  `buildDefaultPacketDeclaration`. */
  buildPacketDeclaration?: (
    kind: ReceptionEndpointKind,
    config: object,
  ) => PacketDeclaration | null;
  /** Clock seam — defaults to `Date.now`. Threaded into the form's
   *  expiry derivation + the share-card expiry note. */
  now?: () => number;
}

export interface ReceptionAuthoringSectionMount {
  /** Re-render the embedded form from its working config. */
  update(): void;
  /** Tear down the embedded form + remove the chrome. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// mountReceptionAuthoringSection
// ════════════════════════════════════════════════════════════════

export const mountReceptionAuthoringSection = (
  opts: ReceptionAuthoringSectionOptions,
): ReceptionAuthoringSectionMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountReceptionAuthoringSection: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const { host, shell, kind, mode } = opts;
  const now = opts.now ?? ((): number => Date.now());
  const buildPacket =
    opts.buildPacketDeclaration ?? buildDefaultPacketDeclaration;

  // ── Chrome: wrapper + back-link + child form host ──
  const root = doc.createElement('div');
  root.className = 'reception-page reception-authoring-section';
  // A queryable mount marker (carries the route verb) — the bootstrap
  // routing tests assert the authoring page mounted instead of the spine.
  root.setAttribute('data-reception-authoring-section', mode);

  const header = doc.createElement('header');
  header.className = 'reception-authoring-section-head';
  const back = doc.createElement('a');
  back.className = 'reception-authoring-back';
  // A plain anchor (no `data-action`) — the click is native hash nav, so
  // it is NOT caught by the form's action dispatcher (which lives on the
  // child form host below + would preventDefault it).
  back.setAttribute('href', serializeShellRoute('reception', 'endpoints'));
  back.textContent = '← Endpoints';
  header.appendChild(back);
  root.appendChild(header);

  const formHost = doc.createElement('div');
  formHost.className = 'reception-authoring-section-form';
  root.appendChild(formHost);
  host.appendChild(root);

  let form: AuthoringFormMount | null = null;
  let disposed = false;

  /** Capture the one-shot share URL (link kinds only — `reception_page`
   *  has no share path) then navigate back. Mirrors the modal host's
   *  create-close handler so the Share Cards surface identically whether
   *  the form was modal or routed.
   *
   *  The share is registered even if the section was disposed mid-create
   *  (the shared shell outlives the section, and the URL is one-shot — same
   *  as the modal host's late-resolve behavior). But navigation is GUARDED
   *  on `disposed`: a create that resolves after the user already left must
   *  not yank them back to the endpoints list (Codex MEDIUM). */
  const onClose = (result?: ReceptionEndpointCreateResult): void => {
    if (result !== undefined && isReceptionEndpointKindAvailable(kind)) {
      shell.setEndpointShare(
        result.endpoint_id,
        buildShareInputForCreate(kind, result, null, now()),
      );
    }
    if (disposed) return;
    // Land on the new endpoint's detail so its one-shot Share Cards surface
    // immediately (the whole point of a link create); fall back to the list
    // for the share-less singleton / a cancel / when no detail nav is wired.
    if (
      result !== undefined
      && isReceptionEndpointKindAvailable(kind)
      && opts.onNavigateToDetail !== undefined
    ) {
      opts.onNavigateToDetail(result.endpoint_id);
      return;
    }
    opts.onBack();
  };

  const mountForm = (initialConfig: object | null): void => {
    if (disposed) return;
    form = mountAuthoringForm({
      host: formHost,
      shell,
      kind,
      now,
      ...(initialConfig !== null ? { initialConfig } : {}),
      // The singleton ignores its packet declaration (no D-145 wrapper on
      // `page.upsert`); omit the factory for it (mirrors the page host).
      ...(kind !== 'reception_page'
        ? {
            buildPacketDeclaration: (config: object): PacketDeclaration | null =>
              buildPacket(kind, config),
          }
        : {}),
      onClose,
    });
  };

  // ── Seed resolution (precedence: stashed seed → edit-fetch → blank) ──
  const seed = consumeAuthoringSeed(kind);
  if (seed !== null) {
    mountForm(seed);
  } else if (mode === 'edit' && kind === 'reception_page') {
    // Re-read the live singleton FIRST — a fresh fetch every time closes
    // the stale-`null` overwrite race without a gate. `config: null` (no
    // singleton yet) seeds a blank "Set up page" form; a present config
    // seeds the "Edit page" form. Loading hint until it resolves.
    formHost.innerHTML = emptyHint({ message: 'Loading page…' });
    void opts
      .conn('reception.page.get')
      .then((res) => {
        // `config: null` is the TRUE fresh-install case (no singleton yet)
        // → a blank "Set up page" form is correct.
        if (disposed) return;
        mountForm(res.config ?? null);
      })
      .catch(() => {
        // A read FAILURE is NOT the same as "no singleton": we don't know
        // whether a page exists, so opening a blank submittable form would
        // risk overwriting an existing page on a transient blip (Codex
        // HIGH). Show an error instead — the back-link (chrome) lets the
        // user retry by re-entering edit, which re-fetches.
        if (disposed) return;
        formHost.innerHTML = panel({
          tone: 'danger',
          role: 'alert',
          title: 'Could not load the page',
          body: '<p class="reception-error-copy">The current page configuration could not be loaded. Go back and try again — editing now could overwrite it.</p>',
        });
      });
  } else {
    // Fresh `new` create (or a fresh `new` reception_page from the create
    // button) — blank seed, "Set up" / "New" heading.
    mountForm(null);
  }

  return {
    update: () => {
      if (disposed) return;
      form?.update();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      form?.dispose();
      try {
        host.removeChild(root);
      } catch {
        root.remove();
      }
    },
  };
};
