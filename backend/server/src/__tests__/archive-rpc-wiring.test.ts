/** Regression — `createServerHandlerSet` forwards composed rpc deps into the
 *  ws-server (the forward-or-dead-rpc seam).
 *
 *  `composeListeners` composes a dep and the ws-server handler-registers it, but
 *  `createServerHandlerSet` (`server.ts`) builds the ws-server config by
 *  EXPLICITLY forwarding each `config.X` — so a forgotten forward silently leaves
 *  that rpc returning `not_configured` over the live wire, even though every
 *  handler + runtime unit test passes (they bypass this seam). A live endpoint
 *  probe of the M5 pre-pair restore caught `archiveDeps` dropped this way; a
 *  Codex sibling sweep then found `updateDeps` + `contactEngagementsRpcDeps`
 *  dropped identically. This pins all three so they can't silently regress.
 *
 *  The signal is wired-vs-not: with the dep forwarded the dispatch reaches the
 *  handler (any non-`not_configured` outcome); without it the dispatcher itself
 *  answers `not_configured`. (For archive specifically, a dry-run import of a
 *  NON-EXISTENT path reaches the handler's existence check → `not_found`.) */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { generateRecoveryKey } from '@recued/crypto';

import { startServer, type RunningServer, type ServerConfig } from '../index.js';

const KEY = generateRecoveryKey().mnemonic;

/** A `fetch` that always 404s — keeps the install-seam-5c probe offline (the
 *  handler returns a result-body failure, never `not_configured`; recipeStore
 *  is never reached because a 404 short-circuits before any save). */
const mock404Fetch: typeof globalThis.fetch = (async () =>
  ({ status: 404, ok: false, statusText: 'Not Found', json: async () => null }) as unknown as Response) as typeof globalThis.fetch;

/** Minimal fakes — the methods either reach an existence/precondition check that
 *  fails before the (empty) runtime is touched, or throw, but NEVER answer the
 *  dispatcher's `not_configured`. That's the whole signal: a registered slice. */
const FAKES: Pick<
  ServerConfig,
  | 'archiveDeps'
  | 'updateDeps'
  | 'contactEngagementsRpcDeps'
  | 'packInstallDeps'
  | 'formResponseDeps'
  | 'serverTimeZoneDeps'
  | 'notificationKindPolicyDeps'
  | 'quietHoursDeps'
> = {
  archiveDeps: {
    runtime: {} as never,
    dataPath: '/recued-archive-wiring-probe-nonexistent',
  },
  updateDeps: {} as never,
  contactEngagementsRpcDeps: {} as never,
  formResponseDeps: {
    store: {
      list: () => [],
      findById: () => null,
    } as never,
  },
  // Install seam 5c — `packInstallDeps` already forwards through server.ts; the
  // new `packs.installBySlug` + `recipe.installBySlug` join the SAME slice, so
  // this pins that they are live over the wire (not silently `not_configured`).
  packInstallDeps: {
    recipeStore: {} as never,
    marketplaceFetch: mock404Fetch,
  },
  // D-269 step 1 — `server.timezone.*`. A read-only fake is enough: the probe
  // below only needs the dispatch to REACH the handler, and this handler's own
  // registered-client gate answers before the store is touched.
  serverTimeZoneDeps: {
    store: { read: () => null, write: () => ({ mode: 'fixed', zone: null, updated_at: 0 }) } as never,
  },
  // D-269 step 2 — the per-kind reminder policy. Read-only fake: the probe only
  // needs the dispatch to REACH the handler, whose registered-client gate
  // answers before the store is touched.
  notificationKindPolicyDeps: { store: { list: () => [], get: () => null, write: () => null } as never },
  // D-269 step 3 — the quiet-hours window.
  quietHoursDeps: {
    store: { read: () => null, write: () => null } as never,
    timezoneStore: { read: () => null, write: () => null } as never,
  },
};

const connectWs = (port: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-realm`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const callRpc = (
  ws: WebSocket,
  method: string,
  args: unknown,
): Promise<{ ok: boolean; error?: { code: string; message: string } }> =>
  new Promise((resolve) => {
    const request_id = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'rpc_result' && msg.request_id === request_id) {
        ws.off('message', onMessage);
        resolve({ ok: !msg.error, error: msg.error });
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
  });

const IMPORT_ARGS = { path: 'probe.recued.archive', recoveryKey: KEY, dry_run: true };

// No recoveryKeyCheck → the pre-enrollment gate is bypassed, so a dispatch
// reaches the handler directly + the only `not_configured` is an unwired slice.
describe('rpc-dep forwarding into the ws-server (server.ts)', () => {
  describe('WITH the deps forwarded → the methods are WIRED', () => {
    let server: RunningServer;
    beforeAll(async () => {
      server = await startServer(0, { ...FAKES });
      server.wsServer.maxInstances = 0;
    });
    afterAll(async () => {
      await server.close();
    });

    it('server.archive.import is wired (reaches the handler → not_found, not not_configured)', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'server.archive.import', IMPORT_ARGS);
        expect(r.error?.code).not.toBe('not_configured');
        expect(r.error?.code).toBe('not_found');
      } finally {
        ws.close();
      }
    });

    it('update.check is wired (D-178 — not not_configured)', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'update.check', {});
        expect(r.error?.code).not.toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('data.contact.engagements.list is wired (D-139 — not not_configured)', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'data.contact.engagements.list', { contact_email: 'x@y.z' });
        expect(r.error?.code).not.toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('server.timezone.get is wired (D-269 — not not_configured)', async () => {
      // ⛔ THE TRAP THIS FILE EXISTS FOR, AND A NEW FAMILY WALKS STRAIGHT INTO
      // IT. `server.timezone.*` needs a ServerConfig DECLARATION and a separate
      // explicit FORWARD in `createServerHandlerSet`; the handler unit tests and
      // the contracts ratchet both pass with the forward missing, and the only
      // symptom is `not_configured` on the live wire. Probed here rather than
      // trusted, because every other layer already said yes.
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'server.timezone.get', {});
        expect(r.error?.code).not.toBe('not_configured');
        // This unregistered probe is turned away by the handler's own paired-
        // client gate — which is itself the proof the slice claimed the method.
        expect(r.error?.code).toBe('unauthorized');
      } finally {
        ws.close();
      }
    });

    it('notification.kind_policy.get is wired (D-269 step 2 — not not_configured)', async () => {
      // Same forward-or-dead-rpc seam as `server.timezone.get`: a ServerConfig
      // declaration AND a separate explicit forward, with every other layer
      // green when the forward is missing.
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'notification.kind_policy.get', {});
        expect(r.error?.code).not.toBe('not_configured');
        expect(r.error?.code).toBe('unauthorized');
      } finally {
        ws.close();
      }
    });

    it('notification.quiet_hours.get is wired (D-269 step 3 — not not_configured)', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'notification.quiet_hours.get', {});
        expect(r.error?.code).not.toBe('not_configured');
        expect(r.error?.code).toBe('unauthorized');
      } finally {
        ws.close();
      }
    });

    it('form_response.list is wired (owner Data browser — not not_configured)', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'form_response.list', {});
        // This unregistered probe is rejected at the handler's privacy gate;
        // that proves the slice was forwarded and claimed the method.
        expect(r.error?.code).toBe('unauthorized');
      } finally {
        ws.close();
      }
    });

    it('packs.installBySlug is wired (install seam 5c — not not_configured)', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'packs.installBySlug', {
          slug: 'wiring-probe',
          granted_permissions: [],
        });
        expect(r.error?.code).not.toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('recipe.installBySlug is wired (install seam 5c — not not_configured)', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'recipe.installBySlug', { slug: 'wiring-probe' });
        expect(r.error?.code).not.toBe('not_configured');
      } finally {
        ws.close();
      }
    });
  });

  describe('WITHOUT the deps → not_configured (the contrast)', () => {
    let server: RunningServer;
    beforeAll(async () => {
      server = await startServer(0, {});
      server.wsServer.maxInstances = 0;
    });
    afterAll(async () => {
      await server.close();
    });

    it('server.archive.import → not_configured', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'server.archive.import', IMPORT_ARGS);
        expect(r.error?.code).toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('update.check → not_configured', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'update.check', {});
        expect(r.error?.code).toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('data.contact.engagements.list → not_configured', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'data.contact.engagements.list', { contact_email: 'x@y.z' });
        expect(r.error?.code).toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('form_response.list → not_configured', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'form_response.list', {});
        expect(r.error?.code).toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('packs.installBySlug → not_configured', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'packs.installBySlug', {
          slug: 'wiring-probe',
          granted_permissions: [],
        });
        expect(r.error?.code).toBe('not_configured');
      } finally {
        ws.close();
      }
    });

    it('recipe.installBySlug → not_configured', async () => {
      const ws = await connectWs(server.port);
      try {
        const r = await callRpc(ws, 'recipe.installBySlug', { slug: 'wiring-probe' });
        expect(r.error?.code).toBe('not_configured');
      } finally {
        ws.close();
      }
    });
  });
});
