/** D-335 slice Z (2026-11-06) — a secret typed into a web page that the model never holds.
 *
 *  The owner: *"password if it is supplied the entering on behalf of user makes sense, if it is not
 *  supply, an ask still goes no way unless the ask is modified to supply a way to get the
 *  password"*, *"it should bind to the field & possibly site/page, for there'd be more than one
 *  password"*, and *"the secret in ask is a perfect solution for two-fa scenario"*.
 *
 *  A batch step names the kind of secret (`secret`, {@link BrowserActSecret}), never the secret.
 *  When the step runs, Recued types the one the owner saved for that field on that site, or asks
 *  the owner for it at that step and waits: an ask that takes a value, given in the Recued app,
 *  which goes to the Browser Bridge in that one command and is kept nowhere else, unless the owner
 *  chooses to remember it. A sign-in code is never remembered. */

import type { BrowserActSecret } from './browser-act.js';

/** The ask kind a secret is asked for under. Its answer is the value, given through
 *  `notification.giveSecret`, never one of the ask's options: the one option an ask for a secret
 *  offers is to stop the task. */
export const BROWSER_SECRET_ASK_KIND = 'browser_secret';
/** The one option a secret ask offers, everywhere it is shown: to stop the task at that step. */
export const BROWSER_SECRET_STOP_OPTION = 'browser_secret_stop';
/** How long a step waits for the owner to give a secret before the batch stops there. */
export const BROWSER_SECRET_WAIT_MS = 5 * 60_000;
/** The longest secret taken. */
export const BROWSER_SECRET_MAX_CHARS = 1_000;

/** What a secret ask asks for, as the card shows it: the kind of secret, the site, the field as the
 *  page names it, whether it can be remembered (never a sign-in code), and when the step stops
 *  waiting. Never a value. */
export interface BrowserSecretPrompt {
  readonly kind: BrowserActSecret;
  /** The site the field is on, as the owner reads it: `login.live.com`. */
  readonly site: string;
  /** The field as the page names it: `Password`. */
  readonly field: string;
  readonly remember: boolean;
  readonly expires_at: number;
  /** D-402 slice H5 (ruling 3) — the browser it is typed in, by the owner's name, when Recued knows it: a
   *  remembered secret is kept for that browser alone. */
  readonly browser?: string;
}

/** A login the owner chose to remember, as the owner's list shows it: never the secret. */
export interface BrowserLoginRow {
  /** D-402 slice H5 (ruling 3) — the browser it was saved in, by its lasting id, and only that one: two
   *  accounts on one site in two browsers each keep their own. */
  readonly browser: string;
  /** The browser's name as its owner gave it, when the list could name it. */
  readonly browser_name?: string;
  /** The origin the secret is typed on, and only there: `https://login.live.com`. */
  readonly origin: string;
  readonly site: string;
  /** How Recued finds the field again (`name:passwd`, `id:i0118`, or `label:Password`). */
  readonly field: string;
  /** The field as the page named it when the owner saved it. */
  readonly label: string;
  readonly kind: BrowserActSecret;
  readonly saved_at: number;
  readonly used_at?: number;
}

/** A secret prompt read back from an ask's handler payload, or undefined for anything else. */
export const readBrowserSecretPrompt = (payload: unknown): BrowserSecretPrompt | undefined => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if ((p.kind !== 'password' && p.kind !== 'PIN' && p.kind !== 'sign-in code') || typeof p.site !== 'string'
    || typeof p.field !== 'string' || typeof p.remember !== 'boolean' || typeof p.expires_at !== 'number') return undefined;
  return { kind: p.kind, site: p.site, field: p.field, remember: p.remember, expires_at: p.expires_at,
    // D-402 slice H5 — the browser it is typed in, by the owner's name, when the ask named one.
    ...(typeof p.browser === 'string' && p.browser !== '' ? { browser: p.browser } : {}) };
};
