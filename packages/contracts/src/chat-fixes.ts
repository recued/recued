/** D-346 follow-up (2026-11-08) — the fixes the owner's chat offers under an answer, for what a
 *  call in the turn could not do: a recipe run's need (a connection to reconnect or set up, a
 *  program to install, a program switched off for the owner) or one of the owner's own switches
 *  that refused a call ("'mail.search' is turned off for you"). The owner's ruling: show the run
 *  dialog's fixes under the model's answer, the way install offers already are.
 *
 *  Only on the owner's own chat (a contract's caller is told nothing about switches, the ruling
 *  of the same day), stamped by the server from the turn's tool results
 *  (`ChatDispatchResult.fixes` → `ChatMessage.fixes`), never from the model's text, and never
 *  read by a model: the model reads a result's `result`, not its side fields. */
import { COLLECTION_GRANT_PREFIX, PRIMITIVE_GRANT_PREFIX, RECIPE_GRANT_PREFIX, TOPIC_GRANT_PREFIX } from './grant-entry.js';
import type { RunNeed } from './run-needs.js';

/** D-405 slice 2 (2026-11-19) — the owner's core features a message can ask about with none connected:
 *  the Connections page's own lanes (a mailbox, a calendar, a file source), by their lane ids. */
export const CHAT_SETUP_FEATURES = ['mail', 'calendar', 'file'] as const;
export type ChatSetupFeature = (typeof CHAT_SETUP_FEATURES)[number];

export const isChatSetupFeature = (value: unknown): value is ChatSetupFeature =>
  typeof value === 'string' && (CHAT_SETUP_FEATURES as readonly string[]).includes(value);

/** D-405 slice 4 — one core feature on the Set up page: connected or not, or null when the server cannot
 *  know (it never says "none" then). The same fact the chat's "Connect your mail" reads. */
export interface ChatSetupFeatureState {
  readonly feature: ChatSetupFeature;
  readonly connected: boolean | null;
}

/** The features `value` holds, each checked and once, in `CHAT_SETUP_FEATURES` order: what the app reads
 *  back from `chat.setup.features`. A feature the answer leaves out is not read as "none". */
export const chatSetupFeaturesOf = (value: unknown): ChatSetupFeatureState[] => {
  if (!Array.isArray(value)) return [];
  const byFeature = new Map<ChatSetupFeature, ChatSetupFeatureState>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as { feature?: unknown; connected?: unknown };
    if (!isChatSetupFeature(row.feature) || byFeature.has(row.feature)) continue;
    if (row.connected !== true && row.connected !== false && row.connected !== null) continue;
    byFeature.set(row.feature, { feature: row.feature, connected: row.connected });
  }
  return CHAT_SETUP_FEATURES.flatMap((feature) => { const row = byFeature.get(feature); return row === undefined ? [] : [row]; });
};

/** One fix. `run_need`: what a failed run needed (`ServerExecuteResponse.run_needs`).
 *  `switch`: one of the owner's own switches on the Contracts page (`entry_key`), which the
 *  chat turns on (`contract.grant.write` on the owner's contract).
 *  `thing` (D-404 slice A, 2026-11-18): a type of thing the owner has none of in Yours, which a
 *  search of their things needed. A link to Yours' form with that type chosen; the owner adds
 *  it, the chat adds nothing. */
export type ChatFix =
  | { readonly kind: 'run_need'; readonly need: RunNeed }
  | {
      readonly kind: 'switch';
      /** The grant entry the call needed (`primitive.mail.search`, `data.task`, …). */
      readonly entry_key: string;
      /** What to call it: the switch's title on the page, else the tool as it was called. */
      readonly label: string;
    }
  | {
      readonly kind: 'thing';
      /** The type to add, as `work.type` names it (`passport`, `travel_passport`, `body`). */
      readonly type_id: string;
      /** Its name, as Yours shows it ("Passport"): a pack's words for a pack's type, shown as data. */
      readonly type_name: string;
    }
  | {
      /** D-404 step 4 (2026-11-19): a thing of the owner's whose type keeps readings, with none yet,
       *  and the INSTALLED pack that feeds them, set up on its page. A feeding pack not installed is
       *  an install offer instead (D-323), never this. */
      readonly kind: 'source';
      /** The thing's own name ("Anna's body"), the owner's words, shown as data. */
      readonly thing_name: string;
      /** The pack that feeds its readings: its slug, for its page, and its name. */
      readonly pack_slug: string;
      readonly pack_name: string;
      /** D-339 slice 23 — the thing's id, when the step names one: for a pack whose setup is on the thing's own
       *  page (`THING_PAGE_SETUPS`), the link opens that page's form instead of the pack's page. */
      readonly thing_id?: string;
    }
  | {
      /** D-405 slice 2 (2026-11-19): one of the owner's core features with none connected (no
       *  mailbox, no calendar, no file source), which the owner's message asked about. A link to that
       *  feature's lane on the Connections page; the owner connects one there, the chat connects nothing. */
      readonly kind: 'feature';
      readonly feature: ChatSetupFeature;
    };

/** A type id a `thing` fix may carry: the shape every asset class id has (`validateAssetClassPreset`). */
const THING_TYPE_ID_RE = /^[a-z][a-z0-9_]{0,127}$/u;
/** A type's name as a fix carries it, cut to this many characters. */
const THING_TYPE_NAME_MAX = 80;
/** A pack slug a `source` fix may carry: the shape an install offer's slug has. */
const SOURCE_PACK_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
/** A thing's id a `source` fix may carry: no slash or space, so it is one segment of a page's address. */
const SOURCE_THING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

/** "a Passport", "an ID card", "an Heirloom or keepsake": the article a type's name takes, by how
 *  it sounds rather than its first letter where English differs (a silent h; a "you" sound). */
const articled = (name: string): string => {
  const lower = name.toLowerCase();
  const an = /^(heir|hour|honest|honou?r)/u.test(lower) || (/^[aeiou]/u.test(lower) && !/^(uni|use|usu|eu|one\b|once)/u.test(lower));
  return `${an ? 'an' : 'a'} ${name}`;
};

/** D-404 — the words of a `thing` fix, one source for every surface that says it: the line under
 *  the answer, its link, the sentence the model reads (which quotes the link as shown), and the line
 *  once one is in Yours (slice B1). */
/** D-339 slice 23 (2026-11-19, the owner: "yes take on the two follow-ups") — the packs whose setup is on the page of
 *  the thing they feed, by the words of the button there: Body signals from Apple Health is set up by "Connect Apple
 *  Health" on a Body's page (its webhook made in one step, the Shortcut's values to copy, the pack's install), which
 *  its own page cannot do. A `source` fix for one of them that names the thing opens that form. */
export const THING_PAGE_SETUPS: Readonly<Record<string, string>> = Object.freeze({ 'body-signals-apple-health': 'Connect Apple Health' });

/** The setup a `source` fix opens on its thing's page, by its button's words; undefined for the pack's own page. */
export const thingPageSetupOf = (fix: { readonly pack_slug: string; readonly thing_id?: string }): string | undefined =>
  fix.thing_id !== undefined && Object.prototype.hasOwnProperty.call(THING_PAGE_SETUPS, fix.pack_slug) ? THING_PAGE_SETUPS[fix.pack_slug] : undefined;

/** D-404 step 4 — the words of a `source` fix, one source for the line, its link and the model's quote of it.
 *  D-339 slice 23: a setup on the thing's own page takes that button's words. */
export const sourceStepWords = (thingName: string, packName: string, thingPageSetup?: string): { readonly lead: string; readonly link: string } => ({
  lead: `No readings for ${thingName} yet.`,
  link: thingPageSetup ?? `Set up ${packName}`,
});

export const thingStepWords = (typeName: string): {
  readonly lead: string; readonly link: string; readonly landed: string;
  /** The name with its article ("an ID card"), for a sentence that names the type (slice E). */
  readonly named: string;
} => {
  const named = articled(typeName);
  return {
    lead: `No ${typeName} in Yours yet.`,
    link: `Add ${named}`,
    landed: `${named.charAt(0).toUpperCase()}${named.slice(1)} is in Yours now.`,
    named,
  };
};

/** D-405 slice 2 — the words of a `feature` fix, one source for every surface that says it: the line
 *  under the answer, its link, the sentence the model reads (which quotes the link as shown), and the
 *  line once one is connected. The links read as the chat's own first-run line does ("Connect your
 *  mail, calendar and files"); "file source" is the Connections page's own name for one.
 *  ⛔ "of yours" for a calendar: every server has its own calendar (`local`), listed in the Calendar
 *  lane, so "no calendar" would be false; the one missing is the owner's. */
const FEATURE_STEP_WORDS: Readonly<Record<ChatSetupFeature, { readonly lead: string; readonly link: string; readonly landed: string }>> = {
  mail: { lead: 'No mailbox is connected yet.', link: 'Connect your mail', landed: 'A mailbox is connected now.' },
  calendar: { lead: 'No calendar of yours is connected yet.', link: 'Connect your calendar', landed: 'Your calendar is connected now.' },
  file: { lead: 'No file source is connected yet.', link: 'Connect your files', landed: 'A file source is connected now.' },
};

export const featureStepWords = (feature: ChatSetupFeature): { readonly lead: string; readonly link: string; readonly landed: string } =>
  FEATURE_STEP_WORDS[feature];

/** At most this many under one answer: a turn that hit more needs a page, not a list. */
export const CHAT_FIX_LIMIT = 4;

/** The prefixes a `switch` fix may name: the owner's own switches the chat may turn on. A
 *  pack's own action (`<publisher>/<catalog>.<op>`) is turned on from its pack's page instead. */
const SWITCH_PREFIXES = [PRIMITIVE_GRANT_PREFIX, RECIPE_GRANT_PREFIX, COLLECTION_GRANT_PREFIX, TOPIC_GRANT_PREFIX, 'core.'];

/** The needs the chat offers a fix for. A browser to use instead (D-402 slice H3c) is offered by the run
 *  dialog, not yet under a chat answer. */
const isRunNeed = (value: unknown): value is Exclude<RunNeed, { kind: 'browser' }> => {
  if (value === null || typeof value !== 'object') return false;
  const need = value as { kind?: unknown; step_id?: unknown };
  return (need.kind === 'connection' || need.kind === 'program' || need.kind === 'switch')
    && typeof need.step_id === 'string';
};

/** The fixes in `value` that are well formed, deduplicated, at most `CHAT_FIX_LIMIT`: what a
 *  surface reads back from a stored message or a tool result. */
export const chatFixesOf = (value: unknown): ChatFix[] => {
  if (!Array.isArray(value)) return [];
  const out: ChatFix[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    const fix = raw as { kind?: unknown; need?: unknown; entry_key?: unknown; label?: unknown; type_id?: unknown; type_name?: unknown;
      thing_name?: unknown; pack_slug?: unknown; pack_name?: unknown; thing_id?: unknown; feature?: unknown };
    let key: string;
    let checked: ChatFix;
    if (fix.kind === 'feature') {
      if (!isChatSetupFeature(fix.feature)) continue;
      key = `feature:${fix.feature}`;
      checked = { kind: 'feature', feature: fix.feature };
    } else if (fix.kind === 'source') {
      const thing = typeof fix.thing_name === 'string' ? fix.thing_name.trim().slice(0, THING_TYPE_NAME_MAX) : '';
      const pack = typeof fix.pack_name === 'string' ? fix.pack_name.trim().slice(0, THING_TYPE_NAME_MAX) : '';
      if (typeof fix.pack_slug !== 'string' || !SOURCE_PACK_SLUG_RE.test(fix.pack_slug) || thing.length === 0 || pack.length === 0) continue;
      key = `source:${fix.pack_slug}:${thing}`;
      checked = { kind: 'source', thing_name: thing, pack_slug: fix.pack_slug, pack_name: pack,
        ...(typeof fix.thing_id === 'string' && SOURCE_THING_ID_RE.test(fix.thing_id) ? { thing_id: fix.thing_id } : {}) };
    } else if (fix.kind === 'thing') {
      const name = typeof fix.type_name === 'string' ? fix.type_name.trim().slice(0, THING_TYPE_NAME_MAX) : '';
      if (typeof fix.type_id !== 'string' || !THING_TYPE_ID_RE.test(fix.type_id) || name.length === 0) continue;
      key = `thing:${fix.type_id}`;
      checked = { kind: 'thing', type_id: fix.type_id, type_name: name };
    } else if (fix.kind === 'run_need' && isRunNeed(fix.need)) {
      const need = fix.need;
      key = need.kind === 'switch'
        ? `switch:${need.ingredient_id}:${need.operation_id}`
        : need.kind === 'program'
          ? `program:${need.pack_slug ?? need.tool ?? need.step_id}:${need.problem}`
          : `connection:${need.slot}:${need.connection_name ?? ''}:${need.problem}`;
      checked = { kind: 'run_need', need };
    } else if (fix.kind === 'switch' && typeof fix.entry_key === 'string' && typeof fix.label === 'string'
      && SWITCH_PREFIXES.some((prefix) => (fix.entry_key as string).startsWith(prefix))) {
      key = `grant:${fix.entry_key}`;
      checked = { kind: 'switch', entry_key: fix.entry_key, label: fix.label };
    } else {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(checked);
    if (out.length >= CHAT_FIX_LIMIT) break;
  }
  return out;
};
