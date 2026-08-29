import { describe, expect, it } from 'vitest';

import {
  groundingCorpusFromPacket,
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

describe('tool-argument grounding — the phone arm is not a hole', () => {
  /** ⚠ THE ARM CANNOT LAUNDER AN INVENTION: a number the packet never carried
   *  has no matching digit-run whatever its formatting. Without this case the
   *  permitting tests above would pass on a rule that grounded every phone. */
  it('still refuses a phone number the packet never carried', () => {
    const found = ungroundedArgumentsInCall(
      { phone: '+14155550123' },
      'user_message: Who is calling from (415) 555-0199?',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toBe('ungrounded');
  });

  /** ⚠ THE 7-DIGIT FLOOR IS DOING REAL WORK. A 24 KB packet is full of digit
   *  runs — dates, counts, ids — and a shorter floor would ground a fabricated
   *  number against an unrelated one. */
  it('does not ground a short number against unrelated digits', () => {
    const found = ungroundedArgumentsInCall(
      { phone: '555-0199' },
      'user_message: on 2026-08-20 we sent 5550199 messages',
    );
    // Grounds legitimately here (the run IS present); the guard is that a
    // SHORTER value cannot reach the arm at all.
    expect(ungroundedArgumentsInCall(
      { phone: '55-0199' }, 'user_message: order 12345678 shipped',
    )).toHaveLength(1);
    expect(found).toHaveLength(0);
  });

  it('does not let a non-phone value into the phone arm', () => {
    // An address-shaped value in an identifier field still takes the address
    // path, so the phone arm cannot become a general escape hatch.
    const found = ungroundedArgumentsInCall(
      { to: 'sarah.chen@northwind.com' },
      'user_message: call (415) 555-0199',
    );
    expect(found).toHaveLength(1);
  });
});

describe('tool-argument grounding — the inline-recipe exemption is not a hole', () => {
  /** ⛔ THE CASE THAT PROVES THE LINE. Bench 98 also named
   *  `recipe.steps[0].input.target = "contact:mona@bench.test"` — a contact the
   *  model was never given. Structure is exempt; the world the recipe reaches
   *  out to is not, so this stays refused and the TASK is what needs fixing. */
  it('still refuses a fabricated contact reference in a recipe step input', () => {
    const found = ungroundedArgumentsInCall(
      { recipe: { steps: [{ id: 'annotate', input: { target: 'contact:mona@bench.test' } }] } },
      'user_message: note her preferred address',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('recipe.steps[0].input.target');
  });

  it('still grounds a BARE `id` in a top-level tool argument', () => {
    // ⚠ SCOPE IS WHAT MAKES BOTH READINGS CORRECT. Outside a recipe body a bare
    // `id` is a record identifier and must be sourced; the exemption must not
    // leak out of `recipe.*`.
    expect(ungroundedArgumentsInCall(
      { id: 'building_1' }, 'user_message: add a unit',
    )).toHaveLength(1);
  });

  /** ⚠ THE EXEMPTION IS PER-VALUE, NOT PER-SUBTREE. Skipping `recipe.*`
   *  wholesale would have handed the model a laundering route: put the invented
   *  address inside an inline recipe and it dispatches. Only values CARRYING a
   *  `{{…}}` are skipped, because only those are engine-resolved. */
  it('still refuses an invented literal address inside an inline recipe', () => {
    const found = ungroundedArgumentsInCall(
      { recipe: { steps: [{ input: { to: ['sarah.chen@northwind.com'] } }] } },
      'user_message: send the note',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('recipe.steps[0].input.to[0]');
    expect(found[0]?.why).toBe('ungrounded');
  });

  /** ⚠ AND IT IS ANCHORED ON THE ARG PATH, WHICH IS THE SCHEMA. `recipe.run`
   *  takes `recipe_id` OR `recipe`; a Tier-2 recipe invoked DIRECTLY carries its
   *  inputs as top-level args, so a template there is still a placeholder bug. */
  it('still refuses a template in a TOP-LEVEL argument', () => {
    const found = ungroundedArgumentsInCall(
      { to: '{{data.shared.reply_to}}' },
      'user_message: send the note',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toBe('template placeholder');
  });

  it('still refuses a template nested under a non-recipe object', () => {
    const found = ungroundedArgumentsInCall(
      { config: { to: '{{data.shared.reply_to}}' } },
      'user_message: send the note',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('config.to');
  });
});

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

  /** ⛔⛔ THE INLINE-RECIPE HATCH, AND IT WAS FULLY CLOSED BY THIS GATE.
   *
   *  MEASURED on bench task 100. A model emitted a well-formed inline recipe
   *  whose step read `to: ["{{data.shared.reply_to}}"]`; this check refused the
   *  dispatch as a "template placeholder" and told the model *"Run the step
   *  that returns them first, wait for the result"* — advice it cannot follow,
   *  because no step returns it. `{{data.shared.reply_to}}` is a REFERENCE the
   *  engine resolves against a namespace the model never sees and must never be
   *  handed. The round then reported `tool_calls_executed: 1`, `outcome:
   *  "completed"`, and nothing ran: the owner is told the note was sent.
   *
   *  ⛔ THE SCOPE WAS THE WHOLE FEATURE. `recipe.run`'s arg schema advertises
   *  `recipe` to the model as "the AI-authored escape hatch", and every useful
   *  recipe references the owner's data (`{{config.*}}`, `{{step.*}}`,
   *  `{{data.shared.*}}`, `{{item.*}}`) — so the hatch was open only for
   *  recipes that read nothing. */
  it('passes an inline recipe that references the owner\'s data', () => {
    expect(ungroundedArgumentsInCall(
      { recipe: { steps: [{ input: { to: ['{{data.shared.reply_to}}'] } }] } },
      'user_message: send the note',
    )).toEqual([]);
  });

  it('passes an inline recipe that interpolates a ref into prose', () => {
    expect(ungroundedArgumentsInCall(
      { recipe: { steps: [{ input: { body: 'Hello {{contact.name}}, a quick note.' } }] } },
      'user_message: send the note',
    )).toEqual([]);
  });

  /** ⛔⛔ A PHONE NUMBER THE MODEL REFORMATTED. Measured on bench task 53, which
   *  was the ONLY task in a 117-task sweep red solely because the turn reported
   *  `completed` having dispatched nothing — every other assertion it makes
   *  passed. The owner types the number the way people write phone numbers; the
   *  model sends the E.164 form the API takes; literal containment cannot see
   *  that they are the same number. */
  it('passes a phone number the model normalised to E.164', () => {
    expect(ungroundedArgumentsInCall(
      { phone: '+14155550199' },
      'user_message: Who is calling from (415) 555-0199?',
    )).toEqual([]);
  });

  it('passes it in the other direction too — owner types +1, model strips it', () => {
    // The suffix relation holds both ways; the owner may well paste E.164.
    expect(ungroundedArgumentsInCall(
      { phone: '4155550199' },
      'user_message: Who is calling from +1 (415) 555-0199?',
    )).toEqual([]);
  });

  it('passes a number written with dots, spaces or dashes', () => {
    for (const typed of ['415.555.0199', '415 555 0199', '415-555-0199']) {
      expect(ungroundedArgumentsInCall(
        { phone: '+14155550199' }, `user_message: call ${typed}`,
      )).toEqual([]);
    }
  });

  /** ⛔⛔ RECIPE STRUCTURE IS AUTHORED, NEVER FETCHED. Measured on bench 98: an
   *  inline recipe was refused for its own STEP ID. A model writing a recipe
   *  must name its steps, and that name exists nowhere until it writes it — so
   *  under the template-only exemption an inline recipe was dispatchable only if
   *  every structural name happened to fall under `isCheckable`'s 4-character
   *  floor, which is an accident of length rather than a design. */
  it('passes an inline recipe whose steps have real names', () => {
    expect(ungroundedArgumentsInCall(
      { recipe: { steps: [{ id: 'annotate', ingredient: 'annotation-create',
        input: { authored_by_recipe_id: 'note-preferred-email' } }] } },
      'user_message: note her preferred address',
    )).toEqual([]);
  });

  it('passes an inline recipe that chains a prior step output', () => {
    expect(ungroundedArgumentsInCall(
      { recipe: { steps: [{ input: { contact_id: '{{step.find.result.id}}' } }] } },
      'user_message: do the thing',
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
  /** ⛔⛔ A PLACEHOLDER IS A DECLARED DEPENDENCY, NOT A GUESS, and one message
   *  for both told the honest case it had guessed. Measured over 1027 stored
   *  bench reports: 133 refusals of this class are unserialised dependent chains
   *  against 11 genuine single-call inventions (92%), and in the dominant case
   *  the producing call sat in the SAME `tool_calls` array 100% of the time. */
  it('answers a PLACEHOLDER as a dependency it already spotted, and points at the same batch', () => {
    const detail = ungroundedArgumentsDetail([
      { path: 'building_id', value: '__first__', why: 'underscore placeholder' },
    ]);
    expect(detail).toContain('building_id');
    expect(detail).toContain('__first__');
    expect(detail).toMatch(/placeholder/i);
    // The remedy that fits the measured common case: the producer is in flight.
    expect(detail).toMatch(/same set of tool calls/i);
    expect(detail).toMatch(/wait for its result/i);
    expect(detail).toMatch(/send this call again/i);
    // ⛔ It must NOT accuse the model of guessing — it did the opposite.
    expect(detail).not.toMatch(/do not guess an identifier/i);
    // ⚠ No scolding: a model reading "you hallucinated" mid-turn tends to
    // apologise rather than retry.
    expect(detail).not.toMatch(/hallucinat|made up|invented|wrong/i);
  });

  it('answers an UNGROUNDED value as a guess, keeping the fetch-first remedy', () => {
    const detail = ungroundedArgumentsDetail([
      { path: 'contact_id', value: 'sarah.chen@northwind.com', why: 'ungrounded' },
    ]);
    expect(detail).toMatch(/run the step that returns it first/i);
    expect(detail).toMatch(/wait for the result/i);
    expect(detail).toMatch(/do not guess an identifier/i);
    expect(detail).not.toMatch(/hallucinat|made up|invented|wrong/i);
  });

  /** ⛔ THE WHOLE POINT OF THE SPLIT. If these two ever converge the distinction
   *  is dead and the placeholder case is back to being told it guessed. */
  it('gives the two classes DIFFERENT messages', () => {
    // ⛔ SAME path, SAME value — only `why` differs, so ONLY the branch can make
    // these strings diverge. A first cut varied the value too and its
    // `not.toEqual` passed for the wrong reason: the messages differed because
    // the quoted values did, and it stayed green with the branch disabled.
    const arg = { path: 'x', value: '[sender_email]' } as const;
    const ph = ungroundedArgumentsDetail([{ ...arg, why: 'bracketed placeholder' }]);
    const ug = ungroundedArgumentsDetail([{ ...arg, why: 'ungrounded' }]);
    expect(ph).not.toEqual(ug);
    expect(ph).toMatch(/same set of tool calls/i);
    expect(ug).not.toMatch(/same set of tool calls/i);
  });

  /** ⚠ FORM BEATS GROUNDING, exactly as it does in the classifier: one declared
   *  dependency among several guesses still means the model flagged a gap. */
  it('takes the placeholder branch when a placeholder rides beside an ungrounded value', () => {
    const detail = ungroundedArgumentsDetail([
      { path: 'a', value: 'sarah@northwind.com', why: 'ungrounded' },
      { path: 'b', value: '[sender_email]', why: 'bracketed placeholder' },
    ]);
    expect(detail).toMatch(/those are placeholders/i);
    expect(detail).toContain('sarah@northwind.com');
  });

  /** ⛔⛔ THE SUFFIX RULE HELD IN ONLY ONE DIRECTION, AND ITS COMMENT CLAIMED BOTH.
   *  `PHONE_SHAPE` anchored on a leading digit or `+`, so the commonest human
   *  form — `(415) 555-0100` — never matched, the digit-run comparison never ran,
   *  and a CORRECTLY reformatted number fell through to literal containment and
   *  was refused. Found by driving the real gate while verifying a phone lure for
   *  a bench task; the false positive would have scored a correct reformat as a
   *  fabrication. Both directions are pinned here so it cannot regress to one. */
  it('grounds a phone the model reformatted — E.164 packet, parenthesised call', () => {
    const packet = JSON.stringify({ user_message: 'Ring the office on +1 415 555 0100.' });
    expect(ungroundedArgumentsInCall({ phone: '(415) 555-0100' }, packet)).toEqual([]);
  });

  it('grounds a phone the model reformatted — parenthesised packet, E.164 call', () => {
    const packet = JSON.stringify({ user_message: 'Who is calling from (415) 555-0199?' });
    expect(ungroundedArgumentsInCall({ phone: '+14155550199' }, packet)).toEqual([]);
  });

  /** ⛔ THE WIDENING MUST NOT LAUNDER AN INVENTION. A number the packet never
   *  carried has no matching digit-run whatever its formatting. */
  it('still refuses a fabricated phone written in the parenthesised form', () => {
    const packet = JSON.stringify({ user_message: 'Ring the office on +1 415 555 0100.' });
    const found = ungroundedArgumentsInCall({ phone: '(415) 555-0472' }, packet);
    expect(found).toHaveLength(1);
    expect(found[0]!.why).toBe('ungrounded');
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

describe('the grounding corpus is what the model was GIVEN, not what it SENT', () => {
  /** ⛔⛔⛔ THE GATE WAS DEFEATED BY A SINGLE RETRY. The loop threads a refused
   *  call back as a `prior_tool_calls` entry carrying its full `args` plus the
   *  corrective `detail` that quotes the offending value — both land in the NEXT
   *  packet, so an UNCHANGED retry grounded on its own rejection. Measured on
   *  bench 98's captures: identical args, refused on packet 5, admitted on
   *  packet 6, nothing changed but the echo. */
  const refusedEcho = JSON.stringify({
    user_message: 'update her preferred email',
    prior_tool_calls: [{
      tool_name: 'recipe.run',
      args: { recipe: { steps: [{ input: { target: 'contact:mona@bench.test' } }] } },
      status: 'error',
      reason: 'invalid_args',
      detail: 'Not dispatched: `recipe.steps[0].input.target` = "contact:mona@bench.test" — that value was not…',
    }],
  });
  const call = { to: 'contact:mona@bench.test' };

  it('the RAW packet launders the value — this is the defect', () => {
    expect(ungroundedArgumentsInCall(call, refusedEcho)).toHaveLength(0);
  });

  it('the trimmed corpus still refuses it', () => {
    expect(
      ungroundedArgumentsInCall(call, groundingCorpusFromPacket(refusedEcho)),
    ).toHaveLength(1);
  });

  it('a value the model read out of a tool RESULT still grounds', () => {
    // ⚠ THE HALF THAT MUST NOT MOVE. A result is something the model was GIVEN;
    // stripping it would refuse every legitimate multi-round chain, which is a
    // far worse failure than the hole being closed.
    const withResult = JSON.stringify({
      user_message: 'send it',
      prior_tool_calls: [{
        tool_name: 'contact.search', args: { query: 'Mona' }, status: 'ok',
        result: { rows: [{ email: 'mona@bench.test' }] },
      }],
    });
    expect(
      ungroundedArgumentsInCall({ to: 'mona@bench.test' }, groundingCorpusFromPacket(withResult)),
    ).toEqual([]);
  });

  it('an unparseable body falls back to itself, never to empty', () => {
    // ⚠ Refusing every call on a malformed packet would be a worse failure than
    // the hole. A broken body is a bug elsewhere; this must not amplify it.
    expect(groundingCorpusFromPacket('not json at all')).toBe('not json at all');
  });

  it('leaves a packet with no prior calls untouched in meaning', () => {
    const plain = JSON.stringify({ user_message: 'email pat@x.io' });
    expect(
      ungroundedArgumentsInCall({ to: 'pat@x.io' }, groundingCorpusFromPacket(plain)),
    ).toEqual([]);
  });
});

/** ⛔⛔ THE DATE ARM — same class as the phone arm above, and it cost a whole
 *  turn before it existed. The owner's message said "14 October 2026"; the model
 *  sent `2026-10-14`; a literal comparison called that an invention and told it
 *  to "run the step that returns it first" — advice with no step to run, because
 *  the value came from the USER. The model re-sent the identical call until the
 *  turn timed out.
 *
 *  ⚠ THE PERMITTING CASES ARE FIRST, for the reason stated at the top of this
 *  file; the refusing cases below are what prove the arm is not a hole. */
describe('tool-argument grounding — the date arm is not a hole', () => {
  const packetProse = 'user_message: the Marlowe site handover is on 14 October 2026';

  it('grounds an ISO date the owner wrote in prose', () => {
    expect(ungroundedArgumentsInCall({ to: '2026-10-14' }, packetProse)).toHaveLength(0);
  });

  it('grounds in the other direction — prose value, ISO packet', () => {
    expect(ungroundedArgumentsInCall(
      { to: '14 October 2026' },
      'user_message: handover is 2026-10-14',
    )).toHaveLength(0);
  });

  it('grounds the month-first spelling', () => {
    expect(ungroundedArgumentsInCall({ to: '2026-10-14' },
      'user_message: handover is October 14, 2026')).toHaveLength(0);
  });

  /** ⛔ THE ARM CANNOT LAUNDER AN INVENTION. A different day is still absent
   *  however it is written — without this the permitting cases would pass on a
   *  rule that grounded every date. */
  it('still refuses a date the packet never carried', () => {
    const found = ungroundedArgumentsInCall({ to: '2026-11-14' }, packetProse);
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toBe('ungrounded');
  });

  /** ⛔ AN OPAQUE ID THAT MERELY CONTAINS A DATE IS NOT A DATE. Scanning the
   *  value for an embedded date rather than requiring the value to BE one would
   *  ground a fabricated identifier by its suffix. */
  it('refuses an identifier that merely embeds a grounded date', () => {
    const found = ungroundedArgumentsInCall({ deal_id: 'deal_2026-10-14' }, packetProse);
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toBe('ungrounded');
  });

  /** ⛔ AMBIGUOUS NUMERIC FORMS ARE OUT ON PURPOSE. `01/02/2026` is 1 February
   *  or 2 January by locale; recognising it would let the model ground a day the
   *  owner never wrote. This must stay REFUSED, and that is a deliberate missed
   *  rescue rather than a bug. */
  it('does not recognise a dd/mm/yyyy packet date', () => {
    const found = ungroundedArgumentsInCall(
      { to: '2026-02-01' },
      'user_message: the handover is on 01/02/2026',
    );
    expect(found).toHaveLength(1);
  });

  /** ⛔ A PARTIAL DATE IS NOT A DAY. A bare year must never ground a full date,
   *  or every date in a packet mentioning the year would be admitted. */
  it('does not ground a full date against a bare year', () => {
    const found = ungroundedArgumentsInCall(
      { to: '2026-10-14' },
      'user_message: sometime in 2026, probably October',
    );
    expect(found).toHaveLength(1);
  });

  /** ⛔ AN IMPOSSIBLE DAY IS NOT A DATE. 31 February parses arithmetically in
   *  many libraries by rolling over into March; a value that is not a real day
   *  must not be grounded as one. */
  it('refuses an impossible calendar day', () => {
    const found = ungroundedArgumentsInCall(
      { to: '2026-02-31' },
      'user_message: due 2026-03-03',
    );
    expect(found).toHaveLength(1);
  });
});
