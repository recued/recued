/** `body_field` connection auth — credentials the vendor reads from the JSON
 *  request BODY.
 *
 *  ⛔⛔ WHY THIS AUTH TYPE EXISTS. Every other member of `ConnectionAuth` writes
 *  to a header or the query string; `injectAuth` had no body write at all. So a
 *  vendor that reads its credential out of the POST body had nowhere inside the
 *  encrypted connection record to put it, and the only place left was a plain
 *  recipe `config.*` string — which is captured VERBATIM into every run's audit
 *  `config_snapshot`. The shipped `plaid` pack is exactly that: `body.access_token`
 *  is a required plain-string op argument on ~100 operations, and it is a durable
 *  bank credential.
 *
 *  ⛔⛔ AND WHY IT IS PER-OPERATION. Injecting into every call is the obvious
 *  design and is measurably wrong: `sandbox.plaid.com` answers `UNKNOWN_FIELDS`
 *  to an unexpected body key, and Plaid's own `/link/token/create` takes no
 *  access_token — a connection-wide injection would break the enrollment flow of
 *  the vendor this exists for. The opt-in is asserted below in BOTH directions,
 *  because a test that only checks "the credential arrives" cannot tell a
 *  correct injector from one that injects everywhere.
 */
import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import {
  HTTP_AUTH_BODY_FIELDS_WIRE_KEY,
  validateBodyFieldAuthEntries,
} from '@recued/contracts';
import { createConnectionApiHandler } from '../connection-api.js';
import type { ConnectionApiHandlerDeps } from '../connection-api.js';
import type { ResolvedCall } from '../types.js';

const ROW: ConnectionRow = {
  pk: 'api:plaid',
  kind: 'api',
  name: 'plaid',
  display_name: 'Plaid (Chase)',
  config_json: '{"base_url":"https://sandbox.plaid.com"}',
  auth_ciphertext: 'opaque-blob',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const CALL: ResolvedCall = { slug: 'plaid', risk_tier: 'read', input: {}, output: {} };

/** ⚠ Two fields, not one — an injector that grabbed `entries[0]` regardless of
 *  the requested name would pass a single-field fixture. */
const AUTH: ConnectionAuth = {
  type: 'body_field',
  fields: [
    { field_name: 'access_token', value: 'access-sandbox-SECRET' },
    { field_name: 'client_id', value: 'client-SECRET' },
  ],
};

interface Wire { url: string; method: string; body: string | undefined }

const run = async (
  params: Record<string, unknown>,
  auth: ConnectionAuth = AUTH,
): Promise<{ wire: Wire[]; body: Record<string, unknown> | undefined }> => {
  const wire: Wire[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    wire.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body == null ? undefined : String(init.body),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const deps: ConnectionApiHandlerDeps = {
    decodeAuth: async () => auth,
    persistAuth: async () => {},
    fetchImpl,
  };
  await createConnectionApiHandler(deps)(ROW, params, CALL);
  const raw = wire[0]?.body;
  return {
    wire,
    body: raw === undefined
      ? undefined
      : (JSON.parse(raw) as Record<string, unknown>),
  };
};

/** The op-side opt-in as the gateway writes it. */
const wants = (...names: string[]): Record<string, unknown> =>
  ({ [HTTP_AUTH_BODY_FIELDS_WIRE_KEY]: JSON.stringify(names) });

describe('body_field auth — the opt-in decides, in both directions', () => {
  it('injects the named credential into an operation that asked for it', async () => {
    const { body } = await run({
      method: 'POST', path: '/item/get', ...wants('access_token'),
    });
    expect(body).toEqual({ access_token: 'access-sandbox-SECRET' });
  });

  it('⛔ leaves an operation that asked for NOTHING completely untouched', async () => {
    // This is the assertion the design turns on. `/link/token/create` carries no
    // access_token, and Plaid rejects the request outright if one appears.
    const { body } = await run({
      method: 'POST', path: '/link/token/create', 'body.client_name': 'Recued',
    });
    expect(body).toEqual({ client_name: 'Recued' });
    expect(JSON.stringify(body)).not.toMatch(/SECRET/u);
  });

  it('⛔ injects ONLY the named field, not every field the record holds', async () => {
    const { body } = await run({
      method: 'POST', path: '/item/get', ...wants('access_token'),
    });
    expect(body).toHaveProperty('access_token');
    expect(body).not.toHaveProperty('client_id');   // held, but not requested
  });

  it('injects several when several are named, and keeps the op’s own fields', async () => {
    const { body } = await run({
      method: 'POST',
      path: '/transactions/get',
      'body.start_date': '2026-01-01',
      ...wants('access_token', 'client_id'),
    });
    expect(body).toEqual({
      start_date: '2026-01-01',
      access_token: 'access-sandbox-SECRET',
      client_id: 'client-SECRET',
    });
  });

  it('adds a body to an operation that had none', async () => {
    // Plaid's `/item/get` takes exactly `{"access_token": …}` and nothing else,
    // so refusing an absent body would make the no-argument case unreachable.
    const { body } = await run({ method: 'POST', path: '/item/get', ...wants('access_token') });
    expect(body).toEqual({ access_token: 'access-sandbox-SECRET' });
  });

  it('overwrites rather than duplicating when the op already set the key', async () => {
    // Idempotence by construction — the 401 re-auth path calls injectAuth a
    // second time on the same request.
    const { body } = await run({
      method: 'POST',
      path: '/item/get',
      'body.access_token': 'a-stale-value-from-an-arg',
      ...wants('access_token'),
    });
    expect(body).toEqual({ access_token: 'access-sandbox-SECRET' });
  });
});

describe('body_field auth — fails closed rather than sending a request without the credential', () => {
  const rejects = async (params: Record<string, unknown>, auth?: ConnectionAuth) =>
    expect(run(params, auth)).rejects.toMatchObject({
      code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    });

  it('⛔ a name this connection does not carry FAILS the call', async () => {
    // Skipping it would send the request with the credential quietly missing;
    // the vendor's reply would then be a generic auth error, sending the owner
    // to re-check a key that was never wrong.
    await rejects({ method: 'POST', path: '/item/get', ...wants('secret') });
  });

  it('⛔ a reserved object key is refused at the assignment site', async () => {
    await rejects({ method: 'POST', path: '/item/get', ...wants('__proto__') });
  });

  it('⛔ a GET cannot carry one', async () => {
    await rejects({ method: 'GET', path: '/item/get', ...wants('access_token') });
  });

  it('⛔ a non-JSON content type is refused, not guessed at', async () => {
    // ⚠ THE BODY HERE IS DELIBERATELY VALID JSON. The obvious fixture — a
    // form-encoded content type with `body.a: '1'` — makes `buildBody` emit
    // `a=1`, which fails JSON.parse, so the test passes on the PARSE branch and
    // says nothing about the content type. Mutation-checked: deleting the
    // content-type refusal left that version green. A JSON-parseable body with
    // a non-JSON label is the only input that reaches this branch.
    await expect(run({
      method: 'POST',
      path: '/item/get',
      'header.Content-Type': 'application/x-www-form-urlencoded',
      body_raw: '{"a":1}',
      ...wants('access_token'),
    })).rejects.toMatchObject({
      code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      // asserted on the message, because the parse branch throws the same code
      message: expect.stringContaining('needs a JSON content type'),
    });
    // and the parse branch is a DIFFERENT message, so the two are separable
    await expect(run({ method: 'POST', path: '/x', body_raw: 'nope', ...wants('access_token') }))
      .rejects.toMatchObject({ message: expect.stringContaining('did not parse') });
  });

  it('⛔ a body that is an array has nowhere to put a named field', async () => {
    await rejects({ method: 'POST', path: '/x', body_raw: '[1,2]', ...wants('access_token') });
  });

  it('⛔ an unparseable body fails rather than being replaced', async () => {
    await rejects({ method: 'POST', path: '/x', body_raw: 'not json', ...wants('access_token') });
  });

  it('⛔ a malformed auth record is rejected before any request', async () => {
    await rejects(
      { method: 'POST', path: '/item/get', ...wants('access_token') },
      { type: 'body_field', fields: [] } as unknown as ConnectionAuth,
    );
  });
});

describe('body_field auth — the wire key is engine-owned', () => {
  it('a malformed opt-in injects nothing rather than failing every call', async () => {
    // The key is written by the engine, so a bad one is our bug — and failing
    // every call on the connection would be worse than behaving as the
    // operation did before the opt-in existed. An op that truly needs the
    // credential still fails loudly, at the vendor.
    const { body } = await run({
      method: 'POST',
      path: '/item/get',
      'body.a': '1',
      [HTTP_AUTH_BODY_FIELDS_WIRE_KEY]: 'not-json',
    });
    expect(body).toEqual({ a: '1' });
  });

  it('an empty list is the same as no opt-in', async () => {
    const { body } = await run({
      method: 'POST', path: '/item/get', 'body.a': '1', ...wants(),
    });
    expect(body).toEqual({ a: '1' });
  });
});

describe('body_field auth — the contract validator', () => {
  it('accepts a well-formed set and normalizes to the entry shape', () => {
    const r = validateBodyFieldAuthEntries([{ field_name: 'access_token', value: 'v' }]);
    expect(r).toEqual({ ok: true, entries: [{ field_name: 'access_token', value: 'v' }] });
  });

  it('⛔ rejects the same shapes header auth rejects', () => {
    expect(validateBodyFieldAuthEntries([]).ok).toBe(false);
    expect(validateBodyFieldAuthEntries('x').ok).toBe(false);
    expect(validateBodyFieldAuthEntries([{ field_name: '__proto__', value: 'v' }]).ok).toBe(false);
    expect(validateBodyFieldAuthEntries([{ field_name: 'a', value: '  ' }]).ok).toBe(false);
    expect(validateBodyFieldAuthEntries([{ field_name: '  ', value: 'v' }]).ok).toBe(false);
    // ⚠ INHERITED, not own — a crafted in-process object must not satisfy it.
    expect(validateBodyFieldAuthEntries(
      [Object.create({ field_name: 'a', value: 'v' })],
    ).ok).toBe(false);
    // ⛔ and it must not accept a header-shaped entry: the two vocabularies are
    // distinct, and a validator that took either would let an enroll payload
    // pass here and inject nothing at dispatch.
    expect(validateBodyFieldAuthEntries([{ header_name: 'a', value: 'v' }]).ok).toBe(false);
  });
});
