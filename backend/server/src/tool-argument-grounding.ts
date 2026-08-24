/** Refuse a tool call whose IDENTIFIER argument the model could not have read.
 *
 *  ⛔⛔ THE FAILURE THIS EXISTS FOR, measured across 246 live turns. A model
 *  handed a multi-step job issues the whole job in ONE round — including the
 *  step that needed a previous step's output — and invents the value it has not
 *  fetched. Bench 181 handed it a chain that CANNOT be batched
 *  (`list-buildings` → building_id → `add-unit` → unit_id →
 *  `open-rental-contract`) and it batched anyway, emitting
 *  `add-unit(building_id: "__first__")` beside the very call that would have
 *  returned the real id. Earlier runs produced `building_1`, `unit_2`, and
 *  `sarah.chen@northwind.com` against a corpus whose only contact was
 *  `pat.lee.bench9q2@northwind-bench-corp.com`.
 *
 *  Every one of the 73 invented arguments observed in the D-219 A/B rounds —
 *  56/56 in the card arm, 17/17 without — was issued inside such a batch,
 *  alongside the read that would have supplied its value. The precedent card
 *  made it ~5.5x more likely and has been removed; this closes the path itself,
 *  which is where it always lived.
 *
 *  🔑 THE RULE: an argument that IDENTIFIES something must have come from
 *  somewhere the model could read — the packet it was handed for this call,
 *  which already contains the conversation, the prefetch block, and every
 *  completed step's result. A value that appears nowhere in it was invented,
 *  and dispatching it acts on a fabrication.
 *
 *  ⚠ IDENTIFIER-ONLY, and the split is what makes this an instrument rather
 *  than a blanket refusal. A value that identifies must be sourced; a value that
 *  DESCRIBES need not — the model composes search text, notes and labels
 *  legitimately, and gating those would break ordinary turns. It is also the
 *  same axis as the mechanism: an identifier is the only kind of value CARRIED
 *  between steps, so it is the only kind whose fabrication means a step
 *  collapsed.
 *
 *  ⚠ THIS FILE IS A TWIN of internal benchmarks,
 *  which SCORES the same property. They must agree: the bench measures what the
 *  server enforces, and a divergence would make the bench read clean while the
 *  server refused (or the reverse). Any rule change belongs in both, and
 *  `tool-argument-grounding.test.ts` pins the shared cases. */

/** ⛔ Form beats grounding. A packet that happens to contain `[email_1]` would
 *  GROUND the placeholder, and a model echoing a placeholder back is the
 *  failure being caught, not an excuse for it. */
const PLACEHOLDER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\[.+\]$/, 'bracketed placeholder'],
  [/^\{\{.+\}\}$/, 'template placeholder'],
  [/^<.+>$/, 'angle placeholder'],
  [/^__.+__$/, 'underscore placeholder'],
  [/^(sender|recipient|user|someone|contact|the-?user)@/i, 'role-name address'],
  [/^(TODO|TBD|PLACEHOLDER|XXX+|N\/A|FIXME)$/i, 'literal placeholder'],
  [/^(first|last|full)[-_. ]?name$/i, 'schema field as value'],
];

/** ⛔ A RESERVED DOMAIN IS SUSPICIOUS, NOT INVALID — so it must be GROUNDED
 *  rather than refused outright.
 *
 *  It began life in the placeholder list, where form beats grounding, and that
 *  refused `alice@example.com` in three existing executor tests. The tests were
 *  right and the rule was wrong: `@example.com` is the near-universal fixture
 *  convention, and a value the owner actually typed is a real value in their
 *  world whatever IANA reserved. Demoting it to "identifier that must be
 *  sourced" keeps every live fabrication it caught — `sender@example.com`,
 *  `pat@example.com`, `recent-sender@example.com` were all ungrounded anyway —
 *  while letting a typed or stored one through.
 *
 *  ⚠ The `[email_1]` family stays form-first: a packet echoing a placeholder
 *  must not ground it, because echoing one back IS the failure. */
const RESERVED_DOMAIN = /@(example|test|invalid|localhost)\.(com|org|net|test)$/i;

const IDENTIFIER_FIELDS =
  /^(email|address|to|cc|bcc|from|sender|recipient|.*_id|id|entity_id|contact_id|deal_id|slug|handle|username|phone)$/i;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPAQUE_ID_SHAPE = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*[_-]\d{3,}$/i;

/** ⛔ Short and structural values are EXCLUDED, not counted as grounded. A
 *  three-character value collides with everything, so neither answer means
 *  anything, and refusing on one would break ordinary turns for noise. */
const SKIP_LEAVES = /^(recipe_id|tool|name|kind|type|status|channel|surface)$/;

/** ⛔⛔ A `{{…}}` INSIDE AN INLINE RECIPE IS THE VALUE SYSTEM, NOT A PLACEHOLDER
 *  — and treating it as one silently killed `recipe.run`'s inline path.
 *
 *  MEASURED on bench task 100. The model emitted a well-formed inline recipe
 *  whose step read `to: ["{{data.shared.reply_to}}"]`, and this gate refused the
 *  whole dispatch as a "template placeholder". The refusal then told the model
 *  *"Run the step that returns them first, wait for the result"* — advice that
 *  cannot be followed, because no step returns it: `{{data.shared.reply_to}}` is
 *  a REFERENCE the engine resolves at execution time against a namespace the
 *  model never sees and must never be handed. The turn reported
 *  `tool_calls_executed: 1`, `outcome: "completed"`, and nothing ran.
 *
 *  ⛔ THE SCOPE OF THE BREAKAGE IS THE WHOLE FEATURE, not one task.
 *  `recipe.run`'s own arg schema advertises `recipe` to the model as *"the
 *  AI-authored escape hatch"*, and every useful recipe references the owner's
 *  data — `{{config.*}}`, `{{step.*}}`, `{{data.shared.*}}`, `{{item.*}}`. So
 *  the hatch was open for exactly those recipes that read nothing.
 *
 *  ⚠ NARROW ON PURPOSE — the subtree is NOT exempted, only its template refs.
 *  A literal fabricated address sitting in `recipe.steps[0].input.to[0]` is
 *  still the fabrication this gate exists to catch and is still refused; only a
 *  value CARRYING a `{{…}}` is skipped, because such a value is not an assertion
 *  about the world at all. And the whole leaf is skipped rather than just its
 *  form rule: `to` is an identifier field, so falling through would re-flag the
 *  same value as `ungrounded` and the exemption would do nothing.
 *
 *  ⚠ Anchored on the ARG PATH, which is the schema: `recipe.run` takes
 *  `recipe_id` OR `recipe`, and a Tier-2 recipe invoked directly carries its
 *  inputs as TOP-LEVEL args — so a `{{…}}` there is still a placeholder bug and
 *  still refused. */
const TEMPLATE_REF = /\{\{.+?\}\}/;
const isInsideInlineRecipe = (path: string): boolean =>
  path === 'recipe' || path.startsWith('recipe.');

/** ⛔⛔ RECIPE STRUCTURE IS AUTHORED, NEVER FETCHED — and the first version of
 *  this exemption only covered `{{…}}` values, which left the OTHER half of an
 *  inline recipe refusable.
 *
 *  MEASURED on bench 98: an inline recipe was refused for
 *  `recipe.steps[0].id = "annotate"` and
 *  `recipe.steps[0].input.authored_by_recipe_id = "note-preferred-email"`. A
 *  model writing a recipe MUST name its steps, and it names the recipe it is
 *  authoring — neither value can ever appear in the packet, because neither
 *  exists until the model writes it. Under the old rule an inline recipe was
 *  only dispatchable if every structural name happened to be under four
 *  characters (`isCheckable`'s floor) — which is not a feature, it is an
 *  accident of length.
 *
 *  ⚠ THE SAME LIST THE GLOBAL RULE ALREADY KEEPS, extended by the two names a
 *  recipe body uses that a tool argument does not. `SKIP_LEAVES` already exempts
 *  `recipe_id|tool|name|kind|type|status|channel|surface` everywhere for exactly
 *  this reason; `id` is absent from it because a BARE `id` in a tool argument is
 *  a record identifier and must be grounded. Inside a recipe definition it is a
 *  step label. Scope is what makes both readings correct.
 *
 *  ⛔ WHAT IS STILL REFUSED, and the case that proves the line: bench 98 also
 *  named `recipe.steps[0].input.target = "contact:mona@bench.test"` — a CONTACT
 *  the model was never given. That is a fabricated identifier wearing recipe
 *  clothing, it stays refused, and the task that scripted it is what needs
 *  fixing. Structure is exempt; the world the recipe reaches out to is not. */
const RECIPE_STRUCTURAL_LEAVES = /^(id|authored_by_recipe_id|ingredient|transform|step|source|label)$/;

export interface UngroundedArgument {
  /** Path to the offending leaf inside the call's args, e.g. `config.to`. */
  path: string;
  value: string;
  /** Which rule fired — a placeholder-pattern label, or `ungrounded`. */
  why: string;
}

const leaves = (node: unknown, path = ''): Array<[string, string]> => {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => leaves(item, `${path}[${i}]`));
  }
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>)
      .flatMap(([key, v]) => leaves(v, path ? `${path}.${key}` : key));
  }
  return [];
};

const leafOf = (path: string): string =>
  (path.split('.').pop() ?? '').replace(/\[\d+\]$/, '');

const isCheckable = (path: string, value: string): boolean =>
  value.length >= 4
  && !/^\d+$/.test(value)
  && !/^(true|false|null|asc|desc|all|any)$/i.test(value)
  && !SKIP_LEAVES.test(leafOf(path));

const isIdentifier = (path: string, value: string): boolean =>
  IDENTIFIER_FIELDS.test(leafOf(path))
  || EMAIL_SHAPE.test(value)
  || OPAQUE_ID_SHAPE.test(value)
  || RESERVED_DOMAIN.test(value);

/** ⛔ A COMPOSED QUERY IS NOT A FABRICATION. Calibrating this check against
 *  6500 live model tool calls surfaced exactly one false-positive shape, three
 *  times: `mail.search.query = "from:pat.lee.bench9q2@northwind-bench-corp.com"`.
 *  The address is REAL and the model had read it — it wrapped it in a `from:`
 *  search operator, so the whole string appears nowhere and a literal
 *  containment test calls it invented. Refusing that would break an ordinary
 *  search on the hot path.
 *
 *  So a value grounds if it appears whole, OR if every address-shaped token
 *  inside it does. The second arm cannot launder an invention: an invented
 *  address is still absent from the packet whatever operator is wrapped round
 *  it, which the `from:` test below pins in both directions.
 *
 *  ⚠ Found by MEASUREMENT, not review. The rule looked obviously right until it
 *  was run over real traffic. */
const EMBEDDED_ADDRESS = /[^\s:<>"'(),;]+@[^\s:<>"'(),;]+\.[^\s:<>"'(),;]+/g;

/** ⛔⛔ A PHONE NUMBER THE MODEL REFORMATTED IS NOT A FABRICATION — the SAME
 *  class as `EMBEDDED_ADDRESS` above, and it was missed because that fix was
 *  written for email only.
 *
 *  MEASURED on bench task 53. The owner asks *"Who is calling from
 *  (415) 555-0199?"*; the model emits `contact.search { phone: "+14155550199" }`
 *  — CORRECTLY normalised to E.164, which is what the API takes. Literal
 *  containment cannot see that the two are the same number, so the dispatch was
 *  refused and the turn reported `completed` having done nothing. ⇒ Any owner
 *  who types a phone number the way people write phone numbers has their
 *  `contact.search` refused.
 *
 *  🔑 SUFFIX, NOT EQUALITY, because the difference is usually a country code:
 *  the typed form yields `4155550199` and the emitted form `14155550199`. One
 *  digit-run being a suffix of the other is exactly the national-vs-E.164
 *  relationship, and it holds in both directions (the owner may type the +1).
 *
 *  ⚠ FLOOR OF 7 DIGITS, and it is doing real work. A 24 KB packet is full of
 *  digit runs — dates, counts, ids — and a shorter floor grounds a fabricated
 *  number against an unrelated one. Seven is a local subscriber number; below
 *  that neither answer means anything, which is the same reasoning
 *  `isCheckable` already applies to short values.
 *
 *  ⚠ This CANNOT launder an invention: a number the packet never carried has no
 *  matching digit-run whatever its formatting, which the "fabricated number"
 *  case in `tool-argument-grounding.test.ts` pins. */
// ⛔⛔ THE LEADING `(` IS LOAD-BEARING AND WAS MISSING. The anchor demanded a
// digit or `+` first, so the commonest human form — `(415) 555-0100` — never
// matched, the suffix rule below never ran, and the value fell through to
// literal containment and was REFUSED. The comment above claimed the rule
// "holds in both directions"; it held only when the EMITTED value happened to
// match this shape. Packet-parenthesised → model-E.164 worked (task 53, the
// case it was written for); packet-E.164 → model-parenthesised did not.
// Found while verifying a phone lure against the real gate before building a
// bench task on it — the false positive would have scored a correct reformat
// as a fabrication.
const PHONE_SHAPE = /^\+?\(?\d[\d\s().-]{5,}$/;
const PACKET_PHONE_RUN = /\d[\d\s().-]{5,}\d/g;
const MIN_PHONE_DIGITS = 7;
const digitsOf = (s: string): string => s.replace(/\D+/g, '');

const groundsAsPhone = (value: string, packet: string): boolean => {
  if (!PHONE_SHAPE.test(value.trim())) return false;
  const want = digitsOf(value);
  if (want.length < MIN_PHONE_DIGITS) return false;
  for (const run of packet.match(PACKET_PHONE_RUN) ?? []) {
    const got = digitsOf(run);
    if (got.length < MIN_PHONE_DIGITS) continue;
    if (want === got || want.endsWith(got) || got.endsWith(want)) return true;
  }
  return false;
};

const isGrounded = (value: string, lowerPacket: string): boolean => {
  const lower = value.toLowerCase();
  if (lowerPacket.includes(lower)) return true;
  // A number the owner typed one way and the model sends another — see
  // `groundsAsPhone`. Checked before the address arm because a phone-shaped
  // value carries no `@` and would fail it anyway.
  if (groundsAsPhone(lower, lowerPacket)) return true;
  const embedded = lower.match(EMBEDDED_ADDRESS);
  return embedded !== null
    && embedded.length > 0
    && embedded.every((token) => lowerPacket.includes(token));
};

/** The packet MINUS the model's own echoed arguments — the corpus a value must
 *  actually be grounded IN.
 *
 *  ⛔⛔⛔ THE GATE WAS DEFEATED BY A SINGLE RETRY, and it was measured on real
 *  captured packets. The loop threads every refused call back to the model as a
 *  `prior_tool_calls` entry carrying its full `args` (so the model can see what
 *  it sent) plus the corrective `detail` (which quotes the offending value by
 *  name). Both land in the NEXT packet. So:
 *
 *    packet N   — `target = "contact:mona@bench.test"` → REFUSED, not in the packet
 *    packet N+1 — the refusal is threaded back, args and all
 *    packet N+1 — the IDENTICAL call now grounds, because the packet contains it
 *
 *  Verified against bench 98's own captures: the same args object refuses on
 *  packet 5 and is admitted on packet 6, and the only thing that changed is the
 *  refusal being echoed. A gate whose refusal supplies the evidence for the
 *  retry is not a gate.
 *
 *  🔑 THE RULE THIS RESTORES IS ALREADY STATED TWICE IN THIS CODEBASE.
 *  `looksLikeToolResultEcho` in `coerceAIOutput`: "a model echoing its input is
 *  the failure being caught, not an excuse for it". And the placeholder comment
 *  above: "a packet that happens to contain `[email_1]` would GROUND the
 *  placeholder, and a model echoing a placeholder back is the failure being
 *  caught". Grounding must ask what the model was GIVEN, never what it SENT.
 *
 *  ⚠ `result` IS KEPT — a tool result is something the model was given, and a
 *  value it read out of one is legitimately grounded. Only `args` (what the
 *  model composed) and `detail` (our own message quoting it back) are removed.
 *  ⚠ The model still SEES all of it; this trims the grounding corpus only.
 *  ⚠ An unparseable body falls back to itself rather than to empty — a malformed
 *  packet is a bug, and refusing every call on one would be a worse failure than
 *  the hole this closes. */
export const groundingCorpusFromPacket = (body: string): string => {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return body; }
  if (!parsed || typeof parsed !== 'object') return body;
  const o = { ...(parsed as Record<string, unknown>) };
  for (const field of ['prior_tool_calls', 'recall_context']) {
    const entries = o[field];
    if (!Array.isArray(entries)) continue;
    o[field] = entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const { args: _args, detail: _detail, ...given } = entry as Record<string, unknown>;
      return given;
    });
  }
  try { return JSON.stringify(o); } catch { return body; }
};

/** Identifier arguments in ONE call that the packet never carried.
 *
 *  ⚠ `packet` must be what the model was handed for THIS call — not the
 *  conversation reconstructed afterwards, and not a later packet. A later
 *  packet contains the results of the very calls being checked, so grounding
 *  against one would let a value the model invented ground itself, and the
 *  check would go quiet exactly where a chain collapsed. */
export const ungroundedArgumentsInCall = (
  args: unknown,
  packet: string,
): UngroundedArgument[] => {
  const lower = packet.toLowerCase();
  const found: UngroundedArgument[] = [];
  for (const [path, value] of leaves(args)) {
    if (!isCheckable(path, value)) continue;
    // See `isInsideInlineRecipe`: inside a recipe DEFINITION, a template ref is
    // engine-resolved and a structural name is authored — neither is a value the
    // model could have "read" anywhere, because neither describes the world.
    if (isInsideInlineRecipe(path)
      && (TEMPLATE_REF.test(value) || RECIPE_STRUCTURAL_LEAVES.test(leafOf(path)))) {
      continue;
    }
    const form = PLACEHOLDER_PATTERNS.find(([re]) => re.test(value))?.[1];
    if (form !== undefined) {
      found.push({ path, value, why: form });
    } else if (isIdentifier(path, value) && !isGrounded(value, lower)) {
      found.push({ path, value, why: 'ungrounded' });
    }
  }
  return found;
};

/** What the model is told when a call is refused.
 *
 *  ⛔ NAMES THE VALUE AND THE REMEDY, because a refusal the model cannot act on
 *  just burns a round. It says which argument was not sourced and that the step
 *  producing it must run FIRST — which is the behaviour the refusal exists to
 *  produce. It does NOT say "you hallucinated": the model reads this mid-turn
 *  and a scolding tone measurably shifts models toward apologising instead of
 *  retrying.
 *
 *  ⚠ Model-facing string — changes belong in `chat-prompt-optimization-log.md`. */
/** ⛔⛔ A PLACEHOLDER AND A GUESS ARE NOT THE SAME MISTAKE, AND ONE MESSAGE FOR
 *  BOTH TOLD THE HONEST ONE IT HAD GUESSED.
 *
 *  A value matching {@link PLACEHOLDER_PATTERNS} — `[sender_email]`,
 *  `{{contact.search.results[0].email}}` — is the model DECLARING a dependency
 *  it could not fill: it knew the value was missing and said so. A value that is
 *  merely `ungrounded` (`sarah.chen@northwind.com`) is a guess wearing the shape
 *  of a real identifier. Telling the placeholder case "do not guess an
 *  identifier" answers a mistake it did not make, and says nothing about the one
 *  it did — emitting the consumer in the SAME batch as its producer.
 *
 *  🔑 MEASURED, not reasoned: a sweep of 1027 stored bench reports (2026-08-22)
 *  found 133 refusals of this class against 11 genuine single-call inventions —
 *  **92% are unserialised dependent chains**, and in the dominant case (96 of
 *  them, `calendar.search.query`) the producing call sat in the same
 *  `tool_calls` array **100%** of the time. So the batch is the common case, and
 *  the remedy that fits it — re-issue AFTER the producer's result lands — is
 *  what the message now leads with.
 *
 *  ⚠ The three grounding sources and the remedy stay the gate's own words; the
 *  base prompt (`FEATURE_TEXT_TOOLS`) restates them and must not drift from
 *  this. */
export const ungroundedArgumentsDetail = (
  found: ReadonlyArray<UngroundedArgument>,
): string => {
  const list = found.map((f) => `\`${f.path}\` = ${JSON.stringify(f.value)}`).join(', ');
  const one = found.length === 1;
  // Form beats grounding here exactly as it does in the classifier above: if ANY
  // leaf is a placeholder, the model has declared a dependency and that is the
  // more useful thing to answer.
  const declared = found.some((f) => f.why !== 'ungrounded');
  if (declared) {
    return `Not dispatched: ${list} — ${one ? 'that is a placeholder' : 'those are placeholders'},`
      + ` not a value. You have correctly spotted that you do not have`
      + ` ${one ? 'it' : 'them'} yet. If you asked for ${one ? 'it' : 'them'} in this same set of`
      + ' tool calls, that call has not returned yet: wait for its result, then send this call'
      + ` again with the real value. Do not substitute a guess for ${one ? 'the placeholder' : 'a placeholder'}.`;
  }
  return `Not dispatched: ${list} — ${one ? 'that value was' : 'those values were'} not in`
    + ' anything you have been given. Run the step that returns'
    + ` ${one ? 'it' : 'them'} first, wait for the result, then`
    + ' call this tool with the value from that result. Do not guess an'
    + ' identifier, and do not send a placeholder.';
};
