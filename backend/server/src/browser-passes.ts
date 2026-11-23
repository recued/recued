/** D-335 slice F — where the passes for Browser Toolkit writes meet the holds.
 *
 *  A held browser write offers a pass on its site (`browserPassOfferFor`, recorded on the
 *  checkpoint); the owner's "Allow on <site> for this session" or "Always allow on <site>"
 *  mints it, and every answer teaches its key (`recordBrowserPassAnswer`, called by the
 *  resumer on approve and on deny). The commit gateway lets a live pass stand in for the ask
 *  (`useBrowserPass`). The store and its suggestion rule are in
 *  `storage/browser-pass-store.ts` and `@recued/contracts`'s `browser-pass.ts`.
 *
 *  ⚠ A PASS NEVER COSTS THE ANSWER. A store that fails is logged and the write's own outcome
 *  is untouched: a pass not kept is friction (the next write asks), never harm. */

import {
  browserPassActsOf,
  browserPassElementOf,
  browserPassHostOf,
  browserPassKeyHash,
  browserPassOccasionOf,
  browserPassSiteOf,
  describeBrowserPass,
  readBrowserPassOffer,
  writeRulePrincipalOf,
  type BrowserPassBrowser,
  type BrowserPassKey,
  type BrowserPassAnswerKind,
  type BrowserPassKind,
  type BrowserPassOffer,
  type BrowserPassRow,
  type BrowserRequestPass,
  type Checkpoint,
  type ExecutionSource,
} from '@recued/contracts';
import type { PreflightNotifier } from '@recued/gateway';

import type { BrowserPassStore } from './storage/browser-pass-store.js';

/** The kernel slug that opens a page: its site is the address it opens, read from the call.
 *  Typing and clicking take theirs from the page, as the Bridge reads it. */
const DOM_OPEN_SLUG = 'dom-open';

/** The site a held browser write acts on: for opening, the origin of the address; for typing
 *  and clicking, the origin of the page the Bridge read (`HeldBrowserTarget.origin`). Never a
 *  value the model supplied for the purpose. Undefined when neither was read. */
export const browserPassSiteFor = (
  slug: string | undefined,
  input: unknown,
  target: { readonly origin?: string } | undefined,
): string | undefined => {
  if (slug === DOM_OPEN_SLUG) {
    return input !== null && typeof input === 'object' && !Array.isArray(input)
      ? browserPassSiteOf((input as { address?: unknown }).address)
      : undefined;
  }
  return browserPassSiteOf(target?.origin);
};

/** The pass a held browser write's site answers would mint, or none: who must be a caller a
 *  pass can name (the owner's chats, or an AI app), and the site must have been read. */
export const browserPassOfferFor = (input: {
  readonly source: ExecutionSource | undefined;
  readonly recipe_id: string;
  readonly site: string | undefined;
  readonly channel_session_id: string | undefined;
  /** D-402 slice H4c — the browser the write runs in, for a recipe that names its browsers. */
  readonly browser?: string;
  /** D-402 slice H4d — its name, as its owner gave it: the ask says its answers are for it alone. */
  readonly browser_name?: string;
}): BrowserPassOffer | undefined => {
  if (input.source === undefined || input.site === undefined || input.channel_session_id === undefined) return undefined;
  const principal = writeRulePrincipalOf(input.source);
  if (principal === undefined || input.recipe_id.length === 0) return undefined;
  return {
    key: { principal, recipe: input.recipe_id, site: input.site, ...(input.browser !== undefined ? { browser: input.browser } : {}) },
    host: browserPassHostOf(input.site),
    channel_session_id: input.channel_session_id,
    ...(input.browser !== undefined && input.browser_name !== undefined ? { browser_name: input.browser_name } : {}),
  };
};

/** The owner, told once, when a key's suggestion opens. */
export const browserPassSuggestedNotice = (key: BrowserPassKey, browser?: BrowserPassBrowser): { title: string; text: string } => {
  const who = key.principal.kind === 'owner_chat' ? 'your chats' : 'an AI app';
  return {
    // D-402 slice H4d — for a key that names its browser, the title says which: it is for that one alone.
    title: `Always allow? ${describeBrowserPass(key, browser)}`,
    text: `You have said yes to ${browserPassActsOf(key)}, asked by ${who}, again and again this month. `
      + `You can let them happen without asking: see Passes Recued suggests, under Contracts. `
      + 'Until you do, each one asks.',
  };
};

/** Keep the owner's answer to a held browser write, and mint the pass a site answer chose. A
 *  hold that offered no pass (an unknown site, a caller no pass names) teaches nothing. */
export const recordBrowserPassAnswer = (
  deps: {
    readonly browserPasses?: BrowserPassStore;
    readonly preflightNotifier?: Pick<PreflightNotifier, 'notify'>;
  } | undefined,
  checkpoint: Checkpoint,
  outcome: 'approved' | 'refused',
  options: { readonly pass?: BrowserPassAnswerKind; readonly decision_version?: 1; readonly now?: number } = {},
): void => {
  const store = deps?.browserPasses;
  const offer = readBrowserPassOffer(checkpoint.preflight_context?.browser_pass);
  if (store === undefined || offer === undefined) return;
  const now = options.now ?? Date.now();
  try {
    if (outcome === 'approved' && options.pass !== undefined && options.decision_version === 1) {
      if (!checkpoint.run_id || !checkpoint.checkpoint_id) throw new Error('a browser pass needs its durable approval identity');
      // First the pass, so an "Always allow" answer is never also suggested to the owner.
      // Legacy saved answers keep their one-time approval; they cannot safely create standing trust.
      store.grantForDecision({
        approval_ref: JSON.stringify(['preflight', checkpoint.run_id, checkpoint.checkpoint_id]),
        offer, kind: options.pass, now,
      });
    }
  } catch (error) {
    console.warn(`[browser-passes] the pass on ${offer.host} was not kept: `
      + (error instanceof Error ? error.message : String(error)));
  }
  // An approval the owner had to change first is no evidence for a standing pass (D-177
  // N.14's ruling, as D-329 applies it).
  if (outcome === 'approved' && checkpoint.arg_overrides !== undefined
    && Object.keys(checkpoint.arg_overrides).length > 0) return;
  // What the approval was for: the element the hold read, or the address it opened.
  const gated = checkpoint.gated_step_id !== undefined ? checkpoint.step_state?.[checkpoint.gated_step_id] : undefined;
  const heldInput = gated !== null && typeof gated === 'object' ? (gated as { input?: unknown }).input : undefined;
  const address = checkpoint.preflight_context?.tool_slug === DOM_OPEN_SLUG
    && heldInput !== null && typeof heldInput === 'object'
    ? (heldInput as { address?: unknown }).address
    : undefined;
  const element = browserPassElementOf(checkpoint.preflight_context?.browser_target, address);
  let suggested = false;
  try {
    suggested = store.recordAnswer({
      run_id: checkpoint.run_id,
      key: offer.key,
      host: offer.host,
      outcome,
      occasion: browserPassOccasionOf(offer, now),
      ...(element !== undefined ? { element } : {}),
      at: now,
    }).suggested;
  } catch (error) {
    console.warn(`[browser-passes] the answer on ${offer.host} was not kept: `
      + (error instanceof Error ? error.message : String(error)));
    return;
  }
  if (suggested && deps?.preflightNotifier !== undefined) {
    void deps.preflightNotifier.notify(browserPassSuggestedNotice(offer.key,
      offer.browser_name !== undefined ? { name: offer.browser_name } : undefined)).catch(() => undefined);
  }
};

/** The live pass that lets this write go ahead without asking, its use counted, or none. */
/** D-341 slice A — the request approved ahead that lets this browser write through, with one more
 *  use counted, or undefined (⇒ the write asks, or a site pass decides). Only the owner's own chat
 *  has one: an AI app, a scheduled prompt, a messenger thread are never covered. */
export const useBrowserRequestPass = (
  store: BrowserPassStore | undefined,
  source: ExecutionSource | undefined,
  channel_session_id: string | undefined,
  now: number = Date.now(),
): BrowserRequestPass | undefined => {
  if (store === undefined || source === undefined || channel_session_id === undefined) return undefined;
  if (source.channel !== 'chat' || writeRulePrincipalOf(source)?.kind !== 'owner_chat') return undefined;
  try {
    return store.useRequestPass(channel_session_id, now);
  } catch (error) {
    // Unknown is "ask", as for any pass.
    console.warn(`[browser-passes] the request pass for ${channel_session_id} could not be read: `
      + (error instanceof Error ? error.message : String(error)));
    return undefined;
  }
};

export const useBrowserPass = (
  store: BrowserPassStore | undefined,
  key: BrowserPassKey,
  channel_session_id: string | undefined,
  now: number = Date.now(),
): BrowserPassRow | undefined => {
  if (store === undefined) return undefined;
  try {
    return store.use(key, channel_session_id, now);
  } catch (error) {
    // Unknown is "ask": a pass that cannot be read never admits a write.
    console.warn(`[browser-passes] the pass for ${browserPassKeyHash(key)} could not be read: `
      + (error instanceof Error ? error.message : String(error)));
    return undefined;
  }
};
