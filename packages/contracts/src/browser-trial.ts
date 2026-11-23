/** D-402 slice C (2026-11-17) — "Try it": a draft recipe run once, for real, before it is saved, with
 *  every change asked about first (§8, ruling 8: "the first trial run asks before each change").
 *
 *  A change in a web page is asked about at the moment it would happen, on the live page: the batch
 *  describes the element as the page names it and shows the full text it would type, and waits. So
 *  a step on a page the batch itself opens, or after a step that moved the page, is asked about as
 *  plainly as the first one, and the draft runs exactly as it is written (§8.1 first had the trial
 *  split its Act calls where an ask made before the batch could not see the page; asking at the
 *  step needs no split, and keeps the run's results those of the recipe the owner saves, which its
 *  saved test is built from, §8.3). Any other change a step makes (an email, a file, a record) is
 *  held before its step as an owner's "always ask" action is, whatever would stand in for it. */

/** The ask kind a change in a trial is asked about under. */
export const BROWSER_TRIAL_ASK_KIND = 'browser_trial_step';
/** The two answers a trial's ask takes. */
export const BROWSER_TRIAL_DO_OPTION = 'browser_trial_do';
export const BROWSER_TRIAL_STOP_OPTION = 'browser_trial_stop';
/** How long a step waits for the owner's answer before the trial stops there. The batch's tabs, and
 *  what it has done, wait in place. */
export const BROWSER_TRIAL_WAIT_MS = 5 * 60_000;
/** The longest typed text an ask shows whole. */
export const BROWSER_TRIAL_MAX_TEXT_CHARS = 4_000;

/** What a change does, as its ask names it. */
export type BrowserTrialAction =
  | 'type' | 'pick' | 'click' | 'press' | 'submit' | 'upload' | 'go' | 'back' | 'reload' | 'close' | 'open' | 'collect';

/** What a trial's ask asks about, as the card shows it. Never a secret: a password step's ask says
 *  which kind of secret it types, not the secret. */
export interface BrowserTrialPrompt {
  readonly action: BrowserTrialAction;
  /** The site, as the owner reads it: `en.wikipedia.org`. */
  readonly site: string;
  /** The page it happens on, or (`open`, `go`) the address it goes to. */
  readonly url: string;
  /** The element, as the page names it at that moment. Absent for a step that names none. */
  readonly element?: { readonly role: string; readonly label: string };
  /** The whole text a step types, or the key it presses. */
  readonly text?: string;
  /** The kind of secret a step types (`password`), in place of any text. */
  readonly secret?: string;
  /** The file an upload puts into the page, by its name. */
  readonly file?: string;
  /** The typing sends the form it is in as well. */
  readonly submits?: true;
  /** The step's place in its batch: 2 of 5. */
  readonly step: number;
  readonly of: number;
  /** When the step stops waiting. */
  readonly expires_at: number;
}

const ACTIONS: ReadonlySet<string> = new Set(['type', 'pick', 'click', 'press', 'submit', 'upload', 'go', 'back', 'reload',
  'close', 'open', 'collect']);

/** A trial prompt read back from an ask's handler payload, or undefined for anything else. */
export const readBrowserTrialPrompt = (payload: unknown): BrowserTrialPrompt | undefined => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.action !== 'string' || !ACTIONS.has(p.action) || typeof p.site !== 'string' || typeof p.url !== 'string'
    || typeof p.step !== 'number' || typeof p.of !== 'number' || typeof p.expires_at !== 'number') return undefined;
  const element = p.element !== null && typeof p.element === 'object' && !Array.isArray(p.element)
    && typeof (p.element as Record<string, unknown>).role === 'string' && typeof (p.element as Record<string, unknown>).label === 'string'
    ? { role: (p.element as { role: string }).role, label: (p.element as { label: string }).label } : undefined;
  return { action: p.action as BrowserTrialAction, site: p.site, url: p.url, step: p.step, of: p.of, expires_at: p.expires_at,
    ...(element !== undefined ? { element } : {}),
    ...(typeof p.text === 'string' ? { text: p.text } : {}),
    ...(typeof p.secret === 'string' ? { secret: p.secret } : {}),
    ...(typeof p.file === 'string' ? { file: p.file } : {}),
    ...(p.submits === true ? { submits: true as const } : {}) };
};

/** The sentence a trial's ask puts to the owner: what the step will do, where, with what. */
export const browserTrialSentence = (prompt: BrowserTrialPrompt): string => {
  const element = prompt.element !== undefined
    ? `the ${prompt.element.role || 'element'}${prompt.element.label !== '' ? ` “${prompt.element.label}”` : ''}` : 'the page';
  const where = ` on ${prompt.url}`;
  const sends = prompt.submits === true ? ', then send the form' : '';
  switch (prompt.action) {
    case 'type': return prompt.secret !== undefined
      ? `Type your ${prompt.secret} into ${element}${sends}${where}.`
      : `Type “${prompt.text ?? ''}” into ${element}${sends}${where}.`;
    case 'pick': return `Type “${prompt.text ?? ''}” into ${element} and pick its suggestion${sends}${where}.`;
    case 'click': return `Click ${element}${where}.`;
    case 'press': return `Press ${prompt.text ?? 'a key'} in ${element}${where}.`;
    case 'submit': return `Send the form through ${element}${where}.`;
    case 'upload': return `Put your file${prompt.file !== undefined ? ` “${prompt.file}”` : ''} into ${element}${where}.`;
    case 'go': return `Go to ${prompt.url}.`;
    case 'back': return `Go back from ${prompt.url}.`;
    case 'reload': return `Reload ${prompt.url}.`;
    case 'close': return `Close the tab showing ${prompt.url}.`;
    case 'open': return `Open ${prompt.url} in a new tab.`;
    case 'collect': return `Turn the pages of ${prompt.url}, following ${element}, to collect what they list.`;
  }
};

/** D-402 slice C — a trial run of the recipe as it stands in Kitchen, unsaved: run once for real in
 *  the owner's browser, every change asked about first (`recipe.try`). */
export interface RecipeTryRequest {
  /** The recipe as the editor holds it, which Kitchen's save checks pass. */
  recipe: unknown;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
}
