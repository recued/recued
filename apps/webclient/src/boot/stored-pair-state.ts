/** Complete stored-pair generation used by boot recovery arbitration.
 *
 * A webclient's five-field store is shared by every tab on the origin. When
 * one tab repairs access while another is backgrounded, the late tab must be
 * able to tell the fresh generation from the rejected one before clearing
 * anything. Keeping the read + equality contract here lets live reauth and
 * cold-start credential repair make the same decision. */

import type {
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';

import type { WebclientLocalStore } from '../storage/local-store.js';

export interface StoredPairVersion {
  readonly tokenId: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly issuedAt: number;
  readonly serverUrl: string;
  readonly serverPublicKey: string;
  readonly instanceId: string | null;
}

export interface CompleteStoredPair {
  readonly token: WebclientTokenRecord;
  readonly serverUrl: string;
  readonly serverPublicKey: string;
  readonly instanceId: string | null;
  readonly version: StoredPairVersion;
}

export interface PartialStoredPair {
  /** A non-empty address survives as a trusted in-process reconnect hint. */
  readonly serverUrl: string | null;
  /** Local-only recovery keeps the existing device roster identity. */
  readonly instanceId: string | null;
  /** Exact closed-list fields that prove this is residue, not first run. */
  readonly presentFields: readonly WebclientLocalKey[];
}

export type StoredPairState =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'partial';
      readonly partial: PartialStoredPair;
    }
  | {
      readonly kind: 'complete';
      readonly pair: CompleteStoredPair;
    };

const instanceIdFrom = (
  metadata: WebclientLocalStorage['pair_metadata'],
): string | null =>
  typeof metadata?.instance_id === 'string'
  && metadata.instance_id.length > 0
    ? metadata.instance_id
    : null;

const completePairFrom = (
  token: WebclientLocalStorage['webclient_token'],
  serverUrl: WebclientLocalStorage['server_url'],
  serverPublicKey: WebclientLocalStorage['server_public_key'],
  metadata: WebclientLocalStorage['pair_metadata'],
): CompleteStoredPair | null => {
  // Match `hydratePairState` exactly: empty strings are missing strict fields.
  if (
    token === null
    || token === undefined
    || !serverUrl
    || !serverPublicKey
  ) {
    return null;
  }
  const instanceId = instanceIdFrom(metadata);
  return {
    token,
    serverUrl,
    serverPublicKey,
    instanceId,
    version: {
      tokenId: token.token_id,
      ciphertext: token.ciphertext_b64,
      iv: token.iv_b64,
      issuedAt: token.issued_at,
      serverUrl,
      serverPublicKey,
      instanceId,
    },
  };
};

/** Classify the full five-field record. Only five nulls mean first run. Any
 * residue without the strict URL + public-key + token triple is an interrupted
 * local write and deserves an explained repair instead of generic onboarding. */
export const readStoredPairState = async (
  localStore: WebclientLocalStore,
): Promise<StoredPairState> => {
  const [token, serverUrl, serverPublicKey, metadata, certPinState] =
    await Promise.all([
      localStore.get('webclient_token'),
      localStore.get('server_url'),
      localStore.get('server_public_key'),
      localStore.get('pair_metadata'),
      localStore.get('cert_pin_state'),
    ]);
  const presentFields: WebclientLocalKey[] = [];
  const markPresent = <K extends WebclientLocalKey>(
    key: K,
    value: WebclientLocalStorage[K] | null,
  ): void => {
    if (value !== null && value !== undefined) presentFields.push(key);
  };
  markPresent('server_url', serverUrl);
  markPresent('webclient_token', token);
  markPresent('server_public_key', serverPublicKey);
  markPresent('pair_metadata', metadata);
  markPresent('cert_pin_state', certPinState);

  const complete = completePairFrom(
    token,
    serverUrl,
    serverPublicKey,
    metadata,
  );
  if (complete !== null) {
    return {
      kind: 'complete',
      pair: complete,
    };
  }
  if (presentFields.length === 0) return { kind: 'empty' };
  return {
    kind: 'partial',
    partial: {
      serverUrl:
        typeof serverUrl === 'string' && serverUrl.length > 0
          ? serverUrl
          : null,
      instanceId: instanceIdFrom(metadata),
      presentFields,
    },
  };
};

/** Read the strict paired discriminant plus the values needed to unwrap it.
 * Partial state is deliberately `null`: both bootstrap and pair-finalization
 * require token + URL + public key before treating this browser as paired. */
export const readCompleteStoredPair = async (
  localStore: WebclientLocalStore,
): Promise<CompleteStoredPair | null> => {
  const [token, serverUrl, serverPublicKey, metadata] = await Promise.all([
    localStore.get('webclient_token'),
    localStore.get('server_url'),
    localStore.get('server_public_key'),
    localStore.get('pair_metadata'),
  ]);
  return completePairFrom(token, serverUrl, serverPublicKey, metadata);
};

export const sameStoredPairVersion = (
  left: StoredPairVersion,
  right: StoredPairVersion,
): boolean =>
  left.tokenId === right.tokenId
  && left.ciphertext === right.ciphertext
  && left.iv === right.iv
  && left.issuedAt === right.issuedAt
  && left.serverUrl === right.serverUrl
  && left.serverPublicKey === right.serverPublicKey
  && left.instanceId === right.instanceId;

/** Compare the logical credential generation rather than its local encrypted
 * envelope. Two tabs can wrap the same rotated bearer with different AES-GCM
 * IV/ciphertext bytes; that is not a server/session replacement and must not
 * force either mounted tab through a recovery remount. */
export const sameStoredCredentialGeneration = (
  left: StoredPairVersion,
  right: StoredPairVersion,
): boolean =>
  left.tokenId === right.tokenId
  && left.issuedAt === right.issuedAt
  && left.serverUrl === right.serverUrl
  && left.serverPublicKey === right.serverPublicKey
  && left.instanceId === right.instanceId;
