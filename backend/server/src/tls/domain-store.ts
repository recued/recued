/** D-148 § A.6.3 (W3.6) — SQLite-backed `TLSDomainStore` implementation.
 *
 *  Production wiring for the W3.2 contracts substrate. Per-domain rows
 *  carry the leaf cert PEM in plaintext (already public bytes — sent
 *  on the wire at every handshake) plus the private key PEM AEAD-
 *  encrypted under the new `tls_domains` sub-DEK. The chain PEM (when
 *  present) is also plaintext — it serves the same intermediate-cert
 *  set on every handshake.
 *
 *  AAD binds each ciphertext to its `domain` so an attacker who
 *  reorders rows in the SQLite file cannot move a `private_key_encrypted`
 *  blob between domains. The `recued/v1/tls_domains/private_key/<domain>`
 *  label doubles as a versioned binding — bumping the version lets a
 *  future format re-encode in place without confusion.
 *
 *  Per-pair only — no cross-cloud sync (D-097 / D-168). The W3.2
 *  contracts substrate already established the no-sync invariant via
 *  the `tls_domains` sub-DEK comment + the spec § A.6.3 "Per-pair
 *  only" line.
 *
 *  Store discipline:
 *    - `lookup(domain)` is called per-handshake by the public listener's
 *      `SNICallback` — must be synchronous + cheap. The store caches
 *      decrypted private keys in RAM keyed by domain so re-handshakes
 *      avoid the AEAD round-trip. Cache invalidates on `upload(domain)`
 *      + `remove(domain)`.
 *    - `upload(args)` validates via the caller-supplied verifier seam
 *      (W3.2 contract) before persisting. The validator + persistence
 *      path is async (verifier seam + crypto.subtle.encrypt).
 *    - `list()` projects rows for the Settings UI + Reachability Doctor —
 *      excludes private-key material at the type level (W3.2 contract).
 *    - `remove(domain)` deletes the row + drops the cache entry.
 *
 *  The `pro_acme` source's renewal flow stays in `cert-renewal.ts` —
 *  W3.6's contract doesn't reach into the existing renewal pipeline;
 *  a follow-up wires the renewal output through `upload({ source:
 *  'pro_acme', ... })` so per-domain auto-renewal lands as one flow. */

import type Database from 'better-sqlite3';
import {
  TLS_CERT_MIN_VALIDITY_MS,
  isFleetIssuedTlsDomainSource,
  isTLSDomainCertSource,
  type TLSDomainCertChain,
  type TLSDomainCertListEntry,
  type TLSDomainStore,
  type TLSDomainUploadInput,
  type TLSDomainUploadIssue,
  type TLSDomainUploadResult,
  type TLSDomainUploadVerifiers,
  validateTLSDomainUpload,
} from '@recued/contracts';
import {
  base64ToBytes,
  bytesToBase64,
  decodeCiphertext,
  decrypt,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';
import { computeCertFingerprint } from '@recued/server-tls';

/** Closed-list table inventory — W3.6 ships one row-per-domain table. */
export const TLS_DOMAIN_TABLES = ['tls_domains'] as const;
export type TlsDomainTableName = (typeof TLS_DOMAIN_TABLES)[number];

/** Idempotent schema install — safe to call on every boot. Mirrors the
 *  per-store pattern used by `ensureChatSchema` / `ensureReceptionSchema`
 *  etc. */
export const ensureTlsDomainSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tls_domains (
      domain                  TEXT PRIMARY KEY,
      source                  TEXT NOT NULL,
      cert_pem                TEXT NOT NULL,
      private_key_encrypted   TEXT NOT NULL,
      chain_pem               TEXT,
      fingerprint             TEXT NOT NULL,
      issuer                  TEXT NOT NULL,
      expires_at              INTEGER NOT NULL,
      uploaded_at             INTEGER NOT NULL,
      last_renewed_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tls_domains_source
      ON tls_domains (source);
    CREATE INDEX IF NOT EXISTS idx_tls_domains_expires_at
      ON tls_domains (expires_at);
  `);
};

/** Caller-supplied seam for the `tls_domains` sub-DEK. Mirrors
 *  `ChatKeyProvider` — returns the derived sub-DEK when FileVault is
 *  unlocked, null when locked. Production wiring passes
 *  `keyManager.keyProvider('tls_domains')`. */
export type TlsDomainKeyProvider = () => Uint8Array | null;

/** AAD binding for the encrypted private key. Binds each ciphertext
 *  to its `domain` so reordering rows in the SQLite file cannot move
 *  a `private_key_encrypted` blob between domains. The `v1` sentinel
 *  is the format version. */
const aadForDomain = (domain: string): Uint8Array =>
  new TextEncoder().encode(`recued/v1/tls_domains/private_key/${domain}`);

/** Sentinel error class thrown when the tls_domains sub-DEK is
 *  unavailable because FileVault is locked / uninitialized. Distinct
 *  from generic decryption failures so caller code can detect locked
 *  state vs. a tampered row. */
export class TlsDomainVaultLockedError extends Error {
  constructor(detail: string) {
    super(`tls-domain-store: server FileVault is locked, cannot ${detail}`);
    this.name = 'TlsDomainVaultLockedError';
  }
}

const requireKey = (getKey: TlsDomainKeyProvider, op: string): Uint8Array => {
  const key = getKey();
  if (!key) {
    throw new TlsDomainVaultLockedError(op);
  }
  return key;
};

/** Encode a private key PEM for at-rest storage. AEAD-encrypts under
 *  the tls_domains sub-DEK with `domain` binding when a key provider
 *  is wired through. Falls back to a base64 encoding when none is
 *  supplied — covers dbless harnesses + the KeyManager-not-yet-wired
 *  boot window per the established `chat-store` discipline. */
export const encodePrivateKeyForStorage = async (
  private_key_pem: string,
  domain: string,
  getKey?: TlsDomainKeyProvider,
): Promise<string> => {
  const plaintext = new TextEncoder().encode(private_key_pem);
  if (!getKey) {
    return bytesToBase64(plaintext);
  }
  const key = requireKey(getKey, 'encrypt private key');
  const ct = await encrypt(key, plaintext, aadForDomain(domain));
  return encodeCiphertext(ct);
};

/** Decode a private key PEM from at-rest ciphertext. The lookup path
 *  calls this at most once per domain (results are cached in RAM until
 *  upload/remove invalidates). AAD must match the row's `domain` —
 *  moving the blob between rows fails to decrypt. */
export const decodePrivateKeyFromStorage = async (
  blob: string,
  domain: string,
  getKey?: TlsDomainKeyProvider,
): Promise<string> => {
  if (!getKey) {
    return new TextDecoder().decode(base64ToBytes(blob));
  }
  const key = requireKey(getKey, 'decrypt private key');
  const ct = decodeCiphertext(blob);
  const plaintext = await decrypt(key, ct, aadForDomain(domain));
  return new TextDecoder().decode(plaintext);
};

interface DomainRow {
  domain: string;
  source: string;
  cert_pem: string;
  private_key_encrypted: string;
  chain_pem: string | null;
  fingerprint: string;
  issuer: string;
  expires_at: number;
  uploaded_at: number;
  last_renewed_at: number | null;
}

/** ⛔ WAS A LOCAL COPY (`s === 'pro_acme' || s === 'byo_upload'`). A copy of a
 *  closed vocabulary is one that will be a member behind exactly once, and the
 *  miss is silent: an unrecognized source reads as "row does not exist", so the
 *  handshake serves nothing and the renewal filter skips it — a certificate
 *  that is present, valid, and unreachable. D-235 added a third member; the
 *  copy is now the contract predicate itself. */
const isKnownSource = isTLSDomainCertSource;

/** Codex W3.6 P2 fold — DNS hostnames are case-insensitive per
 *  RFC 6125 § 6.4.1, but SQLite's default text comparison + our
 *  in-RAM cache `Map<string, ...>` are case-sensitive. A client
 *  sending mixed-case SNI (`Alice.Example`) would miss a row stored
 *  as lowercase (`alice.example`) and the connection would close as
 *  `tls_domain_unknown`.
 *
 *  Canonicalize at every persistence + lookup boundary: lowercase +
 *  trim. The AAD that binds the encrypted private key also derives
 *  from this canonical form, so re-uploading a domain with different
 *  case maps to the same row (idempotent at the user surface). */
const canonicalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase();

/** Production-impl metadata reader. Feeds the `issuer` slot of the
 *  W3.2 `TLSDomainCertListEntry` shape; not part of the validation
 *  seam (validation never reads issuer). The W3.6 production wiring
 *  in `./cert-verifiers.ts` implements both this AND the W3.2
 *  `TLSDomainUploadVerifiers` from the same `node:crypto`
 *  X509Certificate parser. */
export interface TlsDomainCertReader {
  /** Read the cert's issuer common-name (or, when absent, the full
   *  issuer DN string). Empty string when parse fails — the store's
   *  `list()` row carries the issuer for UI display, so an empty
   *  string is a graceful degradation. */
  extractIssuer: (cert_pem: string) => string;
}

export interface CreateTlsDomainStoreOptions {
  db: Database.Database;
  /** Optional sub-DEK provider. When unwired (tests / pre-vault boot)
   *  the store falls back to base64-only encoding identical to the
   *  established `chat-store` discipline. */
  getKey?: TlsDomainKeyProvider;
  /** Caller-supplied verifier seam. W3.6 wires
   *  `createNodeTlsVerifiers()` from `./cert-verifiers.ts`; tests pass
   *  a stub. */
  verifiers: TLSDomainUploadVerifiers;
  /** Caller-supplied metadata reader for the `list()` issuer slot.
   *  When omitted the store records empty-string issuers; tests pass
   *  a stub when they care about the field. */
  metadataReader?: TlsDomainCertReader;
  /** Pluggable clock. Defaults to `Date.now`. Tests pass a fixed
   *  value to make `expires_at` warn-band assertions deterministic. */
  now?: () => number;
  /** Allow self-signed chains. Default false — production callers
   *  reject self-signed at upload (BYO + ACME both terminate at a
   *  public CA). Tests + niche dev configs flip true. */
  acceptSelfSigned?: boolean;
}

/** D-148 FU2 — per-domain row shape used by the Reachability Doctor's
 *  per-domain TLS health rollup. Carries the standard
 *  `TLSDomainCertListEntry` fields PLUS the public cert + chain PEM
 *  bytes (already sent on every handshake; never sensitive). Private
 *  key material is NEVER on this type — the in-process verifier seam
 *  only needs the public bytes to walk leaf → chain → system trust
 *  store.
 *
 *  Internal-only — NOT exposed via rpc. Mary's webclient consumes
 *  the rolled-up `ReachabilityPerDomainTlsEntry` from
 *  `ReachabilityReport.per_domain_tls`, which excludes the raw PEM
 *  bytes (verifier output is the boolean `chain_valid` /
 *  `fingerprint_matches`). */
export interface SqliteTlsDomainHealthCheckRow extends TLSDomainCertListEntry {
  cert_pem: string;
  chain_pem?: string;
}

/** Public surface of the SQLite-backed store. Same shape as the W3.2
 *  abstract `TLSDomainStore` contract plus the production-only
 *  `warmCache()` extension that bin.ts calls after vault unlock to
 *  pre-decrypt every per-domain private key into the in-RAM cache.
 *  The synchronous `lookup()` path consults that cache (not the
 *  AEAD-encrypted blob) so per-handshake SNICallback dispatch stays
 *  off the event loop. */
export interface SqliteTlsDomainStore extends TLSDomainStore {
  /** Walk every persisted domain row and decrypt the private key into
   *  the in-RAM cache. Returns `{ warmed, locked }`:
   *    - `warmed` — the count of domains successfully decrypted.
   *    - `locked` — true iff the vault was locked at any point during
   *      the walk; production callers surface this in the boot banner
   *      + the Reachability Doctor's TLS block.
   *  Idempotent — re-warm after upload/remove invalidates is cheap. */
  warmCache(): Promise<{ warmed: number; locked: boolean }>;
  /** D-148 FU2 — enumerate every persisted domain row WITH the public
   *  cert + chain bytes, for the Reachability Doctor's per-domain
   *  health rollup. Private key material is NEVER included (the
   *  return type doesn't even carry a slot for it). Synchronous —
   *  reads the same SQLite rows as `list()`; the only difference is
   *  the extra `cert_pem` + `chain_pem` columns. Not exposed via
   *  rpc; caller is the in-process doctor builder. */
  listForHealthCheck(): SqliteTlsDomainHealthCheckRow[];
}

/** Build the SQLite-backed store. Caller has already run
 *  `ensureTlsDomainSchema(db)` at boot. */
export const createSqliteTlsDomainStore = (
  options: CreateTlsDomainStoreOptions,
): SqliteTlsDomainStore => {
  const {
    db,
    getKey,
    verifiers,
    metadataReader,
    now: nowFn = Date.now,
    acceptSelfSigned = false,
  } = options;

  // Per-domain decrypted-private-key cache. Per-handshake `lookup` must
  // be synchronous; we warm the cache on `upload` (we already have the
  // plaintext at that point) and lazy-warm on first sync `lookup` via
  // the row's plaintext fallback path. The cache invalidates on
  // upload/remove.
  const decryptedCache = new Map<string, string>();

  const insertOrReplaceStmt = db.prepare(`
    INSERT INTO tls_domains (
      domain, source, cert_pem, private_key_encrypted, chain_pem,
      fingerprint, issuer, expires_at, uploaded_at, last_renewed_at
    ) VALUES (
      @domain, @source, @cert_pem, @private_key_encrypted, @chain_pem,
      @fingerprint, @issuer, @expires_at, @uploaded_at, @last_renewed_at
    )
    ON CONFLICT(domain) DO UPDATE SET
      source = excluded.source,
      cert_pem = excluded.cert_pem,
      private_key_encrypted = excluded.private_key_encrypted,
      chain_pem = excluded.chain_pem,
      fingerprint = excluded.fingerprint,
      issuer = excluded.issuer,
      expires_at = excluded.expires_at,
      uploaded_at = excluded.uploaded_at,
      last_renewed_at = COALESCE(excluded.last_renewed_at, tls_domains.last_renewed_at)
  `);
  const getDomainStmt = db.prepare<{ domain: string }>(
    `SELECT * FROM tls_domains WHERE domain = @domain`,
  );
  const listStmt = db.prepare(`SELECT * FROM tls_domains ORDER BY domain ASC`);
  const deleteStmt = db.prepare<{ domain: string }>(
    `DELETE FROM tls_domains WHERE domain = @domain`,
  );

  /** ⛔⛔ THE FALLBACK USED TO BE `: 'byo_upload'`, AND THAT IS A SILENT
   *  MIS-LABEL, NOT A GRACEFUL DEGRADATION. `byo_upload` means "the user renews
   *  this one" — so an unrecognized source (a row written by a newer build the
   *  operator then rolled back, or a tampered file) would be reported as
   *  user-managed, excluded from every ACME renewal filter, and expire ~90 days
   *  later with nothing having said a word. Exactly D-235 § 5.1's shape.
   *
   *  Returning `null` and having callers DROP the row makes the same condition
   *  visible instead: the domain stops resolving to a cert, which is how
   *  `lookup()` has always treated an unknown source. Absent is loud; mislabelled
   *  is not. */
  const rowToListEntry = (row: DomainRow): TLSDomainCertListEntry | null => {
    if (!isKnownSource(row.source)) return null;
    const entry: TLSDomainCertListEntry = {
      domain: row.domain,
      fingerprint: row.fingerprint,
      expires_at: row.expires_at,
      issuer: row.issuer,
      source: row.source,
    };
    if (row.last_renewed_at !== null && row.last_renewed_at !== undefined) {
      entry.last_renewed_at = row.last_renewed_at;
    }
    return entry;
  };

  const upload = async (
    args: TLSDomainUploadInput,
  ): Promise<TLSDomainUploadResult> => {
    const at = nowFn();
    // Codex W3.6 P2 fold — canonicalize the domain at the persistence
    // boundary so mixed-case SNI hits the same row. The pure
    // `validateTLSDomainUpload` validator already lowercases internally
    // for SAN matching; we mirror that at the storage boundary too so
    // the SQLite PK + cache key + AAD all converge on the canonical
    // form.
    const canonical = canonicalizeDomain(args.domain);
    const canonicalArgs: TLSDomainUploadInput = { ...args, domain: canonical };
    const validation = validateTLSDomainUpload(canonicalArgs, verifiers, {
      now_ms: at,
      accept_self_signed: acceptSelfSigned,
    });
    if (!validation.ok) {
      // The W3.6 store throws a structured error so the rpc handler
      // (lands in a follow-up slice) can map issues directly to the
      // closed-list error codes. Throwing keeps the contract's
      // `Promise<TLSDomainUploadResult>` signature honest — the
      // success path is the only return shape; failure is a typed
      // exception.
      throw new TlsDomainUploadValidationError(validation.issues);
    }
    const fingerprint = computeCertFingerprint(args.cert_pem);
    if (!fingerprint) {
      // The cert PEM passed the verifier-seam gates above (SAN match
      // already extracted, key pair verified, expiry parsed) but the
      // PEM-strip-and-hash step couldn't compute a fingerprint. This
      // is a parse-divergence the verifiers and the fingerprint helper
      // disagree on — surface as `tls_chain_invalid` so the caller
      // sees a closed-list code rather than a generic throw.
      throw new TlsDomainUploadValidationError([
        { code: 'tls_chain_invalid' },
      ]);
    }
    const issuer = metadataReader ? metadataReader.extractIssuer(args.cert_pem) : '';
    const private_key_encrypted = await encodePrivateKeyForStorage(
      args.private_key_pem,
      canonical,
      getKey,
    );
    insertOrReplaceStmt.run({
      domain: canonical,
      source: args.source,
      cert_pem: args.cert_pem,
      private_key_encrypted,
      chain_pem: args.chain_pem ?? null,
      fingerprint,
      issuer,
      expires_at: validation.expires_at,
      uploaded_at: at,
      // D-235 — BOTH fleet-issued sources stamp this. Keyed on `=== 'pro_acme'`
      // it would leave every custom cert with a NULL `last_renewed_at`, which
      // is the field the Doctor and the UI read to answer "is anything renewing
      // this?" — so an auto-renewed cert would report as never renewed.
      last_renewed_at: isFleetIssuedTlsDomainSource(args.source) ? at : null,
    });
    // Warm the decrypted cache with the plaintext we already have.
    // `lookup` from the public listener's SNICallback is synchronous —
    // having the private key in cache avoids an AEAD round-trip on the
    // very first handshake.
    decryptedCache.set(canonical, args.private_key_pem);
    return {
      fingerprint,
      expires_at: validation.expires_at,
      san: validation.san,
    };
  };

  const lookup = (domain: string): TLSDomainCertChain | null => {
    // Codex W3.6 P2 fold — lowercase at the lookup boundary so
    // mixed-case SNI (`Alice.Example`) hits a row stored as
    // `alice.example`.
    const canonical = canonicalizeDomain(domain);
    const row = getDomainStmt.get({ domain: canonical }) as DomainRow | undefined;
    if (!row) return null;
    let private_key_pem = decryptedCache.get(canonical);
    if (private_key_pem === undefined) {
      // Cache miss — the row's encrypted blob is here, but the public
      // SNICallback contract is sync. We CANNOT await `decrypt` here;
      // a missed cache entry means this row has not been warmed since
      // boot. The boot path warms every row via `warmCache()` (called
      // explicitly from bin.ts). Until that runs the lookup returns
      // null + the listener closes the connection — safer than
      // serving a wrong cert.
      return null;
    }
    if (!isKnownSource(row.source)) return null;
    const out: TLSDomainCertChain = {
      domain: row.domain,
      cert_pem: row.cert_pem,
      private_key_pem,
      fingerprint: row.fingerprint,
      expires_at: row.expires_at,
      source: row.source,
    };
    if (row.chain_pem !== null && row.chain_pem !== undefined) {
      out.chain_pem = row.chain_pem;
    }
    return out;
  };

  const list = (): TLSDomainCertListEntry[] => {
    const rows = listStmt.all() as DomainRow[];
    return rows
      .map(rowToListEntry)
      .filter((e): e is TLSDomainCertListEntry => e !== null);
  };

  // D-148 FU2 — same rows as `list()` plus the public `cert_pem` +
  // `chain_pem` columns. Reads from SQLite; never touches the
  // private-key blob or the in-RAM decrypted cache.
  const listForHealthCheck = (): SqliteTlsDomainHealthCheckRow[] => {
    const rows = listStmt.all() as DomainRow[];
    return rows
      .map((row): SqliteTlsDomainHealthCheckRow | null => {
        const base = rowToListEntry(row);
        if (base === null) return null;
        const out: SqliteTlsDomainHealthCheckRow = {
          ...base,
          cert_pem: row.cert_pem,
        };
        if (row.chain_pem !== null && row.chain_pem !== undefined) {
          out.chain_pem = row.chain_pem;
        }
        return out;
      })
      .filter((e): e is SqliteTlsDomainHealthCheckRow => e !== null);
  };

  const remove = async (domain: string): Promise<void> => {
    // Codex W3.6 P2 fold — canonicalize at the persistence boundary
    // so callers that pass mixed-case domains still hit the right row.
    const canonical = canonicalizeDomain(domain);
    deleteStmt.run({ domain: canonical });
    decryptedCache.delete(canonical);
  };

  const warmCache = async (): Promise<{ warmed: number; locked: boolean }> => {
    const rows = listStmt.all() as DomainRow[];
    let warmed = 0;
    for (const row of rows) {
      if (decryptedCache.has(row.domain)) {
        warmed += 1;
        continue;
      }
      try {
        const pem = await decodePrivateKeyFromStorage(
          row.private_key_encrypted,
          row.domain,
          getKey,
        );
        decryptedCache.set(row.domain, pem);
        warmed += 1;
      } catch (err) {
        if (err instanceof TlsDomainVaultLockedError) {
          // Vault locked — we cannot warm any row's private key. Bail
          // out so the caller (bin.ts) can surface the locked state +
          // the listener can decide whether to bind plaintext or
          // refuse to bind public until vault is unlocked.
          return { warmed, locked: true };
        }
        // Other decode failures (tampered row / corrupted file) leave
        // the entry out of the cache so `lookup` returns null + the
        // listener closes the connection cleanly. The store does not
        // throw — surfacing the row drop is the Reachability Doctor's
        // job in a follow-up slice.
        continue;
      }
    }
    return { warmed, locked: false };
  };

  // The store implements the W3.2 abstract `TLSDomainStore` contract +
  // the W3.6 `warmCache()` production extension + the D-148 FU2
  // `listForHealthCheck()` rollup feeder (see SqliteTlsDomainStore for
  // documentation).
  return {
    upload,
    lookup,
    list,
    remove,
    warmCache,
    listForHealthCheck,
  };
};

/** Typed exception thrown by `upload()` when validation fails. The
 *  W3.6 store + the future tls_domain.upload rpc map this directly to
 *  the closed-list error codes from `NETWORK_ERROR_CODES`
 *  (`tls_san_mismatch` / `tls_key_pair_mismatch` / `tls_chain_invalid`
 *  / `tls_cert_expired_at_upload`). */
export class TlsDomainUploadValidationError extends Error {
  constructor(public readonly issues: ReadonlyArray<TLSDomainUploadIssue>) {
    super(
      `tls-domain-store: upload validation failed (${issues.map((i) => i.code).join(', ')})`,
    );
    this.name = 'TlsDomainUploadValidationError';
  }
}

/** Re-export the contract constant so callers reach for one source of
 *  truth on the warning window. */
export { TLS_CERT_MIN_VALIDITY_MS };
