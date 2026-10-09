/** D-145 PA7 / D-172 P2 — the `#mail` route: the compose dialog's first host.
 *
 *  Deliberately thin. Everything that decides anything lives in
 *  `mail-compose-host.ts` (state + dispatch) or in the substrate it drives;
 *  this file owns a heading, a mailbox roster, a Compose button, and the
 *  element the dialog mounts into.
 *
 *  ⚠ NOT A MAIL CLIENT. There is no message list, no thread view, no inbox —
 *  the webclient has never had one, and building one is not what wiring the
 *  compose dialog means. The roster exists so the owner can see WHICH account
 *  a message would leave from before they open the window, and so the
 *  "no send-capable account" case has somewhere honest to say so.
 *
 *  ── The two blocked states, both said out loud ────────────────────
 *  A surface that renders a Compose button which cannot work is worse than one
 *  that explains itself, so both are rendered rather than hidden:
 *
 *    · NO SEND-CAPABLE ACCOUNT — mail is enrolled read-only (IMAP without
 *      SMTP, or an OAuth grant without `gmail.send` / `Mail.Send`). Points at
 *      Settings → Connections.
 *    · NO MAILBOX AT ALL — nothing enrolled yet.
 *
 *  The third failure — the `send-composed-mail` recipe not being installed —
 *  cannot be detected here without guessing, so it is not pre-empted: it
 *  surfaces as the dispatch error on the dialog's own banner, which is where
 *  the user is when it happens.
 *
 *  ✅ 2026-09-07 — that third failure is now unreachable on a running server.
 *  `mail-compose-foundation` is classified a CORE FEATURE (owner ruling, see
 *  internal design notes): the boot wire installs it on every start and
 *  `packs.uninstall` refuses to remove it. The branch stays, because a dispatch
 *  error is still the honest place for any other run failure to land. */

import { MAIL_COMPOSE_STYLES, FORM_RENDERER_STYLES } from '@recued/ui-shared';

import {
  FILE_PICK_STYLES,
  listComposeFiles,
  openFilePickPanel,
  type MirrorFileSearchCaller,
} from './file-pick-panel.js';

import {
  mountMailCompose,
  type MailComposeDeps,
  type MailComposeMount,
} from './mail-compose-host.js';
import { serializeShellRoute } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { MailDraftSummary } from '@recued/contracts';

export const MAIL_ROUTE_HOST_ATTR = 'data-recued-mail-route';
export const MAIL_ROUTE_COMPOSE_ATTR = 'data-recued-mail-compose';
export const MAIL_ROUTE_DIALOG_ATTR = 'data-recued-mail-dialog';
export const MAIL_ROUTE_MAILBOX_ATTR = 'data-recued-mail-mailbox';
export const MAIL_ROUTE_EMPTY_ATTR = 'data-recued-mail-empty';
export const MAIL_ROUTE_RETRY_ATTR = 'data-recued-mail-retry';
export const MAIL_ROUTE_STYLES_MARKER = 'data-recued-mail-styles';

export const MAIL_ROUTE_STYLES = `
${FORM_RENDERER_STYLES}
${MAIL_COMPOSE_STYLES}
${FILE_PICK_STYLES}
[${MAIL_ROUTE_HOST_ATTR}] { display: flex; flex-direction: column; gap: 16px; padding: 16px; max-width: var(--wc-content-max, 1080px); margin: 0 auto; color: var(--fg); }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-header {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
}
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-title { margin: 0; font-size: 20px; font-weight: 600; }
[${MAIL_ROUTE_HOST_ATTR}] a { color: var(--accent); }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-saved-drafts] { display: grid; gap: 12px; justify-items: start; }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-saved-drafts] h2 { margin: 0; font-size: 18px; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-mailboxes {
  list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px;
}
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-mailbox {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border: 1px solid var(--rx-border, var(--border)); border-radius: 4px;
}
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-mailbox-email { flex: 1 1 auto; min-width: 0; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-mailbox-cap { font-size: 12px; color: var(--rx-muted, var(--fg-muted)); }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-empty { margin: 0; color: var(--rx-muted, var(--fg-muted)); }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-empty a,
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-empty button { margin-left: 4px; }
`;

export interface MailRouteOptions extends MailComposeDeps {
  root: HTMLElement;
  document?: Document;
  /** `data.mirror.search` — the owner's file inventory, for the attachment
   *  chooser. Absent ⇒ the Attach control stays inert rather than opening an
   *  empty panel, which would read as "you have no files". */
  searchFiles?: MirrorFileSearchCaller;
}

export interface MailRoute {
  refresh(): Promise<void>;
  /** The live compose mount — the route's own handle, and the seam Chat will
   *  reuse when it becomes the second host. */
  compose(): MailComposeMount;
  /** The shell's route contract. Named `dispose`, not `destroy`. */
  dispose(): void;
  /** ⛔ A HALF-WRITTEN EMAIL IS UNSAVED WORK AND THE SHELL ALREADY KNOWS HOW TO
   *  PROTECT IT. Compose keeps no draft across opens (PA7 —
   *  `openCreateComposeTransition` returns a fresh state every time), so a
   *  navigation that silently unmounts the dialog DESTROYS what the person
   *  typed with no way back. Implementing these two hooks is what turns that
   *  into a prompt. */
  hasUnsavedChanges(): boolean;
  unsavedChangesPrompt(): string | null;
  /** Keep the route mounted while a mail action or file choice is pending. */
  hasInFlightWork(): boolean;
  inFlightWorkPrompt(): string | null;
  /** Part of `RecoveryContextProbe` — resolves once the first roster read has
   *  settled, so the shell does not treat an in-flight mount as empty. */
  whenLoaded(): Promise<void>;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/gu, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export const bootstrapMailRoute = (options: MailRouteOptions): MailRoute => {
  const doc = options.document ?? options.root.ownerDocument;
  const root = options.root;
  if (doc.head.querySelector(`style[${MAIL_ROUTE_STYLES_MARKER}]`) === null) {
    const style = doc.createElement('style');
    style.setAttribute(MAIL_ROUTE_STYLES_MARKER, '');
    style.textContent = MAIL_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  root.innerHTML = `
    <section ${MAIL_ROUTE_HOST_ATTR}>
      <header class="mail-route-header">
        <h1 class="mail-route-title">Mail</h1>
        <a href="${serializeShellRoute('mail', 'work')}">Work you’re following</a>
        <button type="button" ${MAIL_ROUTE_COMPOSE_ATTR} class="wc-button mail-route-compose">New mail</button>
      </header>
      <div class="mail-route-roster"></div>
      <div data-mail-saved-drafts></div>
      <div ${MAIL_ROUTE_DIALOG_ATTR}></div>
    </section>
  `;

  const roster = root.querySelector<HTMLElement>('.mail-route-roster')!;
  const dialogHost = root.querySelector<HTMLElement>(`[${MAIL_ROUTE_DIALOG_ATTR}]`)!;
  const composeButton = root.querySelector<HTMLButtonElement>(`[${MAIL_ROUTE_COMPOSE_ATTR}]`)!;
  const draftsHost = root.querySelector<HTMLElement>('[data-mail-saved-drafts]')!;
  let disposed = false;
  let draftGeneration = 0;
  let draftRows: MailDraftSummary[] = [];
  let draftCursor: string | null = null;
  let draftBusy = false;

  // The file half is wired ONLY when a search caller exists, so a host without
  // one leaves the Attach control inert instead of opening an empty chooser.
  const fileDeps: Pick<MailComposeDeps, 'listFiles' | 'pickFiles'> =
    options.searchFiles === undefined
      ? {}
      : {
        listFiles: () => listComposeFiles(options.searchFiles!),
        pickFiles: async (selected, signal) => {
          const inventory = await listComposeFiles(options.searchFiles!);
          if (signal?.aborted === true) return [];
          return openFilePickPanel(doc, inventory, selected, signal);
        },
      };

  const compose = mountMailCompose(dialogHost, {
    ...options,
    ...fileDeps,
    ...(options.drafts ? { drafts: { ...options.drafts, changed: () => { options.drafts?.changed?.(); void refreshDrafts(); } } } : {}),
  });
  const paintDrafts = (error?: string): void => {
    if (disposed || !options.drafts) return;
    draftsHost.replaceChildren();
    const title = doc.createElement('h2'); title.textContent = 'Saved drafts'; draftsHost.append(title);
    const button = (label: string, run: () => Promise<unknown>): HTMLButtonElement => {
      const el = doc.createElement('button'); el.type = 'button'; el.textContent = label; el.disabled = draftBusy;
      el.className = 'wc-button';
      el.onclick = () => { if (draftBusy) return; void run().catch(caught => paintDrafts(humanizeRpcError(caught))); }; return el;
    };
    draftsHost.append(button('Refresh drafts', () => refreshDrafts()));
    if (error) { const message = doc.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = error; draftsHost.append(message); }
    for (const row of draftRows) {
      const item = doc.createElement('div'); item.dataset.mailDraftId = row.draft_id; item.className = 'mail-route-draft';
      const open = button(row.subject || 'Untitled draft', async () => {
        if (!await compose.openSaved(row.draft_id)) throw new Error('Close the message you have open before you open another draft.');
      });
      open.classList.add('wc-button--wrap');
      item.append(open, button('Delete draft', async () => {
        draftBusy = true; paintDrafts();
        try { await options.drafts!.delete({ draft_id: row.draft_id, expected_revision: row.revision }); await refreshDrafts(); }
        finally { draftBusy = false; paintDrafts(); }
      }));
      const sender = doc.createElement('span'); sender.textContent = ` ${row.sender_mail_instance}`; item.append(sender); draftsHost.append(item);
    }
    if (!draftRows.length && !error) { const empty = doc.createElement('p'); empty.textContent = draftBusy ? 'Loading drafts…' : 'No saved drafts.'; draftsHost.append(empty); }
    if (draftCursor) draftsHost.append(button('More drafts', () => refreshDrafts(true)));
  };
  const refreshDrafts = async (more = false): Promise<void> => {
    if (!options.drafts || disposed) return;
    const generation = ++draftGeneration; draftBusy = true; paintDrafts();
    try {
      const result = await options.drafts.list({ ...(more && draftCursor ? { cursor: draftCursor } : {}), limit: 25 });
      if (disposed || generation !== draftGeneration) return;
      draftRows = more ? [...draftRows, ...result.drafts] : result.drafts; draftCursor = result.next_cursor;
      draftBusy = false; paintDrafts();
    } catch (error) {
      if (!disposed && generation === draftGeneration) { draftBusy = false; paintDrafts(humanizeRpcError(error)); }
    }
  };

  const renderRoster = (): void => {
    const readiness = compose.readiness();
    if (readiness.status === 'loading') {
      roster.innerHTML = '<p class="mail-route-empty" role="status">Checking mail sending…</p>';
      composeButton.disabled = true;
      return;
    }
    if (readiness.status === 'unavailable') {
      roster.innerHTML = `<p class="mail-route-empty" role="status" ${MAIL_ROUTE_EMPTY_ATTR}="unavailable">
        Recued couldn’t check whether your mail can send right now.
        <button type="button" class="wc-button" ${MAIL_ROUTE_RETRY_ATTR}>Try again</button>
      </p>`;
      composeButton.disabled = true;
      return;
    }
    if (readiness.status === 'none') {
      roster.innerHTML = `<p class="mail-route-empty" ${MAIL_ROUTE_EMPTY_ATTR}="none">
        Connect a mailbox to send mail with Recued.
        <a href="${esc(serializeShellRoute('connections', 'mail'))}">Connect mail →</a>
      </p>`;
      composeButton.disabled = true;
      return;
    }
    if (readiness.status === 'read_only') {
      const mailboxes = readiness.mailboxes;
      // D-264 — say why composing is refused too, not only sending. A draft
      // needs an EXIT: send it from here, or hand it to a mail app through the
      // Drafts folder. This mailbox has neither, so a draft would have nowhere
      // to go — and an owner told only "cannot send" would reasonably expect
      // Save draft to work.
      roster.innerHTML = `<p class="mail-route-empty" ${MAIL_ROUTE_EMPTY_ATTR}="read-only">
        Your connected ${mailboxes.length === 1 ? 'mailbox can' : 'mailboxes can'} read mail, but
        ${mailboxes.length === 1 ? 'it cannot' : 'they cannot'} send or save drafts — so there is
        nowhere for a new message to go yet.
        <a href="${esc(serializeShellRoute('connections', 'mail'))}">Fix mail connection →</a>
      </p>`;
      composeButton.disabled = true;
      return;
    }
    // D-264 — `ready` and `draft_only` both reach here, and both open compose.
    // The difference is stated rather than enforced: the roster names what each
    // mailbox can do, and the dialog disables Send for a draft-only sender.
    composeButton.disabled = false;
    const mailboxes = readiness.mailboxes;
    const draftOnlyNote = readiness.status === 'draft_only'
      ? `<p class="mail-route-empty" role="status" ${MAIL_ROUTE_EMPTY_ATTR}="draft-only">
        Your mail can hold drafts but cannot send yet. Compose and save; sending
        needs outbound set up.
        <a href="${esc(serializeShellRoute('connections', 'mail'))}">Fix mail connection →</a>
      </p>`
      : '';
    roster.innerHTML = `${draftOnlyNote}<ul class="mail-route-mailboxes">${mailboxes
      .map((m) => `<li class="mail-route-mailbox" ${MAIL_ROUTE_MAILBOX_ATTR}="${esc(m.mail_instance_slug)}">
        <span class="mail-route-mailbox-email">${esc(m.account_email.length > 0 ? m.account_email : m.mail_instance_slug)}</span>
        <span class="mail-route-mailbox-cap">${
          m.send_capable ? 'can send' : m.draft_capable ? 'drafts only' : 'read only'
        }</span>
      </li>`)
      .join('')}</ul>`;
  };

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`[${MAIL_ROUTE_RETRY_ATTR}]`) !== null) {
      void refresh();
      return;
    }
    if (target.closest(`[${MAIL_ROUTE_COMPOSE_ATTR}]`) !== null) compose.openCreate();
  };
  root.addEventListener('click', onClick);

  const refresh = async (): Promise<void> => {
    const pending = compose.refresh();
    const drafts = refreshDrafts();
    renderRoster();
    await pending;
    await drafts;
    renderRoster();
  };

  // Render an explicit loading state immediately. An empty roster is a server
  // answer, never the placeholder for a read that has not settled yet.
  renderRoster();
  const loaded = refresh();
  // The mount must not reject; `whenLoaded` is the shell's freshness probe, not
  // an error channel (`refresh` translates a failed read into the distinct
  // unavailable state rendered above).
  void loaded.catch(() => {});

  // The compose mount performs the check after folding the live DOM into state;
  // reading `compose.state()` here used to miss text typed since the last click.
  const hasUnsavedChanges = (): boolean => compose.hasUnsavedChanges();

  return {
    refresh,
    compose: () => compose,
    hasUnsavedChanges,
    unsavedChangesPrompt: () =>
      hasUnsavedChanges()
        ? 'This message has changes you have not saved. Leaving Mail throws them away.'
        : null,
    hasInFlightWork: () => compose.hasInFlightWork(),
    inFlightWorkPrompt: () =>
      compose.hasInFlightWork()
        ? 'Mail is still doing something. Leave anyway?'
        : null,
    whenLoaded: () => loaded,
    dispose() {
      disposed = true; draftGeneration++;
      root.removeEventListener('click', onClick);
      compose.destroy();
      root.innerHTML = '';
    },
  };
};
