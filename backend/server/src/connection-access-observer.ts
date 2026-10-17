/** Record API traffic without letting an old in-flight request report health
 * for a replaced credential, changed service, or newer observation. */
import { isDeepStrictEqual } from 'node:util';
import type { ConnectionApiHandlerDeps } from '@recued/ingredients';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import { connectionAccessAuthority, connectionAccessObservationWins, isConnectionAccessKey, recordConnectionAccessEvidence } from './connection-access-evidence.js';

export const createConnectionAccessObserver = (deps: {
  store: Pick<ConnectionStoreSqlite, 'get' | 'setHealth'>;
  decode: ConnectionApiHandlerDeps['decodeAuth'];
}): NonNullable<ConnectionApiHandlerDeps['observeAccess']> => async (original, usedAuth, observation) => {
  const current = deps.store.get(original.kind, original.name);
  if (!current || current.pk !== original.pk || current.enrolled_at !== original.enrolled_at) return;
  const config: unknown = JSON.parse(original.config_json);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  const expected = { ...config, base_url: observation.base_url };
  if (!isDeepStrictEqual(JSON.parse(current.config_json), expected)
    || !isDeepStrictEqual(await deps.decode(current), usedAuth)) return;
  const latest = deps.store.get(original.kind, original.name);
  if (!latest || latest.enrolled_at !== current.enrolled_at || latest.config_json !== current.config_json
    || latest.auth_ciphertext !== current.auth_ciphertext) return;
  let previous: { last_probed_at?: number; status?: string; [field: string]: unknown } = {};
  try { previous = JSON.parse(latest.health_json ?? '{}') ?? {}; } catch { /* Replace malformed local health. */ }
  const updatesSummary = typeof previous.last_probed_at !== 'number' || !Number.isSafeInteger(previous.last_probed_at)
    || connectionAccessObservationWins({ at: previous.last_probed_at, status: previous.status }, observation);
  if (!updatesSummary && !isConnectionAccessKey(observation.check_key)) return;
  const evidence = recordConnectionAccessEvidence(latest.health_json, connectionAccessAuthority(usedAuth, observation.base_url), observation.check_key ? {
    key: observation.check_key, status: observation.status, at: observation.at, verified: observation.status === 'ok',
  } : undefined);
  if (!updatesSummary) {
    // A newer result for another resource owns scalar health. This result
    // still owns its independent, timestamp-fenced resource observation.
    deps.store.setHealth(original.kind, original.name, JSON.stringify({ ...previous, ...evidence }));
    return;
  }
  deps.store.setHealth(original.kind, original.name, JSON.stringify({ status: observation.status, last_probed_at: observation.at,
    ...evidence,
    ...(isConnectionAccessKey(observation.check_key) ? { access_check_key: observation.check_key } : {}),
    ...(observation.status === 'ok' ? { access_verified_at: observation.at }
      : { last_error: observation.status === 'auth_failed' ? 'The vendor rejected the saved sign-in or requested access.'
        : 'The service could not be reached or returned a temporary error.' }) }));
};
