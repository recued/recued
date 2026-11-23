/** D-335 slice Z (2026-11-06) — the secrets browser steps type, which no model holds.
 *
 *  A batch step names the kind of secret a field takes (`secret`, `BrowserActSecret`). When the
 *  step runs, {@link BrowserSecrets.resolve} answers the secret for that field on that site: one the
 *  owner remembered, else what the owner gives when asked at that step. The ask's only option is
 *  to stop the task; the value comes in through {@link BrowserSecrets.give} (the card's own field,
 *  `notification.giveSecret`; or, a sign-in code only, a message typed in a chat app the ask
 *  reached, taken before it can become a chat turn or a message event — `typedSecretAsks`,
 *  `wire-inbound-answer-dispatcher.ts`), straight to the step that waits for it, which types it in
 *  one command. It is kept in no record: not the ask, not the run, not an audit row (which names the
 *  site, the field and the kind), not a log. A password or a PIN is remembered, sealed, only when
 *  the owner asks; a sign-in code never.
 *
 *  The wait is in memory, at most five minutes: the batch's tabs and what it has done wait in
 *  place. A restart ends it, so the secret asks a restart leaves open are ended at boot. One server,
 *  one owner: the process's registry, as the page reads and the flows are. */

import { randomUUID } from 'node:crypto';

import {
  BROWSER_SECRET_ASK_KIND,
  BROWSER_SECRET_STOP_OPTION,
  BROWSER_SECRET_WAIT_MS,
  browserPassHostOf,
  type BrowserActSecret,
  type BrowserSecretPrompt,
} from '@recued/contracts';
import type { InboundMessageRemoval, SecretAskState } from '@recued/notification';
import type { ActivityAction, AuditLogStore } from '@recued/storage';

import type { BrowserLoginStore } from '../storage/browser-login-store.js';

/** D-335 slice Z (2026-11-17) — how long after a sign-in code's ask ends a code typed for it in a
 *  chat app is still taken: a code sent late must reach no chat turn (which keeps what it is sent and
 *  hands it to the model) and no message event. A sign-in code is commonly good for about ten
 *  minutes. In memory, as the wait is. */
export const BROWSER_SECRET_LATE_MS = 10 * 60_000;

/** A sign-in code as people type one: one run of 4 to 12 letters, digits or dashes with a digit in it
 *  (`123456`, `G-482913`, `AB12CD`), or 2 to 4 groups of 2 to 4 digits split by single spaces
 *  (`123 456`), typed without the spaces. Anything else is conversation, and passes on: `Room 1234`,
 *  `ok`, `thanks`. */
export const signInCodeOf = (text: string): string | null => {
  const typed = text.normalize('NFKC').trim();
  if (/^(?=.*\d)[A-Za-z0-9-]{4,12}$/u.test(typed)) return typed;
  if (!/^\d{2,4}(?: \d{2,4}){1,3}$/u.test(typed)) return null;
  const joined = typed.replaceAll(' ', '');
  return joined.length <= 12 ? joined : null;
};

/** What a chat app is told of a code it sent that no step took. */
export const TYPED_CODE_NOT_GIVEN: Readonly<Record<'late' | 'ambiguous', string>> = {
  late: 'No step is waiting for a sign-in code any more, so this one was not used. Recued kept it nowhere.',
  ambiguous: 'More than one step is waiting for a sign-in code here. Reply to the message that asks for this code, with the code.',
};

/** D-335 slice Z follow-up (2026-11-17) — what became of the owner's message with a code typed in a
 *  chat app, said beside what became of the code: Telegram deletes it; Slack lets no bot delete the
 *  owner's message, so the owner is asked to. */
export const TYPED_CODE_REMOVAL: Readonly<Record<InboundMessageRemoval, string>> = {
  deleted: 'Your message with the code was deleted from this chat.',
  unsupported: 'This chat app does not let Recued delete your message with the code, so delete it yourself.',
  failed: 'Recued could not delete your message with the code, so delete it yourself.',
};

/** Beneath an ask once its secret came: in a chat app, the prompt says it was taken. */
const GIVEN_NOTE = 'Given: it went to your browser for that one step.';

/** What a step asks for: the kind of secret, the origin of the page its field is on, and the field. */
export interface BrowserSecretRequest {
  readonly run_id: string;
  readonly kind: BrowserActSecret;
  /** The origin the secret is typed on: `https://login.live.com`. */
  readonly origin: string;
  /** How the field is found again: `name:passwd`, `id:i0118`, or `label:Password`. */
  readonly field: string;
  /** The field as the page names it. */
  readonly label: string;
  /** D-402 slice H5 (ruling 3) — the browser it is typed in, by its lasting id: a remembered secret is kept
   *  for that browser alone. Unknown, none is read or remembered: the owner is asked each time. */
  readonly browser?: string;
  /** The browser's name as its owner gave it, for the ask. */
  readonly browser_name?: string;
  /** The run's: a stopped run stops waiting. */
  readonly signal?: AbortSignal;
  /** The run's budget hook: the wait for the owner does not count against the run's time, as an
   *  approval's does not. */
  readonly extendBudget?: (ms: number) => void;
}

/** The secret, and where it came from; or why there is none, in the words of the step's error. */
export type BrowserSecretAnswer =
  | { readonly value: string; readonly from: 'saved' | 'owner' }
  | { readonly refused: string };

export interface BrowserSecretSource {
  resolve(request: BrowserSecretRequest): Promise<BrowserSecretAnswer>;
}

/** The slice of the notification block a secret ask needs. */
export interface BrowserSecretNotifier {
  ask(
    message: { title: string; text: string; chat?: { title?: string; text: string } },
    options: readonly { id: string; label: string }[],
    handler: { kind: string; payload: Record<string, unknown> },
  ): Promise<{ ask_id: string }>;
  cancelAsk(ask_id: string, options?: { readonly note?: string }): Promise<'cancelled' | 'not_open'>;
  listOpenAsks(): Promise<readonly { ask_id: string; handler_kind: string }[]>;
  registerAskHandler(
    kind: string,
    handler: (payload: Record<string, unknown>, answer: { option: string }) => void | Promise<void>,
  ): void;
}

/** Whether a notification block carries the four methods a secret ask needs: one without them
 *  leaves secrets unasked (a step that needs one stops, saying so) rather than failing the boot. */
export const hasBrowserSecretSurface = (block: unknown): block is BrowserSecretNotifier => {
  const candidate = block as Partial<BrowserSecretNotifier> | null | undefined;
  return typeof candidate?.ask === 'function' && typeof candidate.cancelAsk === 'function'
    && typeof candidate.listOpenAsks === 'function' && typeof candidate.registerAskHandler === 'function';
};

export interface BrowserSecretDeps {
  readonly notifier: BrowserSecretNotifier;
  readonly logins?: BrowserLoginStore;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
  readonly waitMs?: number;
}

/** D-335 slice Z — the secrets a chat app may type (`wire-inbound-answer-dispatcher.ts`). */
export interface TypedSecretIntake {
  /** The asks a secret typed in a chat app may answer: a sign-in code's, waiting, or ended within
   *  `BROWSER_SECRET_LATE_MS`. Never a password's or a PIN's: those are given in the Recued app only.
   *  Empty while none waits, the common case, so a chat message costs nothing more then. */
  typedSecretAsks(): ReadonlyMap<string, SecretAskState>;
  /** The owner gave the secret an open ask waits for, in the Recued app or, a sign-in code, in the
   *  chat app named by `via`, where `removal` says what became of their message with it. False when
   *  no step waits on it any longer. */
  give(ask_id: string, value: string, remember: boolean, via?: string, removal?: InboundMessageRemoval): Promise<boolean>;
}

export interface BrowserSecrets extends BrowserSecretSource, TypedSecretIntake {
  /** Wire the asks, the remembered logins and the audit. Once, at boot: it also ends the secret asks
   *  a restart left open, whose steps are gone. */
  install(deps: BrowserSecretDeps): Promise<void>;
}

interface Waiting {
  readonly request: BrowserSecretRequest;
  readonly settle: (answer: BrowserSecretAnswer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  ask_id?: string;
}

const wording = (kind: BrowserActSecret, site: string) =>
  kind === 'sign-in code' ? `the sign-in code ${site} sent you` : `your ${kind} for ${site}`;

export const createBrowserSecrets = (): BrowserSecrets => {
  let deps: BrowserSecretDeps | undefined;
  const waiting = new Map<string, Waiting>();
  const byAsk = new Map<string, string>();
  /** A sign-in code's ask whose wait ended → when: a code typed for it late is still taken. */
  const ended = new Map<string, number>();
  const now = () => deps?.now?.() ?? Date.now();
  const pruneEnded = (): void => {
    const cutoff = now() - BROWSER_SECRET_LATE_MS;
    for (const [ask_id, at] of ended) if (at < cutoff) ended.delete(ask_id);
  };
  const audit = (action: ActivityAction, request: BrowserSecretRequest, extra: Record<string, unknown> = {}): void => {
    if (deps?.auditLog === undefined) return;
    void deps.auditLog.logActivity({
      activity_id: '', timestamp: now(), action, target: request.origin,
      detail: JSON.stringify({ run_id: request.run_id, field: request.field, label: request.label, kind: request.kind,
        ...(request.browser !== undefined ? { browser: request.browser } : {}), ...extra }),
    }).catch(() => undefined);
  };
  /** End a wait: its ask closes everywhere unless the owner already answered it, with `note` beneath
   *  it where a chat app shows the closed prompt. */
  const finish = (request_id: string, answer: BrowserSecretAnswer, close: boolean, note?: string): void => {
    const wait = waiting.get(request_id);
    if (wait === undefined) return;
    waiting.delete(request_id);
    clearTimeout(wait.timer);
    wait.request.signal?.removeEventListener('abort', wait.onAbort);
    if (wait.ask_id !== undefined) {
      byAsk.delete(wait.ask_id);
      if (wait.request.kind === 'sign-in code') {
        pruneEnded();
        ended.set(wait.ask_id, now());
      }
      if (close) {
        // ⛔ No explicit trailing `undefined`: the call's arity is what a caller's assertion sees.
        const closing = note === undefined ? deps?.notifier.cancelAsk(wait.ask_id) : deps?.notifier.cancelAsk(wait.ask_id, { note });
        void closing?.catch(() => undefined);
      }
    }
    wait.settle(answer);
  };

  return {
    async install(next) {
      deps = next;
      next.notifier.registerAskHandler(BROWSER_SECRET_ASK_KIND, (payload, answer) => {
        if (answer.option !== BROWSER_SECRET_STOP_OPTION || typeof payload.request_id !== 'string') return;
        const wait = waiting.get(payload.request_id);
        if (wait === undefined) return;
        finish(payload.request_id, { refused: `you stopped the task here, at the step that needed `
          + `${wording(wait.request.kind, browserPassHostOf(wait.request.origin))}` }, false);
      });
      for (const ask of await next.notifier.listOpenAsks().catch(() => [])) {
        if (ask.handler_kind === BROWSER_SECRET_ASK_KIND) await next.notifier.cancelAsk(ask.ask_id).catch(() => undefined);
      }
    },

    async resolve(request) {
      const site = browserPassHostOf(request.origin);
      if (deps === undefined) {
        return { refused: `this step needs ${wording(request.kind, site)}, and Recued cannot ask you for it here` };
      }
      // D-402 slice H5 — remembered per browser: another browser's login is not this one's.
      const keeps = request.kind !== 'sign-in code' && deps.logins !== undefined && request.browser !== undefined;
      if (keeps) {
        const saved = await deps.logins!.get(request.browser!, request.origin, request.field);
        if (saved !== undefined) {
          deps.logins!.used(request.browser!, request.origin, request.field, now());
          audit('browser_login_used', request);
          return { value: saved, from: 'saved' };
        }
      }
      if (request.signal?.aborted === true) return { refused: 'the task was stopped' };
      const waitMs = deps.waitMs ?? BROWSER_SECRET_WAIT_MS;
      // Waiting for the owner is no work of the run's: its budget grows by the most it can wait.
      request.extendBudget?.(waitMs);
      const request_id = randomUUID();
      const prompt: BrowserSecretPrompt = { kind: request.kind, site, field: request.label,
        remember: keeps, expires_at: now() + waitMs, ...(request.browser_name !== undefined ? { browser: request.browser_name } : {}) };
      const minutes = Math.round(waitMs / 60_000);
      const how = minutes < 1 ? 'a short while' : minutes === 1 ? 'a minute' : `${minutes} minutes`;
      const answered = new Promise<BrowserSecretAnswer>((settle) => {
        const timer = setTimeout(() => finish(request_id, { refused: `nobody gave ${wording(request.kind, site)} `
          + `within ${how}, so the task stopped at this step` }, true), waitMs);
        timer.unref?.();
        const onAbort = () => finish(request_id, { refused: 'the task was stopped while it waited for '
          + wording(request.kind, site) }, true);
        request.signal?.addEventListener('abort', onAbort, { once: true });
        waiting.set(request_id, { request, settle, timer, onAbort });
      });
      const title = request.kind === 'sign-in code' ? `The sign-in code for ${site}` : `Your ${request.kind} for ${site}`;
      const needs = `A step in ${request.browser_name !== undefined ? `“${request.browser_name}”` : 'your browser'} needs `
        + `${wording(request.kind, site)}, to type into the field “${request.label}”. `;
      try {
        const { ask_id } = await deps.notifier.ask(
          { title,
            text: `${needs}Give it in the Recued app, on this ask: it goes to your browser for that one step and is kept nowhere else`
              + `${prompt.remember ? ', unless you choose to remember it' : ''}. Do not send it in a chat. `
              + `The task waits ${how} for it.`,
            // A sign-in code may come from a chat app the ask reached, since it is used once within
            // minutes (D-335 slice Z); a password or a PIN only in the Recued app. The app's card and
            // email keep the words above, which send the owner to the app.
            ...(request.kind === 'sign-in code' ? { chat: { title, text: `${needs}Send the code here, as a message `
              + 'on its own: it goes to your browser for that one step and is kept nowhere else. You can also give it '
              + `in the Recued app, on this ask. The task waits ${how} for it.` } } : {}) },
          [{ id: BROWSER_SECRET_STOP_OPTION, label: 'Stop the task' }],
          { kind: BROWSER_SECRET_ASK_KIND, payload: { ...prompt, request_id } },
        );
        const wait = waiting.get(request_id);
        if (wait === undefined) {
          // It ended while the ask was being made (the run stopped): close the ask too.
          void deps.notifier.cancelAsk(ask_id).catch(() => undefined);
        } else {
          wait.ask_id = ask_id;
          byAsk.set(ask_id, request_id);
          audit('browser_secret_asked', request);
        }
      } catch {
        finish(request_id, { refused: `Recued could not ask you for ${wording(request.kind, site)}` }, false);
      }
      return answered;
    },

    async give(ask_id, value, remember, via, removal) {
      const request_id = byAsk.get(ask_id);
      const wait = request_id === undefined ? undefined : waiting.get(request_id);
      if (request_id === undefined || wait === undefined) return false;
      const { request } = wait;
      // ⛔ A chat app gives a sign-in code only (`typedSecretAsks`); a password or a PIN typed there
      // would be in the chat app's history, and the ask never offered it.
      if (via !== undefined && request.kind !== 'sign-in code') return false;
      let remembered = false;
      if (remember && request.kind !== 'sign-in code' && deps?.logins !== undefined && request.browser !== undefined) {
        remembered = await deps.logins.save({ browser: request.browser, origin: request.origin, field: request.field,
          label: request.label, kind: request.kind, value, now: now() }).catch(() => false);
      }
      audit('browser_secret_given', request, { remembered, ...(via !== undefined ? { via } : {}) });
      if (remembered) audit('browser_login_saved', request);
      finish(request_id, { value, from: 'owner' }, true,
        via !== undefined && removal !== undefined ? `${GIVEN_NOTE} ${TYPED_CODE_REMOVAL[removal]}` : GIVEN_NOTE);
      return true;
    },

    typedSecretAsks() {
      pruneEnded();
      const asks = new Map<string, SecretAskState>();
      for (const ask_id of ended.keys()) asks.set(ask_id, 'ended');
      for (const wait of waiting.values()) {
        if (wait.request.kind === 'sign-in code' && wait.ask_id !== undefined) asks.set(wait.ask_id, 'waiting');
      }
      return asks;
    },
  };
};

/** The process's: the server installs it at boot, once the notification block is up. */
export const browserSecrets: BrowserSecrets = createBrowserSecrets();
