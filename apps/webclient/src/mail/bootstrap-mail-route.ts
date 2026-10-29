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

import { MAIL_COMPOSE_STYLES, FORM_RENDERER_STYLES, formatClientDateTime } from '@recued/ui-shared';

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
/* A finger's height on a phone. ⛔ Only as tall as its text. */
@media (max-width: 640px) {
  [${MAIL_ROUTE_HOST_ATTR}] .mail-route-header > a { display: inline-flex; align-items: center; min-height: 44px; }
}
[${MAIL_ROUTE_HOST_ATTR}] a { color: var(--accent); }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-saved-drafts] { display: grid; gap: 12px; }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-saved-drafts] h2 { margin: 0; font-size: 18px; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-drafts-header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-drafts-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; min-width: 0; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft { min-width: 0; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft-summary { flex: 1 1 240px; min-width: 0; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft-open { display: block; max-width: 100%; min-height: 44px; padding: 4px 0; border: 0; background: none; color: var(--accent); text-align: left; font: inherit; font-weight: 600; cursor: pointer; overflow-wrap: anywhere; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft-context { margin: 0; color: var(--fg-muted); font-size: 13px; overflow-wrap: anywhere; }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-draft-action] { min-height: 44px; }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-draft-action][aria-disabled="true"] { opacity: .6; cursor: default; }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-draft-action]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex-basis: 100%; border-top: 1px solid var(--border); padding-top: 8px; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-draft-confirm p { flex: 1 1 240px; margin: 0; overflow-wrap: anywhere; }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-draft-action="confirm-delete"] { color: var(--danger, #b42318); }
[${MAIL_ROUTE_HOST_ATTR}] [data-mail-draft-feedback] { margin: 0; overflow-wrap: anywhere; }

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
  let draftLoading = false;
  let deletingDraftId: string | null = null;
  let deleteCandidate: MailDraftSummary | null = null;
  let draftListError: string | null = null;
  let retryDraftsMore = false;
  let draftActionError: string | null = null;
  let draftNotice: string | null = null;
  let deletionNeedsCheck = false;
  type DraftFocus = { action: string; id: string | null };
  const sameDraft = (a: MailDraftSummary, b: MailDraftSummary): boolean =>
    a.draft_id === b.draft_id && a.incarnation === b.incarnation && a.revision === b.revision;

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
  const paintDrafts = (returnTo?: DraftFocus): void => {
    if (disposed || !options.drafts) return;
    const active = doc.activeElement as HTMLElement | null;
    const held = active && draftsHost.contains(active) ? active : null;
    const action = held?.getAttribute('data-mail-draft-action');
    const origin = returnTo ?? (action ? {
      action, id: held?.closest('[data-mail-draft-id]')?.getAttribute('data-mail-draft-id') ?? null,
    } : null);
    const priorOrder = Array.from(draftsHost.querySelectorAll<HTMLElement>('[data-mail-draft-id]'))
      .map(row => row.getAttribute('data-mail-draft-id')!);
    const busy = draftLoading || deletingDraftId !== null;
    draftsHost.setAttribute('aria-busy', String(busy));
    draftsHost.replaceChildren();
    const button = (label: string, key: string, run: () => void | Promise<unknown>, blocked = busy): HTMLButtonElement => {
      const el = doc.createElement('button'); el.type = 'button'; el.textContent = label; el.className = 'wc-button';
      el.setAttribute('data-mail-draft-action', key);
      if (blocked) el.setAttribute('aria-disabled', 'true');
      const failed = (error: unknown): void => {
        if (!disposed) { draftActionError = humanizeRpcError(error); paintDrafts(); }
      };
      el.onclick = () => {
        if (disposed || !el.isConnected || blocked) return;
        try { void Promise.resolve(run()).catch(failed); } catch (error) { failed(error); }
      };
      return el;
    };
    const header = doc.createElement('div'); header.className = 'mail-route-drafts-header';
    const title = doc.createElement('h2'); title.textContent = 'Saved drafts';
    const refresh = button(draftLoading ? 'Refreshing…' : 'Refresh drafts', 'refresh', () => refreshDrafts());
    refresh.setAttribute('aria-label', 'Refresh drafts');
    header.append(title, refresh); draftsHost.append(header);
    for (const [text, alert] of [[draftNotice, false], [draftActionError, true], [draftListError, true]] as const) {
      if (!text) continue;
      const message = doc.createElement('p'); message.setAttribute('data-mail-draft-feedback', ''); message.textContent = text;
      if (alert) message.setAttribute('role', 'alert');
      draftsHost.append(message);
    }
    if (draftListError || deletionNeedsCheck) draftsHost.append(button('Retry', 'retry', () => refreshDrafts(deletionNeedsCheck ? false : retryDraftsMore)));
    const list = doc.createElement('ul'); list.className = 'mail-route-drafts-list'; draftsHost.append(list);
    const readiness = compose.readiness();
    const mailboxes = 'mailboxes' in readiness ? readiness.mailboxes : [];
    for (const row of draftRows) {
      const subject = row.subject || 'Untitled draft';
      const item = doc.createElement('li'); item.dataset.mailDraftId = row.draft_id; item.className = 'mail-route-draft';
      const summary = doc.createElement('div'); summary.className = 'mail-route-draft-summary';
      const open = button(subject, 'open', async () => {
        if (!await compose.openSaved(row.draft_id)) throw new Error('Close the message you have open before you open another draft.');
      });
      open.className = 'mail-route-draft-open'; open.id = `mail-draft-title-${row.draft_id}`;
      const context = doc.createElement('p'); context.className = 'mail-route-draft-context'; context.id = `mail-draft-context-${row.draft_id}`;
      const sender = mailboxes.find(mailbox => mailbox.mail_instance_slug === row.sender_mail_instance);
      context.append(`From ${sender?.account_email || row.sender_mail_instance} · Edited `);
      const edited = doc.createElement('time'); const date = new Date(row.updated_at);
      if (!Number.isNaN(date.getTime())) edited.dateTime = date.toISOString();
      edited.textContent = formatClientDateTime(row.updated_at, { includeSeconds: false }); context.append(edited);
      open.setAttribute('aria-describedby', context.id);
      const describeAction = (control: HTMLButtonElement): HTMLButtonElement => {
        control.setAttribute('aria-describedby', `${open.id} ${context.id}`); return control;
      };
      summary.append(open, context); item.append(summary);
      if (deleteCandidate?.draft_id === row.draft_id) {
        const candidate = deleteCandidate;
        const confirm = doc.createElement('div'); confirm.className = 'mail-route-draft-confirm';
        confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', 'Delete saved draft');
        const question = doc.createElement('p'); question.textContent = `Delete “${subject}”?`;
        confirm.append(question, describeAction(button(deletingDraftId === row.draft_id ? 'Deleting…' : 'Delete draft', 'confirm-delete', () => deleteDraft(candidate))),
          describeAction(button('Cancel', 'cancel-delete', () => {
            deleteCandidate = null; paintDrafts({ action: 'delete', id: row.draft_id });
          }, deletingDraftId !== null)));
        item.append(confirm);
      } else item.append(describeAction(button('Delete', 'delete', () => {
        draftActionError = null; draftNotice = null; deleteCandidate = { ...row };
        paintDrafts({ action: 'cancel-delete', id: row.draft_id });
      }, busy || deletionNeedsCheck)));
      list.append(item);
    }
    if (!draftRows.length && !draftListError && !draftActionError) {
      const empty = doc.createElement('p'); empty.textContent = draftLoading ? 'Loading drafts…' : 'No saved drafts.'; draftsHost.append(empty);
    }
    if (draftCursor) draftsHost.append(button('More drafts', 'more', () => refreshDrafts(true)));
    if (origin) {
      const controls = Array.from(draftsHost.querySelectorAll<HTMLElement>('[data-mail-draft-action]'));
      const rowId = (control: HTMLElement): string | null => control.closest('[data-mail-draft-id]')?.getAttribute('data-mail-draft-id') ?? null;
      let target = controls.find(control => control.getAttribute('data-mail-draft-action') === origin.action && rowId(control) === origin.id);
      if (!target && origin.id !== null) {
        const index = priorOrder.indexOf(origin.id);
        const nearby = [origin.id, ...priorOrder.slice(index + 1), ...priorOrder.slice(0, Math.max(index, 0)).reverse()];
        for (const id of nearby) {
          target = controls.find(control => control.getAttribute('data-mail-draft-action') === 'open' && rowId(control) === id);
          if (target) break;
        }
      }
      (target ?? refresh).focus({ preventScroll: returnTo === undefined });
    }
  };
  const refreshDrafts = async (more = false): Promise<void> => {
    if (!options.drafts || disposed) return;
    const generation = ++draftGeneration; draftLoading = true; draftListError = null; paintDrafts();
    try {
      const result = await options.drafts.list({ ...(more && draftCursor ? { cursor: draftCursor } : {}), limit: 25 });
      if (disposed || generation !== draftGeneration) return;
      const rows = more ? [...draftRows, ...result.drafts] : result.drafts;
      draftRows = [...new Map(rows.map(row => [row.draft_id, row])).values()]; draftCursor = result.next_cursor;
      if (deleteCandidate && deletingDraftId === null && !draftRows.some(row => sameDraft(row, deleteCandidate!))) {
        deleteCandidate = null; draftActionError = 'The draft list changed. Choose the draft again before deleting.';
      } else if (!deletionNeedsCheck || !more) draftActionError = null;
      if (!more) deletionNeedsCheck = false;
    } catch (error) {
      if (!disposed && generation === draftGeneration) { draftListError = humanizeRpcError(error); retryDraftsMore = more; }
    } finally {
      if (!disposed && generation === draftGeneration) { draftLoading = false; paintDrafts(); }
    }
  };
  const deleteDraft = async (candidate: MailDraftSummary): Promise<void> => {
    if (!options.drafts || disposed || draftLoading || deletingDraftId !== null || deletionNeedsCheck || deleteCandidate !== candidate) return;
    if (!draftRows.some(row => sameDraft(row, candidate))) {
      deleteCandidate = null; draftActionError = 'The draft changed. Refresh drafts before deleting it.'; paintDrafts(); return;
    }
    let deleted = false;
    deletingDraftId = candidate.draft_id; draftActionError = null; draftNotice = null; paintDrafts();
    try {
      const result = await options.drafts.delete({ draft_id: candidate.draft_id, expected_revision: candidate.revision });
      if (disposed) return;
      if (result.deleted !== true) throw new Error('The server did not confirm deletion.');
      // The acknowledged write is authoritative even when the next list read
      // fails. Invalidate older snapshots before removing this known row.
      draftGeneration++; draftLoading = false;
      draftRows = draftRows.filter(row => row.draft_id !== candidate.draft_id);
      deleteCandidate = null; deleted = true; draftNotice = `Deleted “${candidate.subject || 'Untitled draft'}”.`;
    } catch (error) {
      if (!disposed) {
        draftGeneration++; draftLoading = false; deleteCandidate = null; deletionNeedsCheck = true;
        draftActionError = `Couldn’t confirm deletion. ${humanizeRpcError(error)} Refresh drafts to check before deleting again.`;
      }
    } finally {
      if (!disposed) { deletingDraftId = null; paintDrafts(); }
    }
    // End this mutation before awaiting a read: that read may be superseded
    // while another deletion starts, and must not clear its pending state.
    if (deleted && !disposed) await refreshDrafts();
  };
  const cancelDraftDelete = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !deleteCandidate || deletingDraftId !== null) return;
    event.preventDefault(); const id = deleteCandidate.draft_id; deleteCandidate = null; paintDrafts({ action: 'delete', id });
  };
  draftsHost.addEventListener('keydown', cancelDraftDelete);

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
    paintDrafts();
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
      draftsHost.removeEventListener('keydown', cancelDraftDelete);
      compose.destroy();
      root.innerHTML = '';
    },
  };
};
