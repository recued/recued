/** D-201 Slice 10AN (the owner's call, 2026-11-20) — a webhook that refuses
 * every message never reads healthy.
 *
 * A message refused for its signature (`authentication_failed`) is recorded in
 * the bounded rejection summaries only (`recordRejectedDelivery`): nothing in
 * the webhook's own record changes, so its health read `healthy` while every
 * message it got was refused. A run of them with no verified message since
 * (`WebhookIngressRecord.last_delivery_at`) now reads `degraded` once it
 * reaches `WEBHOOK_REFUSAL_RUN_DEGRADES_AT`, and its card says so.
 *
 * Where Recued sets the secret the messages are signed with (a managed
 * webhook whose profile's every secret is Recued's own: Telegram's
 * `secret_token`, GitHub's `webhook_secret`), it sets the webhook's secret
 * again at the service with the one it holds (`setRefusedSecretsAgain`), at
 * most once an hour (D-201 Slice 10AR) and, since D-201 Slice 10AU (10AS
 * finding 5), while messages are still refused after its last set again: no
 * longer once per run. That undoes a set that replaced the secret, which no
 * read-back shows: 10AD's limit for a late Telegram set, whose messages were
 * refused while the webhook read healthy until the owner switched it off and
 * on. D-201 Slice 10AU (10AS finding 6) — the secret alone: the adapter's
 * `setSecret`, never its full update, which set a GitHub hook switched off
 * there back on, with Recued's events. Any other webhook's secret is the
 * service's or the owner's: its card says what the owner can do.
 *
 * D-201 Slice 10AR (10AM findings 10, 11, 12, 27, 28, 29 and 30) — nothing an
 * outsider sends steers it: anyone with the address can send a refused
 * message, so the sets again are bounded by time, the run counts from the
 * owner's last switch-on and the secret's making too, and the card says only
 * what the server knows. The card and the pass read the run one way
 * (`refusalStateOf`).
 */

import { webhookProfile, type WebhookIngressRecord } from '@recued/contracts';
import type { WebhookDeliveryStore } from './storage/webhook-delivery-store.js';
import type {
  WebhookCredentialVersionMetadata,
  WebhookIngressStore,
} from './storage/webhook-ingress-store.js';
import type { WebhookManagedRegistrationService } from './webhook-registration-reconciler.js';

/** A run of at least this many refused messages reads `degraded`. One or two
 *  is a stray request to the address; a service retrying a message it signs
 *  with another secret sends more, over minutes. The summaries record at
 *  least this many of them (their writes are bounded), so it is a floor.
 *  D-201 Slice 10AR (10AM finding 27) — how it counts: the summaries write a
 *  refusal of one kind at the 1st, 2nd, 4th, 8th… in a minute, so three is
 *  three recorded: three in separate minutes, or four in one. Three in one
 *  minute record as two, and read healthy. */
export const WEBHOOK_REFUSAL_RUN_DEGRADES_AT = 3;

/** D-201 Slice 10AR (10AM finding 10) — at most one set again per webhook in
 *  this long, done or failed, however its messages go. Bounded by a run's
 *  start alone, read from summaries that move forward as they are evicted, an
 *  outsider's bad requests made Recued set a webhook again hundreds of times a
 *  day, and a set that could not go through was tried at every pass. D-201
 *  Slice 10AU (10AS finding 5) — the one bound: once per run, an outsider's
 *  requests while the secret was right used up the set again a later late set
 *  needed, and it was never undone. */
export const WEBHOOK_SECRET_SET_AGAIN_EVERY_MS = 60 * 60 * 1000;

/** D-201 Slice 10AR (10AM findings 11 and 28) — where a run of refusals starts:
 *  the latest of the webhook's last verified message, its last switch-on, and
 *  the making of the secret it holds now. A refusal before any of them is one
 *  the owner's switch or a new secret answered. A time after `now`, written
 *  while the clock ran ahead, is not trusted: it hid every refusal after it
 *  until the clock caught up. Counted from the last verified message alone, a
 *  webhook switched off and on, or set up again, still read the run. */
export const refusalRunStart = (
  ingress: Pick<WebhookIngressRecord, 'last_delivery_at' | 'enabled_at'>,
  credentials: readonly Pick<WebhookCredentialVersionMetadata, 'active' | 'created_at'>[],
  now: number,
): number | null => {
  const bounds = [
    ingress.last_delivery_at,
    ingress.enabled_at,
    ...credentials.filter((credential) => credential.active).map((credential) => credential.created_at),
  ].filter((at): at is number => at !== null && at <= now);
  return bounds.length === 0 ? null : Math.max(...bounds);
};

/** A time not after `now`: one written while the clock ran ahead is not trusted. */
const notAhead = (at: number | null, now: number): number | null => (at !== null && at <= now ? at : null);

/** D-201 Slice 10AR (10AM findings 11 and 12) — switched on, its messages taken.
 *  A webhook switched off refuses nothing for its secret, so a run of
 *  refusals is not read for it: its card said Recued sets it again while the
 *  pass skipped it. */
const takingMessages = (ingress: Pick<WebhookIngressRecord, 'intake_state'>): boolean =>
  ingress.intake_state === 'enabled' || ingress.intake_state === 'degraded';

/** Messages refused for their signature since the run's start
 *  (`refusalRunStart`). */
export interface WebhookRefusalRun {
  /** At least this many. */
  readonly refused: number;
  /** When the first of them came. */
  readonly since: number;
}

/** The run of an ingress, once it reaches `WEBHOOK_REFUSAL_RUN_DEGRADES_AT`,
 *  counted from `refusalRunStart`. */
export const refusalRunOf = (
  deliveries: Pick<WebhookDeliveryStore, 'authenticationRefusalsSince'>,
  ingress: Pick<WebhookIngressRecord, 'ingress_id' | 'last_delivery_at' | 'enabled_at'>,
  credentials: readonly Pick<WebhookCredentialVersionMetadata, 'active' | 'created_at'>[],
  now: number,
): WebhookRefusalRun | null => {
  const run = deliveries.authenticationRefusalsSince(ingress.ingress_id, refusalRunStart(ingress, credentials, now));
  return run !== null && run.refused >= WEBHOOK_REFUSAL_RUN_DEGRADES_AT
    ? { refused: run.refused, since: run.first_at }
    : null;
};

/** Recued sets the secret this webhook's messages are signed with: it set the
 *  webhook up at the service, and every secret its profile signs with is
 *  Recued's own (`recued_generated`). A secret the service makes, or the owner
 *  types, Recued cannot set. */
export const recuedSetsSecret = (
  ingress: Pick<WebhookIngressRecord, 'profile_id' | 'registration_mode'>,
): boolean => {
  if (ingress.registration_mode !== 'managed_endpoint') return false;
  const secrets = webhookProfile(ingress.profile_id)?.fields.filter((field) => field.kind === 'secret') ?? [];
  return secrets.length > 0 && secrets.every((field) => field.source === 'recued_generated');
};

/** D-201 Slice 10AR — Recued sets this webhook again at its service: its secret
 *  is Recued's (`recuedSetsSecret`), and it is set up there. */
const setsItAgain = (
  ingress: Pick<WebhookIngressRecord, 'profile_id' | 'registration_mode' | 'registration_state' | 'remote_endpoint_id'>,
): boolean => recuedSetsSecret(ingress)
  && (ingress.registration_state === 'registered' || ingress.registration_state === 'drifted')
  && ingress.remote_endpoint_id !== null;

/** D-201 Slice 10AR (10AM finding 12) — the webhook as it stands may be set
 *  again: taking messages, and set up at its service with Recued's secret. The
 *  pass reads a snapshot (`refusalStateOf`); the service reads it again under
 *  the webhook's lock (`setSecretAgain`). One rule for both, and for the card. */
export const mayBeSetAgain = (
  ingress: Pick<WebhookIngressRecord,
    'intake_state' | 'profile_id' | 'registration_mode' | 'registration_state' | 'remote_endpoint_id'>,
): boolean => takingMessages(ingress) && setsItAgain(ingress);

/** D-201 Slice 10AR — a run of refusals as its card and the pass read it: one
 *  reader for both, so neither says what the other does not do. */
export interface WebhookRefusalState {
  readonly run: WebhookRefusalRun;
  /** Recued sets this webhook again at its service (`setsItAgain`): the pass
   *  does, and its card says so. */
  readonly sets_again: boolean;
  /** When Recued last set it again, if it ever did, not after `now`. */
  readonly set_again_at: number | null;
  /** When a try to set it again last failed, if one ever did, not after `now`. */
  readonly set_again_failed_at: number | null;
}

/** The run of refusals of a webhook taking messages, or null. */
export const refusalStateOf = (
  deps: {
    readonly ingresses: Pick<WebhookIngressStore, 'listCredentialVersions' | 'secretSetAgainAt' | 'secretSetAgainFailedAt'>;
    readonly deliveries: Pick<WebhookDeliveryStore, 'authenticationRefusalsSince'>;
  },
  ingress: Pick<WebhookIngressRecord,
    | 'ingress_id'
    | 'intake_state'
    | 'last_delivery_at'
    | 'enabled_at'
    | 'profile_id'
    | 'registration_mode'
    | 'registration_state'
    | 'remote_endpoint_id'>,
  now: number,
): WebhookRefusalState | null => {
  if (!takingMessages(ingress)) return null;
  const run = refusalRunOf(deps.deliveries, ingress, deps.ingresses.listCredentialVersions(ingress.ingress_id), now);
  if (run === null) return null;
  const setsAgain = mayBeSetAgain(ingress);
  return {
    run,
    sets_again: setsAgain,
    set_again_at: setsAgain ? notAhead(deps.ingresses.secretSetAgainAt(ingress.ingress_id), now) : null,
    set_again_failed_at: setsAgain ? notAhead(deps.ingresses.secretSetAgainFailedAt(ingress.ingress_id), now) : null,
  };
};

export interface WebhookRefusedSecretsDeps {
  readonly ingresses: Pick<WebhookIngressStore,
    | 'list'
    /** D-201 Slice 10BB (10AY finding 8) — the webhook as it stands after a
     *  set again that failed: switched off meanwhile, nothing failed. */
    | 'get'
    | 'listCredentialVersions'
    | 'noteSecretSetAgain'
    | 'secretSetAgainAt'
    | 'noteSecretSetAgainFailed'
    | 'secretSetAgainFailedAt'
    | 'clampSecretSetAgainNotes'>;
  readonly deliveries: Pick<WebhookDeliveryStore, 'authenticationRefusalsSince'>;
  readonly service: Pick<WebhookManagedRegistrationService, 'setSecretAgain'>;
  readonly now?: () => number;
  readonly isStopping?: () => boolean;
  /** D-201 Slice 10AR (10AM finding 29) — the vault unlocked and the server
   *  not paused, read before each webhook as the sweep reads it: checked once,
   *  before the sweep, the pass ran on after the vault locked, and a set that
   *  reached the service then left the webhook drifted. */
  readonly canRun?: () => boolean;
  readonly log?: (message: string, error: unknown) => void;
}

/** Set again, with the secret Recued holds, each webhook whose secret Recued
 *  sets and whose messages are being refused: at most once an hour
 *  (`WEBHOOK_SECRET_SET_AGAIN_EVERY_MS`), done or failed, however its messages
 *  go, and only while messages are still refused after its last set again. How
 *  many were set again. A set that fails leaves the webhook drifted, as any
 *  failed pass does; the next one allowed sets it again, which repairs that too.
 *
 *  D-201 Slice 10AU (10AS finding 5) — bounded by time alone. Once per run, a
 *  sender with the address used up a run's one set again by sending refused
 *  requests while the secret was right: a late set after it, with no message
 *  verified in between, was never undone. A set again now answers the
 *  refusals before it, as a verified message does; one recorded after it is
 *  needed for the next, so a run that has gone quiet is not set again every
 *  hour. An outsider can still make Recued set a webhook again, harmlessly,
 *  and so hold the next one back up to an hour: that is the bound. */
/** D-201 Slice 10BB (10AY finding 8) — whether the webhook stopped taking
 *  messages, or went, since the pass read it. A fault reading it says no, so
 *  the failed try is noted, as before. */
const switchedOffSince = (deps: WebhookRefusedSecretsDeps, ingressId: string): boolean => {
  try {
    const now = deps.ingresses.get(ingressId);
    return now === null || !takingMessages(now);
  } catch {
    return false;
  }
};

export const setRefusedSecretsAgain = async (deps: WebhookRefusedSecretsDeps): Promise<number> => {
  const clock = deps.now ?? Date.now;
  let setAgain = 0;
  for (const ingress of deps.ingresses.list()) {
    if (deps.isStopping?.() === true || deps.canRun?.() === false) break;
    const now = clock();
    // A snapshot, read as its card reads it (`refusalStateOf`): taking messages,
    // set up at the service with Recued's secret. The service checks it again
    // under the webhook's lock (10AR, 10AM finding 12).
    let state: WebhookRefusalState | null;
    let done: number | null;
    let failed: number | null;
    try {
      state = refusalStateOf(deps, ingress, now);
      if (state === null || !state.sets_again) continue;
      done = deps.ingresses.secretSetAgainAt(ingress.ingress_id);
      failed = deps.ingresses.secretSetAgainFailedAt(ingress.ingress_id);
      // D-201 Slice 10AU (10AS finding 26) — a note ahead of now, by a clock
      // set back since or one that ran ahead, is brought back to now: the hour
      // counts from here. Ignored, setting the clock back let the pass set a
      // webhook again at once; kept (10AM finding 28), it held every set again
      // until the clock passed it.
      if ((done !== null && done > now) || (failed !== null && failed > now)) {
        deps.ingresses.clampSecretSetAgainNotes(ingress.ingress_id, now);
        done = done === null ? null : Math.min(done, now);
        failed = failed === null ? null : Math.min(failed, now);
      }
    } catch {
      continue;
    }
    const latest = Math.max(done ?? Number.NEGATIVE_INFINITY, failed ?? Number.NEGATIVE_INFINITY);
    if (now - latest < WEBHOOK_SECRET_SET_AGAIN_EVERY_MS) continue;
    // A set again answers the refusals before it: one recorded since is needed
    // for the next (D-201 Slice 10AU, 10AS finding 5).
    if (done !== null) {
      let after: ReturnType<WebhookDeliveryStore['authenticationRefusalsSince']>;
      try {
        after = deps.deliveries.authenticationRefusalsSince(ingress.ingress_id, done);
      } catch {
        continue;
      }
      if (after === null) continue;
    }
    let set: WebhookIngressRecord | null;
    try {
      set = await deps.service.setSecretAgain(ingress.ingress_id);
    } catch (error) {
      // D-201 Slice 10BB (10AY finding 8) — the owner switched it off while the
      // set again was under way, and it stopped there (`state_changed`): no
      // failed try, as a set again its lock refuses is not one. Noted, the next
      // set again it needed waited an hour after the owner switched it on.
      if (switchedOffSince(deps, ingress.ingress_id)) continue;
      deps.log?.(`webhook ${ingress.ingress_id} could not be set again with its secret`, error);
      try {
        deps.ingresses.noteSecretSetAgainFailed(ingress.ingress_id, clock());
      } catch {
        // Not noted: the next pass tries it again.
      }
      continue;
    }
    // D-201 Slice 10AU (10AS finding 27) — not set again: as it stands under
    // its lock, it may not be (switched off since the snapshot, say). Nothing
    // was tried, so nothing is noted: noted as a failed try, it held the next
    // set again an hour after the owner switched the webhook back on.
    if (set === null) continue;
    setAgain += 1;
    try {
      deps.ingresses.noteSecretSetAgain(ingress.ingress_id, clock());
    } catch {
      // Not noted: the next pass may set it again, which changes nothing more.
    }
  }
  return setAgain;
};
