/** D-148 § A.2.1 — disk-backed `ServerKeyStore`.
 *
 *  P1 shipped the `ServerKeyStore` interface + an in-memory
 *  implementation for tests. P2 lands the production-shape disk store
 *  with two persistence modes:
 *
 *   1. **Plain JSON** (default) — `<filePath>` holds a single JSON
 *      document with `{ version: 1, server_identity?, publisher_identity? }`.
 *      File mode 0600 — owner read/write only. The plaintext bytes
 *      live on disk; physical access to the disk is the trust
 *      boundary. Suitable for self-hosted servers running on
 *      hardware the operator controls.
 *
 *   2. **Passphrase-encrypted** — when `passphrase` is supplied, the
 *      same JSON document AEAD-seals under a passphrase-derived KEK
 *      (Argon2id-based). Suitable for servers running on shared
 *      infrastructure where disk-level access is not the trust
 *      boundary.
 *
 *  The OS-keyring path the spec mentions as a third mode is left for
 *  a follow-up — the platform-keyring surface is OS-specific (macOS
 *  Keychain / Windows Credential Manager / Linux Secret Service)
 *  and pulls in a native-bindings dependency that's outside the P2
 *  substrate scope. The interface is identical, so swapping the
 *  store at boot is a one-line change.
 *
 *  The store reads + writes atomically (write-to-tmp + rename) so
 *  a crash mid-write never leaves the file half-populated.
 *
 *  Forge-rejection: `saveServerIdentityKey` and
 *  `savePublisherIdentityKey` reject mismatched key_class at the
 *  store boundary (I-7 storage discipline). The on-disk JSON also
 *  carries the `key_class` field so a tampered file that swaps
 *  classes is caught at load time.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  bytesToBase64,
  base64ToBytes,
  encrypt as aeadEncrypt,
  decrypt as aeadDecrypt,
  encodeCiphertext,
  decodeCiphertext,
  randomBytes,
  deriveKEKFromPassword,
  deriveKEKFromServerKey,
  SALT_LEN,
} from '@recued/crypto';
import { writeFileAtomicSync } from '../durable-fs.js';
import {
  describeMachineSecretCapability,
  machineSecretProvider,
  realmIdForKeyfile,
  type MachineSecretProvider,
  type MachineSecretProviderId,
} from './machine-secret.js';
import {
  type Ed25519Keypair,
  type ServerKeyStore,
  type StoredAccountBinding,
} from './index.js';

/** On-disk JSON shape. `encrypted: true` means the `payload` field
 *  is an AEAD-sealed base64 string; otherwise the payload contains
 *  the cleartext keypairs directly. */
interface KeyFileVersionedDoc {
  version: 1;
  encrypted: boolean;
  /** When `encrypted: true`, salt for the passphrase KEK derivation
   *  (base64). Different per file so the same passphrase across
   *  servers produces different KEKs. */
  kdf_salt_b64?: string;
  /** When `encrypted: true`, Argon2id parameters used. Persisted so
   *  verify-side params match. */
  kdf_params?: { t: number; m: number; p: number };
  /** When `encrypted: true`, base64 of `iv || ct` (per
   *  `encodeCiphertext`). When `encrypted: false`, base64 of the
   *  inner JSON document so unsigned files still roundtrip via the
   *  same loader. */
  payload: string;
  /** D-212 slice 5 — WHICH machine-secret provider sealed this file.
   *
   *  Absent means the operator's passphrase sealed it (or, with
   *  `encrypted: false`, that nothing did). Present means the secret lives in
   *  a platform store, and only that same provider can produce it again.
   *
   *  ⛔ This is what makes the ladder safe. A provider is chosen once, at
   *  enrollment; every later open uses exactly the one recorded here and fails
   *  loudly when it is unavailable. Re-running the ladder at open time would
   *  silently treat a sealed realm as unsealed. */
  sealed_by?: MachineSecretProviderId;
  /** When `sealed_by` is set, the HKDF salt for the machine secret (base64).
   *  Separate from `kdf_salt_b64` because the derivation differs: a
   *  provider-generated secret is high-entropy and takes HKDF, where a
   *  human passphrase takes Argon2id. */
  machine_salt_b64?: string;
}

/** Cleartext inner shape — what the encrypted payload decrypts to. */
interface KeyFileInnerPayload {
  server_identity?: SerializedKeypair;
  publisher_identity?: SerializedKeypair;
  /** D-175 P5 — the recued.com account binding (server-scoped
   *  credential + metadata). Rides the same doc as the signing keys so
   *  it inherits the file's at-rest protection (plaintext under disk-
   *  access trust, or AEAD-sealed under the passphrase). */
  account_binding?: StoredAccountBinding;
  /** Server vault key (base64 of 32 random bytes) — the keyfile-side
   *  factor that auto-unlocks the Master DEK at boot. SECRET; rides the
   *  same at-rest protection as the signing keys. Absent until first-boot
   *  encryption enrollment writes it. Kept in THIS file (not the db) on
   *  purpose: a db-only backup then cannot unwrap the Master DEK. */
  server_vault_key_b64?: string;
}

interface SerializedKeypair {
  key_class: Ed25519Keypair['key_class'];
  private_key_b64: string;
  public_key_b64: string;
  public_key_fingerprint: string;
  created_at: number;
}

const FILE_VERSION = 1 as const;

/** Argon2id parameters for KEK derivation. Tighter than the user-
 *  password defaults because we expect operators to set a strong
 *  passphrase + the file rests on disk where disk-level access is
 *  the threat. 64 MiB / 3 iter / 4 lanes — OWASP 2024 baseline. */
const KEK_ARGON2_PARAMS = Object.freeze({
  t: 3,
  m: 65_536,
  p: 4,
});

const toSerialized = (kp: Ed25519Keypair): SerializedKeypair => ({
  key_class: kp.key_class,
  private_key_b64: kp.private_key_b64,
  public_key_b64: kp.public_key_b64,
  public_key_fingerprint: kp.public_key_fingerprint,
  created_at: kp.created_at,
});

const fromSerialized = (s: SerializedKeypair): Ed25519Keypair => ({
  key_class: s.key_class,
  private_key_b64: s.private_key_b64,
  public_key_b64: s.public_key_b64,
  public_key_fingerprint: s.public_key_fingerprint,
  created_at: s.created_at,
});

const isSerializedKeypair = (
  v: unknown,
  expected_class: Ed25519Keypair['key_class'],
): v is SerializedKeypair => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    r.key_class === expected_class &&
    typeof r.private_key_b64 === 'string' &&
    typeof r.public_key_b64 === 'string' &&
    typeof r.public_key_fingerprint === 'string' &&
    typeof r.created_at === 'number'
  );
};

/** D-175 P5 — minimal shape guard for a persisted account binding.
 *  Returns null on a malformed / partial record rather than throwing:
 *  unlike the signing keypairs (whose tamper guards throw to surface a
 *  swapped key_class), a corrupt binding degrades to "unbound" — the
 *  server is simply re-bindable, and a half-written record must not
 *  brick boot. */
const asStoredAccountBinding = (v: unknown): StoredAccountBinding | null => {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.account_id !== 'string' ||
    typeof r.server_scoped_credential !== 'string' ||
    typeof r.server_fingerprint !== 'string' ||
    typeof r.bound_at !== 'number' ||
    typeof r.credential_issued_at !== 'number'
  ) {
    return null;
  }
  return r as unknown as StoredAccountBinding;
};

// The keyfile publishes through the shared atomic writer. It used to carry its
// own copy, which called `writeSync` once and ignored the byte count it
// returned — a partial write silently truncated the file holding the server
// vault key. See `durable-fs.ts` for why each step of the pattern is there.
const writeAtomic = (path: string, body: string | Buffer): void => {
  writeFileAtomicSync(path, body);
};

const digestOf = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A keyfile that was read, alongside the identity of the exact bytes read.
 *
 *  ⛔ The digest comes from the SAME read that produced `doc`, never a second
 *  one. A digest taken by re-opening the file would be a claim about content
 *  this process never decoded — the same check-then-act one layer down, and the
 *  guard built on it would authorise overwriting a file it had not judged. */
interface LoadedKeyFile {
  doc: KeyFileVersionedDoc;
  digest: string;
}

/** How a document says it is sealed, in the operator's words. Reads an
 *  unvalidated object on purpose: it is also used to describe a file this
 *  process did not write and may not be able to parse. */
const describeSealing = (doc: unknown): string => {
  if (!doc || typeof doc !== 'object') return 'unreadable';
  const d = doc as KeyFileVersionedDoc;
  if (typeof d.sealed_by === 'string') return `sealed by '${d.sealed_by}'`;
  return d.encrypted ? 'sealed by a passphrase' : 'unsealed';
};

/** Raised when the file about to be overwritten was READ and is not the one
 *  this store opened.
 *
 *  ⛔ Narrower than "the guard refused". A path that cannot be read at all — a
 *  directory standing where the keyfile goes, a permissions fault — is an IO
 *  condition that CAN clear, and `flush()` is entitled to ask again; a
 *  replacement never clears, because the file on disk will not match this
 *  store's claim again for as long as it lives. The type is what carries that
 *  difference, so both branches refuse the write but only one is terminal. */
export class KeyfileReplacedError extends Error {
  readonly code = 'D212_KEYFILE_REPLACED';
  constructor(message: string) {
    super(message);
    this.name = 'KeyfileReplacedError';
  }
}

const readDoc = (path: string): LoadedKeyFile | null => {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`createFileServerKeyStore: ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`createFileServerKeyStore: ${path} is not a JSON object`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.version !== FILE_VERSION) {
    throw new Error(
      `createFileServerKeyStore: ${path} has unsupported version ${String(r.version)} (expected ${FILE_VERSION})`,
    );
  }
  if (typeof r.encrypted !== 'boolean' || typeof r.payload !== 'string') {
    throw new Error(`createFileServerKeyStore: ${path} is malformed`);
  }
  return { doc: parsed as KeyFileVersionedDoc, digest: digestOf(bytes) };
};

const decodeInner = async (
  doc: KeyFileVersionedDoc,
  passphrase: string | undefined,
  keyfilePath: string,
): Promise<KeyFileInnerPayload> => {
  if (doc.encrypted && doc.sealed_by) {
    // Sealed by a platform store. Use exactly the recorded provider — never
    // re-run the selection ladder, which would answer for a different store
    // and read as "unsealed" rather than "cannot open".
    const provider = machineSecretProvider(doc.sealed_by);
    if (!provider) {
      throw new Error(
        `createFileServerKeyStore: ${keyfilePath} was sealed by '${doc.sealed_by}', which this build does not support. Re-pair with your recovery key to re-seal it.`,
      );
    }
    const secret = await provider.fetch({
      keyfilePath,
      realmId: realmIdForKeyfile(keyfilePath),
    });
    if (!secret) {
      throw new Error(
        `createFileServerKeyStore: ${keyfilePath} was sealed by '${doc.sealed_by}', which cannot produce its secret right now (locked, or the entry is gone). Unlock it, or re-pair with your recovery key to re-seal the keyfile.`
        // Someone hitting this in recovery will reach for the env var. Say
        // plainly that it cannot help, or they will conclude the passphrase
        // itself is wrong and go looking in the wrong place.
        + (passphrase
          ? ` A passphrase cannot open a machine-sealed keyfile — RECUED_IDENTITY_PASSPHRASE is set but does not apply here.`
          : ''),
      );
    }
    if (!doc.machine_salt_b64) {
      throw new Error(`createFileServerKeyStore: ${keyfilePath} is missing its machine salt`);
    }
    try {
      const kek = deriveKEKFromServerKey(secret, base64ToBytes(doc.machine_salt_b64));
      const plaintext = await aeadDecrypt(kek, decodeCiphertext(doc.payload));
      return JSON.parse(new TextDecoder().decode(plaintext)) as KeyFileInnerPayload;
    } catch {
      throw new Error(
        `createFileServerKeyStore: ${keyfilePath} did not open with the secret from '${doc.sealed_by}' (tampered file, or the store returned a different entry).`,
      );
    } finally {
      secret.fill(0);
    }
  }
  if (doc.encrypted) {
    if (!passphrase) {
      // The whole boot output of a server that cannot open its keyfile, so it
      // says what to DO. It used to say only "file is encrypted but no
      // passphrase supplied" — while the installer told owners such a server
      // starts LOCKED and waits for `recued unlock`. It does not: it exits
      // here, and nothing can unlock a server that is not running.
      throw new Error(
        `createFileServerKeyStore: ${keyfilePath} is sealed with a passphrase, and RECUED_IDENTITY_PASSPHRASE is not set. `
        + 'Start with that variable set to the passphrase, or with RECUED_IDENTITY_PASSPHRASE_FILE naming a '
        + 'file that holds it (a container secret). A service started at boot or login needs it in '
        + "the service's own environment (a systemd EnvironmentFile, a launchd EnvironmentVariables entry); "
        + "it does not see your shell's.",
      );
    }
    if (!doc.kdf_salt_b64 || !doc.kdf_params) {
      throw new Error('createFileServerKeyStore: encrypted file missing kdf fields');
    }
    const salt = base64ToBytes(doc.kdf_salt_b64);
    const kek = await deriveKEKFromPassword(passphrase, salt, doc.kdf_params);
    let plaintext: Uint8Array;
    try {
      plaintext = await aeadDecrypt(kek, decodeCiphertext(doc.payload));
    } catch {
      throw new Error('createFileServerKeyStore: decryption failed (wrong passphrase or tampered file)');
    }
    return JSON.parse(new TextDecoder().decode(plaintext)) as KeyFileInnerPayload;
  }
  // A plaintext file opened WITH a passphrase used to throw here. D-212 §7.10
  // makes that combination the sealing upgrade — the operator is doing exactly
  // what the unsealed-keyfile warning tells them to — so decoding is correct and
  // the policy question ("may this file still change how it is sealed?") belongs
  // at the caller, which can see whether the payload is load-bearing yet.
  return JSON.parse(
    new TextDecoder().decode(base64ToBytes(doc.payload)),
  ) as KeyFileInnerPayload;
};

const encodeInner = async (
  inner: KeyFileInnerPayload,
  passphrase: string | undefined,
  params: { t: number; m: number; p: number },
  sealer: { provider: MachineSecretProvider; secret: Uint8Array } | undefined,
): Promise<KeyFileVersionedDoc> => {
  const innerJson = JSON.stringify(inner);
  if (sealer) {
    // HKDF, not Argon2id: the secret is 32 bytes of CSPRNG from a platform
    // store, not a human's guessable string, so key-stretching buys nothing
    // and would cost a memory-hard derivation on every write.
    const salt = randomBytes(SALT_LEN);
    const kek = deriveKEKFromServerKey(sealer.secret, salt);
    const ct = await aeadEncrypt(kek, new TextEncoder().encode(innerJson));
    return {
      version: FILE_VERSION,
      encrypted: true,
      sealed_by: sealer.provider.id,
      machine_salt_b64: bytesToBase64(salt),
      payload: encodeCiphertext(ct),
    };
  }
  if (passphrase) {
    const salt = randomBytes(SALT_LEN);
    const kek = await deriveKEKFromPassword(passphrase, salt, params);
    const ct = await aeadEncrypt(kek, new TextEncoder().encode(innerJson));
    return {
      version: FILE_VERSION,
      encrypted: true,
      kdf_salt_b64: bytesToBase64(salt),
      kdf_params: { ...params },
      payload: encodeCiphertext(ct),
    };
  }
  return {
    version: FILE_VERSION,
    encrypted: false,
    payload: bytesToBase64(new TextEncoder().encode(innerJson)),
  };
};

/** D-212 — re-seal an existing keyfile under a DIFFERENT passphrase, keeping
 *  everything inside it byte-for-byte.
 *
 *  The passphrase wraps the FILE; the realm's bundle is wrapped to the server
 *  KEY that lives inside it (`wrapped_server`). So re-encoding the payload
 *  under a new passphrase changes only how that key is stored: same server
 *  key, same Master DEK, same database, same `server_identity` /
 *  `publisher_identity` / account binding. Nothing re-pairs.
 *
 *  ⛔ Re-encodes the DECODED PAYLOAD, never a field-by-field copy. Reading the
 *  four known accessors and writing them into a fresh store would silently
 *  drop any inner field this function does not know about — and the payload
 *  has grown three times already. Whole-payload is the only version of this
 *  that stays correct when it grows again.
 *
 *  ⚠ Says nothing about WHO may do this and does not verify the result — the
 *  caller owns the running-server guard, the realm check and the reopen. This
 *  is the primitive, deliberately narrow. */
export const resealKeyfileWithPassphrase = async (args: {
  filePath: string;
  currentPassphrase: string;
  newPassphrase: string;
  /** Argon2id cost for the NEW wrap. Tests pass weaker params — two
   *  OWASP-cost derivations run ~5s, the default test timeout. */
  argon2_params?: { t: number; m: number; p: number };
}): Promise<void> => {
  const loaded = readDoc(args.filePath);
  if (!loaded) {
    throw new Error(`resealKeyfileWithPassphrase: no keyfile at ${args.filePath}`);
  }
  // Throws on the wrong passphrase (AEAD tag), which is what the caller
  // reports as `current_passphrase_wrong`.
  const inner = await decodeInner(loaded.doc, args.currentPassphrase, args.filePath);
  const next = await encodeInner(
    inner,
    args.newPassphrase,
    args.argon2_params ?? KEK_ARGON2_PARAMS,
    // No sealer: this rotates a passphrase-sealed file to another passphrase.
    // Changing the FACTOR CLASS is §7.11's regeneration, not this.
    undefined,
  );
  writeAtomic(args.filePath, JSON.stringify(next));
};

export interface CreateFileServerKeyStoreOptions {
  /** Absolute path to the keys file. The directory is created with
   *  `mkdir -p` when missing. */
  filePath: string;
  /** Optional passphrase. When supplied, the on-disk payload is
   *  AEAD-sealed under an Argon2id-derived KEK. When omitted, the
   *  file holds cleartext keypair bytes; physical disk access is
   *  the trust boundary. */
  passphrase?: string;
  /** D-212 slice 5 — may this store seal a NEW keyfile against a platform
   *  secret store when no passphrase is set?
   *
   *  ⛔ Opt-in, and deliberately so. Provisioning writes to shared machine
   *  state — the operator's OS keychain — which is not a side effect a
   *  constructor should take on someone's behalf. Defaulting it on had test
   *  suites quietly depositing entries in the developer's own login keychain,
   *  one per temp realm, never cleaned up.
   *
   *  Production turns it on at the composition root, where choosing to bind a
   *  realm to this machine is a decision someone made. Library and test callers
   *  get plaintext-or-passphrase, unchanged.
   *
   *  Only ever consulted for a keyfile that does not exist yet: an existing one
   *  keeps whatever sealed it, recorded in its own header. */
  machineSealing?: boolean;
  /** Where a NEW keyfile would be stored unsealed (no passphrase, no platform
   *  store), throw this message instead of warning and writing it. The server
   *  sets it inside a container, where nothing can seal the file but a
   *  passphrase. Consulted only with `machineSealing`, at the same first-boot
   *  decision; an existing keyfile is never refused by it. */
  refuseUnsealed?: string;
  /** Override Argon2id parameters for KEK derivation. Tests pass
   *  weaker params for speed; production callers should leave this
   *  unset to use `KEK_ARGON2_PARAMS` (OWASP 2024 baseline). The
   *  parameters used at write time persist in the file so the
   *  read-side picks them up automatically; cost can evolve over
   *  time without breaking older files. */
  argon2_params?: { t: number; m: number; p: number };
  /** Where a failed background write is reported. Saves are fire-and-forget,
   *  so a persist failure is otherwise invisible until someone calls `flush()`
   *  — and the account-binding saves never do. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/** Build a disk-backed `ServerKeyStore`. Synchronous load on
 *  construction so callers see whatever's already persisted; async
 *  Argon2id derivation only fires on saves under encrypted mode.
 *
 *  Construction throws if the on-disk file is corrupt or fails
 *  decrypt — the caller is expected to surface that to the operator
 *  rather than overwrite.
 *
 *  Concurrency is single-process: this store is not safe for
 *  multiple processes writing the same file simultaneously. The
 *  server runs as one process; the key-rotation flow is single-
 *  threaded by construction. */
export const createFileServerKeyStore = async (
  options: CreateFileServerKeyStoreOptions,
): Promise<ServerKeyStore> => {
  const { filePath, passphrase, warn = (message: string) => console.warn(message) } = options;
  // Read-side Argon2 params come from the on-disk doc when present
  // (verify-side correctness). Write-side falls back to caller
  // override or KEK_ARGON2_PARAMS for fresh files.
  const writeParams = options.argon2_params ?? KEK_ARGON2_PARAMS;
  let cache: KeyFileInnerPayload = {};

  const initialLoad = readDoc(filePath);
  const initialDoc = initialLoad?.doc ?? null;
  if (initialDoc) {
    cache = await decodeInner(initialDoc, passphrase, filePath);
  }

  /** What this store is entitled to overwrite: the digest of the bytes it
   *  opened, or null when it opened nothing. Advances only on a write that
   *  landed — a failed publish leaves the claim on the file still there. */
  let ownedDigest: string | null = initialLoad?.digest ?? null;
  let ownedSealing = initialDoc ? describeSealing(initialDoc) : 'absent';

  /** D-212 §7.10 — a passphrase may seal a keyfile that is still plaintext, but
   *  ONLY while that file is not yet load-bearing.
   *
   *  The unsealed-keyfile warning tells the operator to set
   *  RECUED_IDENTITY_PASSPHRASE, and until this existed doing so threw
   *  (`file is unencrypted but a passphrase was supplied`) and the server did
   *  not boot — the prescribed remedy bricked it. First boot flushes the
   *  keyfile before pairing exists, so by the time anyone reads that warning
   *  there is always a plaintext file on disk.
   *
   *  The boundary is the server vault key. Without one the file holds signing
   *  keys and an optional account binding: re-sealing it costs nothing and the
   *  operator is choosing at the moment §7.10 says the choice is theirs. WITH
   *  one it opens the warehouse, sealing is fixed for the realm's life, and a
   *  passphrase that appears in the environment for one accidental run must not
   *  silently re-seal a live realm — removing it again would then lock the
   *  operator out. That transition is §7.11's, deliberately taken. */
  const upgradeToPassphrase = !!initialDoc && !initialDoc.encrypted && !!passphrase;
  if (upgradeToPassphrase && cache.server_vault_key_b64) {
    throw new Error(
      `createFileServerKeyStore: ${filePath} is unsealed but already holds this realm's server vault key, `
      + 'so a passphrase cannot be applied to it now — sealing is fixed once a realm is encrypted. '
      + 'Re-create the keyfile from your 24-word recovery key to change it, or start without the '
      + 'passphrase to keep this realm as it is.',
    );
  }

  // How this file is sealed is decided ONCE and then honoured forever.
  //
  //  - An existing file keeps whatever sealed it. Re-selecting on every open
  //    would re-seal a keychain-backed file under a passphrase the moment the
  //    keychain happened to be locked, which is the silent downgrade the whole
  //    recorded-provider design exists to prevent.
  //  - A new file takes the operator's passphrase when they set one — an
  //    explicit choice outranks anything we pick for them — and otherwise the
  //    strongest platform store that will still be able to answer next start.
  //  - Neither ⇒ unsealed, and the caller says so out loud.
  let sealer: { provider: MachineSecretProvider; secret: Uint8Array } | undefined;
  if (initialDoc?.sealed_by && passphrase) {
    // Opening never changes how a file is sealed, so the passphrase does
    // nothing here. Harmless — the keyfile still opens through its recorded
    // provider — but silence would leave the operator believing they had
    // switched, which is a belief about where their keys' safety comes from.
    warn(
      `[keys] ${filePath} is sealed by '${initialDoc.sealed_by}'; RECUED_IDENTITY_PASSPHRASE is set but ignored. `
      + 'Sealing is chosen once, at enrollment. To switch, re-pair with your recovery key.',
    );
  }
  if (initialDoc?.sealed_by) {
    const provider = machineSecretProvider(initialDoc.sealed_by);
    const secret = provider
      ? await provider.fetch({ keyfilePath: filePath, realmId: realmIdForKeyfile(filePath) })
      : null;
    // `decodeInner` already threw if this file could not be opened, so reaching
    // here with a live provider means the secret is available.
    if (provider && secret) sealer = { provider, secret };
  } else if (!initialDoc && options.machineSealing) {
    // ⛔ D-212 §7.10 — THE CAPABILITY REPORT, and it runs whether or not a
    // passphrase is set, because it is the only moment the operator can act on
    // it: sealing is chosen at first boot and permanent for the realm's life.
    //
    // Reporting what this host CAN do is what turns the ladder from something
    // done TO the operator into something they choose. Without it the Mac-mini
    // owner who set a passphrase once from a tutorial silently loses their
    // keychain forever, and the VPS owner never learns their host can seal
    // nothing at all. ⚠ `describeMachineSecretCapability` probes only — it must
    // never provision, or asking the question would itself take the decision.
    const ctx = { keyfilePath: filePath, realmId: realmIdForKeyfile(filePath) };
    // ⛔ ONE walk feeds both the report and the decision.
    //
    // The first cut probed twice — `describeMachineSecretCapability` for the
    // report, `selectMachineSecretProvider` for the choice — on the reasoning
    // that a report must not become the decision. That was wrong twice over. It
    // let the two DISAGREE (caught by a test printing `can seal with: nothing`
    // directly above `sealing with 'os-keyring'`), and a report that
    // contradicts the decision is worse than no report at all. It also probed
    // every rung twice per first boot — a real DPAPI round-trip and a
    // `secret-tool` spawn each time — with a window between the walks in which
    // a store could change state.
    //
    // The safety property was never about which walk decides; it is that
    // REPORTING MUST NOT PROVISION. `describeMachineSecretCapability` calls
    // only `isAvailable`, and `provision` is reached below, once, deliberately.
    const capable = await describeMachineSecretCapability(ctx);

    if (!passphrase) {
      const winner = capable[0];
      const provider = winner ? machineSecretProvider(winner) : undefined;
      if (provider) sealer = { provider, secret: await provider.provision(ctx) };
    }

    warn(
      `[keys] this machine can seal the keyfile with: ${capable.length ? capable.join(', ') : 'nothing'}`,
    );
    if (sealer) {
      warn(`[keys] no RECUED_IDENTITY_PASSPHRASE set — sealing with '${sealer.provider.id}'`);
    } else if (passphrase) {
      // ⚠ The precedence cost, said out loud. A passphrase outranks every
      // machine rung because stated intent beats anything selected for someone
      // — but on a host that HAS a keyring this can lower real protection: the
      // keyring secret lives outside the data directory and an env var in a
      // compose file or plist beside it does not. The choice stays theirs; the
      // silence is what we are fixing.
      warn(
        '[keys] a passphrase is set (RECUED_IDENTITY_PASSPHRASE or RECUED_IDENTITY_PASSPHRASE_FILE) — '
        + 'sealing with the passphrase'
        + (capable.length
          ? `, which outranks ${capable.join(', ')}. ⚠ A passphrase stored beside the data directory is `
            + 'weaker than a platform store, which keeps its secret outside it. Unset it to use the platform store instead.'
          : '.'),
      );
    } else if (options.refuseUnsealed !== undefined) {
      // Before anything is written: the decision is made here and the keys are
      // minted only after this store exists, so refusing leaves no file behind.
      throw new Error(options.refuseUnsealed);
    } else {
      warn(
        `[keys] ${filePath} will be stored UNSEALED — no platform secret store is available here. `
        + 'Anyone who copies this directory gets the keys to the realm along with it. '
        + 'Set RECUED_IDENTITY_PASSPHRASE, or RECUED_IDENTITY_PASSPHRASE_FILE, to seal it.',
      );
    }
    warn(
      '[keys] this choice is PERMANENT for this realm. To change it before pairing, stop the server, '
      + `delete ${filePath}, set or unset the passphrase, and start again. After pairing, use 'recued recover-keyfile'.`,
    );
  }

  // ⛔ The same refusal for a caller that skips the machine-sealing decision —
  // `recover-keyfile`, an offline archive restore — but still writes a NEW file
  // with nothing to seal it. Construction, before anything is persisted.
  if (!initialDoc && !passphrase && !sealer && options.refuseUnsealed !== undefined) {
    throw new Error(options.refuseUnsealed);
  }

  const posture = (): import('./index.js').KeyfileSealingPosture => {
    if (sealer) return 'machine';
    if (passphrase) return 'passphrase';
    return 'none';
  };

  /** ⛔ Re-derive, at the act site, that this file is still ours to overwrite.
   *
   *  `rotateKeyfilePassphrase` refuses while a server is RUNNING, but a server
   *  that STARTS during a rotation honours nothing: it opens the pre-rotation
   *  file with the old passphrase from its environment, and the next ordinary
   *  `persist()` — an account-binding save, a publisher-identity write —
   *  re-encodes the WHOLE document under that old passphrase and silently undoes
   *  a rotation that already reported success. The operator then finds their new
   *  passphrase failing at some unpredictable later boot.
   *
   *  The check belongs here rather than at boot, for two reasons. Boot must
   *  never fail because a lock file exists — that would turn a stale reservation
   *  into a boot outage, the exact "worse than no lock" property
   *  `directory-reservation.ts` is built to avoid — so honouring the reservation
   *  there needs a wait-then-proceed policy nothing else in the codebase has.
   *  And this is the function that actually clobbers, so guarding it catches the
   *  same overwrite from ANY other writer, not only the rotation command.
   *
   *  Whole-file digest rather than a header nonce: the header is outside the
   *  AEAD and unauthenticated, content is strictly stronger identity than a
   *  field a careless writer could carry forward unchanged, and it needs no
   *  schema change — so every keyfile already on disk is covered.
   *
   *  ⚠ DETECTION, not exclusion. Refusing leaves the in-memory change unsaved
   *  and says so; it does not serialize the two writers. Deliberate: taking the
   *  directory reservation on every persist would let a stale lock file block a
   *  running server's writes, which is the trade this file already refuses. */
  const guardStillOurs = (): void => {
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Cannot tell. Fail closed — "unreadable" must never be read as
        // "unchanged", and the write below is about to fail anyway. A plain
        // Error, not `KeyfileReplacedError`: this is an IO condition that can
        // clear, so `flush()` should still be allowed to ask again.
        throw new Error(
          `cannot read ${filePath} to confirm it is still the file this process opened, `
          + `so it was not overwritten: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const current = bytes === null ? null : digestOf(bytes);
    if (current === ownedDigest) return;

    // A deletion and a replacement both mean "not ours", and both are refused,
    // but they send the operator to different places — so say which one it is
    // rather than describing every case as a re-seal.
    if (bytes === null) {
      throw new KeyfileReplacedError(
        `createFileServerKeyStore: refusing to re-create ${filePath} — it was ${ownedSealing} when `
        + 'this process opened it and is gone now. Writing would resurrect the identity that file '
        + 'held, which is the opposite of what deleting it asks for, so nothing was written. Stop '
        + 'whatever holds this keyfile (normally the server) and start it again.',
      );
    }
    // ⛔ Describe the SAME bytes that produced the verdict. A second read here
    // would let the message contradict the refusal it explains.
    let nowSealing: string;
    try {
      nowSealing = describeSealing(JSON.parse(bytes.toString('utf8')));
    } catch {
      nowSealing = 'unreadable';
    }
    throw new KeyfileReplacedError(
      `createFileServerKeyStore: refusing to write ${filePath} — it changed on disk since this `
      + `process opened it (${ownedSealing} then, ${nowSealing} now). Another process re-created or `
      + 're-sealed it: a passphrase rotation, or a recovery-key regeneration. Overwriting would undo '
      + 'that and restore the credential this process is holding, so nothing was written. Restart '
      + 'whatever holds this keyfile (normally the server) with the new credential; anything it '
      + 'saved since it started must be redone.',
    );
  };

  const persist = async (): Promise<void> => {
    const doc = await encodeInner(cache, passphrase, writeParams, sealer);
    const body = Buffer.from(JSON.stringify(doc), 'utf8');
    // ⛔ Nothing may await between the check and the write. Both are synchronous
    // and adjacent on purpose, so no other code IN THIS PROCESS can interleave;
    // across processes the window is one atomic rename, which is the floor
    // without an OS-level lock.
    guardStillOurs();
    writeAtomic(filePath, body);
    ownedDigest = digestOf(body);
    ownedSealing = describeSealing(doc);
  };

  // Land the §7.10 upgrade before returning. Awaited rather than scheduled:
  // callers are entitled to assume that a store reporting `passphrase` has a
  // sealed file behind it, and the fire-and-forget chain below cannot promise
  // that. `encodeInner` takes the passphrase branch here because `sealer` is
  // undefined — an unsealed file has no recorded provider to preserve.
  if (upgradeToPassphrase) {
    await persist();
    warn(
      `[keys] ${filePath} was unsealed and is now sealed with RECUED_IDENTITY_PASSPHRASE. `
      + 'Every future start of this server needs that same passphrase.',
    );
  }

  // Saves are sync at the interface boundary (matches in-memory
  // store) but the async persist() is fire-and-forget by design —
  // the on-disk file will be flushed before the next save anyway,
  // and the in-memory cache is the source of truth for in-flight
  // signing. When encryption is enabled, callers that need a strict
  // "key is on disk before I return" guarantee should call
  // `flushFileServerKeyStore` after save (exposed below).
  //
  // Writes are serialized so they land in the order the saves happened and the
  // last one wins, but a failure is caught here rather than left on the chain.
  // Two things go wrong if it stays: a rejected promise short-circuits every
  // `.then` after it, so ONE failed write would mean the keyfile is never
  // written again for the life of the process while the cache keeps moving; and
  // because saves are fire-and-forget the rejection reaches the process-level
  // `unhandledRejection` handler, which exits 1 — a momentarily full disk
  // during an identity rotation would take the server down with it.
  //
  // What survives a failure is `persistFailure`, for `flush()` to act on.
  // persist() writes the WHOLE document, so any later write that lands makes
  // the file current again and clears it.
  let pendingPersist: Promise<void> = Promise.resolve();
  let persistFailure: unknown = null;
  const runPersist = async (): Promise<void> => {
    try {
      await persist();
      persistFailure = null;
    } catch (err) {
      persistFailure = err;
      // A refusal already names the file and says what to do about it; wrapping
      // it in "failed to write" would bury the one line the operator needs.
      warn(
        err instanceof KeyfileReplacedError
          ? err.message
          : `createFileServerKeyStore: failed to write ${filePath}: `
            + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const schedulePersist = (): void => {
    pendingPersist = pendingPersist.then(runPersist);
  };

  const store: ServerKeyStore = {
    sealingPosture: posture,
    loadServerIdentityKey: () => {
      const s = cache.server_identity;
      if (!s) return null;
      if (!isSerializedKeypair(s, 'server_identity_key')) {
        throw new Error(
          `createFileServerKeyStore: ${filePath} server_identity has wrong key_class — file may be tampered`,
        );
      }
      return fromSerialized(s);
    },

    saveServerIdentityKey: (k) => {
      if (k.key_class !== 'server_identity_key') {
        throw new Error(
          `ServerKeyStore: refusing to save key_class '${k.key_class}' as server_identity_key`,
        );
      }
      cache = { ...cache, server_identity: toSerialized(k) };
      schedulePersist();
    },

    loadPublisherIdentityKey: () => {
      const s = cache.publisher_identity;
      if (!s) return null;
      if (!isSerializedKeypair(s, 'publisher_identity_key')) {
        throw new Error(
          `createFileServerKeyStore: ${filePath} publisher_identity has wrong key_class — file may be tampered`,
        );
      }
      return fromSerialized(s);
    },

    savePublisherIdentityKey: (k) => {
      if (k.key_class !== 'publisher_identity_key') {
        throw new Error(
          `ServerKeyStore: refusing to save key_class '${k.key_class}' as publisher_identity_key`,
        );
      }
      cache = { ...cache, publisher_identity: toSerialized(k) };
      schedulePersist();
    },

    loadAccountBinding: () => asStoredAccountBinding(cache.account_binding),

    saveAccountBinding: (b) => {
      cache = { ...cache, account_binding: b };
      schedulePersist();
    },

    clearAccountBinding: () => {
      // Drop the key entirely (rather than persist `undefined`) so the
      // on-disk doc reads clean as "unbound".
      const { account_binding: _dropped, ...rest } = cache;
      cache = rest;
      schedulePersist();
    },

    loadServerVaultKey: () => {
      const b = cache.server_vault_key_b64;
      return b ? base64ToBytes(b) : null;
    },

    saveServerVaultKey: (k) => {
      cache = { ...cache, server_vault_key_b64: bytesToBase64(k) };
      schedulePersist();
    },

    /** Codex P2 #4 fold — disk-fence helper for rotation paths.
     *  Awaits any pending persist scheduled by prior save* calls
     *  before returning. Identity rotation MUST await this before
     *  notifying clients (`pair.required` broadcast) so a crash
     *  between save + broadcast cannot leave clients chasing a key
     *  that's not on disk.
     *
     *  Rejects when the cache did not reach disk. A failed write is retried
     *  here rather than reported from memory: the caller is asking about the
     *  file as it stands now, and an attempt that failed earlier may since
     *  have been superseded, or its cause (a disk that was briefly full) may
     *  have cleared. Retrying is cheap and idempotent — persist() writes the
     *  whole document — and it means the answer is never an old error kept
     *  alive past the condition that produced it. */
    flush: async () => {
      await pendingPersist;
      if (persistFailure === null) return;
      // ⛔ A replacement is terminal for this store — the file on disk will not
      // match its claim again — so retrying is a guaranteed-futile Argon2id
      // derivation and a second identical warning. Only a condition that can
      // actually clear earns the retry below.
      if (persistFailure instanceof KeyfileReplacedError) throw persistFailure;
      schedulePersist();
      await pendingPersist;
      if (persistFailure !== null) throw persistFailure;
    },
  };

  return store;
};

/** Test/production helper: await any pending persists fired by save
 *  calls. Exposed because the synchronous interface schedules
 *  encrypted writes on a background promise chain. Equivalent to
 *  calling `store.flush?.()`. */
export const flushFileServerKeyStore = async (
  store: ServerKeyStore,
): Promise<void> => {
  if (store.flush) await store.flush();
};
