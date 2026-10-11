/** The public-reachability switch for inbound webhooks.
 *
 *  Every inbound webhook surface asks it before accepting a delivery: the
 *  D-128 vendor-connection receiver, its WatchSource governance rows, and
 *  D-201's `/v1/webhooks/<id>` intake and readiness. It is on when EITHER
 *    - the runtime key `collection.webhook.public_reachable` is true
 *      (config.toml `[runtime]`, applied live on SIGHUP and by
 *      `server.setConfigField`), or
 *    - the environment has `RECUED_PUBLIC_REACHABLE=true` (or `1`), the older
 *      switch that container and service installs set.
 *
 *  Read on every call, so the key changes without a restart. The environment
 *  of a running process cannot change, so only the key is a live toggle.
 *
 *  ⛔ Until 2026-10-10 only the environment variable was read. The key was in
 *  the schema, its description called it the gate, and both docker-compose
 *  files and the Homebrew caveats told operators to set it, so an owner who
 *  followed them had every webhook refused with no hint why.
 *
 *  ⚠ NOT the first-boot exposure seed. `RECUED_PUBLIC_REACHABLE` also seeds
 *  `/health`, `/ws` and `/llm_gateway` public on a first boot
 *  (`exposure/bootstrap.ts`). This key is named for webhooks and must not
 *  widen anything else, so the seed reads the environment alone. */

import type { RuntimeConfigStore } from '@recued/config';

export const WEBHOOK_PUBLIC_REACHABLE_KEY = 'collection.webhook.public_reachable';

export interface WebhookPublicReachableInput {
  /** The server's runtime config. Absent (a partial harness) ⇒ only the
   *  environment counts, so the switch stays closed unless it says otherwise. */
  readonly runtimeConfig?: Pick<RuntimeConfigStore, 'get'> | undefined;
  /** Defaults to `process.env`, read live. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const createWebhookPublicReachable = (
  input: WebhookPublicReachableInput = {},
): (() => boolean) => {
  const env = input.env ?? process.env;
  const runtimeConfig = input.runtimeConfig;
  return () => {
    const raw = env.RECUED_PUBLIC_REACHABLE;
    if (raw === 'true' || raw === '1') return true;
    return runtimeConfig?.get(WEBHOOK_PUBLIC_REACHABLE_KEY) === true;
  };
};
