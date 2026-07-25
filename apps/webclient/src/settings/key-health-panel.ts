/** R26.4 Delta 3 (D-148 § A.11 / § P7) — Settings → Server → Key Health
 *  page.
 *
 *  The operator-facing Rotation Center. Renders one card per key class
 *  from the `key.health` view (full per-class `KeyHealthBundle` + the
 *  per-class `availability` map), and drives `key.rotate` for the
 *  reachable actions. The webclient never runs rotations itself — the
 *  server is the authority; this module renders + dispatches.
 *
 *  ── What actually rotates on a self-host realm ──────────────────────
 *
 *  The `availability` map (server-computed from which engine hooks are
 *  wired) drives each card's action:
 *    - `available`         — inline action(s). On self-host this is
 *      `server_identity_key`: "Rotate now" (`server_identity_rotate`) +
 *      "Mark compromised" (`mark_compromised`, cascades the rotation).
 *    - `managed_elsewhere` — no inline action; a pointer to the surface
 *      that owns it (`tls_private_key` → the TLS cert panel;
 *      `webclient_token` → Settings → Devices).
 *    - `unavailable`       — greyed; the substrate isn't loaded on this
 *      server (e.g. Master DEK / publisher identity / webhook secrets —
 *      the engine would return `key_not_loaded`).
 *
 *  ── The de-pair flow (READ before touching) ─────────────────────────
 *
 *  `server_identity_rotate` (and `mark_compromised` on
 *  `server_identity_key`, which cascades into it) revokes EVERY paired
 *  client's bearer — INCLUDING the one driving this panel. From the
 *  caller's POV the rpc either (a) resolves `{ ok: true }` and the WS
 *  drops a tick later, or (b) rejects with a transport-family
 *  `RpcError.code` when the socket closes first. BOTH mean "rotated —
 *  re-pair now"; only a NON-transport rejection (or `{ ok: false }`) is
 *  a real failure. Mirrors `archive-backup-panel.ts`'s `isTransportDrop-
 *  Error` (the same substrate behaviour). See memory
 *  `reference_webclient_restart_rpc_ws_drop`.
 *
 *  ── State machine ──────────────────────────────────────────────────
 *
 *      loading ── load ok ──▶ idle           (cards rendered)
 *      loading ── load threw ──▶ load_error
 *      load_error ── Retry ──▶ loading
 *      idle ── click action ──▶ confirm      (pendingAction set)
 *      confirm ── Cancel ──▶ idle
 *      confirm ── Yes ──▶ busy
 *      busy ── ok ──▶ done                    (re-pair variant if de-pairing)
 *      busy ── !ok / threw ──▶ error
 *      busy ── de-pair + transport drop ──▶ done (re-pair variant)
 *      done ── Close ──▶ loading              (re-fetch so banners refresh)
 *      error ── Back ──▶ idle
 *
 *  Spec: docs/d-148-spec.md § A.11 (Key Health + Rotation Center). */

import {
  type KeyClass,
  type KeyHealthEntry,
  type KeyHealthView,
  type KeyRotateRequest,
  type RotationAvailability,
  type RotationErrorCode,
  type RotationResult,
} from '@recued/contracts';

import { ROTATION_COPY, ROTATION_ERROR_COPY } from './rotation-center.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Element ids — stable for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const KEY_HEALTH_PANEL_ATTR = 'data-recued-key-health-panel';
export const KEY_HEALTH_PANEL_STATE_ATTR = 'data-recued-key-health-panel-state';
export const KEY_HEALTH_CARD_ATTR = 'data-recued-key-health-card';
export const KEY_HEALTH_CARD_CLASS_ATTR = 'data-recued-key-health-card-class';
export const KEY_HEALTH_ROTATE_BTN_ATTR = 'data-recued-key-health-rotate';
export const KEY_HEALTH_COMPROMISE_BTN_ATTR = 'data-recued-key-health-compromise';
export const KEY_HEALTH_CONFIRM_BTN_ATTR = 'data-recued-key-health-confirm';
export const KEY_HEALTH_CANCEL_BTN_ATTR = 'data-recued-key-health-cancel';
export const KEY_HEALTH_CLOSE_BTN_ATTR = 'data-recued-key-health-close';
export const KEY_HEALTH_BACK_BTN_ATTR = 'data-recued-key-health-back';
export const KEY_HEALTH_RETRY_BTN_ATTR = 'data-recued-key-health-retry';
export const KEY_HEALTH_STATUS_ATTR = 'data-recued-key-health-status';
export const KEY_HEALTH_COMPROMISE_BANNER_ATTR = 'data-recued-key-health-compromise-banner';
export const KEY_HEALTH_ERROR_CODE_ATTR = 'data-recued-key-health-error-code';

// ════════════════════════════════════════════════════════════════
// Per-class copy
// ════════════════════════════════════════════════════════════════

/** Display label + one-line description per key class. The owner asked
 *  every class — reachable or not — to carry a brief explanation of what
 *  it is, so the page reads as a complete inventory rather than just the
 *  handful that rotate here. */
const KEY_CLASS_INFO: Record<KeyClass, { label: string; description: string }> = {
  server_identity_key: {
    label: 'Server identity key',
    description:
      'The Ed25519 keypair that signs this server’s identity. Every paired client pins it; rotating it re-pairs them all.',
  },
  tls_private_key: {
    label: 'TLS certificate key',
    description:
      'The private key behind the HTTPS certificate clients connect over. Rotating it is a certificate renewal.',
  },
  master_dek: {
    label: 'Master encryption key',
    description:
      'The master data-encryption key. Every other key + all data at rest is encrypted under it; rotating it re-encrypts the whole warehouse.',
  },
  sub_dek: {
    label: 'Derived encryption keys',
    description:
      'Per-domain keys derived from the master encryption key. They rotate with it — there is no separate control.',
  },
  publisher_identity_key: {
    label: 'Publisher identity key',
    description:
      'Signs the recipes you publish to the marketplace. Rotating it re-signs every published recipe under the new key.',
  },
  webclient_token: {
    label: 'Client tokens',
    description:
      'Per-device bearer credentials for your paired bridges + webclients.',
  },
  webhook_secret: {
    label: 'Webhook secrets',
    description:
      'Per-vendor HMAC secrets that verify inbound webhooks before they are processed.',
  },
};

/** Deliberate display order: the class you can act on here first, then
 *  the ones managed on another surface, then the inventory-only rest. */
const KEY_HEALTH_DISPLAY_ORDER: ReadonlyArray<KeyClass> = [
  'server_identity_key',
  'tls_private_key',
  'webclient_token',
  'master_dek',
  'sub_dek',
  'publisher_identity_key',
  'webhook_secret',
];

/** Where a `managed_elsewhere` class is actually rotated. */
const WHERE_MANAGED: Partial<Record<KeyClass, string>> = {
  tls_private_key: 'Renew the certificate from the TLS panel under Certificates.',
  webclient_token: 'Rotate a paired client from Settings → Devices.',
};

/** The no-selector rotate op for each class that exposes a "Rotate now"
 *  button. `tls_private_key` / `webclient_token` are managed elsewhere;
 *  `webhook_secret` needs a per-vendor selector (and is unavailable on
 *  self-host anyway), so neither appears here. */
const ROTATE_OP_FOR_CLASS: Partial<Record<KeyClass, KeyRotateRequest['op']>> = {
  master_dek: 'master_dek_rotate',
  server_identity_key: 'server_identity_rotate',
  publisher_identity_key: 'publisher_identity_rotate',
};

const COPY = {
  intro_heading: 'Key Health',
  intro_body:
    'Every key this server holds, and what you can do with it. Rotations run on the server and are audit-logged; some keys are renewed elsewhere or are not loaded on this machine.',
  loading: 'Loading key health…',
  load_error_heading: 'Couldn’t load key health.',
  busy: 'Rotating…',
  unavailable_note:
    'Not loaded on this server, so it can’t be rotated here.',
  depair_warning:
    'This includes the client you are using right now — you will be signed out and must re-pair every device with the CLI + your 24-word recovery key.',
  depair_done_heading: 'Server identity rotated.',
  depair_done_body:
    'Every client — including this one — must now re-pair using the CLI + your 24-word recovery key. This session is no longer trusted.',
} as const;

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export type KeyHealthPanelState =
  | 'loading'
  | 'idle'
  | 'load_error'
  | 'confirm'
  | 'busy'
  | 'done'
  | 'error';

/** `key.health` rpc caller seam — resolves the per-class view. */
export type KeyHealthLoader = () => Promise<KeyHealthView>;

/** `key.rotate` rpc caller seam — resolves the substrate's full
 *  `RotationResult` (success or failure) verbatim. A thrown error
 *  surfaces as an `error` state, EXCEPT a transport-family drop on a
 *  de-pairing op (which means the rotation committed + de-paired us). */
export type KeyRotateCaller = (req: KeyRotateRequest) => Promise<RotationResult>;

export interface MountKeyHealthPanelOptions {
  host: HTMLElement;
  document?: Document;
  /** `key.health` rpc caller (loads on mount + after each rotation). */
  loadHealth: KeyHealthLoader;
  /** `key.rotate` rpc caller. */
  runRotate: KeyRotateCaller;
  /** `Date.now`-compatible clock for the "last rotated" copy. Defaults
   *  to `Date.now`. */
  now?: () => number;
  /** Best-effort hook after a successful (non-de-pairing) rotation lands
   *  in `done`. A throw is swallowed. */
  onRotated?: (result: Extract<RotationResult, { ok: true }>) => void;
}

export interface KeyHealthPanelMount {
  getState(): KeyHealthPanelState;
  /** Resolves once the initial `key.health` load settles (ok or error). */
  whenReady(): Promise<void>;
  dispose(): void;
  /** Test-only: click a class's "Rotate now" button. */
  clickRotate(key_class: KeyClass): void;
  /** Test-only: click a class's "Mark compromised" button. */
  clickCompromise(key_class: KeyClass): void;
  /** Test-only: drive the confirm → busy → (done | error) transition. */
  clickConfirm(): Promise<void>;
  /** Test-only: drive cancel from `confirm`. */
  clickCancel(): void;
  /** Test-only: drive the done → loading close path. */
  clickClose(): Promise<void>;
  /** Test-only: drive the error → idle back path. */
  clickBack(): void;
  /** Test-only: drive the load_error → loading retry path. */
  clickRetry(): Promise<void>;
}

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const errorCodeOf = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

const messageOf = (err: unknown): string =>
  humanizeRpcError(err);

/** The closed set of transport-family `RpcError.code`s the webclient's
 *  `rpc-conn` rejects with when the socket closes mid-call. On a
 *  de-pairing rotation these mean "committed — re-pair", not a failure.
 *  Mirrors `archive-backup-panel.ts`'s `isTransportDropError`. */
const isTransportDropError = (err: unknown): boolean => {
  const code = errorCodeOf(err);
  return (
    code === 'transport' ||
    code === 'transport_disposed' ||
    code === 'timeout' ||
    code === 'webclient_reauth_required'
  );
};

const isErrorCode = (value: string): value is RotationErrorCode =>
  Object.prototype.hasOwnProperty.call(ROTATION_ERROR_COPY, value);

const remediationFor = (code: string | null, fallback: string): string => {
  if (code !== null && isErrorCode(code)) return ROTATION_ERROR_COPY[code];
  return fallback;
};

/** A dispatch that revokes the caller's own bearer: a plain server-
 *  identity rotation, or marking `server_identity_key` compromised
 *  (which cascades into the identity rotation). */
const dePairs = (req: KeyRotateRequest): boolean =>
  req.op === 'server_identity_rotate' ||
  (req.op === 'mark_compromised' && req.key_class === 'server_identity_key');

const formatRotatedAt = (rotated_at: number): string => {
  if (!Number.isFinite(rotated_at)) return 'unknown';
  return new Date(rotated_at).toISOString();
};

/** Short label for a dependent/cascade key class in the done summary. */
const labelForKeyClass = (key_class: KeyClass): string =>
  KEY_CLASS_INFO[key_class]?.label ?? key_class;

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountKeyHealthPanel = (
  opts: MountKeyHealthPanelOptions,
): KeyHealthPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountKeyHealthPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  // ── State ──────────────────────────────────────────────────────────
  let state: KeyHealthPanelState = 'loading';
  let disposed = false;
  let view: KeyHealthView | null = null;
  let pendingAction: KeyRotateRequest | null = null;
  let lastSuccess: Extract<RotationResult, { ok: true }> | null = null;
  let lastDepaired = false;
  let lastErrorCode: RotationErrorCode | null = null;
  let lastErrorMessage = '';
  let loadErrorMessage = '';
  // Latch the in-flight load / rotate so the test seams can await them.
  let pendingLoadPromise: Promise<void> | null = null;
  let pendingRotatePromise: Promise<void> | null = null;

  // ── Wrapper ──────────────────────────────────────────────────────
  const wrapper = doc.createElement('div');
  wrapper.setAttribute(KEY_HEALTH_PANEL_ATTR, '');
  wrapper.setAttribute(KEY_HEALTH_PANEL_STATE_ATTR, state);
  wrapper.className = 'key-health-panel';
  opts.host.appendChild(wrapper);

  const transitionTo = (next: KeyHealthPanelState): void => {
    if (disposed) return;
    state = next;
    wrapper.setAttribute(KEY_HEALTH_PANEL_STATE_ATTR, state);
    render();
  };

  // ── Load ─────────────────────────────────────────────────────────
  const runLoad = async (): Promise<void> => {
    if (disposed) return;
    transitionTo('loading');
    try {
      const result = await opts.loadHealth();
      if (disposed) return;
      view = result;
      loadErrorMessage = '';
      transitionTo('idle');
    } catch (err) {
      if (disposed) return;
      loadErrorMessage = messageOf(err);
      transitionTo('load_error');
    }
  };

  // ── Rotate ───────────────────────────────────────────────────────
  const runRotate = async (req: KeyRotateRequest): Promise<void> => {
    if (disposed) return;
    transitionTo('busy');
    try {
      const result = await opts.runRotate(req);
      if (disposed) return;
      if (result.ok) {
        lastSuccess = result;
        lastDepaired = dePairs(req);
        lastErrorCode = null;
        lastErrorMessage = '';
        transitionTo('done');
        if (opts.onRotated && !lastDepaired) {
          try {
            opts.onRotated(result);
          } catch {
            /* telemetry sink is best-effort; never re-enter the panel */
          }
        }
        return;
      }
      lastSuccess = null;
      lastDepaired = false;
      lastErrorCode = result.error;
      lastErrorMessage = result.message ?? '';
      transitionTo('error');
    } catch (err) {
      if (disposed) return;
      // A de-pairing rotation that drops the socket committed server-side
      // — treat the transport drop as success + prompt re-pair (see the
      // header). Any other throw is a genuine failure.
      if (dePairs(req) && isTransportDropError(err)) {
        lastSuccess = null;
        lastDepaired = true;
        lastErrorCode = null;
        lastErrorMessage = '';
        transitionTo('done');
        return;
      }
      lastSuccess = null;
      lastDepaired = false;
      lastErrorCode = null;
      lastErrorMessage = messageOf(err);
      transitionTo('error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────
  const clearChildren = (): void => {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  };

  const makeButton = (
    label: string,
    attr: string,
    attrValue: string,
    variant: 'danger' | 'primary' | 'secondary',
    onClick: () => void,
    disabledFlag = false,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.setAttribute(attr, attrValue);
    btn.type = 'button';
    btn.textContent = label;
    btn.className = `rx-btn rx-btn-${variant} rx-btn-sm key-health-btn`;
    if (disabledFlag) btn.disabled = true;
    btn.addEventListener('click', onClick);
    return btn;
  };

  const renderCard = (key_class: KeyClass): HTMLElement => {
    const info = KEY_CLASS_INFO[key_class];
    const entry: KeyHealthEntry = view?.key_health[key_class] ?? { status: 'healthy' };
    const availability: RotationAvailability =
      view?.availability[key_class] ?? 'unavailable';

    const card = doc.createElement('div');
    card.setAttribute(KEY_HEALTH_CARD_ATTR, '');
    card.setAttribute(KEY_HEALTH_CARD_CLASS_ATTR, key_class);
    card.className = `key-health-card key-health-card-${availability}`;

    const title = doc.createElement('h4');
    title.className = 'key-health-card-title';
    title.textContent = info.label;
    card.appendChild(title);

    const desc = doc.createElement('p');
    desc.className = 'key-health-card-desc';
    desc.textContent = info.description;
    card.appendChild(desc);

    const meta = doc.createElement('div');
    meta.className = 'key-health-card-meta';
    const statusChip = doc.createElement('span');
    statusChip.setAttribute(KEY_HEALTH_STATUS_ATTR, entry.status);
    statusChip.className = `key-health-chip key-health-chip-${entry.status}`;
    statusChip.textContent = entry.status;
    meta.appendChild(statusChip);
    if (entry.last_rotated_at !== undefined) {
      const rotated = doc.createElement('span');
      rotated.className = 'key-health-card-rotated';
      rotated.textContent = `Last rotated ${formatRotatedAt(entry.last_rotated_at)}`;
      meta.appendChild(rotated);
    }
    card.appendChild(meta);

    if (entry.compromise_alert) {
      const banner = doc.createElement('p');
      banner.setAttribute(KEY_HEALTH_COMPROMISE_BANNER_ATTR, '');
      banner.setAttribute('role', 'alert');
      banner.className = 'key-health-compromise-banner';
      banner.textContent =
        'Marked compromised. Rotate this key (or resolve it manually if it can’t rotate here) to clear the alert.';
      card.appendChild(banner);
    }

    const actions = doc.createElement('div');
    actions.className = 'key-health-card-actions';

    if (availability === 'available') {
      const rotateOp = ROTATE_OP_FOR_CLASS[key_class];
      if (rotateOp !== undefined) {
        actions.appendChild(
          makeButton('Rotate now', KEY_HEALTH_ROTATE_BTN_ATTR, key_class, 'primary', () => {
            pendingAction = { op: rotateOp } as KeyRotateRequest;
            transitionTo('confirm');
          }),
        );
      }
      actions.appendChild(
        makeButton(
          'Mark compromised',
          KEY_HEALTH_COMPROMISE_BTN_ATTR,
          key_class,
          'danger',
          () => {
            pendingAction = { op: 'mark_compromised', key_class };
            transitionTo('confirm');
          },
        ),
      );
    } else {
      const note = doc.createElement('p');
      note.className = 'key-health-card-note';
      note.textContent =
        availability === 'managed_elsewhere'
          ? WHERE_MANAGED[key_class] ?? 'Managed on another surface.'
          : COPY.unavailable_note;
      actions.appendChild(note);
    }

    card.appendChild(actions);
    return card;
  };

  const renderLoading = (): void => {
    const status = doc.createElement('p');
    status.className = 'key-health-help';
    status.setAttribute('role', 'status');
    status.textContent = COPY.loading;
    wrapper.appendChild(status);
  };

  const renderLoadError = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'key-health-title key-health-title-error';
    heading.textContent = COPY.load_error_heading;
    const hint = doc.createElement('p');
    hint.className = 'key-health-help';
    hint.textContent = loadErrorMessage || 'Check the server connection + retry.';
    const actions = doc.createElement('div');
    actions.className = 'key-health-actions';
    actions.appendChild(
      makeButton('Retry', KEY_HEALTH_RETRY_BTN_ATTR, '', 'primary', () => {
        pendingLoadPromise = runLoad();
      }),
    );
    wrapper.appendChild(heading);
    wrapper.appendChild(hint);
    wrapper.appendChild(actions);
  };

  const renderIdle = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'key-health-title';
    heading.textContent = COPY.intro_heading;
    const body = doc.createElement('p');
    body.className = 'key-health-help';
    body.textContent = COPY.intro_body;
    wrapper.appendChild(heading);
    wrapper.appendChild(body);

    const list = doc.createElement('div');
    list.className = 'key-health-list';
    for (const key_class of KEY_HEALTH_DISPLAY_ORDER) {
      list.appendChild(renderCard(key_class));
    }
    wrapper.appendChild(list);
  };

  const renderConfirm = (): void => {
    const action = pendingAction;
    if (action === null) {
      transitionTo('idle');
      return;
    }
    const copy = ROTATION_COPY[action.op];
    const heading = doc.createElement('h3');
    heading.className = 'key-health-title';
    heading.textContent = copy.confirm_title;

    const body = doc.createElement('p');
    body.className = 'key-health-help key-health-help-confirm';
    body.setAttribute('role', 'alert');
    body.textContent = copy.confirm_body;
    wrapper.appendChild(heading);
    wrapper.appendChild(body);

    if (dePairs(action)) {
      const warn = doc.createElement('p');
      warn.className = 'key-health-help key-health-depair-warning';
      warn.setAttribute('role', 'alert');
      warn.textContent = COPY.depair_warning;
      wrapper.appendChild(warn);
    }

    const actions = doc.createElement('div');
    actions.className = 'key-health-actions';
    actions.appendChild(
      makeButton('Cancel', KEY_HEALTH_CANCEL_BTN_ATTR, '', 'secondary', () => {
        pendingAction = null;
        transitionTo('idle');
      }),
    );
    actions.appendChild(
      makeButton('Yes, continue', KEY_HEALTH_CONFIRM_BTN_ATTR, '', 'danger', () => {
        pendingRotatePromise = runRotate(action);
      }),
    );
    wrapper.appendChild(actions);
  };

  const renderBusy = (): void => {
    const status = doc.createElement('p');
    status.className = 'key-health-help key-health-help-busy';
    status.setAttribute('role', 'status');
    status.textContent = COPY.busy;
    wrapper.appendChild(status);
  };

  const renderDone = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'key-health-title key-health-title-done';
    const body = doc.createElement('p');
    body.className = 'key-health-help';

    if (lastDepaired) {
      heading.textContent = COPY.depair_done_heading;
      body.textContent = COPY.depair_done_body;
      wrapper.appendChild(heading);
      wrapper.appendChild(body);
      // No Close button — the WS is gone; the reconnect funnel remounts
      // the pair form. The terminal message is the panel's last word.
      return;
    }

    const result = lastSuccess;
    heading.textContent = result ? ROTATION_COPY[result.op].success_title : 'Done.';
    body.textContent =
      'The rotation completed + was recorded in the audit log.';
    wrapper.appendChild(heading);
    wrapper.appendChild(body);

    if (result) {
      const list = doc.createElement('dl');
      list.className = 'key-health-result';
      const addRow = (label: string, value: string): void => {
        const dt = doc.createElement('dt');
        dt.className = 'key-health-result-label';
        dt.textContent = label;
        const dd = doc.createElement('dd');
        dd.className = 'key-health-result-value';
        dd.textContent = value;
        list.appendChild(dt);
        list.appendChild(dd);
      };
      if (result.new_fingerprint !== undefined) addRow('New fingerprint', result.new_fingerprint);
      if (result.reencrypted_blob_count !== undefined) {
        addRow('Re-encrypted blobs', String(result.reencrypted_blob_count));
      }
      if (result.dependents && result.dependents.length > 0) {
        addRow(
          'Dependents rotated',
          result.dependents
            .map((d) => `${labelForKeyClass(d.key_class)} (${d.affected_count})`)
            .join(', '),
        );
      }
      if (result.cascade_pending && result.cascade_pending.length > 0) {
        addRow(
          'Still needs a per-target rotation',
          result.cascade_pending.map((c) => labelForKeyClass(c.key_class)).join(', '),
        );
      }
      if (list.children.length > 0) wrapper.appendChild(list);
    }

    const actions = doc.createElement('div');
    actions.className = 'key-health-actions';
    actions.appendChild(
      makeButton('Close', KEY_HEALTH_CLOSE_BTN_ATTR, '', 'secondary', () => {
        pendingAction = null;
        lastSuccess = null;
        pendingLoadPromise = runLoad();
      }),
    );
    wrapper.appendChild(actions);
  };

  const renderError = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'key-health-title key-health-title-error';
    heading.textContent = 'Rotation failed.';
    const hint = doc.createElement('p');
    hint.className = 'key-health-help';
    hint.textContent = remediationFor(
      lastErrorCode,
      lastErrorMessage || 'Unknown error — check server logs + retry.',
    );

    const errBox = doc.createElement('p');
    errBox.setAttribute('role', 'alert');
    errBox.className = 'key-health-error';
    if (lastErrorCode !== null) {
      errBox.setAttribute(KEY_HEALTH_ERROR_CODE_ATTR, lastErrorCode);
      errBox.textContent = lastErrorMessage
        ? `${lastErrorCode}: ${lastErrorMessage}`
        : lastErrorCode;
    } else {
      errBox.textContent = lastErrorMessage;
    }

    const actions = doc.createElement('div');
    actions.className = 'key-health-actions';
    actions.appendChild(
      makeButton('Back', KEY_HEALTH_BACK_BTN_ATTR, '', 'secondary', () => {
        pendingAction = null;
        transitionTo('idle');
      }),
    );
    wrapper.appendChild(heading);
    wrapper.appendChild(hint);
    wrapper.appendChild(errBox);
    wrapper.appendChild(actions);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren();
    switch (state) {
      case 'loading':
        renderLoading();
        break;
      case 'load_error':
        renderLoadError();
        break;
      case 'idle':
        renderIdle();
        break;
      case 'confirm':
        renderConfirm();
        break;
      case 'busy':
        renderBusy();
        break;
      case 'done':
        renderDone();
        break;
      case 'error':
        renderError();
        break;
    }
  };

  // Initial paint + load.
  render();
  pendingLoadPromise = runLoad();

  // ── Test seams ───────────────────────────────────────────────────
  const findBtn = (attr: string, attrValue?: string): HTMLButtonElement | null => {
    const walk = (node: HTMLElement): HTMLButtonElement | null => {
      if (
        typeof node.hasAttribute === 'function' &&
        node.hasAttribute(attr) &&
        node.tagName === 'BUTTON' &&
        (attrValue === undefined || node.getAttribute(attr) === attrValue)
      ) {
        return node as HTMLButtonElement;
      }
      const kids =
        (node as unknown as { children?: ArrayLike<HTMLElement> }).children ??
        (node as unknown as { childList?: ArrayLike<HTMLElement> }).childList;
      if (!kids) return null;
      const length = (kids as { length: number }).length;
      for (let i = 0; i < length; i += 1) {
        const hit = walk(kids[i] as HTMLElement);
        if (hit) return hit;
      }
      return null;
    };
    return walk(wrapper as HTMLElement);
  };

  const clickAttr = (attr: string, attrValue?: string): void => {
    const b = findBtn(attr, attrValue);
    if (b && !b.disabled) b.click();
  };

  return {
    getState: () => state,
    whenReady: async () => {
      const pending = pendingLoadPromise;
      if (pending) await pending;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        opts.host.removeChild(wrapper);
      } catch {
        wrapper.remove();
      }
    },
    clickRotate: (key_class) => clickAttr(KEY_HEALTH_ROTATE_BTN_ATTR, key_class),
    clickCompromise: (key_class) => clickAttr(KEY_HEALTH_COMPROMISE_BTN_ATTR, key_class),
    clickConfirm: async () => {
      clickAttr(KEY_HEALTH_CONFIRM_BTN_ATTR);
      const pending = pendingRotatePromise;
      if (pending) await pending;
    },
    clickCancel: () => clickAttr(KEY_HEALTH_CANCEL_BTN_ATTR),
    clickClose: async () => {
      clickAttr(KEY_HEALTH_CLOSE_BTN_ATTR);
      const pending = pendingLoadPromise;
      if (pending) await pending;
    },
    clickBack: () => clickAttr(KEY_HEALTH_BACK_BTN_ATTR),
    clickRetry: async () => {
      clickAttr(KEY_HEALTH_RETRY_BTN_ATTR);
      const pending = pendingLoadPromise;
      if (pending) await pending;
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const KEY_HEALTH_PANEL_STYLES = `
[${KEY_HEALTH_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-title-done {
  color: var(--success);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-title-error {
  color: var(--danger);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-help {
  margin: 0;
  line-height: 1.45;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-help-confirm,
[${KEY_HEALTH_PANEL_ATTR}] .key-health-depair-warning {
  font-weight: 600;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-depair-warning {
  color: var(--danger);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card-unavailable {
  opacity: 0.6;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card-desc {
  margin: 0;
  line-height: 1.4;
  color: var(--fg-muted);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-chip {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-chip-healthy {
  background: var(--success-bg);
  color: var(--success);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-chip-warning {
  background: var(--warning-bg);
  color: var(--warning);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-chip-overdue {
  background: var(--danger-bg);
  color: var(--danger);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card-rotated {
  font-size: 12px;
  color: var(--fg-muted);
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-compromise-banner {
  margin: 0;
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-weight: 600;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card-note {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  font-style: italic;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-card-actions,
[${KEY_HEALTH_PANEL_ATTR}] .key-health-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-result {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  padding: 8px 10px;
  background: var(--bg-elev);
  border-radius: 4px;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-result-label {
  margin: 0;
  font-weight: 600;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-result-value {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  word-break: break-all;
}
[${KEY_HEALTH_PANEL_ATTR}] .key-health-error {
  margin: 0;
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  word-break: break-all;
}
`;
