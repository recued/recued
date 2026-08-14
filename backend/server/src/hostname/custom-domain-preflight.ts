/** D-235 P1 — bring-your-own-domain DNS preflight.
 *
 *  Answers three questions about a hostname the user owns, BEFORE anything is
 *  ordered (§ 6 P1 — "ships the diagnostics before the capability, so P2's
 *  failures are legible"):
 *
 *    1. host_route      — does `<hostname>` reach this server through the Pro
 *                         DDNS name?
 *    2. acme_delegation — is `_acme-challenge.<hostname>` CNAME'd into the zone
 *                         the fleet already writes TXT to?
 *    3. caa             — does CAA permit EVERY CA the cloud may fail over to?
 *
 *  The judgement is pure and lives in `@recued/contracts`
 *  (`evaluateCustomDomainPreflight`); this module is the network half — it
 *  performs the lookups and turns resolver exceptions into the observation
 *  shape the evaluator consumes.
 *
 *  ⛔ THE ONE DISTINCTION THIS MODULE EXISTS TO PRESERVE: "the record is not
 *  there" and "I could not find out" are different answers and they arrive
 *  through the same `throw`. `ENOTFOUND` / `ENODATA` mean the name genuinely
 *  has no record of that type; `SERVFAIL` / `ETIMEOUT` / `ECONNREFUSED` mean
 *  the resolver failed and we learned nothing. Collapsing the second into the
 *  first tells a user to create a record they already created, and a diagnostic
 *  that does that once stops being believed.
 *
 *  ⚠ Read-only, by construction. Preflight never writes DNS, never touches the
 *  registry, and never orders a certificate. It is safe to run on every render.
 */

import {
  Resolver as NodeResolver,
  resolveCname as nodeResolveCname,
  resolve4 as nodeResolve4,
  resolve6 as nodeResolve6,
  resolveCaa as nodeResolveCaa,
} from 'node:dns/promises';

import {
  acmeChallengeName,
  caaClimbNames,
  evaluateCustomDomainPreflight,
  normalizeDnsName,
  type AcmeRotationCa,
  type CaaRecord,
  type CustomDomainDnsObservation,
  type CustomDomainPreflightResult,
  type DdnsZone,
} from '@recued/contracts';

/** The DNS surface preflight needs. Injected so the evaluator can be driven
 *  from tests without a network, and so a future slice can point it at a
 *  specific resolver (§ 5.1's delegation watch wants an authoritative one, not
 *  whatever the host box is configured with). */
export interface CustomDomainDnsResolver {
  /** CNAME RDATA at `name`. Empty array = no CNAME. Throws on resolver
   *  failure; NXDOMAIN/NODATA must resolve to `[]`, not throw. */
  resolveCname(name: string): Promise<ReadonlyArray<string>>;
  resolve4(name: string): Promise<ReadonlyArray<string>>;
  resolve6(name: string): Promise<ReadonlyArray<string>>;
  resolveCaa(name: string): Promise<ReadonlyArray<CaaRecord>>;
}

/** DNS "this name has no such record" codes. Everything else is a resolver
 *  failure and must surface as `unknown`, not as absence.
 *
 *  ⚠ `ENODATA` and `ENOTFOUND` are BOTH "no answer" but they are not the same
 *  fact: `ENOTFOUND` is NXDOMAIN (the name does not exist), `ENODATA` is NOERROR
 *  with no record of the requested type (the name EXISTS, carrying something
 *  else). `NAME_EXISTS_CODES` below keeps them apart — see
 *  `delegation_not_a_cname`. */
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA', 'ENODOMAIN', 'NOTFOUND']);
const NAME_EXISTS_CODES = new Set(['ENODATA']);

const dnsErrorCode = (err: unknown): string | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

export const isDnsNameNotFound = (err: unknown): boolean => {
  const code = dnsErrorCode(err);
  return code !== undefined && NOT_FOUND_CODES.has(code);
};

/** True when the lookup failed because the name exists but holds no record of
 *  the requested type (NODATA), as opposed to not existing at all. */
export const isDnsNameExistsWithoutRecord = (err: unknown): boolean => {
  const code = dnsErrorCode(err);
  return code !== undefined && NAME_EXISTS_CODES.has(code);
};

/** Result of one lookup: the answers, plus whether the lookup FAILED (as
 *  opposed to returning nothing). The two must never be conflated. */
interface Lookup<T> {
  answers: ReadonlyArray<T>;
  failed: boolean;
  /** The name resolved but carries no record of this type (NODATA). */
  nameExists?: boolean;
}

const attempt = async <T>(
  run: () => Promise<ReadonlyArray<T>>,
): Promise<Lookup<T>> => {
  try {
    return { answers: await run(), failed: false };
  } catch (err) {
    // A genuinely absent record is an ANSWER ("no, it isn't there"); any other
    // failure is the absence of an answer. NODATA is a THIRD thing: the name is
    // there, carrying something else.
    if (isDnsNameNotFound(err)) {
      return isDnsNameExistsWithoutRecord(err)
        ? { answers: [], failed: false, nameExists: true }
        : { answers: [], failed: false };
    }
    return { answers: [], failed: true };
  }
};

/** Node's `dns.resolveCaa` yields one property per object
 *  (`{ critical, issue? }` / `{ critical, iodef? }`); flatten to the RFC 8659
 *  triple the evaluator reads. Unknown properties are carried through with
 *  their own tag so the critical-bit check in `evaluateCaaForRotation` can see
 *  them — dropping them here would turn a "critical unknown tag forbids
 *  issuance" case into a silent pass. */
export const flattenNodeCaaRecords = (
  records: ReadonlyArray<Record<string, unknown>>,
): CaaRecord[] => {
  const out: CaaRecord[] = [];
  for (const record of records) {
    const flags =
      typeof record.critical === 'number' ? record.critical : 0;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'critical') continue;
      if (typeof value !== 'string') continue;
      out.push({ flags, tag: key, value });
    }
  }
  return out;
};

export interface CreateNodeCustomDomainDnsResolverOptions {
  /** Explicit nameservers (e.g. `['1.1.1.1']`). Omit to use the host's. */
  servers?: ReadonlyArray<string>;
  /** Per-query timeout in ms. Node's default is effectively unbounded across
   *  retries, and preflight runs behind an rpc a user is watching. */
  timeoutMs?: number;
}

export const createNodeCustomDomainDnsResolver = (
  options: CreateNodeCustomDomainDnsResolverOptions = {},
): CustomDomainDnsResolver => {
  if (options.servers === undefined && options.timeoutMs === undefined) {
    return {
      resolveCname: (name) => nodeResolveCname(name),
      resolve4: (name) => nodeResolve4(name),
      resolve6: (name) => nodeResolve6(name),
      resolveCaa: async (name) =>
        flattenNodeCaaRecords(
          (await nodeResolveCaa(name)) as unknown as Record<string, unknown>[],
        ),
    };
  }
  const resolver = new NodeResolver(
    options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {},
  );
  if (options.servers !== undefined && options.servers.length > 0) {
    resolver.setServers([...options.servers]);
  }
  return {
    resolveCname: (name) => resolver.resolveCname(name),
    resolve4: (name) => resolver.resolve4(name),
    resolve6: (name) => resolver.resolve6(name),
    resolveCaa: async (name) =>
      flattenNodeCaaRecords(
        (await resolver.resolveCaa(name)) as unknown as Record<string, unknown>[],
      ),
  };
};

/** Walk the RFC 8659 § 3 climb and return the FIRST non-empty CAA RRset.
 *
 *  ⚠ A resolver failure part-way up is reported (`failed`) rather than treated
 *  as "no CAA here, keep climbing": a SERVFAIL at `their-domain.com` would
 *  otherwise let the climb reach `com`, find nothing, and report the domain as
 *  unrestricted — a false all-clear on the one check whose failure mode is a
 *  renewal that dies months later. */
export const resolveRelevantCaaRrset = async (
  resolver: Pick<CustomDomainDnsResolver, 'resolveCaa'>,
  hostname: string,
): Promise<{ records: CaaRecord[]; name?: string; failed: boolean }> => {
  for (const name of caaClimbNames(hostname)) {
    const lookup = await attempt(() => resolver.resolveCaa(name));
    if (lookup.failed) return { records: [], name, failed: true };
    if (lookup.answers.length > 0) {
      return { records: [...lookup.answers], name, failed: false };
    }
  }
  return { records: [], failed: false };
};

export interface RunCustomDomainPreflightArgs {
  hostname: string;
  /** The server's own Pro DDNS handle — the delegation target is derived from
   *  it, so a caller cannot preflight against someone else's zone. */
  handle: string;
  zone?: DdnsZone;
  resolver: CustomDomainDnsResolver;
  cas?: ReadonlyArray<AcmeRotationCa>;
}

/** Observe, then judge. Every lookup runs concurrently — they are independent,
 *  and a user is waiting on the round-trip. */
export const observeCustomDomainDns = async (args: {
  hostname: string;
  ddnsHostname: string;
  resolver: CustomDomainDnsResolver;
}): Promise<CustomDomainDnsObservation> => {
  const hostname = normalizeDnsName(args.hostname);
  const delegationName = acmeChallengeName(hostname);
  const { resolver } = args;

  const [hostCname, hostA, hostAAAA, ddnsA, ddnsAAAA, delegationCname, caa] =
    await Promise.all([
      attempt(() => resolver.resolveCname(hostname)),
      attempt(() => resolver.resolve4(hostname)),
      attempt(() => resolver.resolve6(hostname)),
      attempt(() => resolver.resolve4(args.ddnsHostname)),
      attempt(() => resolver.resolve6(args.ddnsHostname)),
      attempt(() => resolver.resolveCname(delegationName)),
      resolveRelevantCaaRrset(resolver, hostname),
    ]);

  const observation: CustomDomainDnsObservation = {
    host_cnames: hostCname.answers.map(normalizeDnsName),
    host_addresses: [...hostA.answers, ...hostAAAA.answers],
    ddns_addresses: [...ddnsA.answers, ...ddnsAAAA.answers],
    delegation_cnames: delegationCname.answers.map(normalizeDnsName),
    caa_records: caa.records,
  };
  // Only claim a resolver error when the lookups produced NOTHING to judge —
  // a failed AAAA alongside a good A is not an unknown, it is an answer.
  if (
    (hostCname.failed || hostA.failed || hostAAAA.failed || ddnsA.failed || ddnsAAAA.failed)
    && observation.host_cnames.length === 0
    && observation.host_addresses.length === 0
  ) {
    observation.host_resolver_error = true;
  }
  if (delegationCname.failed && observation.delegation_cnames.length === 0) {
    observation.delegation_resolver_error = true;
  }
  // The challenge name is there but holds no CNAME — a Cloudflare-proxied
  // record is the case that produces this in the wild.
  if (delegationCname.nameExists === true && observation.delegation_cnames.length === 0) {
    observation.delegation_name_exists = true;
  }
  if (caa.failed) observation.caa_resolver_error = true;
  if (caa.name !== undefined) observation.caa_relevant_name = caa.name;
  return observation;
};

export const runCustomDomainPreflight = async (
  args: RunCustomDomainPreflightArgs,
): Promise<CustomDomainPreflightResult> => {
  const evaluatorInput = {
    hostname: args.hostname,
    handle: args.handle,
    ...(args.zone !== undefined ? { zone: args.zone } : {}),
    ...(args.cas !== undefined ? { cas: args.cas } : {}),
  };
  // Derive the DDNS host the same way the evaluator will, so the observation
  // and the judgement can never be about two different names.
  const preview = evaluateCustomDomainPreflight({
    ...evaluatorInput,
    observation: {
      host_cnames: [],
      host_addresses: [],
      ddns_addresses: [],
      delegation_cnames: [],
      caa_records: [],
    },
  });
  const observation = await observeCustomDomainDns({
    hostname: args.hostname,
    ddnsHostname: preview.ddns_hostname,
    resolver: args.resolver,
  });
  return evaluateCustomDomainPreflight({ ...evaluatorInput, observation });
};
