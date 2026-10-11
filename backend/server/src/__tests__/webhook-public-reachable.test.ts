/** The public-reachability switch for inbound webhooks
 *  (`composition/bin/webhook-public-reachable.ts`).
 *
 *  ⛔ Until 2026-10-10 only `RECUED_PUBLIC_REACHABLE` opened it. The runtime key
 *  `collection.webhook.public_reachable` was in the schema, described as the
 *  gate, and named by both docker-compose files and the Homebrew caveats, and
 *  nothing read it. These tests run against the REAL runtime config store, so
 *  a key renamed or dropped from the schema fails here, not in production. */

import { describe, expect, it } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';

import {
  createWebhookPublicReachable,
  WEBHOOK_PUBLIC_REACHABLE_KEY,
} from '../composition/bin/webhook-public-reachable.js';

const storeWith = (value?: boolean) => createRuntimeConfigStore(
  value === undefined ? {} : { [WEBHOOK_PUBLIC_REACHABLE_KEY]: value },
);

describe('createWebhookPublicReachable', () => {
  it('is closed by default: key at its schema default, environment unset', () => {
    expect(createWebhookPublicReachable({ runtimeConfig: storeWith(), env: {} })()).toBe(false);
  });

  it('opens on the runtime key alone', () => {
    expect(createWebhookPublicReachable({ runtimeConfig: storeWith(true), env: {} })()).toBe(true);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['TRUE', false],
    ['yes', false],
  ] as const)('RECUED_PUBLIC_REACHABLE=%s with the key off → %s', (raw, expected) => {
    const open = createWebhookPublicReachable({
      runtimeConfig: storeWith(false),
      env: { RECUED_PUBLIC_REACHABLE: raw },
    });
    expect(open()).toBe(expected);
  });

  it('either one opens it: the environment cannot close what the key opened', () => {
    const open = createWebhookPublicReachable({
      runtimeConfig: storeWith(true),
      env: { RECUED_PUBLIC_REACHABLE: 'false' },
    });
    expect(open()).toBe(true);
  });

  it('follows the key live, without being rebuilt (SIGHUP / setConfigField)', () => {
    const runtimeConfig = storeWith(false);
    const open = createWebhookPublicReachable({ runtimeConfig, env: {} });
    expect(open()).toBe(false);
    runtimeConfig.set(WEBHOOK_PUBLIC_REACHABLE_KEY, true);
    expect(open()).toBe(true);
    runtimeConfig.set(WEBHOOK_PUBLIC_REACHABLE_KEY, false);
    expect(open()).toBe(false);
  });

  it('with no runtime config, the environment alone decides', () => {
    expect(createWebhookPublicReachable({ env: {} })()).toBe(false);
    expect(createWebhookPublicReachable({ env: { RECUED_PUBLIC_REACHABLE: 'true' } })()).toBe(true);
  });

  it('reads process.env on every call when no environment is given', () => {
    const original = process.env.RECUED_PUBLIC_REACHABLE;
    try {
      delete process.env.RECUED_PUBLIC_REACHABLE;
      const open = createWebhookPublicReachable();
      expect(open()).toBe(false);
      process.env.RECUED_PUBLIC_REACHABLE = '1';
      expect(open()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.RECUED_PUBLIC_REACHABLE;
      else process.env.RECUED_PUBLIC_REACHABLE = original;
    }
  });
});
