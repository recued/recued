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

const isGrounded = (value: string, lowerPacket: string): boolean => {
  const lower = value.toLowerCase();
  if (lowerPacket.includes(lower)) return true;
  const embedded = lower.match(EMBEDDED_ADDRESS);
  return embedded !== null
    && embedded.length > 0
    && embedded.every((token) => lowerPacket.includes(token));
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
export const ungroundedArgumentsDetail = (
  found: ReadonlyArray<UngroundedArgument>,
): string =>
  'Not dispatched: '
  + found.map((f) => `\`${f.path}\` = ${JSON.stringify(f.value)}`).join(', ')
  + ` — ${found.length === 1 ? 'that value was' : 'those values were'} not in`
  + ' anything you have been given. Run the step that returns'
  + ` ${found.length === 1 ? 'it' : 'them'} first, wait for the result, then`
  + ' call this tool with the value from that result. Do not guess an'
  + ' identifier, and do not send a placeholder.';
