/** D-335 slice F — a pass for a Browser Toolkit write: the PURE vocabulary.
 *
 *  Every browser write (opening a page, typing, clicking) is held for the owner. The ask
 *  offers, besides allow once and deny, "Allow on <site> for this session" and "Always allow
 *  on <site>"; either mints a pass, and a later write the pass covers runs without asking.
 *  Three approvals of the same key on three occasions in 30 days, with no refusal, suggest
 *  always allowing it, counted exactly as D-329 counts its write rules (the same functions).
 *
 *  🔑 THE KEY IS WHO × RECIPE × SITE. Who: the owner's own chats, or one AI app by its
 *  contract (D-329's principal). Recipe: the recipe whose write it is, so a pass for clicks
 *  covers no typing. Site: the ORIGIN the Bridge read while preparing the ask, never a value
 *  the model supplied; for opening a page, the origin of the address it asked to open. So
 *  always allowing clicks on https://github.com covers no typing there, no clicks elsewhere,
 *  and no other AI app.
 *
 *  ⛔ NOT A D-177 SESSION GRANT. Those match the call's exact payload, which holds the page
 *  handle and the ref, and both change on every read, so they never covered a second write.
 *  And an "Always allow" pass has no end and no use limit, which a D-177 row cannot be.
 *
 *  Everything here is pure: no I/O, no clock (callers pass `now`). */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

import type { WriteRulePrincipal } from './write-approval-rule.js';

export interface BrowserPassKey {
  readonly principal: WriteRulePrincipal;
  /** The recipe whose write it is (`click-web-element`, or an owner's own recipe). */
  readonly recipe: string;
  /** The page's origin, `https://github.com`: scheme, host and port. */
  readonly site: string;
  /** D-402 slice H4c (§4.2 item 8) — for a recipe that names its browsers, the browser the write runs in
   *  (its lasting id): a pass granted for one lets no other through. Absent for a recipe that names none,
   *  such as the Browser Toolkit's, whose browser is its caller's choice: those passes are as they were. */
  readonly browser?: string;
}

export const browserPassKeyHash = (key: BrowserPassKey): string => sha256Hex(canonicalJSONStringify({
  principal: key.principal.kind === 'ai_app'
    ? { kind: 'ai_app', contract_id: key.principal.contract_id }
    : { kind: 'owner_chat' },
  recipe: key.recipe,
  site: key.site,
  // Only when present, so every pass granted without one keeps its hash.
  ...(key.browser !== undefined ? { browser: key.browser } : {}),
}));

/** The origin of an http(s) address, or undefined: a pass names a web site, nothing else. */
export const browserPassSiteOf = (url: unknown): string | undefined => {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The site as the owner reads it: the host, without the scheme. */
export const browserPassHostOf = (site: string): string => {
  try { return new URL(site).host; } catch { return site; }
};

/** How long "Allow on <site> for this session" lasts, at most: the conversation it was given
 *  in, for a working day. (D-177's exact grants last an hour; a pass covers a whole site's
 *  writes of one kind, for one task the owner is in the middle of.) */
export const BROWSER_PASS_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type BrowserPassKind = 'session' | 'always';

/** D-341 slice A — a request approved ahead: with the switch beside Send on, every Browser Toolkit
 *  write the owner's chat makes in that conversation runs without asking, on any site its tabs go,
 *  until the owner turns it off or eight hours pass. One a conversation. Sites on the owner's list
 *  are still refused, a secret is still asked for, and nothing but the owner's own chat has one. */
export interface BrowserRequestPass {
  /** The conversation, as a run's identity names it: `chat:<session_id>`. */
  readonly channel_session_id: string;
  readonly started_at: number;
  readonly expires_at: number;
  /** The browser writes it let through. */
  readonly uses: number;
}
/** How long a request approved ahead lasts at most: a working day, as a session pass. */
export const BROWSER_REQUEST_PASS_TTL_MS = 8 * 60 * 60 * 1000;

/** The answers on a held browser write, beside allow once and deny. ⚠ Ids stay within 23
 *  bytes: Telegram carries `ask-<uuid>|<option>` in a 64-byte callback. */
export const BROWSER_PASS_SESSION_OPTION_ID = 'allow_site_session';
export const BROWSER_PASS_ALWAYS_OPTION_ID = 'allow_site_always';
/** D-341 slice A — beside them on an ask from the owner's own chat: turn the switch beside Send on. */
export const BROWSER_PASS_REQUEST_OPTION_ID = 'allow_request';
/** D-402 (2026-11-23) — beside them on an ask from an AI app that has a job going (`recued_startJob`): the site's
 *  writes of this kind, for this app, until the job ends. */
export const BROWSER_PASS_JOB_OPTION_ID = 'allow_site_job';
export type BrowserPassOptionId = typeof BROWSER_PASS_SESSION_OPTION_ID | typeof BROWSER_PASS_ALWAYS_OPTION_ID
  | typeof BROWSER_PASS_REQUEST_OPTION_ID | typeof BROWSER_PASS_JOB_OPTION_ID;
export const isBrowserPassOptionId = (id: unknown): id is BrowserPassOptionId =>
  id === BROWSER_PASS_SESSION_OPTION_ID || id === BROWSER_PASS_ALWAYS_OPTION_ID || id === BROWSER_PASS_REQUEST_OPTION_ID
  || id === BROWSER_PASS_JOB_OPTION_ID;
/** What an answer gives: a pass on the site, of its kind, (D-341 slice A) the conversation's request
 *  approved ahead, or (D-402) a pass on the site for the AI app's job: a session pass whose conversation
 *  is the job, ending when it does. */
export type BrowserPassAnswerKind = BrowserPassKind | 'request' | 'job';
export const browserPassKindOfOption = (id: BrowserPassOptionId): BrowserPassAnswerKind =>
  id === BROWSER_PASS_ALWAYS_OPTION_ID ? 'always' : id === BROWSER_PASS_REQUEST_OPTION_ID ? 'request'
    : id === BROWSER_PASS_JOB_OPTION_ID ? 'job' : 'session';

/** A host short enough for a button: Slack refuses a button text over 75 characters, and it
 *  refuses the whole message with it. */
const buttonHost = (host: string): string => (host.length > 45 ? `${host.slice(0, 44)}…` : host);

export const browserPassOptions = (
  host: string,
  options: {
    /** D-341 slice A — offer to stop asking about browser actions in this chat conversation. */
    readonly request?: boolean;
    /** D-402 — offer to stop asking about these on the site until the AI app's job ends. */
    readonly job?: boolean;
  } = {},
): ReadonlyArray<{ id: BrowserPassOptionId; label: string }> => [
  // D-402 — the narrowest first: this job only, then this session, then always.
  ...(options.job === true
    ? [{ id: BROWSER_PASS_JOB_OPTION_ID as BrowserPassOptionId, label: `Allow on ${buttonHost(host)} until this job ends` }] : []),
  { id: BROWSER_PASS_SESSION_OPTION_ID, label: `Allow on ${buttonHost(host)} for this session` },
  { id: BROWSER_PASS_ALWAYS_OPTION_ID, label: `Always allow on ${buttonHost(host)}` },
  ...(options.request === true
    ? [{ id: BROWSER_PASS_REQUEST_OPTION_ID as BrowserPassOptionId, label: 'Don’t ask about browser actions in this chat' }] : []),
];

/** D-341 slice A — whether an ask may offer the conversation's request approved ahead: only the
 *  owner's own chat in the Recued app has the switch it turns on. */
export const browserPassOffersRequest = (offer: BrowserPassOffer): boolean =>
  offer.key.principal.kind === 'owner_chat' && offer.channel_session_id.startsWith('chat:');

/** D-402 — whether an ask may offer "until this job ends": an AI app's write, made in a job it started. */
export const browserPassOffersJob = (offer: BrowserPassOffer): offer is BrowserPassOffer & { readonly job: BrowserPassJob } =>
  offer.key.principal.kind === 'ai_app' && offer.job !== undefined;

/** D-402 (2026-11-23) — the AI app's job a held write is part of: the conversation a pass "until this job
 *  ends" is kept under (the job's own, `job:<id>`, which only the app's runs in that job are bound to), and
 *  when the job ends at the latest. The app's runs leave the job when it ends it, starts another or the hour
 *  passes, so the pass covers nothing after, whatever its row says. */
export interface BrowserPassJob {
  readonly channel_session_id: string;
  readonly expires_at: number;
}

/** What a held browser write's answers would mint, as the hold read it: present only when
 *  who, recipe and site are all known. The answer mints exactly this, never a key read again. */
export interface BrowserPassOffer {
  readonly key: BrowserPassKey;
  /** The site as shown on the ask's buttons. */
  readonly host: string;
  /** The conversation a session pass is for (`chat:<id>`, `messenger:<vendor>:<from>`,
   *  `mcp:<token>`, D-177's `channel_session_id`). */
  readonly channel_session_id: string;
  /** D-402 slice H4d — the owner's name for the browser the key names, as the hold could name it: the
   *  ask says its answers are for that browser alone. */
  readonly browser_name?: string;
  /** D-402 — the AI app's job the write is part of, when it has one going: the ask offers "until this job ends". */
  readonly job?: BrowserPassJob;
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A persisted job read back: its conversation is a job's (`job:<id>`), and its end a time. */
const jobOf = (value: unknown): BrowserPassJob | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const job = value as Record<string, unknown>;
  return nonEmptyString(job.channel_session_id) && job.channel_session_id.startsWith('job:') && job.channel_session_id.length > 4
    && typeof job.expires_at === 'number' && Number.isFinite(job.expires_at)
    ? { channel_session_id: job.channel_session_id, expires_at: job.expires_at } : undefined;
};

/** A persisted offer read back (it round-trips through the checkpoint's JSON), or undefined:
 *  an offer this version cannot read offers nothing, and its ask has no site answers. */
export const readBrowserPassOffer = (value: unknown): BrowserPassOffer | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const offer = value as Record<string, unknown>;
  const key = offer.key as Record<string, unknown> | null | undefined;
  if (key === null || typeof key !== 'object' || Array.isArray(key)) return undefined;
  const who = key.principal as Record<string, unknown> | null | undefined;
  const principal: WriteRulePrincipal | undefined = who?.kind === 'owner_chat'
    ? { kind: 'owner_chat' }
    : who?.kind === 'ai_app' && nonEmptyString(who.contract_id)
      ? { kind: 'ai_app', contract_id: who.contract_id }
      : undefined;
  if (principal === undefined || !nonEmptyString(key.recipe) || !nonEmptyString(key.site)
    || browserPassSiteOf(key.site) !== key.site || !nonEmptyString(offer.host)
    || !nonEmptyString(offer.channel_session_id)) return undefined;
  // D-402 slice H4c — a key that names its browser keeps it, a lasting id: the answer's pass is that
  // browser's alone. ⛔ Dropped here, the pass an "Always allow" answer minted was for a key no write of
  // the run's has (the hash leaves the browser out), so it allowed nothing and each write asked again.
  if (key.browser !== undefined && !nonEmptyString(key.browser)) return undefined;
  return {
    key: { principal, recipe: key.recipe, site: key.site, ...(key.browser !== undefined ? { browser: key.browser } : {}) },
    host: offer.host,
    channel_session_id: offer.channel_session_id,
    // D-402 slice H4d — only beside a browser the key names; a name it cannot read is left out (it is words).
    ...(key.browser !== undefined && nonEmptyString(offer.browser_name) ? { browser_name: offer.browser_name } : {}),
    // D-402 — an AI app's job, when it reads: one that does not offers no "until this job ends", and the rest stands.
    ...(jobOf(offer.job) !== undefined && principal.kind === 'ai_app' ? { job: jobOf(offer.job)! } : {}),
  };
};

/** The occasion an answer counts on, as D-329 counts them (`writeRuleOccasionOf`): its
 *  conversation and its UTC day. */
export const browserPassOccasionOf = (offer: BrowserPassOffer, at: number): string =>
  `${offer.channel_session_id}|${Math.floor(at / 86_400_000)}`;

/** What one approval was for, as a suggestion lists it: the element as the page named it
 *  (`button “Send”`), or for opening a page the address it opened without its query or
 *  fragment, which can carry the owner's data. Undefined when the hold read neither. */
export const browserPassElementOf = (target: unknown, address: unknown): string | undefined => {
  if (typeof address === 'string') {
    try {
      const url = new URL(address);
      return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (target === null || typeof target !== 'object') return undefined;
  const read = target as Record<string, unknown>;
  if (!nonEmptyString(read.role) || typeof read.label !== 'string') return undefined;
  return read.label !== '' ? `${read.role} “${read.label}”` : read.role;
};

/** A pass. A session pass covers its conversation until `expires_at`; an always pass has no
 *  end. Revoking ends either. */
export interface BrowserPassRow {
  readonly pass_id: string;
  readonly key_hash: string;
  readonly key: BrowserPassKey;
  readonly host: string;
  readonly kind: BrowserPassKind;
  readonly channel_session_id?: string;
  readonly created_at: number;
  readonly expires_at?: number;
  readonly revoked_at?: number;
  readonly uses: number;
  readonly last_used_at?: number;
  /** D-402 slice H4d — for a key that names its browser: the owner's name for it, or the name it last
   *  went by, when the list could name it. */
  readonly browser_name?: string;
  /** D-402 slice H4d — false once that browser is no longer paired: the pass is never used again. */
  readonly browser_paired?: boolean;
}

export const isBrowserPassLive = (
  pass: BrowserPassRow,
  now: number,
  channel_session_id?: string,
): boolean => {
  if (pass.revoked_at !== undefined) return false;
  if (pass.kind === 'always') return true;
  return pass.channel_session_id !== undefined && pass.channel_session_id === channel_session_id
    && pass.expires_at !== undefined && pass.expires_at > now;
};

/** An open suggestion to always allow a key, as Contracts lists it: the elements the
 *  approvals were for, newest first (what the owner said yes to, in the page's words). */
export interface BrowserPassSuggestionRow {
  readonly key_hash: string;
  readonly key: BrowserPassKey;
  readonly host: string;
  readonly approvals: number;
  readonly occasions: number;
  readonly elements: readonly string[];
  readonly suggested_at: number;
  /** D-402 slice H4d — as on a pass row. */
  readonly browser_name?: string;
  readonly browser_paired?: boolean;
}

/** D-402 slice H4d — the browser a pass is for, as the owner knows it. */
export interface BrowserPassBrowser {
  /** The owner's name for it, or the name it last went by. */
  readonly name?: string;
  /** False once it is no longer paired. */
  readonly paired?: boolean;
}

/** D-402 slice H4d — a row's browser, as `browserPassWhere` reads it. */
export const browserPassBrowserOfRow = (
  row: { readonly browser_name?: string; readonly browser_paired?: boolean },
): BrowserPassBrowser => ({
  ...(row.browser_name !== undefined ? { name: row.browser_name } : {}),
  ...(row.browser_paired !== undefined ? { paired: row.browser_paired } : {}),
});

/** D-402 slice H4d — where a pass for a recipe that names its browsers acts, since it acts in that
 *  browser alone: " in “Home”", " in “Old laptop” (no longer paired)". Empty for a key that names no
 *  browser: every Browser Toolkit pass, and every pass before H4c, read as they did. */
export const browserPassWhere = (key: BrowserPassKey, browser: BrowserPassBrowser = {}): string => {
  if (key.browser === undefined) return '';
  const gone = browser.paired === false;
  if (browser.name === undefined) return gone ? ' in a browser no longer paired' : ' in one of your browsers';
  return ` in “${browser.name}”${gone ? ' (no longer paired)' : ''}`;
};

/** What a pass covers, for a sentence: "clicks on github.com". A sentence that needs the browser of a
 *  key that names one says it apart (D-402 slice H4d): "Both are for “Home” alone". */
export const browserPassActsOf = (key: BrowserPassKey): string => {
  const host = browserPassHostOf(key.site);
  switch (key.recipe) {
    case 'open-web-page': return `opening pages on ${host}`;
    case 'type-into-web-page': return `typing into pages on ${host}`;
    case 'click-web-element': return `clicks on ${host}`;
    // D-335 slice J — a sequence of typing, clicks and sends.
    case 'act-on-web-page': return `sequences of steps on ${host}`;
    default: return `“${key.recipe}” on ${host}`;
  }
};

/** What a pass lets happen, in the owner's words. The toolkit's writes by name; any other
 *  recipe by its id; and, for a key that names its browser (D-402 slice H4d), in which one. */
export const describeBrowserPass = (key: BrowserPassKey, browser?: BrowserPassBrowser): string => {
  const host = browserPassHostOf(key.site);
  const where = browserPassWhere(key, browser);
  switch (key.recipe) {
    case 'open-web-page': return `Open pages on ${host}${where}`;
    case 'type-into-web-page': return `Type into pages on ${host}${where}`;
    case 'click-web-element': return `Click on ${host}${where}`;
    case 'act-on-web-page': return `Act on pages on ${host}${where}`;
    default: return `Run ${key.recipe} on ${host}${where}`;
  }
};
