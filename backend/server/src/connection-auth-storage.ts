/** Shared connection credential codec for enrollment, renewal and app rotation. */
import { RpcError, type ConnectionAuth, type ConnectionKind } from '@recued/contracts';
import { encrypt, decrypt, encodeCiphertext, decodeCiphertext, bytesToBase64, base64ToBytes } from '@recued/crypto';

/** AAD binding domain — separates connection-row ciphertext from
 *  every other AEAD blob on the server, AND ties each ciphertext to
 *  its (kind, name) row so an attacker who reorders rows in the SQLite
 *  file cannot move an `auth_ciphertext` between rows. The label
 *  doubles as a versioned sentinel — bumping `v1` lets a future format
 *  re-encode in place without confusion. */
const aadFor = (identity: { kind: ConnectionKind; name: string }): Uint8Array =>
  new TextEncoder().encode(`recued/v1/connection/${identity.kind}/${identity.name}`);

const requireConnectionKey = (
  getEncryptionKey: () => Uint8Array | null,
): Uint8Array => {
  const key = getEncryptionKey();
  if (!key) {
    throw new RpcError(
      'locked',
      'connection: server FileVault is locked, cannot encrypt or decrypt auth',
    );
  }
  return key;
};

/** Encode a `ConnectionAuth` for at-rest storage. AEAD-encrypts under
 *  the connection sub-DEK with AAD = `recued/v1/connection/${kind}/${name}`
 *  when a keyProvider is wired through. Falls back to the P2.1
 *  base64-JSON placeholder when none is supplied — covers dbless
 *  harnesses + the FileVault-uninitialized state per the existing
 *  `blob-store` / `sqlite-cache-store` discipline.
 *
 *  Exported so the D-125 P4.1 api handler's boot-site `persistAuth`
 *  callback can re-encode after an OAuth2 refresh — same crypto +
 *  AAD as enrollment, so a refreshed token round-trips through the
 *  sync wire alongside enrollments without divergence. */
export const encodeAuthForStorage = async (
  auth: ConnectionAuth,
  identity: { kind: ConnectionKind; name: string },
  getEncryptionKey?: () => Uint8Array | null,
): Promise<string> => {
  // D-322 — one-use consent proofs never enter storage, even transient ciphertext.
  const storedAuth = auth.type === 'managed_oauth' ? {
    type: auth.type, broker_profile_id: auth.broker_profile_id, integration_id: auth.integration_id,
    connection_id: auth.connection_id, target_origin: auth.target_origin, requested_scopes: auth.requested_scopes,
    ...(auth.required_scopes === undefined ? {} : { required_scopes: auth.required_scopes }),
    ...(auth.imported === true ? { imported: true } : {}),
  } : auth;
  const plaintext = new TextEncoder().encode(JSON.stringify(storedAuth));
  if (!getEncryptionKey) {
    return bytesToBase64(plaintext);
  }
  const key = requireConnectionKey(getEncryptionKey);
  const ct = await encrypt(key, plaintext, aadFor(identity));
  return encodeCiphertext(ct);
};

/** Decode an at-rest ciphertext blob back to a `ConnectionAuth`. The P3
 *  adapter calls this at invoke time; the list path also uses it narrowly to
 *  project the non-secret `type` discriminant needed for compatible pack
 *  reuse. No credential field enters a view. Mirrors the encode policy on
 *  `getEncryptionKey`: encrypted when wired, base64-JSON when not. */
export const decodeAuthFromStorage = async (
  blob: string,
  identity: { kind: ConnectionKind; name: string },
  getEncryptionKey?: () => Uint8Array | null,
): Promise<ConnectionAuth> => {
  if (!getEncryptionKey) {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(blob))) as ConnectionAuth;
  }
  const key = requireConnectionKey(getEncryptionKey);
  const ct = decodeCiphertext(blob);
  const plaintext = await decrypt(key, ct, aadFor(identity));
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConnectionAuth;
};
