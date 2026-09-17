/** D-148 — the identity probe is REACHABLE, not merely implemented.
 *
 *  ⛔⛔ THE FEATURE SHIPPED UNROUTABLE AND EVERY TEST PASSED. `matchesPathRole`
 *  claims a path for a role only when the path IS the role's base or sits under
 *  it, so `/auth/identity-probe` matches NO role — exactly like its sibling
 *  `/auth/pair`, which is why that one has an entry in
 *  `SERVER_LEGACY_PATH_ALIASES`. Ours did not. The router would have 404'd
 *  every probe before any handler ran.
 *
 *  ⚠ WHY FOURTEEN GREEN TESTS MISSED IT, INCLUDING ONE OVER REAL HTTP: they all
 *  call `handlers.ws` directly, which is one layer BELOW the thing that decides
 *  whether `handlers.ws` is ever reached. Testing a handler proves the handler;
 *  it says nothing about dispatch. This file drives the ROUTER.
 *
 *  🔑 And the reasoning that felt like checking: I argued at length about which
 *  ROLE the probe should live on and what its exposure bits imply — a real
 *  question, correctly answered — while never asking how a URL reaches a role
 *  at all. Being careful about the adjacent question is what made it feel done.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPathRouter } from '@recued/server-tls';
import {
  IDENTITY_PROBE_PATH,
  PATH_ROLES,
  matchesPathRole,
  totalRecord,
  type PathRole,
  type PathResolution,
} from '@recued/contracts';

import { SERVER_LEGACY_PATH_ALIASES } from '../server.js';

const ALL_ON: Record<PathRole, PathResolution> =
  totalRecord(PATH_ROLES, () => ({ lan: true, public: true }));

const routeTo = async (
  path: string,
  opts: { resolution?: Record<PathRole, PathResolution>; listener?: 'lan' | 'public' } = {},
): Promise<string | null> => {
  let hit: string | null = null;
  const handlers = Object.fromEntries(
    PATH_ROLES.map((role) => [role, (_req: IncomingMessage, res: ServerResponse) => {
      hit = role;
      res.statusCode = 200;
      res.end('ok');
    }]),
  ) as Partial<Record<PathRole, (req: IncomingMessage, res: ServerResponse) => void>>;

  const router = createPathRouter({
    resolution: opts.resolution ?? ALL_ON,
    handlers: handlers as never,
    legacyAliases: SERVER_LEGACY_PATH_ALIASES,
    listener: opts.listener ?? 'public',
  } as never);

  const res = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  } as unknown as ServerResponse;
  await (router as { request: (r: IncomingMessage, s: ServerResponse) => unknown })
    .request({ url: path, method: 'POST', headers: {} } as IncomingMessage, res);
  return hit;
};

describe('identity probe — routing, not just handling', () => {
  it('⛔⛔ /auth/identity-probe reaches the ws role through the real router', async () => {
    expect(await routeTo(IDENTITY_PROBE_PATH)).toBe('ws');
  });

  it('⚠ and it does so ONLY via the alias — it matches no canonical role', async () => {
    // The fact that made this fail silently. Asserting it so nobody later
    // "simplifies" the alias away believing the path routes on its own.
    expect(PATH_ROLES.find((role) => matchesPathRole(IDENTITY_PROBE_PATH, role)))
      .toBeUndefined();
    expect(
      SERVER_LEGACY_PATH_ALIASES.some(
        (a) => a.kind === 'exact' && a.path === IDENTITY_PROBE_PATH && a.role === 'ws',
      ),
      'the probe path has no alias — the router will 404 every probe',
    ).toBe(true);
  });

  it('routes exactly like its sibling /auth/pair, which is why that one works', async () => {
    expect(await routeTo('/auth/pair')).toBe('ws');
    expect(await routeTo(IDENTITY_PROBE_PATH)).toBe(await routeTo('/auth/pair'));
  });

  it('⚠ an unaliased /auth/* path still reaches nothing', async () => {
    // The control: proves the two above pass because of their ALIASES, not
    // because `/auth/` is special to the router.
    expect(await routeTo('/auth/something-else')).toBeNull();
  });

  it('⛔ the probe inherits the ws role\'s EXPOSURE — the tie the design claimed', async () => {
    // ⚠ THE CLAIM I MADE AND DID NOT CHECK. The design doc argues the probe
    // belongs on the `ws` role so that "reachable iff the wss://…/ws URL being
    // saved is reachable" is STRUCTURAL rather than a preset coincidence. That
    // only holds if an ALIASED path is gated by the role's resolution bits too
    // — and an alias is resolved by a different branch from a canonical match.
    const wsLanOnly = totalRecord(PATH_ROLES, (role): PathResolution =>
      role === 'ws' ? { lan: true, public: false } : { lan: true, public: true });

    // Served on LAN, where /ws is served…
    expect(await routeTo(IDENTITY_PROBE_PATH, { resolution: wsLanOnly, listener: 'lan' }))
      .toBe('ws');
    // …and NOT on the public listener, where /ws is not.
    expect(await routeTo(IDENTITY_PROBE_PATH, { resolution: wsLanOnly, listener: 'public' }))
      .toBeNull();
    // ⛔ The half that makes it a TIE and not a coincidence: a probe must never
    // be reachable where the address it verifies is not.
    expect(await routeTo('/ws', { resolution: wsLanOnly, listener: 'public' })).toBeNull();
  });

  it('⚠ turning the ws role public turns the probe public with it', async () => {
    const wsPublic = totalRecord(PATH_ROLES, (): PathResolution => ({ lan: true, public: true }));
    expect(await routeTo(IDENTITY_PROBE_PATH, { resolution: wsPublic, listener: 'public' }))
      .toBe('ws');
  });

  it('every alias names a role that has a handler slot', async () => {
    // A misspelled role would route a live path into nothing.
    for (const alias of SERVER_LEGACY_PATH_ALIASES) {
      expect(PATH_ROLES, `alias for ${JSON.stringify(alias)} names an unknown role`)
        .toContain(alias.role);
    }
  });
});
