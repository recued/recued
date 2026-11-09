/** D-335 slice Z (2026-11-06) — the secrets browser steps type, which no model holds.
 *
 *  A batch step names the kind of secret a field takes (`secret`, `BrowserActSecret`). When the
 *  step runs, {@link BrowserSecrets.resolve} answers the secret for that field on that site: one the
 *  owner remembered, else what the owner gives when asked at that step. The ask's only option is
 *  to stop the task; the value comes in through {@link BrowserSecrets.give} (the card's own field,
 *  `notification.giveSecret`), straight to the step that waits for it, which types it in one
 *  command. It is kept in no record: not the ask, not the run, not an audit row (which names the
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
import type { ActivityAction, AuditLogStore } from '@recued/storage';

import type { BrowserLoginStore } from '../storage/browser-login-store.js';

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
    message: { title: string; text: string },
    options: readonly { id: string; label: string }[],
    handler: { kind: string; payload: Record<string, unknown> },
  ): Promise<{ ask_id: string }>;
  cancelAsk(ask_id: string): Promise<'cancelled' | 'not_open'>;
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

export interface BrowserSecrets extends BrowserSecretSource {
  /** Wire the asks, the remembered logins and the audit. Once, at boot: it also ends the secret asks
   *  a restart left open, whose steps are gone. */
  install(deps: BrowserSecretDeps): Promise<void>;
  /** The owner gave the secret an open ask waits for. False when no step waits on it any longer. */
  give(ask_id: string, value: string, remember: boolean): Promise<boolean>;
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
  const now = () => deps?.now?.() ?? Date.now();
  const audit = (action: ActivityAction, request: BrowserSecretRequest, extra: Record<string, unknown> = {}): void => {
    if (deps?.auditLog === undefined) return;
    void deps.auditLog.logActivity({
      activity_id: '', timestamp: now(), action, target: request.origin,
      detail: JSON.stringify({ run_id: request.run_id, field: request.field, label: request.label, kind: request.kind, ...extra }),
    }).catch(() => undefined);
  };
  /** End a wait: its ask closes everywhere unless the owner already answered it. */
  const finish = (request_id: string, answer: BrowserSecretAnswer, close: boolean): void => {
    const wait = waiting.get(request_id);
    if (wait === undefined) return;
    waiting.delete(request_id);
    clearTimeout(wait.timer);
    wait.request.signal?.removeEventListener('abort', wait.onAbort);
    if (wait.ask_id !== undefined) {
      byAsk.delete(wait.ask_id);
      if (close) void deps?.notifier.cancelAsk(wait.ask_id).catch(() => undefined);
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
      if (request.kind !== 'sign-in code' && deps.logins !== undefined) {
        const saved = await deps.logins.get(request.origin, request.field);
        if (saved !== undefined) {
          deps.logins.used(request.origin, request.field, now());
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
        remember: request.kind !== 'sign-in code' && deps.logins !== undefined, expires_at: now() + waitMs };
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
      try {
        const { ask_id } = await deps.notifier.ask(
          { title: request.kind === 'sign-in code' ? `The sign-in code for ${site}` : `Your ${request.kind} for ${site}`,
            text: `A step in your browser needs ${wording(request.kind, site)}, to type into the field “${request.label}”. `
              + 'Give it in the Recued app, on this ask: it goes to your browser for that one step and is kept nowhere else'
              + `${prompt.remember ? ', unless you choose to remember it' : ''}. Do not send it in a chat. `
              + `The task waits ${how} for it.` },
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

    async give(ask_id, value, remember) {
      const request_id = byAsk.get(ask_id);
      const wait = request_id === undefined ? undefined : waiting.get(request_id);
      if (request_id === undefined || wait === undefined) return false;
      const { request } = wait;
      let remembered = false;
      if (remember && request.kind !== 'sign-in code' && deps?.logins !== undefined) {
        remembered = await deps.logins.save({ origin: request.origin, field: request.field, label: request.label,
          kind: request.kind, value, now: now() }).catch(() => false);
      }
      audit('browser_secret_given', request, { remembered });
      if (remembered) audit('browser_login_saved', request);
      finish(request_id, { value, from: 'owner' }, true);
      return true;
    },
  };
};

/** The process's: the server installs it at boot, once the notification block is up. */
export const browserSecrets: BrowserSecrets = createBrowserSecrets();
