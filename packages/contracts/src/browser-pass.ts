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
}

export const browserPassKeyHash = (key: BrowserPassKey): string => sha256Hex(canonicalJSONStringify({
  principal: key.principal.kind === 'ai_app'
    ? { kind: 'ai_app', contract_id: key.principal.contract_id }
    : { kind: 'owner_chat' },
  recipe: key.recipe,
  site: key.site,
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

/** The answers on a held browser write, beside allow once and deny. ⚠ Ids stay within 23
 *  bytes: Telegram carries `ask-<uuid>|<option>` in a 64-byte callback. */
export const BROWSER_PASS_SESSION_OPTION_ID = 'allow_site_session';
export const BROWSER_PASS_ALWAYS_OPTION_ID = 'allow_site_always';
export type BrowserPassOptionId = typeof BROWSER_PASS_SESSION_OPTION_ID | typeof BROWSER_PASS_ALWAYS_OPTION_ID;
export const isBrowserPassOptionId = (id: unknown): id is BrowserPassOptionId =>
  id === BROWSER_PASS_SESSION_OPTION_ID || id === BROWSER_PASS_ALWAYS_OPTION_ID;
export const browserPassKindOfOption = (id: BrowserPassOptionId): BrowserPassKind =>
  id === BROWSER_PASS_ALWAYS_OPTION_ID ? 'always' : 'session';

/** A host short enough for a button: Slack refuses a button text over 75 characters, and it
 *  refuses the whole message with it. */
const buttonHost = (host: string): string => (host.length > 45 ? `${host.slice(0, 44)}…` : host);

export const browserPassOptions = (host: string): ReadonlyArray<{ id: BrowserPassOptionId; label: string }> => [
  { id: BROWSER_PASS_SESSION_OPTION_ID, label: `Allow on ${buttonHost(host)} for this session` },
  { id: BROWSER_PASS_ALWAYS_OPTION_ID, label: `Always allow on ${buttonHost(host)}` },
];

/** What a held browser write's answers would mint, as the hold read it: present only when
 *  who, recipe and site are all known. The answer mints exactly this, never a key read again. */
export interface BrowserPassOffer {
  readonly key: BrowserPassKey;
  /** The site as shown on the ask's buttons. */
  readonly host: string;
  /** The conversation a session pass is for (`chat:<id>`, `messenger:<vendor>:<from>`,
   *  `mcp:<token>`, D-177's `channel_session_id`). */
  readonly channel_session_id: string;
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

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
  return {
    key: { principal, recipe: key.recipe, site: key.site },
    host: offer.host,
    channel_session_id: offer.channel_session_id,
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
}

/** What a pass covers, for a sentence: "clicks on github.com". */
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
 *  recipe by its id. */
export const describeBrowserPass = (key: BrowserPassKey): string => {
  const host = browserPassHostOf(key.site);
  switch (key.recipe) {
    case 'open-web-page': return `Open pages on ${host}`;
    case 'type-into-web-page': return `Type into pages on ${host}`;
    case 'click-web-element': return `Click on ${host}`;
    case 'act-on-web-page': return `Act on pages on ${host}`;
    default: return `Run ${key.recipe} on ${host}`;
  }
};
