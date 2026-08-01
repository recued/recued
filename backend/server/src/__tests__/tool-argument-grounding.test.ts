import { describe, expect, it } from 'vitest';

import {
  ungroundedArgumentsDetail,
  ungroundedArgumentsInCall,
} from '../tool-argument-grounding.js';

/** ⛔⛔ THE PERMITTING CASES ARE THE IMPORTANT HALF OF THIS SUITE.
 *
 *  This check REFUSES A DISPATCH on the hot path of every chat turn, so a false
 *  positive does not degrade a metric — it breaks a working assistant. The
 *  refusing cases below only prove it is capable of refusing; a blanket
 *  "refuse everything" would pass all of them. What separates a guard from a
 *  wall is the set of calls it must let through, and those are first. */
describe('tool-argument grounding — what must still dispatch', () => {
  it('passes a value the owner typed', () => {
    const packet = 'user_message: email pat.lee@northwind-corp.com about the renewal';
    expect(ungroundedArgumentsInCall(
      { to: 'pat.lee@northwind-corp.com' }, packet,
    )).toEqual([]);
  });

  it('passes a value a completed step returned', () => {
    const packet = JSON.stringify({
      prior_tool_calls: [{ tool: 'contact.search', result: { candidates: [{ record: { email: 'pat@x.io' } }] } }],
    });
    expect(ungroundedArgumentsInCall({ to: 'pat@x.io' }, packet)).toEqual([]);
  });

  /** ⛔ THE PREFETCH CASE, and it would have been the first production break.
   *  D-167 resolves entities server-side and hands the model an alias it never
   *  fetched with a tool; bench 178 showed a model answering correctly with
   *  ZERO tool calls from exactly that. The packet carries the block, so the
   *  alias grounds — but only because the corpus is the WHOLE body. */
  it('passes a D-167 prefetch alias the model never fetched itself', () => {
    const packet = JSON.stringify({
      prefetch_context: ['- pii.Person2 (contact, ref: pii.Person2@d1.invalid)'],
    });
    expect(ungroundedArgumentsInCall(
      { email: 'pii.Person2@d1.invalid' }, packet,
    )).toEqual([]);
  });

  it('passes a value differing only in case', () => {
    expect(ungroundedArgumentsInCall(
      { email: 'Pat.Lee@Northwind-Corp.com' },
      'contact: pat.lee@northwind-corp.com',
    )).toEqual([]);
  });

  /** ⚠ DESCRIPTIVE values are never gated. The model composes search text,
   *  notes and labels itself, and requiring those to pre-exist would refuse
   *  most ordinary turns. Only values that IDENTIFY must be sourced. */
  it('passes model-composed descriptive text', () => {
    expect(ungroundedArgumentsInCall({
      query: 'northwind renewal draft figures',
      note: 'Following up after the call about pricing',
      label: 'Flat 2',
    }, 'user_message: what is happening with northwind?')).toEqual([]);
  });

  /** ⛔ THE ONE FALSE POSITIVE THE CALIBRATION FOUND, verbatim. Over 6500 live
   *  tool calls this was the single legitimate call the first cut refused: the
   *  address is real and the model had read it, wrapped in a search operator.
   *  Both directions are asserted, because the fix must not launder an
   *  invention wrapped in the same operator. */
  it('passes a real address wrapped in a search operator — but not an invented one', () => {
    const packet = 'from pat.lee.bench9q2@northwind-bench-corp.com about renewal';
    expect(ungroundedArgumentsInCall(
      { query: 'from:pat.lee.bench9q2@northwind-bench-corp.com' }, packet,
    )).toEqual([]);
    expect(ungroundedArgumentsInCall(
      { query: 'from:sarah.chen@northwind.com' }, packet,
    )[0]?.why).toBe('ungrounded');
  });

  it('passes short, numeric and enum-ish values', () => {
    expect(ungroundedArgumentsInCall(
      { id: '42', status: 'open', kind: 'invoice', limit: '10', order: 'desc' },
      'nothing here',
    )).toEqual([]);
  });

  /** ⛔ A reserved domain the owner actually typed. It was originally treated as
   *  a placeholder and refused outright, which broke three existing executor
   *  tests using the `@example.com` fixture convention — the tests were right.
   *  Suspicious, so it must be grounded; grounded, so it dispatches. */
  it('passes a reserved-domain address the owner typed', () => {
    expect(ungroundedArgumentsInCall(
      { recipient: 'alice@example.com' }, 'user_message: email alice@example.com',
    )).toEqual([]);
    // …and still refuses the same shape when nothing sourced it.
    expect(ungroundedArgumentsInCall(
      { recipient: 'alice@example.com' }, 'user_message: email the team',
    )[0]?.why).toBe('ungrounded');
  });

  it('passes an empty or absent args object', () => {
    expect(ungroundedArgumentsInCall({}, 'packet')).toEqual([]);
    expect(ungroundedArgumentsInCall(undefined, 'packet')).toEqual([]);
  });
});

describe('tool-argument grounding — what must be refused', () => {
  /** ⛔⛔ VERBATIM FROM BENCH 181. The model was handed a chain that cannot be
   *  batched and issued `list-buildings` and `add-unit` in the SAME round,
   *  supplying a `building_id` no call had returned yet. */
  it('refuses the placeholder join from the live flattened chain', () => {
    const found = ungroundedArgumentsInCall(
      { building_id: '__first__', label: 'Flat 2' },
      JSON.stringify({ user_message: 'list my buildings, add a unit to the first' }),
    );
    expect(found).toEqual([
      { path: 'building_id', value: '__first__', why: 'underscore placeholder' },
    ]);
  });

  /** Also from 181 — an invented id that LOOKS plausible, which is the harder
   *  case: nothing about `building_1` reads as a placeholder. */
  it('refuses a plausible-looking id no step returned', () => {
    const found = ungroundedArgumentsInCall(
      { building_id: 'building_1' },
      JSON.stringify({ user_message: 'add a unit to the first building' }),
    );
    expect(found).toEqual([
      { path: 'building_id', value: 'building_1', why: 'ungrounded' },
    ]);
  });

  /** From D-219 round 3: the corpus held only `pat.lee.bench9q2@…`. */
  it('refuses an invented address', () => {
    const found = ungroundedArgumentsInCall(
      { email: 'sarah.chen@northwind.com' },
      JSON.stringify({ contacts: ['pat.lee.bench9q2@northwind-bench-corp.com'] }),
    );
    expect(found[0]?.why).toBe('ungrounded');
  });

  /** ⛔ Form beats grounding: a packet containing the placeholder must not
   *  ground it, because echoing a placeholder back IS the failure. */
  it('refuses a placeholder even when the packet contains it', () => {
    expect(ungroundedArgumentsInCall(
      { to: '[recipient_email]' }, 'template: [recipient_email]',
    )[0]?.why).toBe('bracketed placeholder');
  });

  it('finds an ungrounded identifier nested in a structure', () => {
    const found = ungroundedArgumentsInCall(
      { config: { to: ['real@x.io', 'made.up@y.io'] } },
      'contact: real@x.io',
    );
    expect(found).toEqual([
      { path: 'config.to[1]', value: 'made.up@y.io', why: 'ungrounded' },
    ]);
  });
});

describe('tool-argument grounding — what the model is told', () => {
  /** ⚠ A refusal the model cannot act on just burns a round. It has to name the
   *  argument AND the remedy, or the model retries the same call. */
  it('names the value and tells the model to fetch it first', () => {
    const detail = ungroundedArgumentsDetail([
      { path: 'building_id', value: '__first__', why: 'underscore placeholder' },
    ]);
    expect(detail).toContain('building_id');
    expect(detail).toContain('__first__');
    expect(detail).toMatch(/run the step that returns it first/i);
    expect(detail).toMatch(/wait for the result/i);
    // ⚠ No scolding: a model reading "you hallucinated" mid-turn tends to
    // apologise rather than retry.
    expect(detail).not.toMatch(/hallucinat|made up|invented|wrong/i);
  });

  it('pluralises when several arguments are unsourced', () => {
    const detail = ungroundedArgumentsDetail([
      { path: 'a_id', value: 'x1', why: 'ungrounded' },
      { path: 'b_id', value: 'y2', why: 'ungrounded' },
    ]);
    expect(detail).toMatch(/those values were/);
    expect(detail).toMatch(/returns them first/);
  });
});
