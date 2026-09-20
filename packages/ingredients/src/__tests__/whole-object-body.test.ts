/** A whole-object `body` is a body, not a silently dropped argument.
 *
 *  ⛔⛔ THE DEFECT THIS CLOSES. `buildConnectionApiBody` read `body_raw`, then
 *  `extractDotPrefix(params, 'body')`, and returned `undefined` otherwise — so a
 *  caller sending `{ body: { name: 'Acme' } }` produced NO REQUEST BODY. 76
 *  operations across 20 packs declare exactly that argument
 *  (`{ key: 'body', type: 'object' }`) with no dotted alternative, 43 of them
 *  pairing it with an `editable_args` entry of `type: 'json'` so the owner can
 *  review the payload on the approval card. Every call to them posted empty, and
 *  eight shipped WRITE recipes were doing so in production shape — a Zuora
 *  billing account created with no fields, a HelpScout reply with no text.
 *
 *  🔑 WHY THE ADAPTER MOVED AND NOT THE 76 OPERATIONS. A free-form payload is
 *  the correct model for the endpoints they wrap: a Zoho CRM record carries
 *  per-tenant CUSTOM fields, so enumerating them as `body.<k>` is impossible in
 *  principle, not merely tedious. 76 authors declaring the same argument, with
 *  an editor for it, is evidence about the contract rather than about the
 *  authors.
 *
 *  ⚠ EVERY COMBINATION REFUSES RATHER THAN PICKING A WINNER, which is this
 *  file's own rule: *"a silent precedence rule is how a caller ships the wrong
 *  body and never learns."* `body_raw` still wins, because that precedence is
 *  documented and predates this.
 */
import { describe, expect, it } from 'vitest';

import { buildConnectionApiBody } from '../connection-api.js';

const headers = (init?: Record<string, string>): Headers => new Headers(init);

describe('connection.api builds a body from a whole-object `body`', () => {
  it('serialises it as JSON and defaults the content type', () => {
    const h = headers();
    expect(buildConnectionApiBody({ body: { name: 'Acme', currency: 'USD' } }, h))
      .toBe('{"name":"Acme","currency":"USD"}');
    expect(h.get('Content-Type')).toBe('application/json');
  });

  it('leaves an author-set content type alone', () => {
    const h = headers({ 'Content-Type': 'application/vnd.api+json' });
    buildConnectionApiBody({ body: { a: 1 } }, h);
    expect(h.get('Content-Type')).toBe('application/vnd.api+json');
  });

  it('sends a string body verbatim, like `body_raw` and the http adapter', () => {
    expect(buildConnectionApiBody({ body: 'already-encoded' }, headers())).toBe('already-encoded');
  });

  it('⛔ refuses `body` combined with `body.<k>` instead of choosing', () => {
    expect(() => buildConnectionApiBody({ body: { a: 1 }, 'body.b': 2 }, headers()))
      .toThrow(/exclusive/);
  });

  it('⛔ refuses `body` combined with exact decimal-integer serialisation', () => {
    // That spec names `body.<k>` fields; applying it to a whole object would
    // silently serialise different bytes than the caller asked for.
    expect(() => buildConnectionApiBody(
      { body: { a: 1 }, __rc_json_decimal_integer_fields: ['a'] },
      headers(),
    )).toThrow(/decimal-integer/);
  });

  it('keeps `body_raw` winning — that precedence is documented and unchanged', () => {
    expect(buildConnectionApiBody({ body_raw: 'raw-wins', body: { a: 1 } }, headers()))
      .toBe('raw-wins');
  });

  it('treats a null `body` as absent rather than as an empty payload', () => {
    expect(buildConnectionApiBody({ body: null }, headers())).toBeUndefined();
    expect(buildConnectionApiBody({ body: null, 'body.a': 1 }, headers())).toBe('{"a":1}');
  });

  it('still builds from `body.<k>` when that is what the caller sent', () => {
    // ⛔ THE CONTROL. Without it, a change that broke the dotted path entirely
    // would pass every assertion above.
    expect(buildConnectionApiBody({ 'body.name': 'Acme' }, headers())).toBe('{"name":"Acme"}');
    expect(buildConnectionApiBody({}, headers())).toBeUndefined();
  });
});
