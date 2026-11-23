import type { IncomingMessage } from 'node:http';
import type { EndpointSummary, ReceptionEndpointKind } from '@recued/contracts';
import type { PublicEndpointRegistryStore } from '../../storage/public-endpoint-registry-store.js';

export const extractReceptionBearer = (req: IncomingMessage): string => {
  const url = new URL(req.url ?? '/', 'http://x');
  const queryToken = url.searchParams.get('t');
  if (queryToken && queryToken.length > 0) return queryToken;
  const headerToken = req.headers['x-recued-endpoint-token'];
  if (typeof headerToken === 'string' && headerToken.length > 0) return headerToken;
  const authorization = req.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
};

/** Read current registry authority, never the dispatcher's cached snapshot.
 * Call again under the submission transaction's write lock before persisting. */
export const readLiveReceptionEndpoint = (
  req: IncomingMessage,
  endpoint_id: string,
  kind: ReceptionEndpointKind,
  deps: {
    readonly getStore: () => PublicEndpointRegistryStore;
    readonly getPepper: () => Buffer;
    readonly now: () => number;
  },
): EndpointSummary | null => {
  const verified = deps.getStore().verifyBearer({
    endpoint_id,
    submitted_secret: extractReceptionBearer(req),
    pepper: deps.getPepper(),
    now: deps.now(),
  });
  return verified.kind === 'ok' && verified.endpoint.kind === kind
    ? verified.endpoint
    : null;
};
