/** D-148 — Settings → Account & Servers: change a paired server's address.
 *
 *  The surface for "my server moved" — a new port behind existing web hosting,
 *  a LAN address becoming a public one, a handle replacing a bare IP. Until
 *  now the only way to follow a server that moved was to clear site data and
 *  pair again, which throws away the bearer, the roster and the history.
 *
 *  ── PROBE, THEN CONFIRM, THEN WRITE ─────────────────────────────────────
 *  Typing an address does nothing. Checking it asks the candidate to PROVE it
 *  holds this profile's pinned key (`auth/identity-probe.ts`), and only a
 *  proven candidate offers a Save. ⛔ Nothing is persisted before that: a
 *  half-applied edit would leave a profile pointing nowhere with a bearer
 *  bound to a server it can no longer reach — strictly worse than the state it
 *  was trying to repair.
 *
 *  🔑 SAVING IS SAFE BECAUSE OF WHAT THE PROBE PROVES, NOT BECAUSE OF WHERE
 *  THE USER IS CONNECTED. An earlier design also refused an edit made through
 *  the address being changed. That was the right rule for the SERVER-SIDE port
 *  change (which really does rebind the listener) and the wrong one here:
 *  `server_url` is browser-local, so moving it closes no socket — and the
 *  refusal blocked the exact migration this panel exists for.
 *
 *  ── One row at a time ───────────────────────────────────────────────────
 *  Only one profile is editable at a time. Two open editors would let a user
 *  probe address A and save it into row B, and the roster's duplicate-address
 *  refusal would be the only thing standing between them and two rows fighting
 *  over one bearer.
 */

import type { WebclientServerProfile } from '@recued/contracts';

import {
  retargetServerUrl,
  verifyRetargetCandidate,
  type RetargetDeps,
  type RetargetOutcome,
} from '../auth/retarget-server-url.js';
import { serverMountIdentity } from '../auth/server-url-change-guard.js';

export const SERVER_ADDRESS_PANEL_ATTR = 'data-server-address-panel';
export const SERVER_ADDRESS_ROW_ATTR = 'data-server-address-row';
export const SERVER_ADDRESS_ROW_STATE_ATTR = 'data-server-address-row-state';
export const SERVER_ADDRESS_EDIT_BTN_ATTR = 'data-server-address-edit';
export const SERVER_ADDRESS_INPUT_ATTR = 'data-server-address-input';
export const SERVER_ADDRESS_CHECK_BTN_ATTR = 'data-server-address-check';
export const SERVER_ADDRESS_SAVE_BTN_ATTR = 'data-server-address-save';
export const SERVER_ADDRESS_CANCEL_BTN_ATTR = 'data-server-address-cancel';
export const SERVER_ADDRESS_STATUS_ATTR = 'data-server-address-status';

/** Per-row state. `verified` is the only one that renders a Save. */
export type ServerAddressRowState =
  | 'idle'
  | 'editing'
  | 'checking'
  | 'verified'
  | 'refused'
  | 'saving'
  | 'saved';

/** ⚠ Copy lives here, next to the outcome it explains, so a new outcome
 *  cannot ship with a message that silently describes a different one. */
export const retargetMessage = (outcome: RetargetOutcome): string => {
  switch (outcome.kind) {
    case 'saved':
      // ⚠ "will use", NOT "is using". The live socket is still on the OLD
      // address and nothing converges it: the server-switch convergence flow
      // keys on `activeProfileId` CHANGING, and a retarget moves the URL of the
      // SAME profile, so it closes immediately (`activeTarget === bootProfileId`).
      // Saying "saved" alone would leave someone who just moved a DEAD address
      // sitting on a silently broken tab with nothing telling them what to do.
      return `Saved. Reload this tab to start using ${outcome.server_url}.`;
    case 'invalid_address':
      return 'That does not look like a server address. It should start with wss:// or ws://.';
    case 'rejected_by_store':
      return 'Another server in this list already uses that address.';
    case 'token_reseal_failed':
      // ⚠ Says what is still TRUE, because the useful fact is that nothing
      // broke — not the internal reason it stopped.
      return 'Could not move your saved credential, so nothing was changed. This browser still uses the old address.';
    case 'refused':
      switch (outcome.probe.kind) {
        case 'unreachable':
          return 'Nothing answered at that address. Check it is running and reachable from this browser.';
        case 'blocked_by_browser':
          // ⛔ NAMES THE BROWSER, NOT THE SERVER, and gives the two fixes that
          // are actually the owner's. Saying "can't reach your server" here
          // about a server that is running and one origin away is the exact
          // failure `net/insecure-origin.ts` was written to stop.
          return 'This page is secure, so your browser refuses to open a plain http:// address. The server may be running fine. Open it from its own address, or give it a certificate.';
        default:
          return 'Something answered, but it could not prove it is this server. Nothing was changed.';
      }
  }
};

export interface MountServerAddressPanelOptions {
  readonly host: { appendChild(el: never): unknown };
  readonly document?: Document;
  /** The roster to render. */
  readonly listProfiles: () => Promise<ReadonlyArray<WebclientServerProfile>>;
  /** Everything `retargetServerUrl` needs. */
  readonly deps: RetargetDeps;
  /** Which profile this tab is CONNECTED through. Only that one needs the tab
   *  to reload; moving any other profile's address changes nothing live. */
  readonly activeProfileId?: () => Promise<string | null>;
  /** Converge the live tab onto a just-saved address.
   *
   *  ⛔ CALLED ONLY AFTER A SUCCESSFUL SAVE OF THE ACTIVE PROFILE, and the HOST
   *  decides what to do — the dirty-work policy lives where the work leases
   *  live, not in a settings panel. It reports back what it did so this panel
   *  can say something true:
   *    · `'reloading'` — the tab is going away; say nothing more.
   *    · `'deferred'`  — work would have been lost, so the user must choose.
   *
   *  ⚠ Optional, and its absence is a real configuration (a host with no reload
   *  seam), not an error: the saved message alone still tells the user what to
   *  do. */
  readonly onActiveAddressChanged?: () => 'reloading' | 'deferred';
}

export interface ServerAddressPanelMount {
  dispose(): void;
  /** Test seam — re-read the roster and rebuild. */
  refresh(): Promise<void>;
  rowState(profile_id: string): ServerAddressRowState;
  statusText(profile_id: string): string;
  /** Test drivers. Each resolves once the work it starts has settled, so a
   *  test never needs to guess at a tick. */
  clickEdit(profile_id: string): void;
  typeAddress(profile_id: string, value: string): void;
  clickCheck(profile_id: string): Promise<void>;
  clickSave(profile_id: string): Promise<void>;
  clickCancel(profile_id: string): void;
}

interface RowModel {
  profile: WebclientServerProfile;
  state: ServerAddressRowState;
  draft: string;
  status: string;
}

export const mountServerAddressPanel = (
  opts: MountServerAddressPanelOptions,
): ServerAddressPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountServerAddressPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  const wrapper = doc.createElement('div');
  wrapper.setAttribute(SERVER_ADDRESS_PANEL_ATTR, '');
  (opts.host as { appendChild(el: unknown): unknown }).appendChild(wrapper);

  let rows: RowModel[] = [];
  let disposed = false;

  const rowFor = (id: string): RowModel | undefined => rows.find((r) => r.profile.id === id);

  const render = (): void => {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    for (const row of rows) {
      const el = doc.createElement('div');
      el.setAttribute(SERVER_ADDRESS_ROW_ATTR, row.profile.id);
      el.setAttribute(SERVER_ADDRESS_ROW_STATE_ATTR, row.state);

      const label = doc.createElement('div');
      label.textContent = `${row.profile.label} — ${row.profile.server_url}`;
      el.appendChild(label);

      if (row.state === 'idle' || row.state === 'saved') {
        const edit = doc.createElement('button');
        edit.setAttribute(SERVER_ADDRESS_EDIT_BTN_ATTR, '');
        edit.textContent = 'Change address';
        edit.addEventListener('click', () => beginEdit(row.profile.id));
        el.appendChild(edit);
      } else {
        const input = doc.createElement('input') as HTMLInputElement;
        input.setAttribute(SERVER_ADDRESS_INPUT_ATTR, '');
        input.value = row.draft;
        // Re-checking is required after every edit: the proof is bound to the
        // address that was probed, so a changed draft invalidates it.
        input.addEventListener('input', () => {
          const current = rowFor(row.profile.id);
          if (!current) return;
          current.draft = input.value;
          if (current.state === 'verified' || current.state === 'refused') {
            current.state = 'editing';
            current.status = '';
            render();
          }
        });
        input.disabled = row.state === 'checking' || row.state === 'saving';
        el.appendChild(input);

        if (row.state === 'verified') {
          const save = doc.createElement('button');
          save.setAttribute(SERVER_ADDRESS_SAVE_BTN_ATTR, '');
          save.textContent = 'Save';
          save.addEventListener('click', () => { void save_(row.profile.id); });
          el.appendChild(save);
        } else {
          const check = doc.createElement('button');
          check.setAttribute(SERVER_ADDRESS_CHECK_BTN_ATTR, '');
          check.textContent = 'Check address';
          check.disabled = row.state === 'checking' || row.state === 'saving';
          check.addEventListener('click', () => { void check_(row.profile.id); });
          el.appendChild(check);
        }

        const cancel = doc.createElement('button');
        cancel.setAttribute(SERVER_ADDRESS_CANCEL_BTN_ATTR, '');
        cancel.textContent = 'Cancel';
        cancel.disabled = row.state === 'saving';
        cancel.addEventListener('click', () => cancel_(row.profile.id));
        el.appendChild(cancel);
      }

      const status = doc.createElement('p');
      status.setAttribute(SERVER_ADDRESS_STATUS_ATTR, '');
      status.textContent = row.status;
      el.appendChild(status);

      wrapper.appendChild(el);
    }
  };

  const beginEdit = (id: string): void => {
    // One editor at a time — see the module header.
    for (const r of rows) {
      if (r.profile.id === id) continue;
      // ⚠ NEVER RESET A ROW MID-SAVE. `cancel_` already refuses to; opening
      // another editor must not be the one way around that, or a write lands
      // against a row that has been wound back to idle underneath it.
      if (r.state === 'saving') continue;
      if (r.state !== 'idle' && r.state !== 'saved') {
        r.state = 'idle';
        r.draft = '';
        r.status = '';
      }
    }
    const row = rowFor(id);
    if (!row) return;
    row.state = 'editing';
    row.draft = row.profile.server_url;
    row.status = '';
    render();
  };

  const cancel_ = (id: string): void => {
    const row = rowFor(id);
    if (!row || row.state === 'saving') return;
    row.state = 'idle';
    row.draft = '';
    row.status = '';
    render();
  };

  /** ⚠ CHECK DOES NOT WRITE. It probes and reports; Save is a separate act,
   *  which is what makes "probe and confirm" two decisions rather than one. */
  const check_ = async (id: string): Promise<void> => {
    const row = rowFor(id);
    if (!row || row.state === 'checking' || row.state === 'saving') return;
    // ⚠ NO PARSE GUARD HERE. An earlier version rejected an unparseable
    // address before probing; mutation testing showed removing it reds
    // nothing, because `probeServerIdentity` already refuses to contact an
    // address it cannot parse and `decideServerUrlChange` already returns
    // `invalid_address`. Two definitions of "is this an address" would be one
    // too many, and the redundant one reads as load-bearing.
    // ⛔ THE LOCAL REFUSAL COMES FIRST. The roster rejects an address another
    // profile already holds, but only at WRITE time — so without this, Check
    // said "proved it is this server, Save to use it" and Save then answered
    // "another server already uses that address". The panel promised and then
    // refused. It has the roster in hand; it can answer that here.
    // ⚠ MOUNT identity, not listener identity: behind a reverse proxy two
    // servers share host and port and differ only by prefix, so comparing
    // listeners would refuse a legitimate second server.
    const candidate = serverMountIdentity(row.draft);
    const clash = rows.some(
      (other) => other.profile.id !== id && serverMountIdentity(other.profile.server_url) === candidate,
    );
    if (candidate !== null && clash) {
      row.state = 'refused';
      row.status = retargetMessage({ kind: 'rejected_by_store' });
      render();
      return;
    }

    row.state = 'checking';
    row.status = 'Checking…';
    render();

    // ⚠ VERIFY, NOT RETARGET. Checking must not touch the bearer — see
    // `verifyRetargetCandidate`.
    const outcome = await verifyRetargetCandidate(row.profile, row.draft, {
      ...(opts.deps.fetch ? { fetch: opts.deps.fetch } : {}),
    });
    const live = rowFor(id);
    if (disposed || !live || live.state !== 'checking') return;
    if (outcome.kind === 'verified') {
      live.state = 'verified';
      live.status = 'That address answered and proved it is this server. Save to use it.';
    } else {
      live.state = 'refused';
      live.status = retargetMessage(outcome);
    }
    render();
  };

  /** ⚠ THE WRITE HAS ALREADY LANDED BEFORE THIS RUNS, AND THAT ORDER MATTERS.
   *  Converging is about the LIVE tab, not about the save — so a host that
   *  cannot reload, or a reload that is declined because work would be lost,
   *  must never make a saved address look unsaved. */
  const convergeIfActive = async (id: string, server_url: string): Promise<void> => {
    const converge = opts.onActiveAddressChanged;
    const readActive = opts.activeProfileId;
    if (!converge || !readActive) return;
    let active: string | null;
    try {
      active = await readActive();
    } catch {
      // Cannot prove this is the connected profile ⇒ do not yank the tab.
      // The saved message already tells the user to reload.
      return;
    }
    if (active !== id) return;
    const live = rowFor(id);
    if (disposed || !live) return;
    if (converge() === 'deferred') {
      // Work would have been lost. Say why, and leave the choice with them.
      live.status =
        `Saved. This tab is still using the old address — reload when you are ready to switch to ${server_url}.`;
      render();
    }
    // `'reloading'`: the tab is about to be replaced. Saying anything more
    // would flash copy nobody can read.
  };

  const save_ = async (id: string): Promise<void> => {
    const row = rowFor(id);
    if (!row || row.state !== 'verified') return;
    row.state = 'saving';
    row.status = 'Saving…';
    render();

    const outcome = await retargetServerUrl(row.profile, row.draft, opts.deps);
    const live = rowFor(id);
    if (disposed || !live) return;
    live.status = retargetMessage(outcome);
    if (outcome.kind === 'saved') {
      live.state = 'saved';
      live.profile = { ...live.profile, server_url: outcome.server_url };
      live.draft = '';
      render();
      await convergeIfActive(id, outcome.server_url);
      return;
    }
    live.state = 'refused';
    render();
  };

  const refresh = async (): Promise<void> => {
    const profiles = await opts.listProfiles();
    if (disposed) return;
    // ⚠ Carry live edit state across a refresh. A roster reload that reset an
    // open editor would throw away a proof the user just waited for.
    rows = profiles.map((profile) => {
      const existing = rowFor(profile.id);
      return existing
        ? { ...existing, profile }
        : { profile, state: 'idle' as const, draft: '', status: '' };
    });
    render();
  };

  void refresh();

  return {
    dispose() {
      disposed = true;
      wrapper.remove();
    },
    refresh,
    rowState: (id) => rowFor(id)?.state ?? 'idle',
    statusText: (id) => rowFor(id)?.status ?? '',
    clickEdit: beginEdit,
    typeAddress: (id, value) => {
      const row = rowFor(id);
      if (!row) return;
      row.draft = value;
      if (row.state === 'verified' || row.state === 'refused') {
        row.state = 'editing';
        row.status = '';
      }
      render();
    },
    clickCheck: check_,
    clickSave: save_,
    clickCancel: cancel_,
  };
};
