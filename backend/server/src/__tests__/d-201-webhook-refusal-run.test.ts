/** D-201 Slice 10AR (10AM findings 10, 11, 27, 28, 29 and 30) — the refusals no
 *  outsider can steer. 10AN's tests recorded refusals with
 *  `recordRejectedDelivery` and the verified message with
 *  `recordAcceptedDelivery`; these send them to the real listener over HTTP,
 *  and read the webhook as the owner's RPC does. */
import http from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBHOOK_PROFILE_IDS, WEBHOOK_PROFILE_REGISTRY, type WebhookIngressRecord } from '@recued/contracts';
import { startServer } from '../server.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookProfileListener } from '../webhook-profile-listener.js';
import { createWebhookProfileRuntimeRegistry } from '../webhook-profile-runtime.js';
import { createTelegramWebhookProfileAdapter } from '../webhook-telegram-profile.js';
import { handleWebhookIngressGet, type WebhookIngressRpcDeps } from '../webhook-ingress-handler.js';
import { webhookProfileRuntimeCapability } from '../webhook-profile-capability.js';
import {
  WEBHOOK_REFUSAL_RUN_DEGRADES_AT,
  WEBHOOK_SECRET_SET_AGAIN_EVERY_MS,
  refusalRunStart,
  refusalStateOf,
  setRefusedSecretsAgain,
} from '../webhook-refusal-run.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SECRET = 'Telegram_secret-token_d201_10ar';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** A Telegram webhook the owner set up, switched on, behind the server's own
 *  listener, every clock one. */
const listening = async () => {
  let clock = Date.parse('2026-11-21T09:00:00.000Z');
  const db = new Database(':memory:');
  const ingressStore = createWebhookIngressStore(db, {
    now: () => clock,
    getEncryptionKey: () => new Uint8Array(32).fill(61),
  });
  const created = ingressStore.create({
    display_name: 'Telegram bot',
    profile_id: 'telegram.bot-webhook.v1',
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['message'],
  });
  await ingressStore.writeCredentialVersion(created.ingress_id, { secret_token: SECRET });
  const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
  ingressStore.confirmManualRegistration(created.ingress_id, { requires_handshake: false, endpoint_url: endpoint });
  ingressStore.enable(created.ingress_id);
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => clock,
    getEncryptionKey: () => new Uint8Array(32).fill(62),
    hasDispatchTarget: () => true,
  });
  const listener = createWebhookProfileListener({
    ingressStore,
    deliveryStore,
    profiles: createWebhookProfileRuntimeRegistry([createTelegramWebhookProfileAdapter()]),
    isOutboxDispatcherStarted: () => true,
    resolveCanonicalPublicUrl: () => endpoint,
    now: () => clock,
  });
  const server = await startServer(0, { webhookProfileListener: listener });
  closers.push(async () => { await server.close(); db.close(); });
  let updateId = 900_000;
  const send = (secret: string): Promise<number> => new Promise((resolve, reject) => {
    updateId += 1;
    const body = Buffer.from(JSON.stringify({
      update_id: updateId,
      message: { message_id: updateId, date: 1_763_000_000, chat: { id: 7, type: 'private' }, text: 'hi' },
    }), 'utf8');
    const request = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: `/v1/webhooks/${created.public_id}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.byteLength,
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(body);
  });
  const deps = {
    store: ingressStore,
    deliveryStore,
    now: () => clock,
    profileCapabilities: WEBHOOK_PROFILE_IDS.map((profileId) =>
      webhookProfileRuntimeCapability(WEBHOOK_PROFILE_REGISTRY[profileId], true)),
    runtimeReadiness: async () => ({
      endpoint_url: endpoint,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: true,
      clock_ready: true,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    }),
  } as unknown as WebhookIngressRpcDeps;
  const health = async () => (await handleWebhookIngressGet(
    deps, { ingress_id: created.ingress_id }, { instance_id: 'owner-webclient' },
  )).ingress!.health;
  /** Requests without the secret, a minute apart. */
  const refusedApart = async (count: number) => {
    for (let n = 0; n < count; n += 1) {
      clock += MINUTE;
      expect(await send('not_the_secret')).toBe(401);
    }
  };
  return {
    ingressStore,
    deliveryStore,
    ingressId: created.ingress_id,
    send,
    health,
    refusedApart,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
  };
};

describe('D-201 Slice 10AR — a run of refusals, through the listener', () => {
  // 10AM finding 27 — three in one minute read healthy.
  it('three recorded read degraded: three a minute apart do, three in one minute record as two and do not', async () => {
    expect(WEBHOOK_REFUSAL_RUN_DEGRADES_AT).toBe(3);
    const apart = await listening();
    await apart.refusedApart(WEBHOOK_REFUSAL_RUN_DEGRADES_AT - 1);
    expect(await apart.health()).toMatchObject({ status: 'healthy' });
    const first = apart.now() - MINUTE;
    await apart.refusedApart(1);
    expect(await apart.health()).toMatchObject({ status: 'degraded', refusing: { refused: 3, since: first } });

    const together = await listening();
    together.advance(MINUTE);
    const at = together.now();
    for (let n = 0; n < 3; n += 1) expect(await together.send('not_the_secret')).toBe(401);
    // Written at the 1st, 2nd, 4th… of a minute: the third is not.
    expect(await together.health()).not.toHaveProperty('refusing');
    expect(await together.send('not_the_secret')).toBe(401);
    expect(await together.health()).toMatchObject({ status: 'degraded', refusing: { refused: 4, since: at } });
    // A verified message ends it.
    together.advance(1_000);
    expect(await together.send(SECRET)).toBe(200);
    expect(await together.health()).toMatchObject({ status: 'healthy' });
  });

  // 10AM finding 11 — off and on again, the webhook still read the run, and
  // its card still told the owner to switch it off and on.
  it('is not read while switched off, and counts from its last switch-on and from the making of its secret', async () => {
    const w = await listening();
    await w.refusedApart(3);
    expect(await w.health()).toMatchObject({ status: 'degraded', refusing: { refused: 3 } });
    w.ingressStore.disable(w.ingressId);
    // Switched off: what it refused is not read, and it reads switched off.
    const off = await w.health();
    expect(off.status).toBe('disabled');
    expect(off).not.toHaveProperty('refusing');
    w.advance(MINUTE);
    w.ingressStore.enable(w.ingressId);
    // Switched on: the switch answered the run before it.
    expect(await w.health()).toMatchObject({ status: 'healthy' });
    await w.refusedApart(2);
    expect(await w.health()).not.toHaveProperty('refusing');
    await w.refusedApart(1);
    expect(await w.health()).toMatchObject({ status: 'degraded', refusing: { refused: 3 } });
    // A new secret: so did its making. The old one still verifies until retired.
    w.advance(MINUTE);
    await w.ingressStore.writeCredentialVersion(w.ingressId, { secret_token: `${SECRET}_new` });
    expect(await w.health()).toMatchObject({ status: 'healthy' });
    await w.refusedApart(3);
    expect(await w.health()).toMatchObject({ status: 'degraded', refusing: { refused: 3 } });
  });

  // 10AM finding 28 — a clock that ran ahead during a verified message hid
  // every refusal after it until the clock caught up.
  it('a verified message stamped by a clock that ran ahead hides no refusal, and gives way to the next', async () => {
    const w = await listening();
    w.advance(HOUR);
    expect(await w.send(SECRET)).toBe(200);
    const ahead = w.now();
    // The clock is set right.
    w.advance(-HOUR);
    await w.refusedApart(3);
    expect(w.ingressStore.get(w.ingressId)!.last_delivery_at).toBe(ahead);
    expect(await w.health()).toMatchObject({ status: 'degraded', refusing: { refused: 3 } });
    // The next verified message takes its place: kept, it would hold the run
    // open until the clock passed it.
    w.advance(MINUTE);
    expect(await w.send(SECRET)).toBe(200);
    expect(w.ingressStore.get(w.ingressId)!.last_delivery_at).toBe(w.now());
    expect(await w.health()).toMatchObject({ status: 'healthy' });
  });
});

describe('D-201 Slice 10AR — where a run starts', () => {
  it('the latest of the last verified message, the last switch-on and the making of the secret held, none ahead of now', () => {
    const credentials = [
      { active: true, created_at: 300 },
      { active: false, created_at: 900 },
      { active: true, created_at: 100 },
    ];
    expect(refusalRunStart({ last_delivery_at: 200, enabled_at: 250 }, credentials, 1_000)).toBe(300);
    expect(refusalRunStart({ last_delivery_at: 400, enabled_at: 250 }, credentials, 1_000)).toBe(400);
    expect(refusalRunStart({ last_delivery_at: 200, enabled_at: 500 }, credentials, 1_000)).toBe(500);
    // A retired secret answers nothing.
    expect(refusalRunStart({ last_delivery_at: null, enabled_at: null }, credentials, 1_000)).toBe(300);
    // Ahead of now: not trusted.
    expect(refusalRunStart({ last_delivery_at: 2_000, enabled_at: 250 }, credentials, 1_000)).toBe(300);
    expect(refusalRunStart({ last_delivery_at: null, enabled_at: null }, [], 1_000)).toBeNull();
  });
});

describe('D-201 Slice 10AR — the pass, webhook by webhook', () => {
  const record = (ingressId: string): WebhookIngressRecord => ({
    ingress_id: ingressId,
    profile_id: 'telegram.bot-webhook.v1',
    registration_mode: 'managed_endpoint',
    registration_state: 'registered',
    remote_endpoint_id: 'telegram_bot_123456',
    intake_state: 'enabled',
    last_delivery_at: null,
    enabled_at: 0,
  }) as unknown as WebhookIngressRecord;
  /** D-201 Slice 10AU — each webhook's notes as the store keeps them (the
   *  clamp writes them), and refusals read by the time asked: a set again
   *  needs one recorded after the last. */
  const passWorld = (options: {
    done?: number | null;
    failed?: number | null;
    refusals?: readonly number[];
  } = {}) => {
    const noted: Array<[string, string, number]> = [];
    const notes = new Map<string, { done: number | null; failed: number | null }>();
    const notesOf = (id: string) => {
      if (!notes.has(id)) notes.set(id, { done: options.done ?? null, failed: options.failed ?? null });
      return notes.get(id)!;
    };
    const refusals = options.refusals ?? [1_000, 2_000, 3_000, 4_000, 5_000];
    /** D-201 Slice 10BB — the webhooks as they stand now; one the owner
     *  switched off reads so. */
    const switchedOff = new Set<string>();
    const ingresses = {
      list: () => [record('whi_one'), record('whi_two')],
      get: (id: string) => (switchedOff.has(id)
        ? ({ ...record(id), intake_state: 'disabled' } as unknown as WebhookIngressRecord)
        : record(id)),
      listCredentialVersions: () => [],
      secretSetAgainAt: (id: string) => notesOf(id).done,
      secretSetAgainFailedAt: (id: string) => notesOf(id).failed,
      noteSecretSetAgain: (id: string, at: number) => { noted.push(['done', id, at]); notesOf(id).done = at; },
      noteSecretSetAgainFailed: (id: string, at: number) => { noted.push(['failed', id, at]); notesOf(id).failed = at; },
      clampSecretSetAgainNotes: (id: string, at: number) => {
        const held = notesOf(id);
        const ahead = (held.done !== null && held.done > at) || (held.failed !== null && held.failed > at);
        if (held.done !== null && held.done > at) held.done = at;
        if (held.failed !== null && held.failed > at) held.failed = at;
        if (ahead) noted.push(['clamped', id, at]);
        return ahead;
      },
    };
    const deliveries = {
      authenticationRefusalsSince: (_id: string, since: number | null) => {
        const after = refusals.filter((at) => since === null || at > since);
        return after.length === 0 ? null : { refused: after.length, first_at: after[0]! };
      },
    };
    return { ingresses, deliveries, noted, notesOf, switchedOff };
  };

  // 10AM finding 29 — read once, before the sweep, the pass ran on after the
  // vault locked.
  it('reads the vault and the pause before each webhook, and stops between them when the server does', async () => {
    for (const stopBy of ['canRun', 'isStopping'] as const) {
      const p = passWorld();
      let open = true;
      const setSecretAgain = vi.fn(async (ingressId: string) => {
        open = false;
        return record(ingressId);
      });
      await expect(setRefusedSecretsAgain({
        ...p,
        service: { setSecretAgain },
        now: () => 10 * HOUR,
        ...(stopBy === 'canRun' ? { canRun: () => open } : { isStopping: () => !open }),
      })).resolves.toBe(1);
      expect(setSecretAgain.mock.calls).toEqual([['whi_one']]);
    }
  });

  // 10AM finding 10 — bounded by a run's start alone, an outsider's requests
  // made Recued set a webhook again hundreds of times a day. D-201 Slice 10AU
  // (10AS finding 26) — a note ahead of now was ignored, so a clock set back
  // let the pass set a webhook again at once: it holds the hour from now.
  it('sets each again at most once an hour, done or failed, and a note ahead of now holds the hour from now', async () => {
    const now = 10 * HOUR;
    for (const [given, sets] of [
      [{ done: now - HOUR + 1 }, 0],
      [{ done: now - HOUR }, 2],
      [{ failed: now - HOUR + 1 }, 0],
      [{ failed: now - HOUR }, 2],
      [{ done: now - 2 * HOUR, failed: now - MINUTE }, 0],
      // Ahead of now: brought back to now, so the hour counts from here.
      [{ done: now + HOUR }, 0],
      [{ failed: now + HOUR }, 0],
      [{ done: now + 24 * HOUR, failed: now - 2 * HOUR }, 0],
    ] as const) {
      // Refusals since every note: the hour is what holds these.
      const p = passWorld({ ...given, refusals: [now - 3, now - 2, now - 1] });
      const setSecretAgain = vi.fn(async (ingressId: string) => record(ingressId));
      await expect(setRefusedSecretsAgain({ ...p, service: { setSecretAgain }, now: () => now })).resolves.toBe(sets);
      expect(setSecretAgain).toHaveBeenCalledTimes(sets);
    }
    expect(WEBHOOK_SECRET_SET_AGAIN_EVERY_MS).toBe(HOUR);
  });

  it('a note ahead of now is kept at now, never until the clock passes it (10AM finding 28)', async () => {
    const now = 10 * HOUR;
    const p = passWorld({ done: now + 24 * HOUR, refusals: [now - 3, now - 2, now - 1, now + 30 * MINUTE] });
    const setSecretAgain = vi.fn(async (ingressId: string) => record(ingressId));
    const pass = (at: number) => setRefusedSecretsAgain({ ...p, service: { setSecretAgain }, now: () => at });
    await expect(pass(now)).resolves.toBe(0);
    expect(p.noted).toEqual([['clamped', 'whi_one', now], ['clamped', 'whi_two', now]]);
    expect(p.notesOf('whi_one')).toEqual({ done: now, failed: null });
    await expect(pass(now + HOUR - 1)).resolves.toBe(0);
    // An hour on, a refusal recorded since: set again, a day before the clock
    // passes the note it held.
    await expect(pass(now + HOUR)).resolves.toBe(2);
  });

  // 10AS finding 5 — once per run, an outsider's refused requests while the
  // secret was right used up the run's one set again: a late set after it was
  // never undone.
  it('bounded by time alone: set again an hour on while refusals come after the last, never for a run gone quiet', async () => {
    const now = 10 * HOUR;
    const run = [now - 3 * HOUR, now - 3 * HOUR + MINUTE, now - 3 * HOUR + 2 * MINUTE];
    // Set again within this run, two hours ago; refused since: set again.
    const refusedSince = passWorld({ done: now - 2 * HOUR, refusals: [...run, now - 30 * MINUTE] });
    const set = vi.fn(async (ingressId: string) => record(ingressId));
    await expect(setRefusedSecretsAgain({ ...refusedSince, service: { setSecretAgain: set }, now: () => now }))
      .resolves.toBe(2);
    // Nothing refused since the last: not set again, the run still standing.
    const quiet = passWorld({ done: now - 2 * HOUR, refusals: run });
    expect(refusalStateOf(quiet, record('whi_one'), now)).toMatchObject({ run: { refused: 3 } });
    const notSet = vi.fn(async (ingressId: string) => record(ingressId));
    await expect(setRefusedSecretsAgain({ ...quiet, service: { setSecretAgain: notSet }, now: () => now }))
      .resolves.toBe(0);
    expect(notSet).not.toHaveBeenCalled();
    // A failed try needs none: nothing was set, so the refusals stand unanswered.
    const failed = passWorld({ failed: now - 2 * HOUR, refusals: run });
    const retried = vi.fn(async (ingressId: string) => record(ingressId));
    await expect(setRefusedSecretsAgain({ ...failed, service: { setSecretAgain: retried }, now: () => now }))
      .resolves.toBe(2);
  });

  // 10AS finding 27 — refused under the lock (switched off since the pass's
  // snapshot), it was noted as a failed try and held the next an hour.
  it('a webhook the service will not set again, as it stands under its lock, is no failed try', async () => {
    const p = passWorld();
    const log = vi.fn();
    await expect(setRefusedSecretsAgain({
      ...p,
      service: { setSecretAgain: async () => null },
      now: () => 10 * HOUR,
      log,
    })).resolves.toBe(0);
    expect(p.noted).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  // D-201 Slice 10BB (10AY finding 8) — switched off while the set again was
  // under way, it stopped there: no failed try. A webhook still taking
  // messages whose set again fails is one, as before.
  it('a set again the owner switched the webhook off during is no failed try; one that fails as it stands is', async () => {
    const p = passWorld();
    const log = vi.fn();
    const setSecretAgain = vi.fn(async (ingressId: string) => {
      if (ingressId === 'whi_one') p.switchedOff.add(ingressId);
      throw Object.assign(new Error('the webhook changed while it was set again'), { code: 'state_changed' });
    });
    await expect(setRefusedSecretsAgain({ ...p, service: { setSecretAgain }, now: () => 10 * HOUR, log }))
      .resolves.toBe(0);
    expect(setSecretAgain).toHaveBeenCalledTimes(2);
    expect(p.noted).toEqual([['failed', 'whi_two', 10 * HOUR]]);
    expect(log).toHaveBeenCalledTimes(1);
    // A fault reading it says no: the failed try is noted, as before.
    const q = passWorld();
    await expect(setRefusedSecretsAgain({
      ...q,
      ingresses: { ...q.ingresses, get: () => { throw new Error('the database is busy'); } },
      service: { setSecretAgain: async () => { throw new Error('upstream refused'); } },
      now: () => 10 * HOUR,
    })).resolves.toBe(0);
    expect(q.noted.map(([kind]) => kind)).toEqual(['failed', 'failed']);
  });

  // What the card says Recued does is what the pass does: one reader.
  it('a webhook not set up at its service, or switched off, is neither set again nor said to be', async () => {
    for (const [change, read] of [
      [{}, 'sets'],
      [{ registration_state: 'drifted' }, 'sets'],
      [{ intake_state: 'degraded' }, 'sets'],
      [{ registration_state: 'cleanup_pending' }, 'says no'],
      [{ registration_state: 'unregistered' }, 'says no'],
      [{ remote_endpoint_id: null }, 'says no'],
      [{ registration_mode: 'manual' }, 'says no'],
      [{ profile_id: 'stripe.event.v1' }, 'says no'],
      [{ intake_state: 'disabled' }, 'reads none'],
      [{ intake_state: 'ready' }, 'reads none'],
      [{ intake_state: 'verification_pending' }, 'reads none'],
    ] as const) {
      // A world each: a set again is noted, and holds the next an hour.
      const p = passWorld();
      const ingress = { ...record('whi_one'), ...change } as WebhookIngressRecord;
      const state = refusalStateOf(p, ingress, 10 * HOUR);
      expect(state === null ? 'reads none' : state.sets_again ? 'sets' : 'says no').toBe(read);
      const setSecretAgain = vi.fn(async (ingressId: string) => record(ingressId));
      await setRefusedSecretsAgain({
        ...p, ingresses: { ...p.ingresses, list: () => [ingress] }, service: { setSecretAgain }, now: () => 10 * HOUR,
      });
      expect(setSecretAgain).toHaveBeenCalledTimes(read === 'sets' ? 1 : 0);
    }
  });

  it('notes a try that failed, so the next waits the hour too', async () => {
    const p = passWorld();
    const log = vi.fn();
    await expect(setRefusedSecretsAgain({
      ...p,
      service: { setSecretAgain: async () => { throw new Error('Telegram is down'); } },
      now: () => 10 * HOUR,
      log,
    })).resolves.toBe(0);
    expect(p.noted).toEqual([['failed', 'whi_one', 10 * HOUR], ['failed', 'whi_two', 10 * HOUR]]);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
