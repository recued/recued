/** D-339 slice 21 (2026-11-19, the owner: "do the smaller setup items") — Connect Apple Health on a Body's page.
 *  The module against a stub of the server's calls, and the page's wiring by its source. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WebhookIngressView } from '@recued/contracts';
import {
  APPLE_HEALTH_HEADER, APPLE_HEALTH_PROFILE, APPLE_HEALTH_WEBHOOK_NAME, createAppleHealthConnect, newWebhookToken, type AppleHealthMethod,
} from '../yours/body-apple-health.js';

/** A webhook as the server lists it: keyed or not, its address, its state and why it is closed. */
const ingress = (over: Partial<WebhookIngressView> & { keyed?: boolean; registered?: boolean; blockers?: string[]; last?: number | null } = {}): WebhookIngressView => {
  const { keyed = true, registered = true, blockers = [], last = null, ...rest } = over;
  return {
    ingress_id: 'wh-1', public_id: 'pub-1', display_name: APPLE_HEALTH_WEBHOOK_NAME, profile_id: APPLE_HEALTH_PROFILE, environment: 'live',
    paired_connection_id: null, registration_target: null, registration_mode: 'manual', endpoint_url: 'https://home.example/v1/webhooks/pub-1',
    remote_endpoint_id: null, selected_event_types: ['delivery'], registration_state: registered ? 'confirmed' : 'unconfirmed', intake_state: 'ready',
    configured_fields: keyed ? ['header_name', 'header_token'] : [], missing_required_fields: keyed ? [] : ['header_name', 'header_token'],
    active_credential_versions: [], created_at: 1, updated_at: 1, enabled_at: null,
    readiness: { credentials_complete: keyed, registration_complete: registered, can_enable: blockers.length === 0, blockers },
    health: { status: 'healthy', test_observed_at: null, last_delivery_at: last, last_error_code: null },
    ...rest,
  } as unknown as WebhookIngressView;
};

/** The server's calls, each answered from `answers` (a value, a function of the params, or an Error to refuse). */
const stub = (answers: Partial<Record<AppleHealthMethod, unknown>>) => {
  const calls: Array<[AppleHealthMethod, unknown]> = [];
  const call = async (method: AppleHealthMethod, params?: unknown) => {
    calls.push([method, params]);
    const answer = answers[method];
    const value = typeof answer === 'function' ? (answer as (p: unknown) => unknown)(params) : answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, call, methods: () => calls.map(([method]) => method) };
};

describe('D-339 slice 21 — the webhook for the Shortcut', () => {
  it('makes a token of 32 random bytes, as 43 characters a header can carry, different each time', () => {
    const fixed = newWebhookToken(bytes => bytes.fill(0xfb));
    expect(fixed).toHaveLength(43);
    expect(fixed).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fixed).toBe(Buffer.alloc(32, 0xfb).toString('base64url'));
    const tokens = new Set(Array.from({ length: 50 }, () => newWebhookToken()));
    expect(tokens.size).toBe(50);
  });

  it('makes the webhook, writes its keys, confirms its address and lets messages in, in that order', async () => {
    const made = ingress({ keyed: false, registered: false });
    const server = stub({ 'webhook.ingress.create': { ingress: made }, 'webhook.ingress.credentials.write': { ingress: ingress({ registered: false }) },
      'webhook.ingress.manual.confirm': { ingress: ingress() }, 'webhook.ingress.enable': { ingress: ingress({ intake_state: 'enabled' }) },
      'webhook.ingress.get': { ingress: ingress({ intake_state: 'enabled' }) } });
    const prepared = await createAppleHealthConnect({ call: server.call, token: () => 'tok-made-here' }).prepare();
    expect(server.methods()).toEqual(['webhook.ingress.create', 'webhook.ingress.credentials.write', 'webhook.ingress.manual.confirm',
      'webhook.ingress.enable', 'webhook.ingress.get']);
    expect(server.calls[0]![1]).toEqual({ display_name: 'Apple Health on my iPhone', profile_id: 'generic.static-header-token.v1', environment: 'live',
      registration_mode: 'manual', selected_event_types: ['delivery'] });
    expect(server.calls[1]![1]).toEqual({ ingress_id: 'wh-1', credentials: { header_name: APPLE_HEALTH_HEADER, header_token: 'tok-made-here' } });
    expect(APPLE_HEALTH_HEADER).toBe('X-Recued-Token');
    expect(prepared).toEqual({ token: 'tok-made-here', webhook: { ingress_id: 'wh-1', address: 'https://home.example/v1/webhooks/pub-1', open: true,
      keyed: true, blockers: [], last_post_at: null } });
  });

  it('is still made when the server cannot take a post from a phone yet, and says why', async () => {
    const closed = ingress({ endpoint_url: null, registered: false, blockers: ['registration_incomplete', 'public_url_unavailable'] });
    const server = stub({ 'webhook.ingress.create': { ingress: ingress({ keyed: false, registered: false, endpoint_url: null }) },
      'webhook.ingress.credentials.write': { ingress: closed },
      'webhook.ingress.manual.confirm': new Error('webhook.ingress.manual.confirm: no public address'),
      'webhook.ingress.enable': new Error('webhook.ingress.enable: not ready'), 'webhook.ingress.get': { ingress: closed } });
    const prepared = await createAppleHealthConnect({ call: server.call, token: () => 'tok' }).prepare();
    expect(prepared.token).toBe('tok');
    // Only what the owner must mend elsewhere: confirming the address is this step's own, and it retries it each time.
    expect(prepared.webhook).toMatchObject({ open: false, keyed: true, address: null, blockers: ['public_url_unavailable'] });
  });

  it('finishes the one found: keys only when it has none, the address only when unconfirmed, and no new webhook', async () => {
    const keyedClosed = ingress({ intake_state: 'disabled' });
    const server = stub({ 'webhook.ingress.get': { ingress: keyedClosed }, 'webhook.ingress.enable': { ingress: ingress({ intake_state: 'enabled' }) } });
    const prepared = await createAppleHealthConnect({ call: server.call, token: () => 'never' }).prepare('wh-1');
    // Its keys and its address stand: only the opening, and no token to show.
    expect(server.methods()).toEqual(['webhook.ingress.get', 'webhook.ingress.enable', 'webhook.ingress.get']);
    expect(prepared.token).toBeUndefined();
    const unkeyed = stub({ 'webhook.ingress.get': { ingress: ingress({ keyed: false }) }, 'webhook.ingress.credentials.write': { ingress: ingress() } });
    const finished = await createAppleHealthConnect({ call: unkeyed.call, token: () => 'tok-2' }).prepare('wh-1');
    expect(unkeyed.methods()).not.toContain('webhook.ingress.create');
    expect(unkeyed.methods()).toContain('webhook.ingress.credentials.write');
    expect(finished.token).toBe('tok-2');
  });

  it('fails when its keys cannot be written, rather than pass a webhook with none for made', async () => {
    const server = stub({ 'webhook.ingress.create': { ingress: ingress({ keyed: false }) },
      'webhook.ingress.credentials.write': new Error('Unlock your server’s keys') });
    await expect(createAppleHealthConnect({ call: server.call, token: () => 'tok' }).prepare()).rejects.toThrow('Unlock your server’s keys');
    expect(server.methods()).not.toContain('webhook.ingress.enable');
  });

  it('finds its own webhook, the newest made here and not retired, and whether the pack is installed', async () => {
    const server = stub({
      'webhook.ingress.list': { ingresses: [
        ingress({ ingress_id: 'old', created_at: 1 }),
        ingress({ ingress_id: 'newest', created_at: 3, intake_state: 'enabled', last: 99 }),
        ingress({ ingress_id: 'retired', created_at: 9, intake_state: 'retired' }),
        ingress({ ingress_id: 'other-name', created_at: 9, display_name: 'Home Assistant' }),
        ingress({ ingress_id: 'other-profile', created_at: 9, profile_id: 'github.v1' as never }),
      ], profiles: [] },
      'packs.list': { packs: [{ slug: 'body-signals', installed: true }, { slug: 'body-signals-apple-health', installed: true }] },
    });
    const state = await createAppleHealthConnect({ call: server.call }).state();
    expect(state).toEqual({ installed: true, webhook: { ingress_id: 'newest', address: 'https://home.example/v1/webhooks/pub-1', open: true, keyed: true,
      blockers: [], last_post_at: 99 } });
    const none = stub({ 'webhook.ingress.list': { ingresses: [], profiles: [] }, 'packs.list': { packs: [{ slug: 'body-signals-apple-health', installed: false }] } });
    expect(await createAppleHealthConnect({ call: none.call }).state()).toEqual({ installed: false });
  });
});

describe('⛔ D-339 slice 21 — Connect Apple Health on a Body\'s page', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');
  const bootstrap = readFileSync(new URL('../webclient-bootstrap.ts', import.meta.url), 'utf8');

  it('offers it on every Body, opening the form with where its steps stand', () => {
    expect(route).toMatch(/if \(options\.appleHealth && asset\.class_id === BODY_CLASS_ID\) \{\s+const appleHealth = options\.appleHealth;\s+button\(readingActions, 'Connect Apple Health', loadEditor\(async \(\) => \(\{ type: 'apple_health', asset, state: await appleHealth\.state\(\) \}\)\), 'apple-health'\);/u);
    expect(bootstrap).toMatch(/appleHealth: createAppleHealthConnect\(\{ call: \(method, params\) => rpcConn\.call\(method, params as never\) as Promise<unknown> \}\),/u);
  });

  it('keeps the form open after the step, with the token until it closes, and leaves the install to the pack\'s own review', () => {
    expect(route).toMatch(/const prepareAppleHealth = \(value: Extract<Editor, \{ type: 'apple_health' \}>\) => write\(async \(\): Promise<YoursCommandResult> => \{/u);
    expect(route).toMatch(/editor = \{ \.\.\.value, state: \{ \.\.\.value\.state, webhook: prepared\.webhook \}, \.\.\.\(token \? \{ token \} : \{\}\) \};\s+return \{ message: [^\n]+\};\s+\}, true\);/u);
    expect(route).toMatch(/link\(second, 'Install Body signals from Apple Health', `#packs\/\$\{encodeURIComponent\(APPLE_HEALTH_PACK\)\}`\)/u);
    expect(route).not.toMatch(/packs\.install'/u);
  });

  it('says why a webhook is closed in the webhooks page\'s own words', () => {
    expect(route).toMatch(/import \{ blockerLabel as webhookBlockerWords \} from '\.\.\/connections\/webhooks-panel\.js';/u);
    expect(route).toMatch(/for \(const blocker of webhook\.blockers\) el\('li', webhookBlockerWords\[blocker\] \?\? blocker, why\);/u);
  });
});

describe('⛔ D-339 slice 23 — chat\'s step for a Body with no readings opens Connect Apple Health', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');

  it('opens the form once from `#yours/asset/<id>/setup/body-signals-apple-health`, after reading where it stands', () => {
    expect(route).toMatch(/const setupFor = selected && segments\[2\] === 'setup' && segments\[3\] === APPLE_HEALTH_PACK && options\.appleHealth\s+\? snapshot\?\.assets\.find\(row => row\.id === selected && row\.class_id === BODY_CLASS_ID\) : undefined;/u);
    expect(route).toMatch(/if \(setupFor && options\.appleHealth && !editor && !routeEditorOpened\) \{\s+routeEditorOpened = true;/u);
    expect(route).toMatch(/void options\.appleHealth\.state\(\)\.then\(state => \{ if \(!disposed && !editor\) open\(\{ type: 'apple_health', asset: setupFor, state, \.\.\.\(back \? \{ returnToChat: back \} : \{\}\) \}\); \},/u);
  });

  it('offers Back to chat when it came from an answer', () => {
    expect(route).toMatch(/const back = segments\[4\] === 'return' && segments\[5\] === 'chat' && segments\[6\] && segments\[7\] && segments\.length === 8/u);
    expect(route).toMatch(/if \(value\.returnToChat\) \{ const back = link\(node, 'Back to chat', serializeChatAnswerAddress\(value\.returnToChat\)\); back\.dataset\.yoursBackToChat = ''; \}/u);
  });
});

describe('⛔ D-339 slice 24 — the pack\'s install with no webhook opens Connect Apple Health on the owner\'s Body', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');

  it('`#yours/setup/body-signals-apple-health` finds the Body: one opens its form, none the form to add one, several are asked about', () => {
    expect(route).toMatch(/if \(segments\[0\] === 'setup' && segments\[1\] === APPLE_HEALTH_PACK && options\.appleHealth && !editor && !routeEditorOpened\) \{\s+routeEditorOpened = true;/u);
    expect(route).toMatch(/if \(bodies\.length === 1\) doc\.defaultView\.location\.replace\(serializeShellRoute\('yours', 'asset', bodies\[0\]!\.id, 'setup', APPLE_HEALTH_PACK\)\);/u);
    expect(route).toMatch(/else if \(bodies\.length === 0\) doc\.defaultView\.location\.replace\(serializeShellRoute\('yours', 'new', BODY_CLASS_ID\)\);\s+else open\(\{ type: 'apple_health_body', bodies \}\);/u);
  });

  it('reads every page of the owner\'s things for their Bodies, leaving a retired one out', () => {
    expect(route).toMatch(/const page = await options\.read\(\{ offset, limit: 200 \}\);\s+for \(const asset of page\.assets\) if \(asset\.class_id === BODY_CLASS_ID && asset\.status !== 'retired'\) found\.set\(asset\.id, asset\);/u);
    expect(route).toMatch(/if \(page\.assets\.length < 200 \|\| offset >= \(page\.total_assets \?\? offset\)\) break;/u);
  });
});
