/** D-235 P1 — bring-your-own-domain enrolment + preflight contracts.
 *
 *  A Pro user points their own hostname at the Pro DDNS name and delegates
 *  `_acme-challenge` by CNAME into the zone the fleet already writes, so the
 *  fleet can issue AND RENEW a certificate for a hostname it does not own.
 *  See D-235.
 *
 *  Everything here is pure + environment-agnostic (contracts runs in Workers,
 *  Node and the browser). The DNS queries themselves live server-side behind
 *  the `CustomDomainDnsResolver` seam — this module only names what to ask and
 *  judges the answers.
 *
 *  ⚠ The two records the user creates (§ 3.1) are NOT interchangeable and the
 *  second is easy to skip:
 *
 *      recued.their-domain.com                  CNAME → <handle>.recued.net
 *      _acme-challenge.recued.their-domain.com  CNAME → _acme-challenge.<handle>.recued.net
 *
 *  The first is ROUTING; it proves nothing about issuance. DNS-01 validates by
 *  reading TXT at `_acme-challenge.<hostname>`, a different name in a zone the
 *  fleet cannot write — so without the second record every order dies at
 *  authorization. `evaluateCustomDomainPreflight` reports them separately for
 *  exactly this reason.
 */

import { hostnameForHandle, type DdnsZone } from './network.js';
import {
  CERT_RENEWAL_LEAD_TIME_MS,
  CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS,
} from './d148-constants.js';

/** The DNS-01 challenge label. `_acme-challenge.<hostname>` is the name the CA
 *  reads TXT from, and therefore the name the user delegates. */
export const ACME_CHALLENGE_LABEL = '_acme-challenge' as const;

/** DNS names are case-insensitive (RFC 1035 § 2.3.3) and may be written fully
 *  qualified with a trailing dot. Fold both away so one name never yields two
 *  spellings across the resolver → comparison path. */
export const normalizeDnsName = (name: string): string =>
  name.trim().toLowerCase().replace(/\.+$/, '');

/** The challenge name for a hostname — where the CA looks, and what the user
 *  creates the delegation CNAME at. */
export const acmeChallengeName = (hostname: string): string =>
  `${ACME_CHALLENGE_LABEL}.${normalizeDnsName(hostname)}`;

/** The delegation TARGET — the name inside the fleet's own zone that the
 *  challenge CNAME must point to.
 *
 *  🔑 This is the same name the fleet already writes TXT at for
 *  `<handle>.recued.net`'s own certificate (`recued-acme-dns-control.ts`), which
 *  is what makes D-235 cheap: the write side does not change at all. The CA
 *  follows the user's CNAME and lands on a record the fleet was already
 *  publishing. */
export const customDomainDelegationTarget = (
  handle: string,
  zone?: DdnsZone,
): string => acmeChallengeName(hostnameForHandle(handle, zone));

/** One certificate authority in the cloud's ordered ACME rotation, with the
 *  CAA `issue` identifier that authorizes it.
 *
 *  ⛔ THE ROTATION LIVES IN A WORKER SECRET (`ACME_CA_CONFIG`), NOT HERE. The
 *  cloud picks a CA per issuance and fails over between them; a self-hosted
 *  server cannot see that config, so this list is the SHARED DECLARATION both
 *  sides are held to. A CA present in the Worker secret but absent here would
 *  be issued from without ever having been CAA-preflighted — which is precisely
 *  the § 5.2 failure ("one renewal succeeds, the next fails"). Any change to
 *  the deployed rotation MUST land here in the same change. */
export interface AcmeRotationCa {
  /** Stable id — matches `AcmeCaConfig.id` in the cloud's rotation config. */
  readonly id: string;
  /** Human label for the record the user has to add. */
  readonly label: string;
  /** CAA `issue` property values that authorize this CA. Any one of them
   *  permits it; a CA with several is one that has more than one documented
   *  identifier. */
  readonly caa_identifiers: readonly string[];
}

/** D-235 § 5.2 — every CA the cloud may fail over to, in rotation order.
 *  Mirrors `backend/api/src/acme/multi-ca-provider.ts`'s documented order
 *  (ZeroSSL primary → GTS standby → Let's Encrypt baseline). */
export const ACME_ROTATION_CAS: readonly AcmeRotationCa[] = [
  { id: 'zerossl', label: 'ZeroSSL', caa_identifiers: ['sectigo.com'] },
  { id: 'gts', label: 'Google Trust Services', caa_identifiers: ['pki.goog'] },
  { id: 'letsencrypt', label: "Let's Encrypt", caa_identifiers: ['letsencrypt.org'] },
] as const;

/** The three things preflight asks about a custom hostname. Separate checks,
 *  separate verdicts — collapsing them would hide § 2.5's whole point (routing
 *  can be perfect while issuance is impossible). */
export const CUSTOM_DOMAIN_PREFLIGHT_CHECKS = [
  /** Does `<hostname>` reach the server, through the Pro DDNS name? */
  'host_route',
  /** Can the CA find the fleet's TXT at `_acme-challenge.<hostname>`? */
  'acme_delegation',
  /** Does CAA permit every CA the cloud may fail over to? */
  'caa',
] as const;
export type CustomDomainPreflightCheck =
  (typeof CUSTOM_DOMAIN_PREFLIGHT_CHECKS)[number];

/** ⛔ `unknown` IS NOT `fail`, AND THE DIFFERENCE IS THE WHOLE POINT. A
 *  SERVFAIL / timeout means we did not learn anything; reporting it as `fail`
 *  sends the user to fix a record that is already correct, and reporting it as
 *  `pass` is worse. `warn` means "issuance works today but the setup carries a
 *  caveat that will bite later" — § 5.2's partial CAA pass is the archetype. */
export const CUSTOM_DOMAIN_PREFLIGHT_STATUSES = [
  'pass',
  'warn',
  'fail',
  'unknown',
] as const;
export type CustomDomainPreflightStatus =
  (typeof CUSTOM_DOMAIN_PREFLIGHT_STATUSES)[number];

/** Closed list of preflight outcomes. One code per distinguishable cause — a
 *  diagnostic that cannot name the cause is one the user cannot act on. */
export const CUSTOM_DOMAIN_PREFLIGHT_CODES = [
  // host_route
  'host_cname_matches_ddns',
  'host_flattened_matches_ddns',
  'host_flattened_stale',
  /** The hostname has addresses, but the Pro DDNS name itself did not resolve,
   *  so there is no baseline to compare them against. ⛔ NOT `stale` — see the
   *  evaluator. */
  'host_ddns_baseline_unavailable',
  'host_cname_target_mismatch',
  'host_unresolved',
  'host_resolver_error',
  // acme_delegation
  'delegation_target_matches',
  'delegation_target_mismatch',
  'delegation_missing',
  /** ⛔ THE NAME EXISTS BUT CARRIES NO CNAME — which is NOT the same as "you
   *  didn't create it", and telling the user it is sends them to re-create a
   *  record they are looking at.
   *
   *  Found live on Cloudflare 2026-08-13: a `_acme-challenge` CNAME left on the
   *  default PROXIED setting (orange cloud) is hidden and answered with
   *  Cloudflare's own edge A records instead. The dashboard shows the record;
   *  every resolver in the world says there is no CNAME. The CA cannot follow
   *  it, so issuance fails — and the fix is a toggle no error message about a
   *  missing record would ever lead you to. */
  'delegation_not_a_cname',
  'delegation_resolver_error',
  // caa
  'caa_absent',
  'caa_permits_all_rotation_cas',
  'caa_permits_some_rotation_cas',
  'caa_permits_no_rotation_cas',
  'caa_critical_unknown_tag',
  'caa_resolver_error',
] as const;
export type CustomDomainPreflightCode =
  (typeof CUSTOM_DOMAIN_PREFLIGHT_CODES)[number];

/** A CAA record, flattened from whatever the resolver hands back into the
 *  RFC 8659 triple. Node's `dns.resolveCaa` returns one property per object
 *  (`{ critical, issue? }`); the server-side adapter normalizes to this. */
export interface CaaRecord {
  /** The flags octet. Bit 0 (value 128) is the Issuer Critical flag. */
  flags: number;
  /** Property tag — `issue` / `issuewild` / `iodef` / anything else. */
  tag: string;
  /** Property value, verbatim (e.g. `letsencrypt.org` or `sectigo.com; foo=1`). */
  value: string;
}

/** RFC 8659 § 4.1 — the Issuer Critical bit. A CAA record carrying an
 *  unrecognized tag WITH this bit set forbids issuance outright. */
export const CAA_ISSUER_CRITICAL_FLAG = 128;

const CAA_KNOWN_TAGS = new Set(['issue', 'issuewild', 'iodef']);

/** The issuer-domain-name half of an `issue` property value: everything before
 *  the first `;`, trimmed and case-folded. An empty result is the RFC 8659
 *  "forbid all issuance" form (`issue ";"`). */
export const caaIssuerDomain = (value: string): string =>
  normalizeDnsName(value.split(';')[0] ?? '');

export interface CaaEvaluation {
  status: Extract<CustomDomainPreflightStatus, 'pass' | 'warn' | 'fail'>;
  code: Extract<
    CustomDomainPreflightCode,
    | 'caa_absent'
    | 'caa_permits_all_rotation_cas'
    | 'caa_permits_some_rotation_cas'
    | 'caa_permits_no_rotation_cas'
    | 'caa_critical_unknown_tag'
  >;
  /** Rotation CA ids this RRset authorizes. */
  permitted_ca_ids: string[];
  /** Rotation CA ids this RRset forbids — the ones whose renewal will fail. */
  blocked_ca_ids: string[];
}

/** RFC 8659 § 4.2 — judge a CAA RRset against the whole rotation.
 *
 *  Only non-wildcard issuance is considered (`issuewild` governs wildcards,
 *  which D-235 § 7 defers past v1), so `issue` is the tag that matters.
 *
 *  ⚠ Matching is EXACT on the issuer-domain-name, not suffix-wise. Some CAs
 *  accept a parent domain; being stricter than the CA can only produce a
 *  false alarm the user can see and dismiss, whereas being looser produces a
 *  cert that renews until the day it doesn't. Given § 5.1's silent-until-outage
 *  shape, the loud error is the correct side to be wrong on.
 *
 *  `records` is the RELEVANT RRset (the first non-empty one found climbing from
 *  the hostname toward the root, per § 3) — an empty array means no CAA RRset
 *  exists anywhere on that climb, which permits every CA. */
export const evaluateCaaForRotation = (
  records: ReadonlyArray<CaaRecord>,
  cas: ReadonlyArray<AcmeRotationCa> = ACME_ROTATION_CAS,
): CaaEvaluation => {
  const allIds = cas.map((ca) => ca.id);

  if (records.length === 0) {
    return {
      status: 'pass',
      code: 'caa_absent',
      permitted_ca_ids: allIds,
      blocked_ca_ids: [],
    };
  }

  // RFC 8659 § 4.1 — an unrecognized tag with the critical bit set forbids
  // issuance by every conforming CA, whatever the `issue` records say. Checked
  // FIRST: an RRset that also names our CA would otherwise read as a pass.
  const criticalUnknown = records.some(
    (r) =>
      (r.flags & CAA_ISSUER_CRITICAL_FLAG) !== 0
      && !CAA_KNOWN_TAGS.has(r.tag.trim().toLowerCase()),
  );
  if (criticalUnknown) {
    return {
      status: 'fail',
      code: 'caa_critical_unknown_tag',
      permitted_ca_ids: [],
      blocked_ca_ids: allIds,
    };
  }

  const issueValues = records
    .filter((r) => r.tag.trim().toLowerCase() === 'issue')
    .map((r) => caaIssuerDomain(r.value));

  // A CAA RRset with no `issue` tag at all (e.g. `iodef` only) places no
  // restriction on non-wildcard issuance.
  if (issueValues.length === 0) {
    return {
      status: 'pass',
      code: 'caa_absent',
      permitted_ca_ids: allIds,
      blocked_ca_ids: [],
    };
  }

  const authorized = new Set(issueValues.filter((v) => v.length > 0));
  const permitted_ca_ids: string[] = [];
  const blocked_ca_ids: string[] = [];
  for (const ca of cas) {
    const ok = ca.caa_identifiers.some((id) => authorized.has(normalizeDnsName(id)));
    (ok ? permitted_ca_ids : blocked_ca_ids).push(ca.id);
  }

  if (permitted_ca_ids.length === 0) {
    return {
      status: 'fail',
      code: 'caa_permits_no_rotation_cas',
      permitted_ca_ids,
      blocked_ca_ids,
    };
  }
  if (blocked_ca_ids.length === 0) {
    return {
      status: 'pass',
      code: 'caa_permits_all_rotation_cas',
      permitted_ca_ids,
      blocked_ca_ids,
    };
  }
  // ⚠ D-235 § 5.2 — the worst diagnostic shape available: issuance succeeds
  // whenever the rotation lands on a permitted CA and fails when it doesn't,
  // so the user sees an intermittent failure months later with nothing to
  // connect it to. A partial pass is reported as a partial pass.
  return {
    status: 'warn',
    code: 'caa_permits_some_rotation_cas',
    permitted_ca_ids,
    blocked_ca_ids,
  };
};

/** The CAA names to query, in RFC 8659 § 3 order: the hostname itself, then
 *  each ancestor. The first name with a non-empty RRset is the relevant one.
 *
 *  Climbing stops at the registry-level label (two labels remaining) rather
 *  than the root: TLDs do not publish CAA, and an unbounded climb is one query
 *  per label for no information. */
export const caaClimbNames = (hostname: string): string[] => {
  const labels = normalizeDnsName(hostname).split('.').filter((l) => l.length > 0);
  const names: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i += 1) {
    names.push(labels.slice(i).join('.'));
  }
  return names;
};

/** Heuristic: is this hostname likely a zone apex, where RFC 1034 forbids the
 *  CNAME § 3.1 asks for?
 *
 *  ⚠ HEURISTIC, and knowably imperfect — `example.co.uk` is an apex with three
 *  labels and reads as false here. Correct apex detection needs the public
 *  suffix list, which contracts does not carry. It is used only to decide
 *  whether to SHOW the ALIAS/flattening caveat, never to refuse anything, so a
 *  miss costs a caveat the user did not see rather than a broken enrolment. */
export const isLikelyZoneApex = (hostname: string): boolean =>
  normalizeDnsName(hostname).split('.').filter((l) => l.length > 0).length === 2;

/** The form of `name` a DNS provider's UI most likely wants: RELATIVE to the
 *  zone, with the zone suffix removed, and `@` for the zone itself.
 *
 *  ⛔ EVERY MAJOR PROVIDER'S "NAME" FIELD IS RELATIVE, AND PASTING AN FQDN INTO
 *  IT SILENTLY DOUBLES THE DOMAIN. Cloudflare turns
 *  `_acme-challenge.example.com` into
 *  `_acme-challenge.example.com.example.com` without complaint — the record
 *  appears created, resolves nowhere, and the resulting failure says the
 *  delegation is missing. Observed as a live near-miss on 2026-08-13, which is
 *  why the panel now shows BOTH forms rather than the fully-qualified one alone.
 *
 *  ⚠ SAME REGISTRABLE-DOMAIN HEURISTIC AS `isLikelyZoneApex` — the last two
 *  labels — and it is wrong for a multi-part suffix (`example.co.uk`) or a
 *  delegated sub-zone. It is a HINT shown beside the authoritative full name,
 *  never a replacement for it, so a bad guess costs a glance rather than a
 *  broken record. */
export const relativeDnsName = (name: string, hostname: string): string => {
  const full = normalizeDnsName(name);
  const labels = normalizeDnsName(hostname).split('.').filter((l) => l.length > 0);
  if (labels.length < 2) return full;
  const zone = labels.slice(-2).join('.');
  if (full === zone) return '@';
  return full.endsWith(`.${zone}`) ? full.slice(0, -(zone.length + 1)) : full;
};

/** What the resolver observed for one check, before judgement. Separating
 *  observation from verdict keeps `evaluateCustomDomainPreflight` pure and
 *  testable without a network. */
export interface CustomDomainDnsObservation {
  /** CNAME targets at `<hostname>`, normalized. Empty = no CNAME. */
  host_cnames: ReadonlyArray<string>;
  /** A/AAAA addresses at `<hostname>`. Populated when the zone flattens. */
  host_addresses: ReadonlyArray<string>;
  /** A/AAAA addresses at `<handle>.<zone>` — what the host must resolve to. */
  ddns_addresses: ReadonlyArray<string>;
  /** True when any of the three lookups above failed for a reason that is not
   *  "the name does not exist". */
  host_resolver_error?: boolean;
  /** CNAME targets at `_acme-challenge.<hostname>`, normalized. */
  delegation_cnames: ReadonlyArray<string>;
  /** The challenge name EXISTS but holds no CNAME (DNS NODATA, as opposed to
   *  NXDOMAIN). Distinguishing the two is what separates "you have not created
   *  it" from "you created it and your provider is hiding it". */
  delegation_name_exists?: boolean;
  delegation_resolver_error?: boolean;
  /** The relevant CAA RRset (first non-empty on the climb), or an empty array
   *  when the climb found none. */
  caa_records: ReadonlyArray<CaaRecord>;
  /** Which name the CAA RRset came from, for the UI to name in its advice. */
  caa_relevant_name?: string;
  caa_resolver_error?: boolean;
}

export interface CustomDomainPreflightCheckResult {
  check: CustomDomainPreflightCheck;
  status: CustomDomainPreflightStatus;
  code: CustomDomainPreflightCode;
  /** The DNS name this check interrogated. */
  name: string;
  /** What the check required to see. Absent for CAA, which has no single
   *  expected value. */
  expected?: string;
  /** What it actually saw, for the UI to echo back. */
  observed?: ReadonlyArray<string>;
}

export interface CustomDomainPreflightResult {
  hostname: string;
  /** The Pro DDNS host the custom hostname routes through. */
  ddns_hostname: string;
  /** The two records § 3.1 asks the user to create, ready to copy-paste. */
  required_records: {
    host: { name: string; type: 'CNAME'; value: string };
    delegation: { name: string; type: 'CNAME'; value: string };
  };
  checks: CustomDomainPreflightCheckResult[];
  /** True iff every check passed. `warn` does not clear this — a partial CAA
   *  pass is a cert that renews intermittently, which is not "ready". */
  ok: boolean;
  /** True iff no check FAILED. Distinguishes "ready" from "will work but has a
   *  caveat" from "will not work". */
  blocking_failure: boolean;
  /** § 3.1 — the hostname looks like a zone apex, where the host CNAME needs
   *  ALIAS/ANAME or CNAME flattening. Advisory; see `isLikelyZoneApex`. */
  apex_cname_caveat: boolean;
  /** CAA verdict detail, so the UI can name exactly which CA is blocked. */
  caa: CaaEvaluation | null;
}

const sameSet = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean => {
  if (a.length === 0 || b.length === 0) return false;
  const bs = new Set(b);
  return a.every((v) => bs.has(v)) && new Set(a).size === bs.size;
};

/** Pure judgement over an observation. The network lives in the caller. */
export const evaluateCustomDomainPreflight = (args: {
  hostname: string;
  handle: string;
  zone?: DdnsZone;
  observation: CustomDomainDnsObservation;
  cas?: ReadonlyArray<AcmeRotationCa>;
}): CustomDomainPreflightResult => {
  const hostname = normalizeDnsName(args.hostname);
  const ddns_hostname = hostnameForHandle(args.handle, args.zone);
  const delegationName = acmeChallengeName(hostname);
  const delegationTarget = customDomainDelegationTarget(args.handle, args.zone);
  const obs = args.observation;

  // ── host_route ─────────────────────────────────────────────────────────
  const hostCnames = obs.host_cnames.map(normalizeDnsName);
  let host: CustomDomainPreflightCheckResult;
  if (hostCnames.length > 0) {
    host = hostCnames.includes(ddns_hostname)
      ? {
          check: 'host_route',
          status: 'pass',
          code: 'host_cname_matches_ddns',
          name: hostname,
          expected: ddns_hostname,
          observed: hostCnames,
        }
      : {
          check: 'host_route',
          status: 'fail',
          code: 'host_cname_target_mismatch',
          name: hostname,
          expected: ddns_hostname,
          observed: hostCnames,
        };
  } else if (obs.host_addresses.length > 0 && obs.ddns_addresses.length === 0) {
    // ⛔ THE COMPARISON HAS NO BASELINE, SO IT HAS NO VERDICT. The user's
    //    addresses can only be judged against the ones the Pro DDNS name
    //    currently publishes, and we did not get those — the lookup failed, or
    //    DDNS is paused, or the handle has not published yet. Falling through
    //    to `stale` here would tell a user with a PERFECTLY CORRECT flattened
    //    apex to go fix it, which is the same absence-is-not-failure mistake
    //    the delegation check exists to avoid, one branch over.
    host = {
      check: 'host_route',
      status: 'unknown',
      code: 'host_ddns_baseline_unavailable',
      name: hostname,
      expected: ddns_hostname,
      observed: obs.host_addresses,
    };
  } else if (obs.host_addresses.length > 0) {
    // No CNAME but addresses exist — either the provider flattens (ALIAS/ANAME,
    // which § 3.1 endorses) or the user hardcoded an A record. Both look
    // identical in DNS; the addresses matching the DDNS name's is what tells
    // them apart TODAY, and only a `warn` because a hardcoded A stops matching
    // the moment the dynamic IP changes and we cannot see which one this is.
    host = sameSet(obs.host_addresses, obs.ddns_addresses)
      ? {
          check: 'host_route',
          status: 'warn',
          code: 'host_flattened_matches_ddns',
          name: hostname,
          expected: ddns_hostname,
          observed: obs.host_addresses,
        }
      : {
          check: 'host_route',
          status: 'fail',
          code: 'host_flattened_stale',
          name: hostname,
          expected: ddns_hostname,
          observed: obs.host_addresses,
        };
  } else if (obs.host_resolver_error === true) {
    host = {
      check: 'host_route',
      status: 'unknown',
      code: 'host_resolver_error',
      name: hostname,
      expected: ddns_hostname,
    };
  } else {
    host = {
      check: 'host_route',
      status: 'fail',
      code: 'host_unresolved',
      name: hostname,
      expected: ddns_hostname,
    };
  }

  // ── acme_delegation ────────────────────────────────────────────────────
  const delegationCnames = obs.delegation_cnames.map(normalizeDnsName);
  let delegation: CustomDomainPreflightCheckResult;
  if (delegationCnames.includes(delegationTarget)) {
    delegation = {
      check: 'acme_delegation',
      status: 'pass',
      code: 'delegation_target_matches',
      name: delegationName,
      expected: delegationTarget,
      observed: delegationCnames,
    };
  } else if (delegationCnames.length > 0) {
    delegation = {
      check: 'acme_delegation',
      status: 'fail',
      code: 'delegation_target_mismatch',
      name: delegationName,
      expected: delegationTarget,
      observed: delegationCnames,
    };
  } else if (obs.delegation_resolver_error === true) {
    // ⛔ NOT `delegation_missing`. A SERVFAIL is not evidence the record is
    //    absent, and telling the user to create a record they already created
    //    is how a diagnostic loses its credibility.
    delegation = {
      check: 'acme_delegation',
      status: 'unknown',
      code: 'delegation_resolver_error',
      name: delegationName,
      expected: delegationTarget,
    };
  } else if (obs.delegation_name_exists === true) {
    // ⛔ SAME RULE, DIFFERENT EVIDENCE. The name resolved — something is there —
    //    it just is not a CNAME. Reporting that as "missing" is the identical
    //    mistake as reporting a SERVFAIL that way, and it has a real-world
    //    trigger: a Cloudflare-proxied CNAME (see the code's note).
    delegation = {
      check: 'acme_delegation',
      status: 'fail',
      code: 'delegation_not_a_cname',
      name: delegationName,
      expected: delegationTarget,
    };
  } else {
    delegation = {
      check: 'acme_delegation',
      status: 'fail',
      code: 'delegation_missing',
      name: delegationName,
      expected: delegationTarget,
    };
  }

  // ── caa ────────────────────────────────────────────────────────────────
  let caaEval: CaaEvaluation | null = null;
  let caa: CustomDomainPreflightCheckResult;
  if (obs.caa_resolver_error === true && obs.caa_records.length === 0) {
    caa = {
      check: 'caa',
      status: 'unknown',
      code: 'caa_resolver_error',
      name: obs.caa_relevant_name ?? hostname,
    };
  } else {
    caaEval = evaluateCaaForRotation(obs.caa_records, args.cas);
    caa = {
      check: 'caa',
      status: caaEval.status,
      code: caaEval.code,
      name: obs.caa_relevant_name ?? hostname,
      observed: obs.caa_records.map((r) => `${r.flags} ${r.tag} "${r.value}"`),
    };
  }

  const checks = [host, delegation, caa];
  return {
    hostname,
    ddns_hostname,
    required_records: {
      host: { name: hostname, type: 'CNAME', value: ddns_hostname },
      delegation: { name: delegationName, type: 'CNAME', value: delegationTarget },
    },
    checks,
    ok: checks.every((c) => c.status === 'pass'),
    blocking_failure: checks.some((c) => c.status === 'fail'),
    apex_cname_caveat: isLikelyZoneApex(hostname),
    caa: caaEval,
  };
};

/** `collection.hostname.preflight` request. The handle is resolved server-side
 *  from the Pro subscription state — a caller cannot preflight against someone
 *  else's delegation target. */
export interface CustomDomainPreflightRequest {
  hostname: string;
}

export interface CustomDomainPreflightResponse {
  preflight: CustomDomainPreflightResult;
}

export const isCustomDomainPreflightStatus = (
  value: unknown,
): value is CustomDomainPreflightStatus =>
  typeof value === 'string'
  && (CUSTOM_DOMAIN_PREFLIGHT_STATUSES as readonly string[]).includes(value);

export const isCustomDomainPreflightCode = (
  value: unknown,
): value is CustomDomainPreflightCode =>
  typeof value === 'string'
  && (CUSTOM_DOMAIN_PREFLIGHT_CODES as readonly string[]).includes(value);

// ─────────────────────────────────────────────────────────────────────────
// D-235 P2 — the issuance gate
// ─────────────────────────────────────────────────────────────────────────

/** § 7 — how many custom hostnames one server may enrol.
 *
 *  Unbounded invites a single subscriber to spend the fleet's whole ACME budget;
 *  each order is a real CA round-trip plus a DNS-01 dance, and CAs rate-limit
 *  FAILED validations too, so a server with fifty half-configured domains can
 *  starve its own legitimate renewals. Five is the § 7 suggestion's upper end —
 *  generous for the "my domain plus a couple of aliases" case this is for, and
 *  a raise-on-request path can lift it later without a schema change. */
export const CUSTOM_DOMAIN_MAX_PER_SERVER = 5;

/** Why the fleet will not issue for this hostname. Every blocker names
 *  something the user (or the server) can act on.
 *
 *  ⛔ THIS IS A GATE, SO UNKNOWN FAILS CLOSED — the exact inverse of the
 *  preflight's rule. A preflight that could not reach DNS reports `unknown`
 *  because telling a user to fix a correct record is worse than saying nothing;
 *  a gate that has not confirmed the delegation must refuse, because ordering
 *  against an unconfirmed delegation burns CA quota on a validation that cannot
 *  pass. The two rules look contradictory and are not: one is a diagnosis, the
 *  other is a decision. */
export const CUSTOM_DOMAIN_ISSUANCE_BLOCKERS = [
  /** Not a `recued_acme_custom` row — the fleet does not issue for it at all. */
  'not_a_custom_acme_hostname',
  /** § 3.2 gate 1 — the requester has not proved they control the name. */
  'ownership_unverified',
  /** § 3.2 ⛔ — verified, but by `cert_proof`, which is not authority to mint.
   *  Reachable on a row whose source changed after an earlier cert proof. */
  'ownership_proof_method_insufficient',
  /** § 3.2 gate 2 — no preflight result was supplied. Not "it might be fine". */
  'delegation_unchecked',
  /** § 3.2 gate 2 — `_acme-challenge.<host>` does not reach the fleet's zone.
   *  Every order would die at authorization; check BEFORE ordering. */
  'delegation_unverified',
  /** § 3.2 gate 3 / § 5.2 — CAA forbids at least one CA the rotation may pick.
   *  Blocking on a PARTIAL is deliberate: see `evaluateCustomDomainIssuanceEligibility`. */
  'caa_blocks_rotation',
  /** § 3.2 gate 4 — Pro is what pays for the fleet's ACME capacity. */
  'subscription_inactive',
  /** The user disabled the hostname; issuing for it would be surprising. */
  'hostname_disabled',
  /** § 7 — the per-server cap. */
  'custom_hostname_cap_reached',
] as const;
export type CustomDomainIssuanceBlocker =
  (typeof CUSTOM_DOMAIN_ISSUANCE_BLOCKERS)[number];

export interface CustomDomainIssuanceDecision {
  /** True iff `blockers` is empty. */
  eligible: boolean;
  /** ⚠ EVERY blocker, not the first. A gate that reports one reason at a time
   *  makes the user fix-and-retry N times, and each retry is a round-trip they
   *  did not need — the CAA record and the delegation CNAME live in the same
   *  zone editor and should be added in one visit. */
  blockers: CustomDomainIssuanceBlocker[];
  /** CAA `issue` values the user must add for the whole rotation to work.
   *  Empty unless `caa_blocks_rotation` is present. */
  missing_caa_identifiers: string[];
}

/** § 3.2 — may the fleet issue a certificate for this hostname?
 *
 *  Composes all four gates plus the two local ones (enabled, cap). Pure: the
 *  caller supplies the row, a preflight result, the subscription state and the
 *  enrolled count.
 *
 *  ⛔⛔ THIS IS LOCAL POLICY, NOT AUTHORITY. The server is the user's own
 *  machine — anyone who can patch it can pass this function. The gate that
 *  actually binds is cloud-side: `backend/api/src/routes/acme.ts` re-resolves
 *  the delegation CNAME itself and refuses anything that does not point into
 *  the authenticated publisher's own zone. This function exists so the server
 *  does not burn CA quota on orders the cloud will refuse, and so the UI can
 *  say why — not to be trusted as the boundary. See D-235 § 8.2.
 *
 *  ⚠ A PARTIAL CAA PASS BLOCKS. § 5.2 asks for refusal "with a legible message
 *  naming the records to add", and that is the kinder answer even though it
 *  refuses a setup that would work today: `issue letsencrypt.org` alone is a
 *  common, deliberate config, and letting it through hands the user a
 *  certificate that renews until the rotation happens to pick ZeroSSL, months
 *  later, with nothing to connect the outage to. Adding two CAA records is a
 *  two-minute fix; `missing_caa_identifiers` carries exactly which. */
export const evaluateCustomDomainIssuanceEligibility = (args: {
  row: {
    cert_source: string;
    ownership_status: string;
    verification_method?: string;
    enabled: boolean;
  };
  /** A preflight for THIS hostname. `null` blocks — see the vocabulary note. */
  preflight: Pick<CustomDomainPreflightResult, 'checks' | 'caa'> | null;
  subscription_active: boolean;
  /** Enrolled `recued_acme_custom` rows INCLUDING this one. */
  enrolled_custom_count: number;
  cap?: number;
  cas?: ReadonlyArray<AcmeRotationCa>;
}): CustomDomainIssuanceDecision => {
  const blockers: CustomDomainIssuanceBlocker[] = [];
  const missing_caa_identifiers: string[] = [];
  const cap = args.cap ?? CUSTOM_DOMAIN_MAX_PER_SERVER;
  const { row } = args;

  if (row.cert_source !== 'recued_acme_custom') {
    // Nothing else is meaningful about a row the fleet will not issue for, so
    // this is the one blocker that returns alone.
    return {
      eligible: false,
      blockers: ['not_a_custom_acme_hostname'],
      missing_caa_identifiers,
    };
  }

  if (row.ownership_status !== 'verified') {
    blockers.push('ownership_unverified');
  } else if (row.verification_method === 'cert_proof') {
    // A row that was `byo_uploaded`, proved by cert, and later switched source
    // carries a `verified` status earned by the one method § 3.2 excludes.
    // Reading only `ownership_status` here would let that stale proof through.
    blockers.push('ownership_proof_method_insufficient');
  }

  if (args.preflight === null) {
    blockers.push('delegation_unchecked');
  } else {
    const delegation = args.preflight.checks.find(
      (c) => c.check === 'acme_delegation',
    );
    if (delegation?.status !== 'pass') blockers.push('delegation_unverified');

    const caa = args.preflight.checks.find((c) => c.check === 'caa');
    if (caa?.status !== 'pass') {
      blockers.push('caa_blocks_rotation');
      // Name the records to add. On a partial we know exactly which CAs are
      // blocked; on a total refusal or an unknown we list the whole rotation,
      // because adding all of them is the fix in both cases.
      const blockedIds = args.preflight.caa?.blocked_ca_ids;
      const cas = args.cas ?? ACME_ROTATION_CAS;
      const wanted =
        blockedIds !== undefined && blockedIds.length > 0
          ? cas.filter((ca) => blockedIds.includes(ca.id))
          : cas;
      for (const ca of wanted) {
        const first = ca.caa_identifiers[0];
        if (first !== undefined && !missing_caa_identifiers.includes(first)) {
          missing_caa_identifiers.push(first);
        }
      }
    }
  }

  if (!args.subscription_active) blockers.push('subscription_inactive');
  if (!row.enabled) blockers.push('hostname_disabled');
  if (args.enrolled_custom_count > cap) blockers.push('custom_hostname_cap_reached');

  return { eligible: blockers.length === 0, blockers, missing_caa_identifiers };
};

/** `collection.hostname.issuanceReadiness` — "would the fleet issue for this
 *  hostname right now, and if not, what must I do?". Runs a live preflight, so
 *  it is the same round-trip cost as `collection.hostname.preflight`. */
export interface CustomDomainIssuanceReadinessRequest {
  hostname: string;
}

export interface CustomDomainIssuanceReadinessResponse {
  decision: CustomDomainIssuanceDecision;
  /** The preflight the decision was made on, so the UI renders one view rather
   *  than asking twice and risking two different answers. */
  preflight: CustomDomainPreflightResult;
}

export const isCustomDomainIssuanceBlocker = (
  value: unknown,
): value is CustomDomainIssuanceBlocker =>
  typeof value === 'string'
  && (CUSTOM_DOMAIN_ISSUANCE_BLOCKERS as readonly string[]).includes(value);

// ─────────────────────────────────────────────────────────────────────────
// D-235 P4 § 5.1 — the delegation watch
// ─────────────────────────────────────────────────────────────────────────

/** Last observed state of the `_acme-challenge` delegation for a custom
 *  hostname.
 *
 *  ⛔ THIS IS A SEPARATE FIELD FROM `cert_provisioning` BECAUSE THE WHOLE
 *  FAILURE MODE IS THAT THEY DISAGREE. A cert can be perfectly `ready` — issued,
 *  valid, serving handshakes — while the delegation it depends on has been
 *  deleted. Nothing breaks. Nothing will break for ~60 days. Then the renewal
 *  fails and everything breaks at once. § 5.1: "this is the classic
 *  silent-until-outage shape and it MUST be monitored, not discovered." */
export const CUSTOM_DOMAIN_DELEGATION_STATES = [
  /** Resolves to this server's challenge name. */
  'ok',
  /** Resolves to something else, or to nothing. Renewal WILL fail. */
  'broken',
  /** The lookup did not answer. ⛔ Never treated as `broken` — see
   *  `customDomainDelegationUrgency`. */
  'unknown',
] as const;
export type CustomDomainDelegationState =
  (typeof CUSTOM_DOMAIN_DELEGATION_STATES)[number];

export const isCustomDomainDelegationState = (
  value: unknown,
): value is CustomDomainDelegationState =>
  typeof value === 'string'
  && (CUSTOM_DOMAIN_DELEGATION_STATES as readonly string[]).includes(value);

/** How loudly to say it. § 5.1: "A renewal failure at T-30d is a notice; at
 *  T-2d it is an incident." */
export const CUSTOM_DOMAIN_DELEGATION_URGENCIES = [
  'none',
  'notice',
  'warning',
  'incident',
] as const;
export type CustomDomainDelegationUrgency =
  (typeof CUSTOM_DOMAIN_DELEGATION_URGENCIES)[number];

/** § 5.1 — severity of a delegation problem, with REMAINING CERT LIFETIME as
 *  the urgency signal. The same broken CNAME is a footnote three months out and
 *  an emergency next Tuesday, and a monitor that cannot tell those apart either
 *  cries wolf or arrives too late.
 *
 *  ⛔ `unknown` NEVER ESCALATES PAST `notice`, whatever the clock says. A lookup
 *  that failed is a fact about OUR resolver, not about the user's zone; paging
 *  someone to fix a record that is already correct is how a monitor gets muted,
 *  and a muted monitor is worse than none. If the delegation really is gone, the
 *  next successful check says `broken` and the urgency arrives then.
 *
 *  ⚠ Escalates at 7 days, not the § 5.1 sketch's 2 — deliberately EARLIER.
 *  Repairing a delegation means editing DNS in a zone we do not control and
 *  waiting for propagation; at T-2d that is cutting it fine, and the cost of
 *  being early is one extra week of a banner the user can act on. Reuses
 *  `CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS` rather than minting a fourth
 *  cert-lifetime threshold. */
export const customDomainDelegationUrgency = (args: {
  delegation_state: CustomDomainDelegationState | undefined;
  /** Unix-ms cert expiry. Undefined ⇒ no certificate yet, so there is nothing
   *  to lose and a broken delegation is (at most) a notice. */
  cert_expires_at: number | undefined;
  now: number;
  /** Injected for the two thresholds; defaults to the D-148 constants. */
  notice_window_ms?: number;
  incident_window_ms?: number;
}): CustomDomainDelegationUrgency => {
  const { delegation_state, cert_expires_at, now } = args;
  if (delegation_state === undefined || delegation_state === 'ok') return 'none';
  if (delegation_state === 'unknown') return 'notice';

  if (cert_expires_at === undefined) return 'notice';
  const remaining = cert_expires_at - now;
  const noticeWindow = args.notice_window_ms ?? CERT_RENEWAL_LEAD_TIME_MS;
  const incidentWindow =
    args.incident_window_ms ?? CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS;

  if (remaining <= incidentWindow) return 'incident';
  if (remaining <= noticeWindow) return 'warning';
  return 'notice';
};

/** Turn a preflight into the state the watch persists. Reads ONLY the
 *  delegation check — a CAA problem or a broken host route is a different
 *  complaint, and folding them in would make "delegation broken" mean four
 *  things and point at the wrong record. */
export const delegationStateFromPreflight = (
  preflight: Pick<CustomDomainPreflightResult, 'checks'>,
): CustomDomainDelegationState => {
  const check = preflight.checks.find((c) => c.check === 'acme_delegation');
  if (check === undefined) return 'unknown';
  if (check.status === 'pass') return 'ok';
  if (check.status === 'unknown') return 'unknown';
  return 'broken';
};
