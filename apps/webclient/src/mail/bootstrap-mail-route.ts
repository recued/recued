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
 *  the user is when it happens. */

import { composeDialog } from '@recued/contracts';
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

export const MAIL_ROUTE_HOST_ATTR = 'data-recued-mail-route';
export const MAIL_ROUTE_COMPOSE_ATTR = 'data-recued-mail-compose';
export const MAIL_ROUTE_DIALOG_ATTR = 'data-recued-mail-dialog';
export const MAIL_ROUTE_MAILBOX_ATTR = 'data-recued-mail-mailbox';
export const MAIL_ROUTE_EMPTY_ATTR = 'data-recued-mail-empty';
export const MAIL_ROUTE_STYLES_MARKER = 'data-recued-mail-styles';

export const MAIL_ROUTE_STYLES = `
${FORM_RENDERER_STYLES}
${MAIL_COMPOSE_STYLES}
${FILE_PICK_STYLES}
[${MAIL_ROUTE_HOST_ATTR}] { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
[${MAIL_ROUTE_HOST_ATTR}] .mail-route-title { margin: 0; font-size: 20px; font-weight: 600; }
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

  root.innerHTML = `
    <section ${MAIL_ROUTE_HOST_ATTR}>
      <header class="mail-route-header">
        <h1 class="mail-route-title">Mail</h1>
        <button type="button" ${MAIL_ROUTE_COMPOSE_ATTR} class="mail-route-compose">New mail</button>
      </header>
      <div class="mail-route-roster"></div>
      <div ${MAIL_ROUTE_DIALOG_ATTR}></div>
    </section>
  `;

  const roster = root.querySelector<HTMLElement>('.mail-route-roster')!;
  const dialogHost = root.querySelector<HTMLElement>(`[${MAIL_ROUTE_DIALOG_ATTR}]`)!;
  const composeButton = root.querySelector<HTMLButtonElement>(`[${MAIL_ROUTE_COMPOSE_ATTR}]`)!;

  let mailboxes: ReadonlyArray<{
    slug: string;
    account_email: string;
    send_capable: boolean;
  }> = [];

  // The route reads the roster for its own rendering AND hands the same caller
  // to the compose host. One server read would be tidier, but two callers with
  // one source is what keeps this file from owning the host's state.
  const listMailInstances: MailComposeDeps['listMailInstances'] = async () => {
    const listed = await options.listMailInstances();
    mailboxes = listed.instances;
    return listed;
  };

  // The file half is wired ONLY when a search caller exists, so a host without
  // one leaves the Attach control inert instead of opening an empty chooser.
  const fileDeps: Pick<MailComposeDeps, 'listFiles' | 'pickFiles'> =
    options.searchFiles === undefined
      ? {}
      : {
        listFiles: () => listComposeFiles(options.searchFiles!),
        pickFiles: async () => {
          const inventory = await listComposeFiles(options.searchFiles!);
          const dialog = composeDialog(compose.state());
          return openFilePickPanel(doc, inventory, dialog?.values.attachments ?? []);
        },
      };

  const compose = mountMailCompose(dialogHost, {
    ...options,
    ...fileDeps,
    listMailInstances,
  });

  const renderRoster = (): void => {
    if (mailboxes.length === 0) {
      roster.innerHTML = `<p class="mail-route-empty" ${MAIL_ROUTE_EMPTY_ATTR}="none">
        No mail account is connected yet. Connect one in
        <a href="${esc(serializeShellRoute('connections'))}">Settings → Connections</a>
        to send from Recued.
      </p>`;
      composeButton.disabled = true;
      return;
    }
    const sendable = mailboxes.filter((m) => m.send_capable);
    if (sendable.length === 0) {
      roster.innerHTML = `<p class="mail-route-empty" ${MAIL_ROUTE_EMPTY_ATTR}="read-only">
        Your mail ${mailboxes.length === 1 ? 'account is' : 'accounts are'} connected for reading only.
        Sending needs SMTP, the <code>gmail.send</code> scope, or <code>Mail.Send</code> —
        re-connect in <a href="${esc(serializeShellRoute('connections'))}">Settings → Connections</a>.
      </p>`;
      composeButton.disabled = true;
      return;
    }
    composeButton.disabled = false;
    roster.innerHTML = `<ul class="mail-route-mailboxes">${mailboxes
      .map((m) => `<li class="mail-route-mailbox" ${MAIL_ROUTE_MAILBOX_ATTR}="${esc(m.slug)}">
        <span class="mail-route-mailbox-email">${esc(m.account_email.length > 0 ? m.account_email : m.slug)}</span>
        <span class="mail-route-mailbox-cap">${m.send_capable ? 'can send' : 'read only'}</span>
      </li>`)
      .join('')}</ul>`;
  };

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`[${MAIL_ROUTE_COMPOSE_ATTR}]`) !== null) compose.openCreate();
  };
  root.addEventListener('click', onClick);

  const refresh = async (): Promise<void> => {
    await compose.refresh();
    renderRoster();
  };

  // Render the roster's own empty state immediately so the surface is never
  // blank while the first read is in flight.
  renderRoster();
  const loaded = refresh();
  // The mount must not reject; `whenLoaded` is the shell's freshness probe, not
  // an error channel (`refresh` already swallows a failed read into an empty
  // roster, which renders the "no account" state).
  void loaded.catch(() => {});

  /** Anything the person typed that would be lost. Values are compared against
   *  the empty seed rather than checked for truthiness so a compose opened and
   *  immediately abandoned does not prompt. ⚠ `sender_source` is deliberately
   *  EXCLUDED: it is prefilled by the route, so counting it would make every
   *  freshly-opened dialog look dirty. */
  const hasUnsavedChanges = (): boolean => {
    const dialog = composeDialog(compose.state());
    if (dialog === null) return false;
    const v = dialog.values;
    return (
      v.subject.trim().length > 0
      || v.body.trim().length > 0
      || v.to.length > 0
      || v.cc.length > 0
      || v.bcc.length > 0
      || v.attachments.length > 0
    );
  };

  return {
    refresh,
    compose: () => compose,
    hasUnsavedChanges,
    unsavedChangesPrompt: () =>
      hasUnsavedChanges()
        ? 'This message has not been sent. Leaving Mail discards it.'
        : null,
    whenLoaded: () => loaded,
    dispose() {
      root.removeEventListener('click', onClick);
      compose.destroy();
      root.innerHTML = '';
    },
  };
};
