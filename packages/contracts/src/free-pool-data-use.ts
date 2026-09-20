/** T3-AUD-1 — what a free-tier provider does with the owner's data.
 *
 *  ⛔⛔ THE GAP THIS CLOSES. Recued's whole proposition is that the owner's
 *  world stays on machines they control, and the DEFAULT zero-cost path routes
 *  their mail, calendar and CRM text to a third-party free tier. At least one
 *  of those tiers states in its own terms that it trains on that text, that
 *  humans may read it, and that it may not lawfully be used at all for API
 *  clients serving a large part of Recued's likely audience. None of that was
 *  surfaced anywhere — not in Settings, not in the chat, not in the docs.
 *  Measured absent across `apps/webclient/src/settings/**`, `packages/llm/**`,
 *  `backend/server/src/ports/llm-gateway/**` and `docs/*.md` (invention round
 *  9, T3-AUD-1: "the finding with the largest gap between severity and cost to
 *  fix").
 *
 *  🔑 THIS DISCLOSES, IT DOES NOT REFUSE. The owner may have entirely good
 *  reasons to accept the trade — it is their machine and their data. What they
 *  may not do is take the trade without being told they are taking it. An
 *  enforcement axis (refusing a training tier under a `sovereign` realm) is a
 *  separate, larger decision and is deliberately NOT built here.
 *
 *  ⛔ EVERY ENTRY BELOW IS READ FROM THE VENDOR'S OWN PUBLISHED TERMS AND
 *  CARRIES ITS URL AND EFFECTIVE DATE. Nothing here is inferred from a
 *  provider's reputation, its pricing page, or anyone's recollection. A
 *  provider we have not actually read resolves to `unreviewed` and says so —
 *  which is the honest answer and is itself useful, because it tells the owner
 *  where to look. Adding a provider is one entry plus the citation; guessing
 *  one would make this surface worse than no surface, because a confident wrong
 *  reassurance is exactly the assurance-shaped non-assurance this codebase
 *  refuses elsewhere. */

/** What a provider's FREE tier does, per its own terms. */
export interface FreePoolDataUseTerms {
  /** The provider states it uses unpaid-tier input/output to improve or train
   *  its products or models. */
  trains_on_input: boolean;
  /** The provider states human reviewers may read the content. */
  human_review: boolean;
  /** Regions where the provider's terms forbid using the FREE tier to serve
   *  users — a legal bar, not a latency or availability note. Empty ⇒ no such
   *  clause found in the terms read. */
  geo_restricted: readonly string[];
  /** The provider explicitly instructs callers not to submit sensitive,
   *  confidential or personal information to the free tier. */
  no_sensitive_data: boolean;
  /** The exact document these facts were read from, and the date it carried.
   *  ⚠ Terms change. A stale citation is the failure mode here, so the date
   *  travels with the fact rather than living in a changelog. */
  source_url: string;
  effective: string;
  /** Round-12 audit fix (T3 Q-1 / O-1 rung 1) — the date WE last fetched
   *  `source_url` and re-verified every boolean above against the live text.
   *  Distinct from `effective`: that is the document's own effective date, and
   *  the document can be REVISED while its effective date stands — exactly
   *  what happened here (revision of 2026-04-28 behind an unchanged
   *  effective of 2026-03-23, found by an owner-executed re-read on
   *  2026-08-19, all four facts still true). Required, so an entry cannot be
   *  added without saying when it was last looked at. */
  checked_at: string;
  /** The revision stamp the document itself displayed at `checked_at`
   *  ("Last updated …"), when it displays one. The stable comparator for a
   *  re-read: a changed `doc_last_updated` behind unchanged facts is the
   *  informative middle case a content hash of a dynamic page cannot give. */
  doc_last_updated?: string;
}

export type FreePoolDataUse =
  | { kind: 'known'; label: string; terms: FreePoolDataUseTerms }
  /** The endpoint is on this machine or this network — nothing leaves, so
   *  there is no third-party data-use question to answer. Warning here would
   *  be noise, and noise is what makes a real warning ignorable. */
  | { kind: 'local' }
  /** We have not read this provider's terms. NOT "it is fine". */
  | { kind: 'unreviewed' };

/** Providers whose free-tier terms have actually been read, keyed by the host
 *  their traffic goes to (an `openai-compatible` entry names its host in
 *  `base_url`) and by the native provider id where we speak their own API. */
const KNOWN_BY_HOST: ReadonlyMap<string, { label: string; terms: FreePoolDataUseTerms }> =
  new Map([
    ['generativelanguage.googleapis.com', {
      label: 'Google Gemini (free tier)',
      terms: {
        trains_on_input: true,
        human_review: true,
        geo_restricted: ['EEA', 'Switzerland', 'UK'],
        no_sensitive_data: true,
        source_url: 'https://ai.google.dev/gemini-api/terms',
        effective: '2026-03-23',
        // Re-verified against the live document 2026-08-19 (invention round 12,
        // T3 O-1 rung 1, owner-executed): all four booleans above still hold
        // verbatim; the document's own "Last updated" stamp had moved.
        checked_at: '2026-08-19',
        doc_last_updated: '2026-04-28',
      },
    }],
  ]);

/** Native-adapter providers, where the entry carries no `base_url` because the
 *  adapter knows its own endpoint. */
const KNOWN_BY_PROVIDER: ReadonlyMap<string, string> = new Map([
  ['google', 'generativelanguage.googleapis.com'],
]);

const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal',
]);

/** ⚠ Deliberately conservative: only ranges that CANNOT be routed off the
 *  owner's own network count as local. Anything ambiguous falls through to the
 *  table, and then to `unreviewed` — the direction that tells the owner to
 *  look rather than the direction that reassures them. */
/** The four octets of a dotted-quad, or null when `host` is not an IPv4
 *  literal at all.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE A PREFIX TEST ON A HOSTNAME IS NOT AN ADDRESS TEST.
 *  `isLocalHost` used `h.startsWith('10.')`, `h.startsWith('192.168.')` and
 *  `/^172\.(\d{1,2})\./` — all three of which match an ordinary DNS NAME whose
 *  first labels happen to look numeric. Driven live before the fix:
 *
 *      local  <- https://10.evil.com/v1
 *      local  <- https://192.168.example.com/v1
 *      local  <- https://172.16.attacker.net/v1
 *
 *  Those are public hostnames that resolve wherever their owner points them.
 *  🔑 AND `local` IS THE ONE KIND THAT SAYS NOTHING — `freePoolDataUseNotice`
 *  returns `undefined` for it, which this module's own suite describes as
 *  *"nothing leaves, so nothing to warn about"*. So the failure was not a
 *  mislabel; it was TOTAL SILENCE while the owner's prompts went to a public
 *  host. That is the exact direction the header above forbids: *"the direction
 *  that tells the owner to look rather than the direction that reassures
 *  them."*
 *
 *  🔑🔑 THE CORRECT COPY WAS ALREADY IN THIS PACKAGE. `chat.ts`'s private-host
 *  check parses octets numerically and says why in its own comment — *"Avoids
 *  substring false-positives on hostnames like `192.168.example.com` whose
 *  first labels happen to look like a private prefix."* One directory apart,
 *  one right and one wrong, sharing no name. ⚠ They are NOT merged here: that
 *  copy also accepts all of `127.0.0.0/8` and IPv6 `fc00::/7`, so adopting it
 *  would WIDEN what counts as local — i.e. widen the silence — which is a
 *  separate decision from fixing the matching.
 *
 *  ⚠ Octal / short forms need no handling: the only caller passes
 *  `new URL(...).hostname`, which canonicalises `010.0.0.1` to `8.0.0.1`
 *  before this sees it. */
const ipv4Octets = (host: string): [number, number, number, number] | null => {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (!octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
  return octets as [number, number, number, number];
};

const isLocalHost = (host: string): boolean => {
  const h = host.toLowerCase();
  if (LOCAL_HOSTS.has(h)) return true;
  // `.local` (RFC 6762 mDNS) and `.internal` (ICANN private-use) are reserved
  // and undelegable, so a SUFFIX test on them is an address test.
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  const o = ipv4Octets(h);
  if (o === null) return false;
  if (o[0] === 10) return true;                          // 10.0.0.0/8
  if (o[0] === 192 && o[1] === 168) return true;         // 192.168.0.0/16
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
  return false;
};

const hostOf = (base_url: string | undefined): string | undefined => {
  if (base_url === undefined || base_url.length === 0) return undefined;
  try {
    return new URL(base_url).hostname;
  } catch {
    // A malformed base_url is not a licence to guess. Fall through to
    // `unreviewed` rather than pattern-matching a substring out of it.
    return undefined;
  }
};

/** Resolve what a free-pool entry's provider does with the owner's data.
 *
 *  Reads only `provider` and `base_url`; never the api key, never the model. */
export const resolveFreePoolDataUse = (
  entry: { provider?: string; base_url?: string },
): FreePoolDataUse => {
  const host = hostOf(entry.base_url);
  if (host !== undefined && isLocalHost(host)) return { kind: 'local' };

  const nativeHost =
    entry.provider === undefined ? undefined : KNOWN_BY_PROVIDER.get(entry.provider);
  const key = host ?? nativeHost;
  if (key === undefined) return { kind: 'unreviewed' };

  const hit = KNOWN_BY_HOST.get(key);
  if (hit === undefined) return { kind: 'unreviewed' };
  return { kind: 'known', label: hit.label, terms: hit.terms };
};

/** The one-line notice a surface renders. Shared so Settings and any later
 *  surface (the chat header was the other one named) say the same words about
 *  the same entry rather than drifting into two descriptions of one fact.
 *
 *  Returns `undefined` when there is genuinely nothing to say — a local
 *  endpoint. `unreviewed` DOES return a line: "we have not checked" is
 *  information, and silence there would read as approval. */
export const freePoolDataUseNotice = (use: FreePoolDataUse): string | undefined => {
  if (use.kind === 'local') return undefined;
  if (use.kind === 'unreviewed') {
    return 'Data-use terms not reviewed for this provider — check what its free tier does with your data.';
  }
  const parts: string[] = [];
  if (use.terms.trains_on_input) parts.push('trains on what you send');
  if (use.terms.human_review) parts.push('human reviewers may read it');
  if (use.terms.no_sensitive_data) parts.push('its terms say not to send sensitive or personal data');
  const geo =
    use.terms.geo_restricted.length > 0
      ? ` Its terms permit only PAID use when serving users in ${use.terms.geo_restricted.join(', ')}.`
      : '';
  const body = parts.length > 0 ? ` Free tier: ${parts.join('; ')}.` : '';
  // Round-12 audit fix (T3 Q-1) — the citation carries its own check age, so
  // "still true" and "merely not looked at since" stop reading identically.
  return `${use.label}.${body}${geo} Source: ${use.terms.source_url} (effective ${use.terms.effective}; verified ${use.terms.checked_at}).`;
};
